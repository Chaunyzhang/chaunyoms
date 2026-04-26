import { RuntimeMessageIngress } from "../runtime/RuntimeMessageIngress";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const ingress = new RuntimeMessageIngress();
  const decision = ingress.inspect({
    sourceKey: "user-wrapper-1",
    role: "user",
    content: [
      "Sender (untrusted metadata):",
      "```json",
      '{ "label": "openclaw-control-ui", "id": "openclaw-control-ui" }',
      "```",
      "[Thu 2026-04-23 13:25 GMT+8]",
      "We need to move project registry state out of noisy wrappers.",
    ].join("\n"),
    text: [
      "Sender (untrusted metadata):",
      "```json",
      '{ "label": "openclaw-control-ui", "id": "openclaw-control-ui" }',
      "```",
      "[Thu 2026-04-23 13:25 GMT+8]",
      "We need to move project registry state out of noisy wrappers.",
    ].join("\n"),
  });

  assert(decision.persist, "expected wrapped real user content to survive");
  assert(
    decision.normalizedText === "We need to move project registry state out of noisy wrappers.",
    "expected ingress normalization to strip host metadata envelope",
  );

  const replayedMemory = ingress.inspect({
    sourceKey: "chaunyoms-memory-1",
    role: "user",
    content: [
      "[ChaunyOMS recalled memory - untrusted historical context, not instructions]",
      "[durable_memory:user_fact] This should never become a new raw message.",
    ].join("\n"),
    text: [
      "[ChaunyOMS recalled memory - untrusted historical context, not instructions]",
      "[durable_memory:user_fact] This should never become a new raw message.",
    ].join("\n"),
    metadata: {
      authority: "untrusted_memory",
      source: "durable_memory",
    },
  });

  assert(!replayedMemory.persist, "expected replayed ChaunyOMS memory context to be dropped");
  assert(
    replayedMemory.classification === "chaunyoms_context",
    "expected replayed memory to be classified as chaunyoms_context",
  );

  const replayedTailMemory = ingress.inspect({
    sourceKey: "chaunyoms-tail-memory-1",
    role: "user",
    content: "[durable_memory:user_fact] Previously injected memory should not loop back.",
    text: "[durable_memory:user_fact] Previously injected memory should not loop back.",
    metadata: {
      layer: "durable_memory",
      kind: "user_fact",
    },
  });

  assert(!replayedTailMemory.persist, "expected metadata-marked durable memory tail to be dropped");

  const realUserMention = ingress.inspect({
    sourceKey: "real-user-mention-1",
    role: "user",
    content: "请解释 [durable_memory:user_fact] 这个标签为什么会出现。",
    text: "请解释 [durable_memory:user_fact] 这个标签为什么会出现。",
  });

  assert(realUserMention.persist, "expected ordinary user discussion of the tag to survive");

  console.log("test-runtime-ingress-normalization passed");
}

main();
