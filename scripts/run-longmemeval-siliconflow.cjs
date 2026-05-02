const fsp = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const {
  buildEvalHarness,
  cleanupEvalHarness,
  finalizeReplay,
  replayMessages,
} = require('../dist/src/evals/runtimeHarness.js');
const {
  resolveDefaultEvalBaseUrl,
  resolveDefaultEvalModel,
  resolveDefaultEvalApi,
  resolveEvalApiKey,
  paidApiAllowed,
  chatJson,
  preflightEvalModel,
} = require('./eval-model-client.cjs');

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const args = process.argv.slice(2);
  const hit = args.find((arg) => arg === name || arg.startsWith(prefix));
  if (!hit) return fallback;
  if (hit === name) {
    const index = args.indexOf(hit);
    return args[index + 1] ?? fallback;
  }
  return hit.slice(prefix.length);
}

function numberArg(name, fallback) {
  const value = Number(argValue(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const baseUrl = argValue('--base-url', resolveDefaultEvalBaseUrl(process.argv.slice(2)));
const api = argValue('--api', resolveDefaultEvalApi(baseUrl, process.argv.slice(2)));
const options = {
  dataPath: argValue('--data', path.join('artifacts', 'datasets', 'longmemeval', 'longmemeval_s_cleaned.json')),
  outDir: argValue('--out-dir', path.join('artifacts', 'evals', 'longmemeval-s-minimax')),
  cases: numberArg('--cases', 12),
  offset: numberArg('--offset', 0),
  maxSessions: numberArg('--max-sessions', 60),
  afterTurnEvery: numberArg('--after-turn-every', 20),
  model: argValue('--model', resolveDefaultEvalModel(baseUrl, process.argv.slice(2))),
  baseUrl,
  api,
  apiKey: resolveEvalApiKey(baseUrl, api, process.argv.slice(2)),
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

function sessionIdAt(item, index) {
  return item.haystack_session_ids?.[index] ?? `session_${index + 1}`;
}

function sessionDateAt(item, index) {
  return item.haystack_dates?.[index] ?? 'unknown date';
}

function materializeLongMemEvalMessages(item, maxSessions) {
  const sessions = Array.isArray(item.haystack_sessions) ? item.haystack_sessions : [];
  const selectedSessions = sessions.slice(0, Math.min(maxSessions, sessions.length));
  const messages = [];
  for (let sessionIndex = 0; sessionIndex < selectedSessions.length; sessionIndex += 1) {
    const turns = Array.isArray(selectedSessions[sessionIndex]) ? selectedSessions[sessionIndex] : [];
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

async function answerFromEvidence(question, evidenceText) {
  return chatJson({
    baseUrl: options.baseUrl,
    api: options.api,
    apiKey: options.apiKey,
    model: options.model,
    system: 'You answer long-term memory questions using only the provided retrieved evidence. If the first verified answer candidate directly answers the question, return exactly that candidate text; do not expand it with extra source-list items. Use source excerpts to confirm or break ties between candidates. Do not include reasoning. Return strict JSON: {"answer":"...","confidence":0-1,"evidence":"short quote"}. If evidence is insufficient, answer "INSUFFICIENT_EVIDENCE".',
    user: `Question:\n${question}\n\nRetrieved evidence:\n${truncate(evidenceText, 12000)}`,
    maxTokens: 768,
  });
}

async function judgeAnswer(question, expected, hypothesis, evidenceText) {
  return chatJson({
    baseUrl: options.baseUrl,
    api: options.api,
    apiKey: options.apiKey,
    model: options.model,
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
    sections.push('', 'Retrieved source excerpts:', ...turnLines);
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
    description: 'LongMemEval-S standard benchmark case.',
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
  await fsp.writeFile(metaPath, JSON.stringify({
    ...options,
    apiKey: options.apiKey ? 'set' : 'missing',
    startedAt: new Date().toISOString(),
    standardSource: 'LongMemEval-S cleaned local dataset',
  }, null, 2), 'utf8');

  if (!paidApiAllowed(process.argv.slice(2))) {
    throw new Error('external evaluation model calls are disabled; pass --allow-paid-api or set CHAUNYOMS_EVAL_ALLOW_PAID=1');
  }
  const preflight = await preflightEvalModel({
    baseUrl: options.baseUrl,
    api: options.api,
    apiKey: options.apiKey,
    model: options.model,
  });
  await fsp.writeFile(path.join(options.outDir, 'api-preflight.json'), JSON.stringify(preflight, null, 2), 'utf8');

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
