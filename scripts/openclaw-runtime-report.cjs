const fs = require("node:fs");
const path = require("node:path");

const { DatabaseSync } = require("node:sqlite");

const LEAK_PATTERNS = [
  /^\[durable_memory:[^\]]+\]/i,
  /^\[ChaunyOMS recalled memory\b[^\]]*\]/i,
  /^\[oms_recall_guidance\]/i,
  /^\[shared_cognition\]/i,
  /^\[navigation\]/i,
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

function normalizeBreakdown(rows) {
  return rows.map((row) => ({
    source: row.source,
    authority: row.authority,
    count: Number(row.count ?? 0),
    tokens: Number(row.tokens ?? 0),
  }));
}

function detectLeak(text) {
  return LEAK_PATTERNS.some((pattern) => pattern.test(String(text || "").trim()));
}

function tableExists(db, tableName) {
  const row = db.prepare(`
    select 1 as found
    from sqlite_master
    where type = 'table' and name = ?
    limit 1
  `).get(tableName);
  return Boolean(row?.found);
}

function countTable(db, tableName) {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  return Number(db.prepare(`select count(*) as count from ${tableName}`).get()?.count ?? 0);
}

function isReplayLeakCandidate(row, preview) {
  const source = String(row.source || "").trim().toLowerCase();
  if (!["recent_tail", "raw_exact_search"].includes(source)) {
    return false;
  }
  return detectLeak(preview);
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
    const counts = {
      messages: countTable(db, "messages"),
      summaries: countTable(db, "summaries"),
      memories: countTable(db, "memory_items") || countTable(db, "memories"),
      assets: countTable(db, "assets"),
      context_runs: countTable(db, "context_runs"),
      retrieval_candidates: countTable(db, "retrieval_candidates"),
    };

    const leakRows = db.prepare(`
      select id, session_id, role, turn_number, substr(content, 1, 240) as preview
      from messages
      order by sequence desc
      limit 400
    `).all();
    const leakedMessages = leakRows.filter((row) => detectLeak(row.preview));

    const latestSessionResolution = resolveLatestSessionId(db);
    const selectedSessionId =
      target.resolvedSessionId ??
      latestSessionResolution?.sessionId ??
      null;

    const latestRun = selectedSessionId
      ? db.prepare(`
          select id, session_id, created_at, intent, total_budget, selected_tokens, selected_count, rejected_count
          from context_runs
          where session_id = ?
          order by created_at desc
          limit 1
        `).get(selectedSessionId)
      : db.prepare(`
          select id, session_id, created_at, intent, total_budget, selected_tokens, selected_count, rejected_count
          from context_runs
          order by created_at desc
          limit 1
        `).get();

    let selectedBreakdown = [];
    let selectedLeakCount = 0;
    let selectedLeakExamples = [];
    if (latestRun?.id) {
      selectedBreakdown = normalizeBreakdown(db.prepare(`
        select source, authority, count(*) as count, sum(token_count) as tokens
        from retrieval_candidates
        where context_run_id = ? and status = 'selected'
        group by source, authority
        order by count(*) desc, sum(token_count) desc
      `).all(latestRun.id));

      const selectedRows = db.prepare(`
        select source, authority, substr(payload_json, 1, 400) as payload
        from retrieval_candidates
        where context_run_id = ? and status = 'selected'
      `).all(latestRun.id);
      const leakingSelected = selectedRows.filter((row) => {
        const preview = extractContentPreview(row.payload);
        return isReplayLeakCandidate(row, preview);
      });
      selectedLeakCount = leakingSelected.length;
      selectedLeakExamples = leakingSelected.slice(0, 5).map((row) => ({
        source: row.source,
        authority: row.authority,
        preview: extractContentPreview(row.payload).slice(0, 180),
      }));
    }

    const sessionId = selectedSessionId ?? latestRun?.session_id ?? null;
    const sessionSummary = sessionId
      ? db.prepare(`
          select
            count(*) as messages,
            sum(case when role = 'user' then 1 else 0 end) as user_messages,
            sum(case when role = 'assistant' then 1 else 0 end) as assistant_messages,
            sum(token_count) as total_tokens
          from messages
          where session_id = ?
        `).get(sessionId)
      : null;

    const report = {
      configPath,
      dbPath,
      agent: target.agent,
      requestedAgent: options.agent,
      requestedSessionSelector: options.sessionId ?? null,
      resolvedSessionId: target.resolvedSessionId ?? sessionId,
      resolvedSessionKey: target.resolvedSessionKey ?? null,
      sessionResolutionSource: target.resolutionSource ?? latestSessionResolution?.source ?? null,
      counts: {
        messages: Number(counts.messages ?? 0),
        summaries: Number(counts.summaries ?? 0),
        memories: Number(counts.memories ?? 0),
        assets: Number(counts.assets ?? 0),
        contextRuns: Number(counts.context_runs ?? 0),
        retrievalCandidates: Number(counts.retrieval_candidates ?? 0),
      },
      leakedMessageCount: leakedMessages.length,
      leakedMessageExamples: leakedMessages.slice(0, 5).map((row) => ({
        sessionId: row.session_id,
        role: row.role,
        turnNumber: Number(row.turn_number ?? 0),
        preview: String(row.preview ?? ""),
      })),
      latestContextRun: latestRun
        ? {
            id: latestRun.id,
            sessionId: latestRun.session_id,
            createdAt: latestRun.created_at,
            intent: latestRun.intent,
            totalBudget: Number(latestRun.total_budget ?? 0),
            selectedTokens: Number(latestRun.selected_tokens ?? 0),
            selectedCount: Number(latestRun.selected_count ?? 0),
            rejectedCount: Number(latestRun.rejected_count ?? 0),
            selectedBreakdown,
            selectedLeakCount,
            selectedLeakExamples,
          }
        : null,
      sessionSummary: sessionSummary
        ? {
            sessionId,
            messages: Number(sessionSummary.messages ?? 0),
            userMessages: Number(sessionSummary.user_messages ?? 0),
            assistantMessages: Number(sessionSummary.assistant_messages ?? 0),
            totalTokens: Number(sessionSummary.total_tokens ?? 0),
          }
        : null,
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    db.close();
  }
}

function extractContentPreview(payloadText) {
  try {
    const payload = JSON.parse(String(payloadText || "{}"));
    return String(payload.contentPreview ?? "");
  } catch {
    return "";
  }
}

main();
