import { MemoryOperationValidator } from "../memory/MemoryOperation";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const validator = new MemoryOperationValidator();
  const invalid = validator.validate({
    operationId: "op-1",
    type: "add",
    targetKind: "memory_item",
    sourceIds: [],
    proposedContent: "Store this.",
    reason: "llm proposal",
    confidence: 0.8,
    createdBy: "llm",
  });
  assert(!invalid.ok, "LLM operations must not apply without source binding");
  assert(invalid.errors.some((error) => error.includes("sourceId")), "source binding error should be explicit");

  const valid = validator.validate({
    operationId: "op-2",
    type: "update",
    targetKind: "memory_item",
    targetId: "memory-item:1",
    sourceIds: ["m-1"],
    proposedContent: "Updated content.",
    reason: "source-backed correction",
    confidence: 0.9,
    createdBy: "llm",
  });
  assert(valid.ok, "source-bound LLM operation should pass validation");

  const targetless = validator.validate({
    operationId: "op-3",
    type: "promote",
    targetKind: "knowledge_raw",
    sourceIds: ["summary-1"],
    reason: "promote candidate",
    confidence: 0.7,
    createdBy: "rule",
  });
  assert(!targetless.ok, "non-add operations that mutate existing records require targetId");
  console.log("test-memory-operation-validator passed");
}

void main();
