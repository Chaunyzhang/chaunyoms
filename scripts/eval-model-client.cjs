const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MINIMAX_MODEL = "MiniMax-M2.7";
const DEFAULT_SILICONFLOW_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
const DEFAULT_TIMEOUT_MS = 45000;

let cachedOpenClawEvalTarget;

function argValue(argv, name, fallback) {
  const prefix = `${name}=`;
  const hit = argv.find((arg) => arg === name || arg.startsWith(prefix));
  if (!hit) return fallback;
  if (hit === name) {
    const index = argv.indexOf(hit);
    return argv[index + 1] ?? fallback;
  }
  return hit.slice(prefix.length);
}

function stripBom(content) {
  return String(content ?? "").replace(/^\uFEFF/, "");
}

function providerFromBaseUrl(baseUrl, api = "") {
  const apiKind = normalizeApiKind(api, baseUrl);
  if (apiKind === "anthropic-messages") {
    const lowerBaseUrl = String(baseUrl ?? "").toLowerCase();
    if (lowerBaseUrl.includes("minimaxi") || lowerBaseUrl.includes("minimax")) {
      return "minimax";
    }
    return "anthropic";
  }
  const lower = String(baseUrl ?? "").toLowerCase();
  if (lower.includes("minimaxi") || lower.includes("minimax")) {
    return "minimax";
  }
  if (lower.includes("siliconflow")) {
    return "siliconflow";
  }
  return "openai_compatible";
}

function normalizeApiKind(api, baseUrl = "") {
  const normalizedApi = String(api ?? "").trim().toLowerCase();
  if ([
    "anthropic",
    "anthropic-messages",
    "claude",
    "messages",
  ].includes(normalizedApi)) {
    return "anthropic-messages";
  }
  if ([
    "openai",
    "openai-completions",
    "openai-compatible",
    "openai-chat-completions",
    "chat-completions",
    "minimax",
    "minimax-openai",
  ].includes(normalizedApi)) {
    return "openai-compatible";
  }
  const lowerBaseUrl = String(baseUrl ?? "").toLowerCase();
  if (lowerBaseUrl.includes("/anthropic")) {
    return "anthropic-messages";
  }
  if (lowerBaseUrl.includes("minimaxi") || lowerBaseUrl.includes("minimax")) {
    return "minimax-text";
  }
  return "openai-compatible";
}

function getOpenClawConfigPath() {
  const home = process.env.OPENCLAW_HOME?.trim()
    || path.join(process.env.USERPROFILE || "", ".openclaw");
  return path.join(home, "openclaw.json");
}

function stripProviderId(modelRef) {
  const value = String(modelRef ?? "").trim();
  const slashIndex = value.indexOf("/");
  return slashIndex <= 0 ? value : value.slice(slashIndex + 1);
}

function resolveProviderId(modelRef) {
  const value = String(modelRef ?? "").trim();
  const slashIndex = value.indexOf("/");
  return slashIndex <= 0 ? null : value.slice(0, slashIndex);
}

