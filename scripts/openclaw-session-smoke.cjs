const fs = require("node:fs");
const path = require("node:path");

const { DatabaseSync } = require("node:sqlite");

const REPLAY_LEAK_PATTERNS = [
  /^\[durable_memory:[^\]]+\]/i,
  /^\[ChaunyOMS recalled memory\b[^\]]*\]/i,
  /^\[oms_recall_guidance\]/i,
  /^\[knowledge_base_index\]/i,
];

function parseArgs(argv) {
  const options = {
    agent: process.env.CHAUNYOMS_REPORT_AGENT || process.env.CHAUNYOMS_TEST_AGENT_ID || "main",
    agentExplicit: Boolean(process.env.CHAUNYOMS_REPORT_AGENT || process.env.CHAUNYOMS_TEST_AGENT_ID),
    sessionId: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent") {
      options.agent = argv[index + 1] ?? options.agent;
      options.agentExplicit = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) {
      options.agent = arg.slice("--agent=".length);
      options.agentExplicit = true;
      continue;
    }
    if (arg === "--session") {
      options.sessionId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--session=")) {
      options.sessionId = arg.slice("--session=".length);
    }
  }

  return options;
}

function loadOpenClawConfig() {
  const configPath = path.join(process.env.USERPROFILE || "", ".openclaw", "openclaw.json");
  return {
    configPath,
    config: JSON.parse(stripBom(fs.readFileSync(configPath, "utf8"))),
  };
}

function stripBom(content) {
  return String(content).replace(/^\uFEFF/, "");
}

function resolveDataDir(config) {
  const dataDir =
    config?.plugins?.entries?.oms?.config?.dataDir ??
    config?.plugins?.entries?.chaunyoms?.config?.dataDir;
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new Error("ChaunyOMS dataDir is missing from ~/.openclaw/openclaw.json (expected plugins.entries.oms.config.dataDir or legacy plugins.entries.chaunyoms.config.dataDir)");
  }
  return dataDir;
}

function loadSessionRegistry(agentId) {
  const registryPath = path.join(
    process.env.USERPROFILE || "",
    ".openclaw",
    "agents",
    agentId,
    "sessions",
    "sessions.json",
  );
  if (!fs.existsSync(registryPath)) {
    return {};
  }
  try {
    return JSON.parse(stripBom(fs.readFileSync(registryPath, "utf8")));
  } catch {
    return {};
  }
}

function findRegistryEntryBySelector(registry, selector) {
  if (!selector) {
    return null;
  }
  if (registry && typeof registry === "object" && registry[selector]) {
    return {
      sessionKey: selector,
      entry: registry[selector],
      resolutionSource: "session_key",
    };
  }
  for (const [sessionKey, entry] of Object.entries(registry || {})) {
    if (entry && typeof entry === "object" && entry.sessionId === selector) {
      return {
        sessionKey,
        entry,
        resolutionSource: "session_id_registry",
      };
    }
  }
  return null;
}

function resolveRuntimeDbTarget(config, agent, sessionSelector, agentExplicit) {
  const dataDir = resolveDataDir(config);
  if (sessionSelector && !agentExplicit) {
    const inferred = findRuntimeDbTargetForSession(dataDir, agent, sessionSelector);
    if (inferred) {
      return inferred;
    }
  }
  return {
    agent,
    dbPath: path.join(dataDir, "agents", agent, "chaunyoms-runtime.sqlite"),
    requestedSessionSelector: sessionSelector ?? null,
    resolvedSessionId: null,
    resolvedSessionKey: null,
    resolutionSource: sessionSelector ? "unresolved_selector" : "latest_agent_activity",
  };
}

function findRuntimeDbTargetForSession(dataDir, preferredAgent, sessionSelector) {
  const agentsRoot = path.join(dataDir, "agents");
  const agentNames = fs.existsSync(agentsRoot)
    ? fs.readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    : [];
  const orderedAgents = [
    ...agentNames.filter((agent) => agent !== "main"),
    preferredAgent,
    "main",
  ].filter((agent, index, list) => agent && list.indexOf(agent) === index);
  for (const agent of orderedAgents) {
    const dbPath = path.join(agentsRoot, agent, "chaunyoms-runtime.sqlite");
    if (!fs.existsSync(dbPath)) {
      continue;
    }
    const registry = loadSessionRegistry(agent);
    const registryHit = findRegistryEntryBySelector(registry, sessionSelector);
    const resolvedSessionId =
      typeof registryHit?.entry?.sessionId === "string" && registryHit.entry.sessionId.trim()
        ? registryHit.entry.sessionId.trim()
        : null;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const selectorToCheck = resolvedSessionId ?? sessionSelector;
      const hit = selectorToCheck ? db.prepare(`
        select 1 as found from context_runs where session_id = ?
        union all
        select 1 as found from messages where session_id = ?
        limit 1
      `).get(selectorToCheck, selectorToCheck) : null;
      if (hit) {
        return {
          agent,
          dbPath,
          requestedSessionSelector: sessionSelector ?? null,
          resolvedSessionId: selectorToCheck,
          resolvedSessionKey: registryHit?.sessionKey ?? null,
          resolutionSource: registryHit?.resolutionSource ?? "db_session_id",
        };
      }
    } catch {
      // Keep scanning other agent stores.
    } finally {
      db?.close();
    }
  }
  return null;
}

function resolveLatestSessionId(db) {
  const latestContextRun = db.prepare(`
    select session_id
    from context_runs
    order by created_at desc
    limit 1
  `).get();
  if (latestContextRun?.session_id) {
    return {
      sessionId: latestContextRun.session_id,
      source: "latest_context_run",
    };
  }

  const latestMessage = db.prepare(`
    select session_id
    from messages
    order by created_at desc
    limit 1
  `).get();
  if (latestMessage?.session_id) {
    return {
      sessionId: latestMessage.session_id,
      source: "latest_message",
    };
  }

  return null;
}

