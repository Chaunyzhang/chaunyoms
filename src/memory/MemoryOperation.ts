export type MemoryOperationType =
  | "add"
  | "update"
  | "merge"
  | "split"
  | "promote"
  | "expire"
  | "lock"
  | "reject";

export type MemoryOperationTargetKind = "memory_item" | "evidence_atom" | "knowledge_raw" | "project_state";
export type MemoryOperationCreator = "llm" | "rule" | "user" | "system";

export interface MemoryOperation {
  operationId: string;
  type: MemoryOperationType;
  targetKind: MemoryOperationTargetKind;
  targetId?: string;
  sourceIds: string[];
  proposedContent?: string;
  reason: string;
  confidence: number;
  createdBy: MemoryOperationCreator;
}

export interface MemoryOperationValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export class MemoryOperationValidator {
  validate(operation: MemoryOperation): MemoryOperationValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!operation.operationId.trim()) {
      errors.push("operationId is required");
    }
    if (!operation.reason.trim()) {
      errors.push("reason is required");
    }
    if (!Number.isFinite(operation.confidence) || operation.confidence < 0 || operation.confidence > 1) {
      errors.push("confidence must be between 0 and 1");
    }
    if (operation.createdBy === "llm" && operation.sourceIds.length === 0) {
      errors.push("llm-created memory operations require at least one sourceId");
    }
    if (["update", "merge", "split", "promote", "expire", "lock", "reject"].includes(operation.type) && !operation.targetId?.trim()) {
      errors.push(`${operation.type} operations require targetId`);
    }
    if ((operation.type === "add" || operation.type === "update" || operation.type === "split") && !operation.proposedContent?.trim()) {
      warnings.push(`${operation.type} operation has no proposedContent; applier must derive content from source-bound policy`);
    }
    const duplicateSourceIds = operation.sourceIds.filter((id, index, list) => list.indexOf(id) !== index);
    if (duplicateSourceIds.length > 0) {
      warnings.push("duplicate sourceIds will be collapsed by the applier");
    }
    return { ok: errors.length === 0, errors, warnings };
  }
}
