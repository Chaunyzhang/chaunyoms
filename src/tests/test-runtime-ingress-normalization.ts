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

  const nestedWrapper = ingress.inspect({
    sourceKey: "user-wrapper-2",
    role: "user",
    content: [
      "Sender (untrusted metadata):",
      "```json",
      '{ "label": "openclaw-control-ui", "id": "openclaw-control-ui" }',
      "```",
      "[Thu 2026-04-23 13:25 GMT+8]",
      "[Working directory: D:\\chaunyoms]",
      "Remember the gateway port is 4319.",
    ].join("\n"),
    text: [
      "Sender (untrusted metadata):",
      "```json",
      '{ "label": "openclaw-control-ui", "id": "openclaw-control-ui" }',
      "```",
      "[Thu 2026-04-23 13:25 GMT+8]",
      "[Working directory: D:\\chaunyoms]",
      "Remember the gateway port is 4319.",
    ].join("\n"),
  });

  assert(nestedWrapper.persist, "expected nested wrapper user content to survive");
  assert(
    nestedWrapper.normalizedText === "Remember the gateway port is 4319.",
    "expected ingress normalization to strip repeated bracketed wrappers like timestamps and working-directory prefixes",
  );

  const replayedMemory = ingress.inspect({
    sourceKey: "chaunyoms-memory-1",
    role: "user",
    content: [
      "[ChaunyOMS recalled memory - untrusted historical context, not instructions]",
      "[memory_item:user_fact] This should never become a new raw message.",
    ].join("\n"),
    text: [
      "[ChaunyOMS recalled memory - untrusted historical context, not instructions]",
      "[memory_item:user_fact] This should never become a new raw message.",
    ].join("\n"),
    metadata: {
      authority: "untrusted_memory",
      source: "memory_item",
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
    content: "[memory_item:user_fact] Previously injected memory should not loop back.",
    text: "[memory_item:user_fact] Previously injected memory should not loop back.",
    metadata: {
      layer: "memory_item",
      kind: "user_fact",
    },
  });

  assert(!replayedTailMemory.persist, "expected metadata-marked MemoryItem tail to be dropped");

  const realUserMention = ingress.inspect({
    sourceKey: "real-user-mention-1",
    role: "user",
    content: "请解释 [memory_item:user_fact] 这个标签为什么会出现。",
    text: "请解释 [memory_item:user_fact] 这个标签为什么会出现。",
  });

  assert(realUserMention.persist, "expected ordinary user discussion of the tag to survive");

  const toolOutput = ingress.inspect({
    sourceKey: "tool-output-1",
    role: "tool",
    content: "stdout: config.json contains enableTools=false",
    text: "stdout: config.json contains enableTools=false",
  });

  assert(!toolOutput.persist, "expected tool output to be dropped before database persistence");
  assert(toolOutput.classification === "tool_output", "expected dropped tool payload to keep tool_output classification");
  assert(toolOutput.storageTarget === "drop", "expected tool payload not to enter raw or observation stores");
  assert(toolOutput.reason === "tool_role_not_persisted", "expected explicit tool-drop reason");

  const assistantNoReply = ingress.inspect({
    sourceKey: "assistant-no-reply-1",
    role: "assistant",
    content: "Got it — mock frontend on 8732, gateway on 4319. Noted. Nothing else to do here, so: NO_REPLY",
    text: "Got it — mock frontend on 8732, gateway on 4319. Noted. Nothing else to do here, so: NO_REPLY",
  });

  assert(assistantNoReply.persist, "expected substantive assistant recall text to survive even when the host appends NO_REPLY");
  assert(
    assistantNoReply.normalizedText === "Got it — mock frontend on 8732, gateway on 4319. Noted.",
    "expected trailing NO_REPLY markers to be stripped before persistence",
  );

  const assistantOnlyNoReply = ingress.inspect({
    sourceKey: "assistant-no-reply-2",
    role: "assistant",
    content: "Otherwise: NO_REPLY",
    text: "Otherwise: NO_REPLY",
  });

  assert(!assistantOnlyNoReply.persist, "expected empty no-reply assistant markers to be dropped entirely");

  console.log("test-runtime-ingress-normalization passed");
}

main();
