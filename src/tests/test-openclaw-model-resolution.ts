import { DEFAULT_BRIDGE_CONFIG, OpenClawLlmCaller } from "../host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function main(): Promise<void> {
  const apiConfig = {
    agents: {
      defaults: {
        model: {
          primary: "openai-codex/gpt-5.4",
        },
        models: {
          "openai-codex/gpt-5.4": {},
          "codex/gpt-5.4": {},
        },
      },
    },
    models: {
      providers: {
        "openai-codex": {
          baseUrl: "https://example.com",
          apiKey: "test-key",
          api: "anthropic-messages",
        },
      },
    },
  };

  const requests: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: true,
      json: async () => ({
        content: [{ text: "summary ok" }],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const caller = new OpenClawLlmCaller(
      {
        config: apiConfig,
      },
      undefined,
    );

    const text = await caller.call({
      model: "gpt-5.4",
      prompt: "hello",
      maxOutputTokens: 64,
    });
    assert(text === "summary ok", "expected configured provider call to resolve response text");
    assert(requests.length === 1, "expected one configured provider request");
    assert(
      asRecord(requests[0]?.body).model === "gpt-5.4",
      "expected bare model id to resolve against the configured provider ref",
    );
    assert(
      requests[0]?.url === "https://example.com/v1/messages",
      "expected configured provider endpoint to be used",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const payloadAdapter = new OpenClawPayloadAdapter(
    () => ({
      config: apiConfig,
      context: {
        model: {
          provider: "openai-codex",
          id: "gpt-5.4",
        },
      },
    }),
    () => ({
      info(): void {},
      warn(): void {},
      error(): void {},
    }),
  );

  const lifecycle = payloadAdapter.resolveLifecycleContext({}, DEFAULT_BRIDGE_CONFIG);
  assert(
    lifecycle.summaryModel === "openai-codex/gpt-5.4",
    "expected provider/id model objects to normalize into provider-scoped refs",
  );

  const minimaxConfig = {
    agents: {
      defaults: {
        model: {
          primary: "minimax/MiniMax-M2.7",
        },
        models: {
          "minimax/MiniMax-M2.7": {},
        },
      },
    },
    models: {
      providers: {
        minimax: {
          baseUrl: "https://api.minimaxi.com/v1",
          apiKey: "test-key",
          api: "openai-completions",
          models: [
            {
              id: "MiniMax-M2.7",
              contextWindow: 200000,
              maxTokens: 64000,
            },
          ],
        },
      },
    },
  };
  const minimaxPayloadAdapter = new OpenClawPayloadAdapter(
    () => ({ config: minimaxConfig }),
    () => ({
      info(): void {},
      warn(): void {},
      error(): void {},
    }),
  );

  const autoWindowLifecycle = minimaxPayloadAdapter.resolveLifecycleContext({}, DEFAULT_BRIDGE_CONFIG);
  assert(
    autoWindowLifecycle.config.contextWindow === 200000,
    "expected plugin contextWindow to auto-resolve from configured provider model",
  );
  assert(
    autoWindowLifecycle.totalBudget === 200000,
    "expected assemble budget to use auto-resolved provider context window",
  );

  const cappedByRuntimeBudget = minimaxPayloadAdapter.resolveLifecycleContext(
    { tokenBudget: 64000 },
    DEFAULT_BRIDGE_CONFIG,
  );
  assert(
    cappedByRuntimeBudget.config.contextWindow === 200000,
    "expected runtime tokenBudget not to overwrite configured model context window",
  );
  assert(
    cappedByRuntimeBudget.totalBudget === 64000,
    "expected runtime tokenBudget to cap per-call assemble budget",
  );

  const explicitPluginWindow = minimaxPayloadAdapter.resolveLifecycleContext(
    { config: { contextWindow: 32000 } },
    DEFAULT_BRIDGE_CONFIG,
  );
  assert(
    explicitPluginWindow.config.contextWindow === 32000 &&
      explicitPluginWindow.totalBudget === 32000,
    "expected explicit plugin contextWindow to override model auto-detection",
  );

  const minimaxRequests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    minimaxRequests.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{\"summary\":\"ok\",\"keywords\":[],\"toneTag\":\"test\"}" } }],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const minimaxCaller = new OpenClawLlmCaller(
      {
        config: minimaxConfig,
      },
      undefined,
    );
    const text = await minimaxCaller.call({
      prompt: "summarize",
      maxOutputTokens: 64,
      responseFormat: "json",
    });
    assert(text.includes("\"summary\":\"ok\""), "expected openai-completions provider alias to return chat content");
    assert(minimaxRequests.length === 1, "expected one MiniMax configured provider request");
    assert(
      minimaxRequests[0]?.url === "https://api.minimaxi.com/v1/chat/completions",
      "expected openai-completions alias to use the chat completions endpoint",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("test-openclaw-model-resolution passed");
}

void main();
