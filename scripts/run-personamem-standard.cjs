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
  if (hit === name) return args[args.indexOf(hit) + 1] ?? fallback;
  return hit.slice(prefix.length);
}

function numberArg(name, fallback) {
  const value = Number(argValue(name, String(fallback)));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const baseUrl = argValue('--base-url', resolveDefaultEvalBaseUrl(process.argv.slice(2)));
const api = argValue('--api', resolveDefaultEvalApi(baseUrl, process.argv.slice(2)));
const options = {
  questions: argValue('--questions', path.join('artifacts', 'datasets', 'personamem', 'questions_32k.csv')),
  contexts: argValue('--contexts', path.join('artifacts', 'datasets', 'personamem', 'shared_contexts_32k.jsonl')),
  outDir: argValue('--out-dir', path.join('artifacts', 'evals', 'personamem-32k-standard')),
  cases: numberArg('--cases', 0),
  offset: numberArg('--offset', 0),
  afterTurnEvery: numberArg('--after-turn-every', 12),
  model: argValue('--model', resolveDefaultEvalModel(baseUrl, process.argv.slice(2))),
  baseUrl,
  api,
  apiKey: resolveEvalApiKey(baseUrl, api, process.argv.slice(2)),
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() || [];
  return rows
    .filter((currentRow) => currentRow.length === header.length)
    .map((currentRow) => Object.fromEntries(header.map((key, index) => [key, currentRow[index]])));
}

function contextsMap(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    for (const [key, value] of Object.entries(obj)) {
      map.set(key, value);
    }
  }
  return map;
}

function normalizeChoice(value) {
  return String(value ?? '').match(/[A-Da-d]/)?.[0]?.toUpperCase() ?? null;
}

function truncate(text, maxChars) {
  const value = String(text ?? '');
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function materializeMessages(context, endIndex) {
  const cut = Number.isFinite(Number(endIndex)) ? context.slice(0, Number(endIndex)) : context;
  return cut
    .filter((message) => message.role !== 'system')
    .map((message, index) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: `PersonaMem context turn ${index + 1} | ${String(message.content ?? '').replace(/\s+/g, ' ').trim()}`,
    }));
}

async function appendJsonl(file, record) {
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

async function runCase(item, index, ctxMap, jsonlPath) {
  const ctx = ctxMap.get(item.shared_context_id);
  const messages = materializeMessages(Array.isArray(ctx) ? ctx : [], item.end_index_in_shared_context);
  const optionsText = String(item.all_options || '');
  const caseDef = {
    id: `personamem-${item.question_id || index}`,
    title: `PersonaMem ${item.context_length_in_tokens || ''}`,
    description: 'Official PersonaMem MCQ sample using shared context id and end_index_in_shared_context.',
    tags: ['personamem', item.question_type || 'unknown'],
    mode: 'retrieve',
    query: `Personalized preference recall: ${item.user_question_or_message}\nOptions:\n${optionsText}`,
    messages,
    afterTurnEvery: options.afterTurnEvery,
    configOverrides: {
      contextWindow: 900,
      contextThreshold: 0.34,
      freshTailTokens: 64,
      maxFreshTailTurns: 1,
      compactionBatchTurns: 10,
      summaryMaxOutputTokens: 520,
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
      rawFtsLimit: 10,
      retrievalStrength: 'strict',
    });
    const retrieveMs = performance.now() - retrieveStart;
    const evidence = String(response.content?.[0]?.text ?? '');
    const picked = await chatJson({
      baseUrl: options.baseUrl,
      api: options.api,
      apiKey: options.apiKey,
      model: options.model,
      system: 'You are evaluating PersonaMem multiple-choice personalization. Use only retrieved evidence and the listed options. Return strict JSON {"choice":"A|B|C|D"}. If evidence is weak, still choose the best supported option.',
      user: `User message/question:\n${item.user_question_or_message}\n\nOptions from dataset:\n${optionsText}\n\nRetrieved memory evidence:\n${truncate(evidence, 10000)}`,
      maxTokens: 96,
    });
    const choice = normalizeChoice(picked.choice ?? picked.raw);
    const expected = normalizeChoice(item.correct_answer);
    const record = {
      index,
      questionId: item.question_id,
      questionType: item.question_type,
      contextTokens: Number(item.context_length_in_tokens) || null,
      expected,
      choice,
      correct: choice === expected,
      retrieveMs: Number(retrieveMs.toFixed(2)),
      totalMs: Number((performance.now() - started).toFixed(2)),
      messages: messages.length,
      details: {
        route: response.details?.route,
        retrievalHitType: response.details?.retrievalHitType,
        hitCount: response.details?.hitCount,
      },
      picked,
    };
    await appendJsonl(jsonlPath, record);
    return record;
  } catch (error) {
    const record = {
      index,
      questionId: item.question_id,
      error: error instanceof Error ? error.message : String(error),
      correct: false,
      totalMs: Number((performance.now() - started).toFixed(2)),
      messages: messages.length,
    };
    await appendJsonl(jsonlPath, record);
    return record;
  } finally {
    await cleanupEvalHarness(dir).catch(() => {});
  }
}

async function main() {
  await fsp.mkdir(options.outDir, { recursive: true });
  const jsonlPath = path.join(options.outDir, 'results.jsonl');
  const summaryPath = path.join(options.outDir, 'summary.json');
  await fsp.writeFile(path.join(options.outDir, 'run-meta.json'), JSON.stringify({
    ...options,
    apiKey: options.apiKey ? 'set' : 'missing',
    startedAt: new Date().toISOString(),
    standardSource: 'bowen-upenn/PersonaMem',
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

  const questions = parseCsv(await fsp.readFile(options.questions, 'utf8'));
  const ctxMap = contextsMap(await fsp.readFile(options.contexts, 'utf8'));
  const selected = questions.slice(options.offset, options.cases > 0 ? options.offset + options.cases : undefined);
  const results = [];
  for (let index = 0; index < selected.length; index += 1) {
    const globalIndex = options.offset + index;
    console.log(`[personamem] case ${index + 1}/${selected.length} global=${globalIndex}`);
    const record = await runCase(selected[index], globalIndex, ctxMap, jsonlPath);
    results.push(record);
    const correct = results.filter((result) => result.correct).length;
    const latencies = results.filter((result) => Number.isFinite(result.retrieveMs)).map((result) => result.retrieveMs);
    const summary = {
      completed: results.length,
      requested: selected.length,
      correct,
      accuracy: Number((correct / results.length).toFixed(4)),
      avgRetrieveMs: latencies.length ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2)) : 0,
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
