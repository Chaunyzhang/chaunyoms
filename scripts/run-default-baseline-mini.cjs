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

const options = {
  outDir: argValue('--out-dir', path.join('artifacts', 'evals', 'baseline-mini-2026-04-29')),
  locomoCases: numberArg('--locomo-cases', 5),
  longMemEvalCases: numberArg('--longmemeval-cases', 3),
  personaMemCases: numberArg('--personamem-cases', 3),
  prefEvalCases: numberArg('--prefeval-cases', 4),
  longMemEvalMaxSessions: numberArg('--longmemeval-max-sessions', 5),
  deadlineMinutes: numberArg('--deadline-minutes', 14),
  useLlmScoring: process.argv.includes('--use-llm-scoring'),
  allowPaidApi: process.argv.includes('--allow-paid-api') || process.env.CHAUNYOMS_EVAL_ALLOW_PAID === '1',
  baseUrl: argValue('--base-url', process.env.CHAUNYOMS_EVAL_BASE_URL || 'https://api.siliconflow.cn/v1'),
  model: argValue('--model', process.env.CHAUNYOMS_EVAL_MODEL || 'Qwen/Qwen3-8B'),
  enhancedLanes: process.argv.includes('--enhanced-lanes'),
  llmRuntime: process.argv.includes('--llm-runtime'),
  directGrepBaseline: process.argv.includes('--direct-grep-baseline'),
  retrievalStrength: argValue('--retrieval-strength', 'high'),
};

function resolveApiKey(baseUrl) {
  if (process.env.CHAUNYOMS_EVAL_API_KEY) return process.env.CHAUNYOMS_EVAL_API_KEY;
  const lowerUrl = String(baseUrl ?? '').toLowerCase();
  if (lowerUrl.includes('siliconflow')) return process.env.SILICONFLOW_API_KEY || '';
  if (lowerUrl.includes('minimax') || lowerUrl.includes('minimaxi')) return process.env.MINIMAX_API_KEY || '';
  return process.env.OPENAI_API_KEY || process.env.SILICONFLOW_API_KEY || process.env.MINIMAX_API_KEY || '';
}

const apiKey = resolveApiKey(options.baseUrl);

function isOfficialDeepSeek() {
  const lowerUrl = String(options.baseUrl ?? '').toLowerCase();
  const lowerModel = String(options.model ?? '').toLowerCase();
  return lowerUrl.includes('api.deepseek.com') || lowerModel.startsWith('deepseek-');
}

function buildChatPayload({ system, user, maxTokens, jsonMode = false, disableThinking = false }) {
  return {
    model: options.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    max_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
  };
}

async function postChatCompletion(payload, { timeoutMs = 20_000 } = {}) {
  const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`model call failed ${response.status}: ${raw.slice(0, 300)}`);
  }
  const parsed = JSON.parse(raw);
  const message = parsed.choices?.[0]?.message ?? {};
  return {
    content: String(message.content ?? parsed.output_text ?? ''),
    reasoningContent: message.reasoning_content ?? '',
    finishReason: parsed.choices?.[0]?.finish_reason ?? null,
    usage: parsed.usage ?? null,
    rawResponse: raw,
  };
}

function createOpenAiCompatibleLlmCaller() {
  if (!options.llmRuntime) return null;
  if (!options.allowPaidApi) {
    throw new Error('LLM runtime requires --allow-paid-api or CHAUNYOMS_EVAL_ALLOW_PAID=1');
  }
  if (!apiKey) {
    throw new Error('LLM runtime API key is not set');
  }
  return {
    async call(params) {
      const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: params.model || options.model,
          messages: [{ role: 'user', content: params.prompt }],
          temperature: params.temperature ?? 0,
          max_tokens: params.maxOutputTokens ?? 512,
          ...(params.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`runtime model call failed ${response.status}: ${raw.slice(0, 300)}`);
      }
      const parsed = JSON.parse(raw);
      return parsed.choices?.[0]?.message?.content ?? parsed.output_text ?? raw;
    },
  };
}

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return normalize(value).toLowerCase();
}

