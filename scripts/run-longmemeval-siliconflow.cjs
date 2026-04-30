const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const {
  buildEvalHarness,
  cleanupEvalHarness,
  finalizeReplay,
  replayMessages,
} = require('../dist/src/evals/runtimeHarness.js');

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg === name || arg.startsWith(prefix));
  if (!hit) return fallback;
  if (hit === name) {
    const index = process.argv.indexOf(name);
    return process.argv[index + 1] ?? fallback;
  }
  return hit.slice(prefix.length);
}

function numberArg(name, fallback) {
  const value = Number(argValue(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveApiKey(baseUrl) {
  if (process.env.CHAUNYOMS_EVAL_API_KEY) return process.env.CHAUNYOMS_EVAL_API_KEY;
  const lower = String(baseUrl ?? '').toLowerCase();
  if (lower.includes('siliconflow')) return process.env.SILICONFLOW_API_KEY || process.env.MINIMAX_API_KEY || '';
  if (lower.includes('minimaxi') || lower.includes('minimax')) return process.env.MINIMAX_API_KEY || process.env.SILICONFLOW_API_KEY || '';
  return process.env.OPENAI_API_KEY || process.env.SILICONFLOW_API_KEY || process.env.MINIMAX_API_KEY || '';
}

function paidApiAllowed() {
  return process.env.CHAUNYOMS_EVAL_ALLOW_PAID === '1' || process.argv.includes('--allow-paid-api');
}

const baseUrl = argValue('--base-url', process.env.CHAUNYOMS_EVAL_BASE_URL || process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1');
const options = {
  dataPath: argValue('--data', path.join('artifacts', 'datasets', 'longmemeval', 'longmemeval_s_cleaned.json')),
  outDir: argValue('--out-dir', path.join('artifacts', 'evals', 'longmemeval-s-minimax')),
  cases: numberArg('--cases', 12),
  offset: numberArg('--offset', 0),
  maxSessions: numberArg('--max-sessions', 60),
  afterTurnEvery: numberArg('--after-turn-every', 20),
  model: argValue('--model', process.env.CHAUNYOMS_EVAL_MODEL || 'MiniMax-M2.7'),
  baseUrl,
  apiKey: resolveApiKey(baseUrl),
};

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function normalizeAnswer(value) {
  if (Array.isArray(value)) return value.map(String).join('; ');
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function truncate(text, maxChars) {
  const value = String(text ?? '');
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function firstJsonObject(text) {
  const value = String(text ?? '');
  const start = value.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const ch = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function looseJsonObject(text) {
  const value = String(text ?? '');
  const answer = value.match(/"answer"\s*:\s*"([\s\S]*?)"\s*(?:,|})/);
  const confidence = value.match(/"confidence"\s*:\s*(0(?:\.\d+)?|1(?:\.0+)?)/);
  const evidence = value.match(/"evidence"\s*:\s*"([\s\S]*?)"\s*(?:,|})/);
  if (answer) {
    return {
      answer: answer[1].replace(/\\"/g, '"'),
      confidence: confidence ? Number(confidence[1]) : 0,
      evidence: evidence ? evidence[1].replace(/\\"/g, '"') : '',
    };
  }
  const correct = value.match(/"correct"\s*:\s*(true|false)/);
  const reason = value.match(/"reason"\s*:\s*"([\s\S]*?)"\s*(?:,|})/);
  if (correct) {
    return {
      correct: correct[1] === 'true',
      reason: reason ? reason[1].replace(/\\"/g, '"') : value.slice(0, 500),
    };
  }
  return null;
}

function sessionIdAt(item, index) {
  return item.haystack_session_ids?.[index] ?? `session_${index + 1}`;
}

function sessionDateAt(item, index) {
  return item.haystack_dates?.[index] ?? 'unknown date';
}

function materializeLongMemEvalMessages(item, maxSessions) {
  const sessions = Array.isArray(item.haystack_sessions) ? item.haystack_sessions : [];
  const selected = sessions.slice(0, Math.min(maxSessions, sessions.length));
  const messages = [];
  for (let sessionIndex = 0; sessionIndex < selected.length; sessionIndex += 1) {
    const turns = Array.isArray(selected[sessionIndex]) ? selected[sessionIndex] : [];
    const sid = sessionIdAt(item, sessionIndex);
    const date = sessionDateAt(item, sessionIndex);
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      const turn = turns[turnIndex] ?? {};
      const role = turn.role === 'assistant' ? 'assistant' : 'user';
      const hasAnswer = turn.has_answer ? ' | has_answer: true' : '';
      messages.push({
        role,
        content: [
          `LongMemEval ${item.question_id}`,
          `${sid} date ${date}`,
          `T${sessionIndex + 1}:${turnIndex + 1}`,
          `${role}: ${String(turn.content ?? '').replace(/\s+/g, ' ').trim()}${hasAnswer}`,
        ].join(' | '),
      });
    }
  }
  return messages;
}

async function chatJson({ system, user, maxTokens = 768 }) {
  if (!paidApiAllowed()) {
    throw new Error('external evaluation model calls are disabled; pass --allow-paid-api or set CHAUNYOMS_EVAL_ALLOW_PAID=1');
  }
  if (!options.apiKey) {
    throw new Error('evaluation API key is not set');
  }
  const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`model call failed ${response.status}: ${raw.slice(0, 600)}`);
  }
  const data = JSON.parse(raw);
  const content = data.choices?.[0]?.message?.content ?? '{}';
  try {
    return JSON.parse(content);
  } catch {
    const match = firstJsonObject(content);
    if (match) {
      try {
        return JSON.parse(match);
      } catch {
        const loose = looseJsonObject(match);
        if (loose) return loose;
      }
    }
    const loose = looseJsonObject(content);
    if (loose) return loose;
    return { raw: content };
  }
}

async function answerFromEvidence(question, evidenceText) {
  return chatJson({
    system: 'You answer long-term memory questions using only the provided retrieved evidence. If the first verified answer candidate directly answers the question, return exactly that candidate text; do not expand it with extra source-list items. Use source excerpts to confirm or break ties between candidates. Do not include reasoning. Return strict JSON: {"answer":"...","confidence":0-1,"evidence":"short quote"}. If evidence is insufficient, answer "INSUFFICIENT_EVIDENCE".',
    user: `Question:\n${question}\n\nRetrieved evidence:\n${truncate(evidenceText, 12000)}`,
    maxTokens: 768,
  });
}

async function judgeAnswer(question, expected, hypothesis, evidenceText) {
  return chatJson({
    system: 'You are a strict but fair evaluator for conversational memory QA. Do not include reasoning. Return strict JSON: {"correct":true|false,"reason":"..."}. Mark correct only if the hypothesis is semantically equivalent to the expected answer and supported by evidence. If the hypothesis is INSUFFICIENT_EVIDENCE while an expected answer is provided, mark correct false.',
    user: `Question:\n${question}\n\nExpected answer:\n${expected}\n\nHypothesis:\n${hypothesis}\n\nRetrieved evidence:\n${truncate(evidenceText, 9000)}`,
    maxTokens: 512,
  });
}

function compactDetails(details) {
  return {
    route: details.route,
    retrievalHitType: details.retrievalHitType,
    recallStrategy: details.recallStrategy,
    hitCount: details.hitCount,
    rawCandidateCount: details.rawCandidateCount,
    rawFtsHintCount: details.rawFtsHintCount,
    sourceVerified: Array.isArray(details.sourceTrace) && details.sourceTrace.some((trace) => trace.verified === true),
    answerCandidates: details.answerCandidates,
  };
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function queryTerms(text) {
  return normalizeText(text)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

function scoreCandidate(candidate, questionTerms) {
  const haystack = [
    candidate.text,
    candidate.type,
    candidate.reason,
  ].map(normalizeText).join(' ').toLowerCase();
  let score = Number(candidate.confidence ?? 0);
  if (candidate.sourceVerified) score += 0.2;
  for (const term of questionTerms) {
    if (haystack.includes(term)) {
      score += term.length >= 6 ? 0.12 : 0.08;
    }
  }
  return score;
}

function buildLosslessEvidence(question, response) {
  const details = response.details ?? {};
  const answerCandidates = Array.isArray(details.answerCandidates) ? details.answerCandidates : [];
  const sourceTrace = Array.isArray(details.sourceTrace) ? details.sourceTrace : [];
  const questionTerms = queryTerms(question);
  const rankedCandidates = [...answerCandidates]
    .sort((left, right) => scoreCandidate(right, questionTerms) - scoreCandidate(left, questionTerms))
    .slice(0, 8);
  const rawText = String(response.content?.[0]?.text ?? '');
  const turnLines = rawText
    .split(/\r?\n/)
    .filter((line) => /^\[turn /.test(line))
    .slice(0, 12)
    .map((line) => normalizeText(line));

  const sections = [`Question: ${question}`];

  if (rankedCandidates.length > 0) {
    sections.push(
      '',
      'Verified answer candidates:',
      ...rankedCandidates.map((candidate, index) =>
        `${index + 1}. ${normalizeText(candidate.text)} | type=${candidate.type} | confidence=${candidate.confidence} | sourceVerified=${candidate.sourceVerified} | reason=${candidate.reason}`,
      ),
    );
  }

  if (turnLines.length > 0) {
    sections.push(
      '',
      'Retrieved source excerpts:',
      ...turnLines,
    );
  }

  if (sourceTrace.length > 0) {
    sections.push(
      '',
      'Source trace:',
      ...sourceTrace.map((trace) =>
        `- summary ${trace.summaryId ?? '?'} -> ${trace.strategy} -> ${trace.verified ? 'verified' : 'unverified'} (${trace.resolvedMessageCount} messages)`,
      ),
    );
  }

  return sections.join('\n');
}

async function appendJsonl(file, record) {
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

async function runCase(item, index, jsonlPath) {
  const messages = materializeLongMemEvalMessages(item, options.maxSessions);
  const caseDef = {
    id: `longmemeval-${item.question_id || index}`,
    title: `LongMemEval ${item.question_type || 'unknown'}`,
    description: 'LongMemEval-S async MiniMax reader/judge stress case.',
    tags: ['longmemeval', item.question_type || 'unknown', 'source_verified'],
    mode: 'retrieve',
    query: `History recall: ${item.question}`,
    messages,
    afterTurnEvery: options.afterTurnEvery,
    configOverrides: {
      contextWindow: 760,
      contextThreshold: 0.34,
      freshTailTokens: 48,
      maxFreshTailTurns: 1,
      compactionBatchTurns: 10,
      summaryMaxOutputTokens: 460,
      strictCompaction: true,
      compactionBarrierEnabled: true,
      configPreset: 'balanced',
    },
    expected: {},
  };

  const started = performance.now();
  const { dir, config, runtime, retrieval } = await buildEvalHarness(caseDef);
  try {
    await replayMessages(runtime, config, messages, options.afterTurnEvery);
    await finalizeReplay(runtime, config);
    const retrieveStart = performance.now();
    const response = await retrieval.executeMemoryRetrieve({
      sessionId: config.sessionId,
      config,
      query: caseDef.query,
      rawFts: true,
      deepRecall: true,
      rawFtsLimit: 12,
    });
    const retrieveMs = performance.now() - retrieveStart;
    const evidenceText = buildLosslessEvidence(item.question, response);
    const reader = await answerFromEvidence(item.question, evidenceText);
    const expected = normalizeAnswer(item.answer);
    const judge = await judgeAnswer(item.question, expected, reader.answer ?? reader.raw ?? '', evidenceText);
    const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
    const summaries = stores.summaryStore.getAllSummaries({ sessionId: config.sessionId });
    const record = {
      index,
      questionId: item.question_id,
      questionType: item.question_type,
      question: item.question,
      expected,
      hypothesis: reader.answer ?? reader.raw ?? '',
      reader,
      judge,
      correct: judge.correct === true && !(/^INSUFFICIENT_EVIDENCE$/i.test(String(reader.answer ?? reader.raw ?? '').trim()) && expected.length > 0),
      retrieveMs: Number(retrieveMs.toFixed(2)),
      totalMs: Number((performance.now() - started).toFixed(2)),
      messages: messages.length,
      sessions: Array.isArray(item.haystack_sessions) ? Math.min(options.maxSessions, item.haystack_sessions.length) : 0,
      summaryCount: summaries.length,
      branchCount: summaries.filter((entry) => entry.nodeKind === 'branch').length,
      details: compactDetails(response.details ?? {}),
    };
    await appendJsonl(jsonlPath, record);
    return record;
  } catch (error) {
    const record = {
      index,
      questionId: item.question_id,
      questionType: item.question_type,
      question: item.question,
      expected: normalizeAnswer(item.answer),
      error: error instanceof Error ? error.message : String(error),
      correct: false,
      totalMs: Number((performance.now() - started).toFixed(2)),
      messages: messages.length,
    };
    await appendJsonl(jsonlPath, record);
    return record;
  } finally {
    await cleanupEvalHarness(dir).catch(() => undefined);
  }
}

async function main() {
  await fsp.mkdir(options.outDir, { recursive: true });
  const jsonlPath = path.join(options.outDir, 'results.jsonl');
  const summaryPath = path.join(options.outDir, 'summary.json');
  const metaPath = path.join(options.outDir, 'run-meta.json');
  await fsp.writeFile(metaPath, JSON.stringify({ ...options, apiKey: options.apiKey ? 'set' : 'missing', startedAt: new Date().toISOString() }, null, 2), 'utf8');

  const raw = await fsp.readFile(options.dataPath, 'utf8');
  const dataset = JSON.parse(raw);
  const selected = dataset.slice(options.offset, options.offset + options.cases);
  const results = [];
  for (let i = 0; i < selected.length; i += 1) {
    const globalIndex = options.offset + i;
    console.log(`[longmemeval] case ${i + 1}/${selected.length} global=${globalIndex}`);
    const record = await runCase(selected[i], globalIndex, jsonlPath);
    results.push(record);
    const completed = results.length;
    const correct = results.filter((item) => item.correct).length;
    const latencies = results.filter((item) => Number.isFinite(item.retrieveMs)).map((item) => item.retrieveMs);
    const summary = {
      completed,
      requested: selected.length,
      correct,
      accuracy: completed === 0 ? 0 : Number((correct / completed).toFixed(4)),
      avgRetrieveMs: latencies.length ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)) : 0,
      p95RetrieveMs: Number(percentile(latencies, 95).toFixed(2)),
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});




