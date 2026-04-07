import { OpenClawBridge } from "../src/OpenClawBridge";

type RegisteredContextEngineFactory = () => {
  bootstrap?: (payload?: any) => Promise<any>;
  assemble?: (payload?: any) => Promise<any>;
};

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  let factory: RegisteredContextEngineFactory | null = null;
  const api = {
    logger: { info(): void {}, warn(): void {}, error(): void {} },
    config: {
      agents: {
        defaults: {
          memorySearch: {
            enabled: false,
          },
        },
      },
    },
    registerTool(): void {},
    registerContextEngine(
      _id: string,
      create: RegisteredContextEngineFactory,
    ): void {
      factory = create;
    },
  };

  const bridge = new OpenClawBridge();
  bridge.register(api);
  assert(factory, "context engine factory not registered");
  const engine = factory!();

  const boot = await engine.bootstrap?.({
    sessionId: "embed-bootstrap-test",
    config: {},
  });
  assert(
    boot?.embeddingsSetupRequired === true,
    "expected bootstrap to report embeddingsSetupRequired=true when memorySearch is unavailable",
  );

  const firstAssemble = await engine.assemble?.({
    sessionId: "embed-bootstrap-test",
    messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
  });
  assert(
    typeof firstAssemble?.systemPromptAddition === "string" &&
      firstAssemble.systemPromptAddition.includes("memorySearch embeddings"),
    "expected first assemble to inject embeddings bootstrap guidance",
  );

  const secondAssemble = await engine.assemble?.({
    sessionId: "embed-bootstrap-test",
    messages: [{ role: "user", content: [{ type: "text", text: "再来一次" }] }],
  });
  assert(
    !secondAssemble?.systemPromptAddition,
    "expected embeddings bootstrap guidance to be one-shot per session",
  );

  console.log("test-embedding-bootstrap passed");
}

void main();