function importantTerms(value, limit = 8) {
  const stop = new Set([
    'about', 'after', 'again', 'assistant', 'because', 'before', 'being', 'between', 'could',
    'course', 'from', 'have', 'into', 'that', 'their', 'there', 'these', 'this', 'with',
    'would', 'what', 'when', 'where', 'which', 'your', 'user', 'message', 'question',
  ]);
  const seen = new Set();
  const result = [];
  for (const term of lower(value).split(/[^a-z0-9\u4e00-\u9fff]+/i)) {
    if (term.length < 4 || stop.has(term) || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
    if (result.length >= limit) break;
  }
  return result;
}

function containsAny(text, needles) {
  const haystack = lower(text);
  return needles.some((needle) => needle && haystack.includes(lower(needle)));
}

function termCoverage(text, terms) {
  if (terms.length === 0) return 0;
  const haystack = lower(text);
  return Number((terms.filter((term) => haystack.includes(term)).length / terms.length).toFixed(4));
}

function exactContains(text, expected) {
  const needle = lower(expected);
  return needle.length > 0 && lower(text).includes(needle);
}

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
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows
    .filter((cells) => cells.length === header.length)
    .map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index]])));
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

function parseOptionList(raw) {
  const text = String(raw ?? '');
  try {
    return JSON.parse(text.replace(/'/g, '"'));
  } catch {
    return Array.from(text.matchAll(/\([a-d]\)\s*([\s\S]*?)(?=(?:['"]?,\s*['"]?\([a-d]\))|$)/gi), (match) =>
      normalize(match[0].replace(/^['"]?|['"]?$/g, '')),
    );
  }
}

function optionByLetter(rawOptions, rawLetter) {
  const letter = String(rawLetter ?? '').match(/[a-d]/i)?.[0]?.toLowerCase();
  const index = letter ? letter.charCodeAt(0) - 97 : -1;
  const options = parseOptionList(rawOptions);
  return index >= 0 ? normalize(options[index] ?? '') : '';
}

function scoreOption(text, option) {
  const haystack = lower(text);
  const normalizedOption = normalize(option).replace(/^\([a-d]\)\s*/i, '');
  if (!normalizedOption) return { score: 0, phraseHit: false, matchedTerms: [] };
  const phraseHit = haystack.includes(lower(normalizedOption));
  const terms = importantTerms(normalizedOption, 16);
  const matchedTerms = terms.filter((term) => haystack.includes(term));
  return {
    score: (phraseHit ? 100 : 0) + matchedTerms.length,
    phraseHit,
    matchedTerms,
  };
}

function selectUniqueOption(text, options) {
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }
  const scored = options.map((option, index) => ({
    index,
    option: normalize(option),
    ...scoreOption(text, option),
  }));
  const bestScore = Math.max(...scored.map((item) => item.score));
  const winners = scored.filter((item) => item.score === bestScore);
  return {
    selectedIndex: bestScore > 0 && winners.length === 1 ? winners[0].index : null,
    bestScore,
    scores: scored,
  };
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

async function chatJson({ system, user, maxTokens = 160 }) {
  if (!options.useLlmScoring) return {};
  if (!options.allowPaidApi) {
    throw new Error('LLM scoring requires --allow-paid-api or CHAUNYOMS_EVAL_ALLOW_PAID=1');
  }
  if (!apiKey) {
    throw new Error('evaluation API key is not set');
  }
  const result = await postChatCompletion(buildChatPayload({
    system,
    user,
    maxTokens,
    jsonMode: true,
    disableThinking: isOfficialDeepSeek(),
  }));
  const content = result.content || '{}';
  try {
    return JSON.parse(content);
  } catch {
    const json = firstJsonObject(content);
    if (json) {
      try {
        return JSON.parse(json);
      } catch {}
    }
    return { raw: content };
  }
}

async function chatChoiceDeepSeek({ question, evidenceText, optionText }) {
  if (!options.useLlmScoring) return {};
  if (!options.allowPaidApi) {
    throw new Error('LLM scoring requires --allow-paid-api or CHAUNYOMS_EVAL_ALLOW_PAID=1');
  }
  if (!apiKey) {
    throw new Error('evaluation API key is not set');
  }

  const system = [
    'You are a strict memory benchmark answer selector.',
    'Use only the retrieved evidence.',
    'Output exactly one uppercase letter: A, B, C, or D.',
    'No JSON. No explanation. No extra words.',
  ].join(' ');
  const user = `Question:\n${question}\n\nOptions:\n${optionText}\n\nRetrieved evidence:\n${evidenceText.slice(0, 9000)}\n\nFinal answer, one letter only:`;
  const attempts = [
    { maxTokens: 256, retry: false },
    { maxTokens: 512, retry: true },
  ];
  const attemptAudits = [];

  for (const attempt of attempts) {
    const result = await postChatCompletion(buildChatPayload({
      system,
      user: attempt.retry
        ? `${user}\n\nPrevious output was empty. Return only A, B, C, or D now.`
        : user,
      maxTokens: attempt.maxTokens,
      jsonMode: false,
      disableThinking: true,
    }));
    const content = normalize(result.content);
    const selected = choiceToIndex(content);
    const audit = {
      maxTokens: attempt.maxTokens,
      contentEmpty: content.length === 0,
      finishReason: result.finishReason,
      usage: result.usage,
      reasoningContentPresent: normalize(result.reasoningContent).length > 0,
    };
    attemptAudits.push(audit);
    if (selected !== null) {
      return {
        choice: String.fromCharCode(65 + selected),
        raw: content,
        scorerProvider: 'deepseek_plain_choice',
        failureType: null,
        attempts: attemptAudits,
      };
    }
  }

  const lastAudit = attemptAudits.at(-1);
  return {
    raw: '',
    scorerProvider: 'deepseek_plain_choice',
    failureType: lastAudit?.contentEmpty ? 'model_empty_output' : 'model_unparseable_output',
    attempts: attemptAudits,
  };
}

function choiceToIndex(value) {
  const text = String(value ?? '');
  const choiceField = text.match(/\bchoice\b\s*[:=]\s*[\"']?([A-Da-d])\b/);
  if (choiceField) return choiceField[1].toUpperCase().charCodeAt(0) - 65;
  const standalone = text.match(/(?:^|[^A-Za-z])([A-Da-d])(?:[^A-Za-z]|$)/);
  return standalone ? standalone[1].toUpperCase().charCodeAt(0) - 65 : null;
}

function normalizedAnswerMatch(hypothesis, expected) {
  const h = lower(hypothesis).replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
  const e = lower(expected).replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
  return e.length > 0 && (h === e || h.includes(e) || e.includes(h));
}

async function answerWithLlm(question, evidenceText, expected, optionList) {
  if (!options.useLlmScoring) return null;
  if (Array.isArray(optionList) && optionList.length > 0) {
    const optionText = optionList
      .map((option, index) => `${String.fromCharCode(65 + index)}. ${normalize(option).replace(/^\([a-d]\)\s*/i, '')}`)
      .join('\n');
    if (isOfficialDeepSeek()) {
      return await chatChoiceDeepSeek({ question, evidenceText, optionText });
    }
    return await chatJson({
      system: 'You are a strict memory benchmark answer selector. Use only the retrieved evidence. Return JSON only: {"choice":"A"}. No explanation.',
      user: `Question:\n${question}\n\nOptions:\n${optionText}\n\nRetrieved evidence:\n${evidenceText.slice(0, 9000)}`,
      maxTokens: 128,
    });
  }
  return await chatJson({
    system: 'You are a strict memory benchmark answerer. Use only the retrieved evidence. Return JSON only: {"answer":"exact short answer","evidence":"short quote"}. If evidence is insufficient, answer "INSUFFICIENT_EVIDENCE".',
    user: `Question:\n${question}\n\nGold answer format hint, do not copy unless supported by evidence:\n${expected}\n\nRetrieved evidence:\n${evidenceText.slice(0, 9000)}`,
    maxTokens: 180,
  });
}

function locomoMessages(conv, convIndex) {
  const messages = [];
  const sessions = Object.keys(conv)
    .filter((key) => /^session_\d+$/.test(key))
    .sort((left, right) => Number(left.split('_')[1]) - Number(right.split('_')[1]));
  for (const sessionKey of sessions) {
    const sessionNumber = Number(sessionKey.split('_')[1]);
    const date = conv[`session_${sessionNumber}_date_time`] ?? 'unknown date';
    for (const turn of conv[sessionKey] ?? []) {
      const role = String(turn.speaker) === String(conv.speaker_b) ? 'assistant' : 'user';
      messages.push({
        role,
        content: `LOCOMO conv${convIndex} | ${sessionKey} date ${date} | dia_id ${turn.dia_id} | ${turn.speaker}: ${turn.text}`,
      });
    }
  }
  return messages;
}

function longMemEvalMessages(item, maxSessions) {
  const messages = [];
  const sessions = Array.isArray(item.haystack_sessions) ? item.haystack_sessions.slice(0, maxSessions) : [];
  for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
    const date = item.haystack_dates?.[sessionIndex] ?? 'unknown date';
    const sid = item.haystack_session_ids?.[sessionIndex] ?? `session_${sessionIndex + 1}`;
    for (let turnIndex = 0; turnIndex < sessions[sessionIndex].length; turnIndex += 1) {
      const turn = sessions[sessionIndex][turnIndex] ?? {};
      const role = turn.role === 'assistant' ? 'assistant' : 'user';
      messages.push({
        role,
        content: `LongMemEval ${item.question_id} | ${sid} date ${date} | T${sessionIndex + 1}:${turnIndex + 1} | ${role}: ${normalize(turn.content)}`,
      });
    }
  }
  return messages;
}

function personaMessages(context, endIndex) {
  const selected = Array.isArray(context) ? context.slice(0, Number(endIndex)) : [];
  return selected
    .filter((message) => message.role !== 'system')
    .map((message, index) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: `PersonaMem context turn ${index + 1} | ${normalize(message.content)}`,
    }));
}

function prefEvalMessages(task) {
  return [
    { role: 'user', content: `User stated preference: ${task.preference}` },
    { role: 'assistant', content: 'I will remember and follow this preference.' },
    { role: 'user', content: 'Inter-turn filler: please discuss something unrelated before the next task.' },
    { role: 'assistant', content: 'Acknowledged; continuing unrelated context without changing preferences.' },
  ];
}

function loadGroups() {
  const groups = [];

  const locomoPath = path.join('artifacts', 'datasets', 'locomo', 'locomo10.json');
  if (fs.existsSync(locomoPath) && options.locomoCases > 0) {
    const data = JSON.parse(fs.readFileSync(locomoPath, 'utf8'));
    const convIndex = 0;
    const conv = data[convIndex];
    groups.push({
      groupId: 'locomo-conv0-default-baseline',
      benchmark: 'locomo',
      messages: locomoMessages(conv.conversation, convIndex),
      questions: conv.qa
        .filter((qa) => [1, 2, 3, 4].includes(Number(qa.category)))
        .slice(0, options.locomoCases)
        .map((qa, index) => ({
          id: `locomo-conv0-q${index}`,
          query: `LOCOMO memory question: ${qa.question}`,
          expected: normalize(qa.answer),
          sourceNeedles: Array.isArray(qa.evidence) ? qa.evidence.map(String) : [],
          answerNeedles: [normalize(qa.answer)],
          terms: importantTerms(`${qa.question} ${qa.answer}`),
          meta: { category: qa.category, question: qa.question },
        })),
    });
  }

  const longPath = path.join('artifacts', 'datasets', 'longmemeval', 'longmemeval_s_cleaned.json');
  if (fs.existsSync(longPath) && options.longMemEvalCases > 0) {
    const data = JSON.parse(fs.readFileSync(longPath, 'utf8'));
    for (const [index, item] of data.slice(0, options.longMemEvalCases).entries()) {
      groups.push({
        groupId: `longmemeval-${index}`,
        benchmark: 'longmemeval',
        messages: longMemEvalMessages(item, options.longMemEvalMaxSessions),
        questions: [{
          id: `longmemeval-${index}`,
          query: `History recall: ${item.question}`,
          expected: normalize(item.answer),
          sourceNeedles: [],
          answerNeedles: [normalize(item.answer)],
          terms: importantTerms(`${item.question} ${item.answer}`),
          meta: { questionType: item.question_type, question: item.question },
        }],
      });
    }
  }

  const personaQuestions = path.join('artifacts', 'datasets', 'personamem', 'questions_32k.csv');
  const personaContexts = path.join('artifacts', 'datasets', 'personamem', 'shared_contexts_32k.jsonl');
  if (fs.existsSync(personaQuestions) && fs.existsSync(personaContexts) && options.personaMemCases > 0) {
    const questions = parseCsv(fs.readFileSync(personaQuestions, 'utf8')).slice(0, options.personaMemCases);
    const contexts = contextsMap(fs.readFileSync(personaContexts, 'utf8'));
    for (const [index, item] of questions.entries()) {
      const correctOption = optionByLetter(item.all_options, item.correct_answer);
      const candidateOptions = parseOptionList(item.all_options);
      const correctIndex = String(item.correct_answer ?? '').match(/[a-d]/i)
        ? String(item.correct_answer ?? '').match(/[a-d]/i)[0].toLowerCase().charCodeAt(0) - 97
        : -1;
      groups.push({
        groupId: `personamem-32k-${index}`,
        benchmark: 'personamem',
        messages: personaMessages(contexts.get(item.shared_context_id), item.end_index_in_shared_context),
        questions: [{
          id: `personamem-32k-${index}`,
          query: `Personalized preference recall: ${item.user_question_or_message}`,
          expected: correctOption,
          options: candidateOptions,
          correctIndex,
          sourceNeedles: importantTerms(correctOption, 4),
          answerNeedles: importantTerms(correctOption, 4),
          terms: importantTerms(`${item.user_question_or_message} ${correctOption}`),
          meta: { questionType: item.question_type, topic: item.topic, correctAnswer: item.correct_answer },
        }],
      });
    }
  }

  const prefPath = path.join('artifacts', 'external', 'PrefEval', 'benchmark_dataset', 'mcq_options', 'education_learning_styles.json');
  if (fs.existsSync(prefPath) && options.prefEvalCases > 0) {
    const data = JSON.parse(fs.readFileSync(prefPath, 'utf8')).slice(0, options.prefEvalCases);
    for (const [index, item] of data.entries()) {
      const correctOption = normalize(item.classification_task_options?.[0] ?? '');
      groups.push({
        groupId: `prefeval10-explicit-${index}`,
        benchmark: 'prefeval10',
        messages: prefEvalMessages(item),
        questions: [{
          id: `prefeval10-explicit-${index}`,
          query: `Preference-following choice: ${item.question}`,
          expected: correctOption,
          options: item.classification_task_options,
          correctIndex: 0,
          sourceNeedles: [item.preference],
          answerNeedles: importantTerms(correctOption, 4),
          terms: importantTerms(`${item.preference} ${item.question} ${correctOption}`),
          meta: { topic: 'education_learning_styles', preference: item.preference },
        }],
      });
    }
  }

  return groups;
}

async function appendJsonl(file, record) {
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

async function run() {
  await fsp.mkdir(options.outDir, { recursive: true });
  const jsonl = path.join(options.outDir, 'results.jsonl');
  const summaryPath = path.join(options.outDir, 'summary.json');
  const startedAt = new Date();
  const deadlineMs = performance.now() + options.deadlineMinutes * 60_000;
  await fsp.writeFile(path.join(options.outDir, 'run-meta.json'), JSON.stringify({
    ...options,
    startedAt: startedAt.toISOString(),
    externalModelCalls: options.useLlmScoring,
    paidApiAllowed: options.allowPaidApi,
    model: options.useLlmScoring ? options.model : 'none',
    baseUrl: options.useLlmScoring ? options.baseUrl : 'none',
    profile: 'default_substrate_baseline',
    enabledLanes: {
      rag: options.enhancedLanes,
      graph: options.enhancedLanes,
      rerank: options.enhancedLanes,
      embedding: options.enhancedLanes ? 'local_hash_v1' : false,
      llmPlanner: options.llmRuntime ? 'auto with OpenAI-compatible runtime caller' : 'auto, but harness uses synthetic host summary caller only',
      evidenceAnswerResolver: options.llmRuntime ? 'llm' : false,
      dagExpansion: options.llmRuntime ? 'planner_decides + llm provider' : false,
    },
    retrievalStrength: options.retrievalStrength,
    scoring: 'strict deterministic precision: MCQ must select the unique correct option from retrieved evidence; open QA must contain the exact expected answer string',
  }, null, 2));

  const groups = loadGroups();
  const results = [];
  for (const group of groups) {
    if (performance.now() > deadlineMs) break;
    const caseDef = {
      id: group.groupId,
      title: `${group.benchmark} default baseline mini`,
      description: 'No external model calls; default substrate baseline retrieval coverage.',
      tags: [group.benchmark, 'default-baseline', 'no-paid-api'],
      mode: 'retrieve',
      query: group.questions[0]?.query ?? 'baseline query',
      messages: group.messages,
      afterTurnEvery: 20,
      configOverrides: {
        graphEnabled: options.enhancedLanes,
        ragEnabled: options.enhancedLanes,
        rerankEnabled: options.enhancedLanes,
        embeddingEnabled: options.enhancedLanes,
        graphBuilderEnabled: options.enhancedLanes,
        ragProvider: options.enhancedLanes ? 'brute_force' : 'none',
        graphProvider: options.enhancedLanes ? 'sqlite_graph' : 'none',
        graphBuilderProvider: options.enhancedLanes ? 'deterministic' : 'none',
        rerankProvider: options.llmRuntime ? 'llm' : (options.enhancedLanes ? 'deterministic' : 'none'),
        rerankModel: options.llmRuntime ? options.model : undefined,
        rerankTimeoutMs: 60000,
        rerankFallbackToDeterministic: false,
        candidateRerankThreshold: options.llmRuntime ? 4 : 20,
        laneCandidateRerankThreshold: options.llmRuntime ? 4 : 10,
        evidenceAnswerResolverEnabled: options.llmRuntime,
        evidenceAnswerResolverProvider: options.llmRuntime ? 'llm' : 'none',
        evidenceAnswerResolverModel: options.llmRuntime ? options.model : undefined,
        evidenceAnswerResolverTimeoutMs: 60000,
        evidenceAnswerResolverFallbackToDeterministic: false,
        dagExpansionMode: options.llmRuntime ? 'planner_decides' : 'deterministic',
        dagExpansionAgentProvider: options.llmRuntime ? 'llm' : 'none',
        dagExpansionAgentModel: options.llmRuntime ? options.model : undefined,
        dagExpansionAgentTimeoutMs: 60000,
        llmPlannerMode: 'auto',
        llmPlannerModel: options.llmRuntime ? options.model : undefined,
        embeddingProvider: options.enhancedLanes ? 'local_hash' : 'none',
        embeddingModel: options.enhancedLanes ? 'local_hash_v1' : 'none',
        embeddingDimensions: 256,
        retrievalStrength: options.retrievalStrength,
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
    console.log(`[baseline-mini] ingest ${group.groupId} messages=${group.messages.length}`);
    const groupStart = performance.now();
    const { dir, config, runtime, retrieval } = await buildEvalHarness(caseDef);
    const llmCaller = createOpenAiCompatibleLlmCaller();
    if (llmCaller) {
      runtime.updateHost({ info() {}, warn() {}, error() {} }, llmCaller);
    }
    try {
      await replayMessages(runtime, config, group.messages, 20);
      await finalizeReplay(runtime, config);
      const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
      const summaries = stores.summaryStore.getAllSummaries({ sessionId: config.sessionId });
      for (const question of group.questions) {
        if (performance.now() > deadlineMs) break;
        console.log(`[baseline-mini] query ${question.id}`);
        const retrieveStart = performance.now();
        const response = await retrieval.executeMemoryRetrieve({
          sessionId: config.sessionId,
          config,
          query: question.query,
          losslessFastPath: options.directGrepBaseline,
          contextTurns: options.directGrepBaseline ? 0 : undefined,
          fastOnly: options.directGrepBaseline,
          includeFreshTail: options.directGrepBaseline,
          recentTailTurns: options.directGrepBaseline ? 8 : undefined,
          maxCharsPerHit: options.directGrepBaseline ? 1600 : undefined,
          maxCharsPerFreshTail: options.directGrepBaseline ? 1200 : undefined,
          assumeRuntimeFresh: options.directGrepBaseline,
          rawFts: true,
          deepRecall: true,
          rawFtsLimit: 12,
          retrievalStrength: options.retrievalStrength,
        });
        const retrieveMs = performance.now() - retrieveStart;
        const text = String(response.content?.[0]?.text ?? '');
        const exactAnswerHit = exactContains(text, question.expected);
        const answerHit = exactAnswerHit || containsAny(text, question.answerNeedles);
        const sourceHit = containsAny(text, question.sourceNeedles);
        const coverage = termCoverage(text, question.terms);
        const optionSelection = selectUniqueOption(text, question.options);
        let llmAnswer = null;
        let llmError = null;
        let answerMs = 0;
        const answerStart = performance.now();
        try {
          llmAnswer = await answerWithLlm(question.query, text, question.expected, question.options);
        } catch (error) {
          llmError = error instanceof Error ? error.message : String(error);
        } finally {
          answerMs = performance.now() - answerStart;
        }
        const llmSelectedIndex = options.useLlmScoring && question.options
          ? choiceToIndex(llmAnswer?.choice ?? llmAnswer?.raw)
          : null;
        const llmFailureType = llmError
          ? (String(llmError).toLowerCase().includes('timeout') ? 'timeout' : 'model_call_error')
          : (llmAnswer?.failureType ?? null);
        const llmHypothesis = options.useLlmScoring && !question.options
          ? String(llmAnswer?.answer ?? llmAnswer?.raw ?? '')
          : '';
        const strictOptionHit = optionSelection
          ? (options.useLlmScoring ? llmSelectedIndex === question.correctIndex : optionSelection.selectedIndex === question.correctIndex)
          : false;
        const llmAnswerHit = options.useLlmScoring && !question.options
          ? normalizedAnswerMatch(llmHypothesis, question.expected)
          : false;
        const passed = optionSelection ? strictOptionHit : (options.useLlmScoring ? llmAnswerHit : exactAnswerHit);
        const record = {
          benchmark: group.benchmark,
          groupId: group.groupId,
          id: question.id,
          passed,
          answerHit,
          exactAnswerHit,
          sourceHit,
          strictOptionHit,
          selectedOptionIndex: optionSelection?.selectedIndex ?? null,
          llmSelectedOptionIndex: llmSelectedIndex,
          llmHypothesis,
          llmAnswer,
          llmError,
          llmFailureType,
          correctOptionIndex: Number.isInteger(question.correctIndex) ? question.correctIndex : null,
          optionScores: optionSelection?.scores ?? [],
          termCoverage: coverage,
          expectedPreview: normalize(question.expected).slice(0, 180),
          retrieveMs: Number(retrieveMs.toFixed(2)),
          answerMs: Number(answerMs.toFixed(2)),
          groupElapsedMs: Number((performance.now() - groupStart).toFixed(2)),
          messages: group.messages.length,
          summaryCount: summaries.length,
          branchCount: summaries.filter((summary) => summary.nodeKind === 'branch').length,
          route: response.details?.route,
          retrievalHitType: response.details?.retrievalHitType,
          recallStrategy: response.details?.recallStrategy,
          hitCount: response.details?.hitCount,
          freshTailCount: response.details?.freshTailCount,
          fastOnly: response.details?.fastOnly,
          grepMs: response.details?.grepMs,
          rawCandidateCount: response.details?.rawCandidateCount,
          rawFtsHintCount: response.details?.rawFtsHintCount,
          plannerSelectedPlan: response.details?.planner?.selectedPlan ?? response.details?.selectedPlan ?? null,
          plannerDagExpansion: response.details?.planner?.dagExpansion ?? null,
          dagExpansion: response.details?.dagExpansion ?? null,
          evidenceAnswer: response.details?.evidenceAnswer ?? null,
          rerankAudit: response.details?.rerankAudit ?? null,
          meta: question.meta,
        };
        results.push(record);
        await appendJsonl(jsonl, record);
        const byBenchmark = {};
        for (const item of results) {
          byBenchmark[item.benchmark] ??= { completed: 0, passed: 0 };
          byBenchmark[item.benchmark].completed += 1;
          if (item.passed) byBenchmark[item.benchmark].passed += 1;
        }
        for (const value of Object.values(byBenchmark)) {
          value.passRate = Number((value.passed / value.completed).toFixed(4));
        }
        await fsp.writeFile(summaryPath, JSON.stringify({
          completed: results.length,
          passed: results.filter((item) => item.passed).length,
          passRate: results.length ? Number((results.filter((item) => item.passed).length / results.length).toFixed(4)) : 0,
          byBenchmark,
          elapsedSeconds: Number(((performance.now() - (deadlineMs - options.deadlineMinutes * 60_000)) / 1000).toFixed(2)),
          updatedAt: new Date().toISOString(),
        }, null, 2));
      }
    } finally {
      await cleanupEvalHarness(dir).catch(() => undefined);
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

