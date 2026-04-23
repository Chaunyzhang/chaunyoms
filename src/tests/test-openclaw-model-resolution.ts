import { DEFAULT_BRIDGE_CONFIG, OpenClawLlmCaller } from "../host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
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

  const requests: Array<{ url: string; body: any }> = [];
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
      requests[0]?.body?.model === "gpt-5.4",
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

  console.log("test-openclaw-model-resolution passed");
}

void main();