function normalizeProviderKey(providerId) {
  return String(providerId ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

function resolveProviderApiKey(providerId, providerConfig = null) {
  if (process.env.CHAUNYOMS_EVAL_API_KEY) {
    return process.env.CHAUNYOMS_EVAL_API_KEY;
  }
  const direct = providerConfig?.apiKey;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const envName = providerConfig?.apiKeyEnv;
  if (typeof envName === "string" && envName.trim()) {
    const envValue = process.env[envName.trim()];
    if (typeof envValue === "string" && envValue.trim()) {
      return envValue.trim();
    }
  }

  const normalizedProvider = normalizeProviderKey(providerId);
  const generic = normalizedProvider ? process.env[`${normalizedProvider}_API_KEY`] : "";
  if (typeof generic === "string" && generic.trim()) {
    return generic.trim();
  }

  const lowerProviderId = String(providerId ?? "").trim().toLowerCase();
  if (lowerProviderId === "minimax") {
    return process.env.MINIMAX_API_KEY || process.env.SILICONFLOW_API_KEY || "";
  }
  if (lowerProviderId === "siliconflow") {
    return process.env.SILICONFLOW_API_KEY || process.env.MINIMAX_API_KEY || "";
  }
  if (lowerProviderId.includes("openai")) {
    return process.env.OPENAI_API_KEY || process.env.SILICONFLOW_API_KEY || process.env.MINIMAX_API_KEY || "";
  }
  return process.env.OPENAI_API_KEY || process.env.SILICONFLOW_API_KEY || process.env.MINIMAX_API_KEY || "";
}

function loadOpenClawEvalTarget() {
  if (cachedOpenClawEvalTarget !== undefined) {
    return cachedOpenClawEvalTarget;
  }
  try {
    const configPath = getOpenClawConfigPath();
    if (!fs.existsSync(configPath)) {
      cachedOpenClawEvalTarget = null;
      return cachedOpenClawEvalTarget;
    }
    const config = JSON.parse(stripBom(fs.readFileSync(configPath, "utf8")));
    const modelRef = typeof config?.agents?.defaults?.model?.primary === "string"
      ? config.agents.defaults.model.primary.trim()
      : "";
    if (!modelRef) {
      cachedOpenClawEvalTarget = null;
      return cachedOpenClawEvalTarget;
    }
    const providerId = resolveProviderId(modelRef);
    const model = stripProviderId(modelRef);
    const providerConfig = providerId && config?.models?.providers && typeof config.models.providers === "object"
      ? config.models.providers[providerId]
      : null;
    const baseUrl = typeof providerConfig?.baseUrl === "string" && providerConfig.baseUrl.trim()
      ? providerConfig.baseUrl.trim()
      : null;
    const api = typeof providerConfig?.api === "string" && providerConfig.api.trim()
      ? providerConfig.api.trim()
      : normalizeApiKind("", baseUrl);
    cachedOpenClawEvalTarget = {
      source: "openclaw_json",
      configPath,
      modelRef,
      providerId,
      model,
      baseUrl,
      api,
      apiKey: resolveProviderApiKey(providerId, providerConfig),
    };
    return cachedOpenClawEvalTarget;
  } catch {
    cachedOpenClawEvalTarget = null;
    return cachedOpenClawEvalTarget;
  }
}

function resolveDefaultEvalBaseUrl(argv = process.argv.slice(2)) {
  const explicit =
    process.env.CHAUNYOMS_EVAL_BASE_URL ||
    process.env.MINIMAX_BASE_URL ||
    argValue(argv, "--base-url", "");
  if (explicit) {
    return explicit;
  }
  const openClawTarget = loadOpenClawEvalTarget();
  if (openClawTarget?.baseUrl) {
    return openClawTarget.baseUrl;
  }
  if (process.env.MINIMAX_API_KEY) {
    return DEFAULT_MINIMAX_BASE_URL;
  }
  return DEFAULT_SILICONFLOW_BASE_URL;
}

function resolveDefaultEvalModel(baseUrl, argv = process.argv.slice(2)) {
  const explicit = process.env.CHAUNYOMS_EVAL_MODEL || argValue(argv, "--model", "");
  if (explicit) {
    return explicit;
  }
  const explicitBaseUrl =
    process.env.CHAUNYOMS_EVAL_BASE_URL ||
    process.env.MINIMAX_BASE_URL ||
    argValue(argv, "--base-url", "");
  const openClawTarget = loadOpenClawEvalTarget();
  if (
    openClawTarget?.model &&
    (!explicitBaseUrl || openClawTarget.baseUrl === baseUrl)
  ) {
    return openClawTarget.model;
  }
  return providerFromBaseUrl(baseUrl) === "minimax"
    ? DEFAULT_MINIMAX_MODEL
    : DEFAULT_SILICONFLOW_MODEL;
}

function resolveDefaultEvalApi(baseUrl, argv = process.argv.slice(2)) {
  const explicit = process.env.CHAUNYOMS_EVAL_API || argValue(argv, "--api", "");
  if (explicit) {
    return explicit;
  }
  const explicitBaseUrl =
    process.env.CHAUNYOMS_EVAL_BASE_URL ||
    process.env.MINIMAX_BASE_URL ||
    argValue(argv, "--base-url", "");
  const openClawTarget = loadOpenClawEvalTarget();
  if (
    openClawTarget?.api &&
    (!explicitBaseUrl || openClawTarget.baseUrl === baseUrl)
  ) {
    return openClawTarget.api;
  }
  return normalizeApiKind("", baseUrl);
}

function resolveEvalApiKey(baseUrl, api = "", argv = process.argv.slice(2)) {
  if (process.env.CHAUNYOMS_EVAL_API_KEY) return process.env.CHAUNYOMS_EVAL_API_KEY;
  const explicitBaseUrl =
    process.env.CHAUNYOMS_EVAL_BASE_URL ||
    process.env.MINIMAX_BASE_URL ||
    argValue(argv, "--base-url", "");
  const openClawTarget = loadOpenClawEvalTarget();
  if (
    openClawTarget?.apiKey &&
    (!explicitBaseUrl || openClawTarget.baseUrl === baseUrl)
  ) {
    return openClawTarget.apiKey;
  }
  const provider = providerFromBaseUrl(baseUrl, api);
  if (provider === "minimax") {
    return process.env.MINIMAX_API_KEY || process.env.SILICONFLOW_API_KEY || "";
  }
  if (provider === "siliconflow") {
    return process.env.SILICONFLOW_API_KEY || process.env.MINIMAX_API_KEY || "";
  }
  return process.env.OPENAI_API_KEY || process.env.SILICONFLOW_API_KEY || process.env.MINIMAX_API_KEY || "";
}

function paidApiAllowed(argv = process.argv.slice(2)) {
  return process.env.CHAUNYOMS_EVAL_ALLOW_PAID === "1" || argv.includes("--allow-paid-api");
}

function firstJsonObject(text) {
  const value = String(text ?? "");
  const start = value.indexOf("{");
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
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function looseJsonObject(text) {
  const value = String(text ?? "");
  const answer = value.match(/"answer"\s*:\s*"([\s\S]*?)"\s*(?:,|})/);
  const confidence = value.match(/"confidence"\s*:\s*(0(?:\.\d+)?|1(?:\.0+)?)/);
  const evidence = value.match(/"evidence"\s*:\s*"([\s\S]*?)"\s*(?:,|})/);
  if (answer) {
    return {
      answer: answer[1].replace(/\\"/g, '"'),
      confidence: confidence ? Number(confidence[1]) : 0,
      evidence: evidence ? evidence[1].replace(/\\"/g, '"') : "",
    };
  }
  const correct = value.match(/"correct"\s*:\s*(true|false)/);
  const reason = value.match(/"reason"\s*:\s*"([\s\S]*?)"\s*(?:,|})/);
  if (correct) {
    return {
      correct: correct[1] === "true",
      reason: reason ? reason[1].replace(/\\"/g, '"') : value.slice(0, 500),
    };
  }
  const choice = value.match(/"choice"\s*:\s*"([A-Da-d])"\s*(?:,|})/);
  if (choice) {
    return {
      choice: choice[1].toUpperCase(),
    };
  }
  return null;
}

async function callEvalModel({
  baseUrl,
  api,
  apiKey,
  model,
  system,
  user,
  maxTokens = 256,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  responseFormatJson = true,
}) {
  if (!apiKey) {
    throw new Error("evaluation API key is not set");
  }
  const cleanedBaseUrl = String(baseUrl).replace(/\/$/, "");
  const apiKind = normalizeApiKind(api, baseUrl);

  if (apiKind === "anthropic-messages") {
    const endpoint = cleanedBaseUrl.endsWith("/v1/messages")
      ? cleanedBaseUrl
      : `${cleanedBaseUrl}/v1/messages`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        system: system || undefined,
        messages: [{ role: "user", content: user }],
        temperature: 0,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`model call failed ${response.status}: ${raw.slice(0, 600)}`);
    }
    const parsed = JSON.parse(raw);
    const text = Array.isArray(parsed.content)
      ? parsed.content
        .flatMap((part) => {
          if (typeof part === "string") return [part];
          if (part && typeof part === "object" && typeof part.text === "string") {
            return [part.text];
          }
          return [];
        })
        .join("\n")
      : "";
    return text || String(parsed.output_text ?? parsed.reply ?? "");
  }

  if (apiKind === "minimax-text") {
    const response = await fetch(`${cleanedBaseUrl}/text/chatcompletion_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`model call failed ${response.status}: ${raw.slice(0, 600)}`);
    }
    const parsed = JSON.parse(raw);
    return String(parsed.choices?.[0]?.message?.content ?? parsed.reply ?? parsed.output_text ?? "");
  }

  const response = await fetch(`${cleanedBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      ...(responseFormatJson ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`model call failed ${response.status}: ${raw.slice(0, 600)}`);
  }
  const parsed = JSON.parse(raw);
  return String(parsed.choices?.[0]?.message?.content ?? "{}");
}

async function chatJson({ baseUrl, api, apiKey, model, system, user, maxTokens = 256, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const content = await callEvalModel({
    baseUrl,
    api,
    apiKey,
    model,
    system,
    user,
    maxTokens,
    timeoutMs,
    responseFormatJson: true,
  });
  try {
    return JSON.parse(content);
  } catch {
    const json = firstJsonObject(content);
    if (json) {
      try {
        return JSON.parse(json);
      } catch {
        const loose = looseJsonObject(json);
        if (loose) return loose;
      }
    }
    const loose = looseJsonObject(content);
    if (loose) return loose;
    return { raw: content };
  }
}

async function preflightEvalModel({ baseUrl, api, apiKey, model, timeoutMs = 15000 }) {
  const started = Date.now();
  const content = await callEvalModel({
    baseUrl,
    api,
    apiKey,
    model,
    system: "Reply with strict JSON: {\"ok\":true}",
    user: "Return {\"ok\":true}",
    maxTokens: 32,
    timeoutMs,
    responseFormatJson: true,
  });
  const openClawTarget = loadOpenClawEvalTarget();
  const provider = providerFromBaseUrl(baseUrl, api);
  return {
    ok: true,
    provider,
    api: normalizeApiKind(api, baseUrl),
    baseUrl,
    model,
    elapsedMs: Date.now() - started,
    preview: String(content).slice(0, 200),
    source: openClawTarget?.baseUrl === baseUrl && openClawTarget?.model === model ? openClawTarget.source : "explicit_or_env",
    modelRef: openClawTarget?.baseUrl === baseUrl && openClawTarget?.model === model ? openClawTarget.modelRef : undefined,
    configPath: openClawTarget?.baseUrl === baseUrl && openClawTarget?.model === model ? openClawTarget.configPath : undefined,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  providerFromBaseUrl,
  normalizeApiKind,
  loadOpenClawEvalTarget,
  resolveDefaultEvalBaseUrl,
  resolveDefaultEvalModel,
  resolveDefaultEvalApi,
  resolveEvalApiKey,
  paidApiAllowed,
  chatJson,
  preflightEvalModel,
  firstJsonObject,
  looseJsonObject,
};