function detectReplayLeak(text) {
  return REPLAY_LEAK_PATTERNS.some((pattern) => pattern.test(String(text || "").trim()));
}

function extractContentPreview(payloadText) {
  try {
    const payload = JSON.parse(String(payloadText || "{}"));
    return String(payload.contentPreview ?? "");
  } catch {
    return "";
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { configPath, config } = loadOpenClawConfig();
  const target = resolveRuntimeDbTarget(config, options.agent, options.sessionId, options.agentExplicit);
  const dbPath = target.dbPath;

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Runtime DB not found: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath);
  try {
    const latestSessionResolution = resolveLatestSessionId(db);
    const latestSession = target.resolvedSessionId
      ? { session_id: target.resolvedSessionId }
      : latestSessionResolution
        ? { session_id: latestSessionResolution.sessionId }
        : null;

    if (!latestSession?.session_id) {
      throw new Error("No ChaunyOMS session found in runtime DB");
    }

    const latestRun = db.prepare(`
      select id, session_id, created_at, intent, total_budget, selected_tokens, selected_count, rejected_count
      from context_runs
      where session_id = ?
      order by
        case when intent like 'assemble%' then 0 else 1 end,
        created_at desc
      limit 1
    `).get(latestSession.session_id);

    const messageRows = db.prepare(`
      select role, turn_number, substr(content, 1, 240) as preview
      from messages
      where session_id = ?
      order by sequence desc
      limit 300
    `).all(latestSession.session_id);
    const messageLeakRows = messageRows.filter((row) => detectReplayLeak(row.preview));

    const selectedRows = latestRun
      ? db.prepare(`
          select source, authority, token_count, substr(payload_json, 1, 400) as payload
          from retrieval_candidates
          where context_run_id = ? and status = 'selected'
        `).all(latestRun.id)
      : [];
    const selectedLeakRows = selectedRows.filter((row) =>
      row.source === "recent_tail" && detectReplayLeak(extractContentPreview(row.payload)),
    );

    const breakdownRows = latestRun
      ? db.prepare(`
          select source, authority, count(*) as count, sum(token_count) as tokens
          from retrieval_candidates
          where context_run_id = ? and status = 'selected'
          group by source, authority
          order by count(*) desc, sum(token_count) desc
        `).all(latestRun.id)
      : [];

    const summaryStats = db.prepare(`
      select count(*) as summary_count
      from summaries
      where session_id = ?
    `).get(latestSession.session_id);

    const sessionStats = db.prepare(`
      select
        count(*) as messages,
        sum(case when role = 'user' then 1 else 0 end) as user_messages,
        sum(case when role = 'assistant' then 1 else 0 end) as assistant_messages,
        sum(token_count) as total_tokens
      from messages
      where session_id = ?
    `).get(latestSession.session_id);

    const checks = [
      {
        name: "no_replayed_messages_in_raw",
        pass: messageLeakRows.length === 0,
        observed: messageLeakRows.length,
      },
      {
        name: "no_replayed_context_selected_as_recent_tail",
        pass: selectedLeakRows.length === 0,
        observed: selectedLeakRows.length,
      },
      {
        name: "model_budget_is_not_stuck_at_32k",
        pass: Number(latestRun?.total_budget ?? 0) > 32000,
        observed: Number(latestRun?.total_budget ?? 0),
      },
      {
        name: "session_has_live_context_run",
        pass: Boolean(latestRun?.id),
        observed: latestRun?.id ?? null,
      },
    ];

    const report = {
      configPath,
      dbPath,
      agent: target.agent,
      requestedAgent: options.agent,
      requestedSessionSelector: options.sessionId ?? null,
      resolvedSessionId: target.resolvedSessionId ?? latestSession.session_id,
      resolvedSessionKey: target.resolvedSessionKey ?? null,
      sessionResolutionSource: target.resolutionSource ?? latestSessionResolution?.source ?? null,
      ok: checks.every((check) => check.pass),
      sessionId: latestSession.session_id,
      latestRun: latestRun
        ? {
            id: latestRun.id,
            createdAt: latestRun.created_at,
            intent: latestRun.intent,
            totalBudget: Number(latestRun.total_budget ?? 0),
            selectedTokens: Number(latestRun.selected_tokens ?? 0),
            selectedCount: Number(latestRun.selected_count ?? 0),
            rejectedCount: Number(latestRun.rejected_count ?? 0),
          }
        : null,
      sessionStats: {
        messages: Number(sessionStats.messages ?? 0),
        userMessages: Number(sessionStats.user_messages ?? 0),
        assistantMessages: Number(sessionStats.assistant_messages ?? 0),
        totalTokens: Number(sessionStats.total_tokens ?? 0),
        summaries: Number(summaryStats.summary_count ?? 0),
      },
      selectedBreakdown: breakdownRows.map((row) => ({
        source: row.source,
        authority: row.authority,
        count: Number(row.count ?? 0),
        tokens: Number(row.tokens ?? 0),
      })),
      checks,
      failures: checks.filter((check) => !check.pass),
      messageLeakExamples: messageLeakRows.slice(0, 5).map((row) => ({
        role: row.role,
        turnNumber: Number(row.turn_number ?? 0),
        preview: String(row.preview ?? ""),
      })),
      selectedLeakExamples: selectedLeakRows.slice(0, 5).map((row) => ({
        source: row.source,
        authority: row.authority,
        preview: extractContentPreview(row.payload).slice(0, 180),
      })),
    };

    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main();
