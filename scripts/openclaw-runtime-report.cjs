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
  const dataDir = config?.plugins?.entries?.chaunyoms?.config?.dataDir;
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new Error("ChaunyOMS dataDir is missing from ~/.openclaw/openclaw.json");
  }
  return dataDir;
}

function resolveRuntimeDbTarget(config, agent, sessionId, agentExplicit) {
  const dataDir = resolveDataDir(config);
  if (sessionId && !agentExplicit) {
    const inferred = findRuntimeDbTargetForSession(dataDir, agent, sessionId);
    if (inferred) {
      return inferred;
    }
  }
  return {
    agent,
    dbPath: path.join(dataDir, "agents", agent, "chaunyoms-runtime.sqlite"),
  };
}

function findRuntimeDbTargetForSession(dataDir, preferredAgent, sessionId) {
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
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const hit = db.prepare(`
        select 1 as found from context_runs where session_id = ?
        union all
        select 1 as found from messages where session_id = ?
        limit 1
      `).get(sessionId, sessionId);
      if (hit) {
        return { agent, dbPath };
      }
    } catch {
      // Keep scanning other agent stores.
    } finally {
      db?.close();
    }
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
    const counts = db.prepare(`
      select
        (select count(*) from messages) as messages,
        (select count(*) from summaries) as summaries,
        (select count(*) from memories) as memories,
        (select count(*) from assets) as assets,
        (select count(*) from context_runs) as context_runs,
        (select count(*) from retrieval_candidates) as retrieval_candidates
    `).get();

    const leakRows = db.prepare(`
      select id, session_id, role, turn_number, substr(content, 1, 240) as preview
      from messages
      order by sequence desc
      limit 400
    `).all();
    const leakedMessages = leakRows.filter((row) => detectLeak(row.preview));

    const latestRun = options.sessionId
      ? db.prepare(`
          select id, session_id, created_at, intent, total_budget, selected_tokens, selected_count, rejected_count
          from context_runs
          where session_id = ?
          order by created_at desc
          limit 1
        `).get(options.sessionId)
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

    const sessionId = options.sessionId ?? latestRun?.session_id;
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
      requestedSessionId: options.sessionId ?? null,
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
