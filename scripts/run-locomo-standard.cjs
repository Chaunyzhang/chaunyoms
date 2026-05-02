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
const {
  resolveDefaultEvalBaseUrl,
  resolveDefaultEvalModel,
  resolveDefaultEvalApi,
  resolveEvalApiKey,
  paidApiAllowed,
  chatJson,
  preflightEvalModel,
} = require('./eval-model-client.cjs');

const CATEGORY_NAMES = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
};

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
  dataPath: argValue('--data', path.join('artifacts', 'datasets', 'locomo', 'locomo10.json')),
  outDir: argValue('--out-dir', path.join('artifacts', 'evals', 'locomo-standard')),
  cases: numberArg('--cases', 0),
  offset: numberArg('--offset', 0),
  conversations: argValue('--conversations', '0,1,2,3,4,5,6,7,8,9').split(',').map((item) => Number(item.trim())).filter(Number.isFinite),
  categories: argValue('--categories', '1,2,3,4').split(',').map((item) => Number(item.trim())).filter(Number.isFinite),
  afterTurnEvery: numberArg('--after-turn-every', 20),
  rawFtsLimit: numberArg('--raw-fts-limit', 200),
  model: argValue('--model', resolveDefaultEvalModel(baseUrl, process.argv.slice(2))),
  baseUrl,
  api,
  apiKey: resolveEvalApiKey(baseUrl, api, process.argv.slice(2)),
};

