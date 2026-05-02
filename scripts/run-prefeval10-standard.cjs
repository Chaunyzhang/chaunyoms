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
  root: argValue('--root', path.join('artifacts', 'external', 'PrefEval')),
  outDir: argValue('--out-dir', path.join('artifacts', 'evals', 'prefeval-10-standard')),
  cases: numberArg('--cases', 0),
  interTurns: numberArg('--inter-turns', 10),
  forms: argValue('--forms', 'explicit,implicit-choice,implicit-persona').split(',').map((item) => item.trim()).filter(Boolean),
  model: argValue('--model', resolveDefaultEvalModel(baseUrl, process.argv.slice(2))),
  baseUrl,
  api,
  apiKey: resolveEvalApiKey(baseUrl, api, process.argv.slice(2)),
};

function truncate(text, maxChars) {
  const value = String(text ?? '');
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function choice(value) {
  return String(value ?? '').match(/[A-Da-d]/)?.[0]?.toUpperCase() ?? null;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function topics() {
  const datasetRoot = path.join(options.root, 'benchmark_dataset');
  return walk(path.join(datasetRoot, 'mcq_options'))
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.basename(file, '.json'))
    .filter((topic) => !/\bcopy\b/i.test(topic))
    .filter((topic) =>
      fs.existsSync(path.join(datasetRoot, 'implicit_preference', 'choice-based', `${topic}.json`))
      && fs.existsSync(path.join(datasetRoot, 'implicit_preference', 'persona-driven', `${topic}.json`)))
    .sort();
}

function seededShuffle(values, seed) {
  let state = seed || 41;
  const shuffled = [...values];
  function random() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  }
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function irrelevantTurns() {
  const file = path.join(options.root, 'benchmark_dataset', 'filtered_inter_turns.json');
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  return items.flatMap((item) => Array.isArray(item.conversation) ? item.conversation : []);
}

function messagesFor(form, task, interTurns, interPool) {
  const messages = [];
  if (form === 'explicit') {
    messages.push(
      { role: 'user', content: `User stated preference: ${task.preference}` },
      { role: 'assistant', content: 'I will remember and follow this preference.' },
    );
  } else {
    const conversation = task.conversation;
    if (form === 'implicit-choice') {
      messages.push(
        { role: 'user', content: String(conversation.query) },
        { role: 'assistant', content: String(conversation.assistant_options) },
        { role: 'user', content: String(conversation.user_selection) },
        { role: 'assistant', content: String(conversation.assistant_acknowledgment) },
      );
    } else {
      for (const key of Object.keys(conversation).sort((left, right) => Number(left) - Number(right))) {
        messages.push(
          { role: 'user', content: String(conversation[key].user ?? '') },
          { role: 'assistant', content: String(conversation[key].assistant ?? '') },
        );
      }
    }
  }
  for (let index = 0; index < interTurns && index < interPool.length; index += 1) {
    messages.push({ role: 'user', content: `Irrelevant inter-turn ${index + 1}: ${interPool[index].content ?? ''}` });
    if (interPool[index + 1]) {
      messages.push({ role: 'assistant', content: `Irrelevant response ${index + 1}: ${interPool[index + 1].content ?? ''}` });
    }
  }
  return messages;
}

function loadCases() {
  const inter = irrelevantTurns();
  const cases = [];
  for (const topic of topics()) {
    const mcq = JSON.parse(fs.readFileSync(path.join(options.root, 'benchmark_dataset', 'mcq_options', `${topic}.json`), 'utf8'));
    for (const form of options.forms) {
      let dataset = mcq;
      if (form === 'implicit-choice') {
        dataset = JSON.parse(fs.readFileSync(path.join(options.root, 'benchmark_dataset', 'implicit_preference', 'choice-based', `${topic}.json`), 'utf8'));
      }
      if (form === 'implicit-persona') {
        dataset = JSON.parse(fs.readFileSync(path.join(options.root, 'benchmark_dataset', 'implicit_preference', 'persona-driven', `${topic}.json`), 'utf8'));
      }
      for (let index = 0; index < dataset.length; index += 1) {
        const source = dataset[index];
        const shuffledOptions = seededShuffle(mcq[index].classification_task_options, 41000 + index);
        const correct = String.fromCharCode(65 + shuffledOptions.indexOf(mcq[index].classification_task_options[0]));
        cases.push({
          topic,
          form,
          index,
          question: source.question || mcq[index].question,
          preference: source.preference || mcq[index].preference,
          options: shuffledOptions,
          correct,
          messages: messagesFor(form, source, options.interTurns, inter),
        });
      }
    }
  }
  return options.cases > 0 ? cases.slice(0, options.cases) : cases;
}

async function appendJsonl(file, record) {
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

async function runCase(testCase, index, jsonlPath) {
  const optionsText = testCase.options.map((option, optionIndex) => `${String.fromCharCode(65 + optionIndex)}. ${option}`).join('\n');
  const caseDef = {
    id: `prefeval10-${testCase.form}-${testCase.topic}-${testCase.index}`,
    title: `PrefEval-10 ${testCase.form} ${testCase.topic}`,
    description: 'Official PrefEval MCQ classification sample with 10 inter-turns using OMS memory retrieval.',
    tags: ['prefeval-10', testCase.form, testCase.topic],
    mode: 'retrieve',
    query: `Preference-following choice: ${testCase.question}\nOptions:\n${optionsText}`,
    messages: testCase.messages,
    afterTurnEvery: 6,
    configOverrides: {
      contextWindow: 760,
      contextThreshold: 0.34,
      freshTailTokens: 64,
      maxFreshTailTurns: 1,
      compactionBatchTurns: 8,
      summaryMaxOutputTokens: 420,
      strictCompaction: true,
      compactionBarrierEnabled: true,
      configPreset: 'balanced',
    },
    expected: {},
  };

  const started = performance.now();
  const { dir, config, runtime, retrieval } = await buildEvalHarness(caseDef);
  try {
    await replayMessages(runtime, config, testCase.messages, 6);
    await finalizeReplay(runtime, config);
    const retrieveStart = performance.now();
    const response = await retrieval.executeMemoryRetrieve({
      sessionId: config.sessionId,
      config,
      query: caseDef.query,
      rawFts: true,
      deepRecall: true,
      rawFtsLimit: 8,
      retrievalStrength: 'strict',
    });
    const retrieveMs = performance.now() - retrieveStart;
    const picked = await chatJson({
      baseUrl: options.baseUrl,
      api: options.api,
      apiKey: options.apiKey,
      model: options.model,
      system: 'You are doing the official PrefEval multiple-choice preference-following task. Use retrieved memory evidence and choose the option that best follows the user preference. Return strict JSON {"choice":"A|B|C|D"}.',
      user: `Question:\n${testCase.question}\n\nOptions:\n${optionsText}\n\nRetrieved memory evidence:\n${truncate(String(response.content?.[0]?.text ?? ''), 9000)}`,
    });
    const pickedChoice = choice(picked.choice ?? picked.raw);
    const record = {
      i: index,
      topic: testCase.topic,
      form: testCase.form,
      caseIndex: testCase.index,
      expected: testCase.correct,
      choice: pickedChoice,
      correct: pickedChoice === testCase.correct,
      retrieveMs: Number(retrieveMs.toFixed(2)),
      totalMs: Number((performance.now() - started).toFixed(2)),
      messages: testCase.messages.length,
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
      i: index,
      topic: testCase.topic,
      form: testCase.form,
      caseIndex: testCase.index,
      error: error instanceof Error ? error.message : String(error),
      correct: false,
      totalMs: Number((performance.now() - started).toFixed(2)),
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
    standardSource: 'amazon-science/PrefEval benchmark_dataset',
    note: 'PrefEval-10 means official MCQ classification with inter_turns=10.',
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

  const cases = loadCases();
  const results = [];
  for (let index = 0; index < cases.length; index += 1) {
    console.log(`[prefeval10] case ${index + 1}/${cases.length} ${cases[index].form}/${cases[index].topic}`);
    const record = await runCase(cases[index], index, jsonlPath);
    results.push(record);
    const correct = results.filter((item) => item.correct).length;
    const summary = {
      completed: results.length,
      requested: cases.length,
      correct,
      accuracy: Number((correct / results.length).toFixed(4)),
      byForm: Object.fromEntries(options.forms.map((form) => {
        const formResults = results.filter((item) => item.form === form);
        const formCorrect = formResults.filter((item) => item.correct).length;
        return [form, {
          completed: formResults.length,
          correct: formCorrect,
          accuracy: formResults.length ? Number((formCorrect / formResults.length).toFixed(4)) : 0,
        }];
      })),
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
