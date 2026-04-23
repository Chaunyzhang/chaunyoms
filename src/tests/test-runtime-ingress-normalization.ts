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

  console.log("test-runtime-ingress-normalization passed");
}

main();