function normalize(value) {
  if (Array.isArray(value)) return value.map(String).join('; ');
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(text, maxChars) {
  const value = String(text ?? '');
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function preprocessAnswer(category, answer) {
  const value = normalize(answer);
  return category === 3 && value.includes(';') ? value.split(';')[0].trim() : value;
}

function materializeConversation(conv, conversationIndex) {
  const messages = [];
  const sessions = Object.keys(conv)
    .filter((key) => /^session_\d+$/.test(key))
    .sort((left, right) => Number(left.split('_')[1]) - Number(right.split('_')[1]));
  for (const sessionKey of sessions) {
    const sessionNumber = Number(sessionKey.split('_')[1]);
    const date = conv[`session_${sessionNumber}_date_time`] ?? 'unknown date';
    for (const turn of conv[sessionKey] ?? []) {
      const speaker = String(turn.speaker ?? '');
      const role = speaker === conv.speaker_b ? 'assistant' : 'user';
      messages.push({
        role,
        content: [
          `LOCOMO conv${conversationIndex}`,
          `${sessionKey} date ${date}`,
          `dia_id ${turn.dia_id}`,
          `${speaker}: ${String(turn.text ?? '').replace(/\s+/g, ' ').trim()}`,
        ].join(' | '),
      });
    }
  }
  return messages;
}

function evidenceLookup(data) {
  const map = new Map();
  for (let convIndex = 0; convIndex < data.length; convIndex += 1) {
    const conv = data[convIndex].conversation;
    for (const sessionKey of Object.keys(conv).filter((key) => /^session_\d+$/.test(key))) {
      const date = conv[`${sessionKey}_date_time`] ?? 'unknown date';
      for (const turn of conv[sessionKey] ?? []) {
        map.set(`${convIndex}:${turn.dia_id}`, `[${turn.dia_id} | ${date}] ${turn.speaker}: ${turn.text}`);
      }
    }
  }
  return map;
}

function buildEvidence(question, response) {
  const details = response.details ?? {};
  const lines = [`Question: ${question}`];
  const candidates = Array.isArray(details.answerCandidates) ? details.answerCandidates.slice(0, 20) : [];
  if (candidates.length > 0) {
    lines.push('', 'Verified answer candidates:');
    for (const [index, candidate] of candidates.entries()) {
      lines.push(`${index + 1}. ${normalize(candidate.text)} | type=${candidate.type} | confidence=${candidate.confidence} | sourceVerified=${candidate.sourceVerified}`);
    }
  }
  const rawLines = String(response.content?.[0]?.text ?? '')
    .split(/\r?\n/)
    .filter((line) => /^\[turn /.test(line))
    .slice(0, 60)
    .map(normalize);
  if (rawLines.length > 0) {
    lines.push('', 'Retrieved source excerpts:', ...rawLines);
  }
  return lines.join('\n');
}

async function answerFromEvidence(question, evidenceText) {
  return chatJson({
    baseUrl: options.baseUrl,
    api: options.api,
    apiKey: options.apiKey,
    model: options.model,
    system: 'You answer LOCOMO long-term conversational memory questions using only retrieved evidence. Do not include reasoning. Return strict JSON {"answer":"...","confidence":0-1,"evidence":"short quote"}. If evidence is insufficient, answer "INSUFFICIENT_EVIDENCE".',
    user: `Question:\n${question}\n\nRetrieved evidence:\n${truncate(evidenceText, 14000)}`,
    maxTokens: 512,
  });
}

async function judgeAnswer({ category, question, expected, hypothesis, evidenceText, goldEvidence }) {
  return chatJson({
    baseUrl: options.baseUrl,
    api: options.api,
    apiKey: options.apiKey,
    model: options.model,
    system: 'You are evaluating conversational AI memory recall. Return JSON only. Be strict but fair: partial credit is acceptable for list answers if at least one correct gold item is given; evidence may support accepting a semantically equivalent answer.',
    user: [
      'Label the generated answer as CORRECT or WRONG.',
      `Category: ${category} (${CATEGORY_NAMES[category] ?? 'unknown'})`,
      `Question: ${question}`,
      `Gold answer: ${preprocessAnswer(category, expected)}`,
      `Generated answer: ${hypothesis}`,
      '',
      `Gold evidence excerpts:\n${truncate(goldEvidence || 'not provided', 3000)}`,
      '',
      `Retrieved evidence used by system:\n${truncate(evidenceText, 9000)}`,
      '',
      'Return strict JSON {"correct":true|false,"reason":"..."}',
    ].join('\n'),
    maxTokens: 512,
  });
}

async function appendJsonl(file, record) {
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

function selectQuestions(data) {
  const records = [];
  for (const convIndex of options.conversations) {
    const conv = data[convIndex];
    if (!conv) continue;
    for (let qaIndex = 0; qaIndex < conv.qa.length; qaIndex += 1) {
      const qa = conv.qa[qaIndex];
      if (!options.categories.includes(Number(qa.category))) continue;
      records.push({ convIndex, qaIndex, qa });
    }
  }
  return records.slice(options.offset, options.cases > 0 ? options.offset + options.cases : undefined);
}

function compactDetails(details) {
  return {
    route: details.route,
    retrievalHitType: details.retrievalHitType,
    recallStrategy: details.recallStrategy,
    hitCount: details.hitCount,
    rawCandidateCount: details.rawCandidateCount,
    rawFtsHintCount: details.rawFtsHintCount,
    answerCandidates: details.answerCandidates,
  };
}

async function main() {
  await fsp.mkdir(options.outDir, { recursive: true });
  const jsonlPath = path.join(options.outDir, 'results.jsonl');
  const summaryPath = path.join(options.outDir, 'summary.json');
  await fsp.writeFile(path.join(options.outDir, 'run-meta.json'), JSON.stringify({
    ...options,
    apiKey: options.apiKey ? 'set' : 'missing',
    startedAt: new Date().toISOString(),
    standardSource: 'snap-research/locomo locomo10.json; protocol aligned with mem0ai/memory-benchmarks LOCOMO categories 1,2,3,4',
    note: 'OMS-native adapter: official LOCOMO-10 full dataset/questions/categories, OpenAI-compatible answerer/judge, OMS retrieval as system under test.',
  }, null, 2), 'utf8');

  const data = JSON.parse(await fsp.readFile(options.dataPath, 'utf8'));
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
  const selected = selectQuestions(data);
  const byConv = new Map();
  for (const item of selected) {
    if (!byConv.has(item.convIndex)) byConv.set(item.convIndex, []);
    byConv.get(item.convIndex).push(item);
  }
  const evLookup = evidenceLookup(data);
  const results = [];

  for (const [convIndex, items] of byConv.entries()) {
    const messages = materializeConversation(data[convIndex].conversation, convIndex);
    const caseDef = {
      id: `locomo-conv${convIndex}`,
      title: `LOCOMO conversation ${convIndex}`,
      description: 'Official LOCOMO-10 conversation replay for OMS-native standard benchmark adapter.',
      tags: ['locomo', 'standard'],
      mode: 'retrieve',
      query: 'LOCOMO conversation replay',
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
    const { dir, config, runtime, retrieval } = await buildEvalHarness(caseDef);
    try {
      await replayMessages(runtime, config, messages, options.afterTurnEvery);
      await finalizeReplay(runtime, config);
      for (const item of items) {
        const started = performance.now();
        const qid = `conv${item.convIndex}_q${item.qaIndex}`;
        console.log(`[locomo] ${results.length + 1}/${selected.length} ${qid}`);
        try {
          const retrieveStart = performance.now();
          const response = await retrieval.executeMemoryRetrieve({
            sessionId: config.sessionId,
            config,
            query: `LOCOMO memory question: ${item.qa.question}`,
            rawFts: true,
            deepRecall: true,
            rawFtsLimit: options.rawFtsLimit,
            retrievalStrength: 'strict',
          });
          const retrieveMs = performance.now() - retrieveStart;
          const evidenceText = buildEvidence(item.qa.question, response);
          const goldEvidence = (item.qa.evidence ?? [])
            .map((ref) => evLookup.get(`${item.convIndex}:${ref}`))
            .filter(Boolean)
            .join('\n');
          const reader = await answerFromEvidence(item.qa.question, evidenceText);
          const hypothesis = reader.answer ?? reader.raw ?? '';
          const judge = await judgeAnswer({
            category: Number(item.qa.category),
            question: item.qa.question,
            expected: normalize(item.qa.answer),
            hypothesis,
            evidenceText,
            goldEvidence,
          });
          const record = {
            questionId: qid,
            conversationIndex: item.convIndex,
            qaIndex: item.qaIndex,
            category: Number(item.qa.category),
            categoryName: CATEGORY_NAMES[Number(item.qa.category)] ?? 'unknown',
            question: item.qa.question,
            expected: normalize(item.qa.answer),
            hypothesis,
            reader,
            judge,
            correct: judge.correct === true && !/^INSUFFICIENT_EVIDENCE$/i.test(String(hypothesis).trim()),
            retrieveMs: Number(retrieveMs.toFixed(2)),
            totalMs: Number((performance.now() - started).toFixed(2)),
            messages: messages.length,
            details: compactDetails(response.details ?? {}),
          };
          await appendJsonl(jsonlPath, record);
          results.push(record);
        } catch (error) {
          const record = {
            questionId: qid,
            conversationIndex: item.convIndex,
            qaIndex: item.qaIndex,
            category: Number(item.qa.category),
            question: item.qa.question,
            expected: normalize(item.qa.answer),
            error: error instanceof Error ? error.message : String(error),
            correct: false,
            totalMs: Number((performance.now() - started).toFixed(2)),
            messages: messages.length,
          };
          await appendJsonl(jsonlPath, record);
          results.push(record);
        }
        const completed = results.length;
        const correct = results.filter((item) => item.correct).length;
        const byCategory = {};
        for (const category of options.categories) {
          const xs = results.filter((item) => item.category === category);
          byCategory[category] = {
            completed: xs.length,
            correct: xs.filter((item) => item.correct).length,
            accuracy: xs.length ? Number((xs.filter((item) => item.correct).length / xs.length).toFixed(4)) : 0,
          };
        }
        await fsp.writeFile(summaryPath, JSON.stringify({
          completed,
          requested: selected.length,
          correct,
          accuracy: Number((correct / completed).toFixed(4)),
          byCategory,
          updatedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
      }
    } finally {
      await cleanupEvalHarness(dir).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
