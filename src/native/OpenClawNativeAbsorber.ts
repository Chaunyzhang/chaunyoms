import { createHash } from "node:crypto";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { MemoryOperation, MemoryOperationCreator, MemoryOperationValidator } from "../memory/MemoryOperation";
import { BridgeConfig, OpenClawNativeMode } from "../types";

export type OpenClawNativeFeature = "memory_core" | "active_memory" | "memory_wiki" | "dreaming" | "unknown";

export interface OpenClawNativeAbsorbRequest {
  feature?: string;
  pluginId?: string;
  sourceId?: string;
  content: string;
  createdBy?: MemoryOperationCreator;
  confidence?: number;
  apply?: boolean;
  metadata?: Record<string, unknown>;
}

export interface OpenClawNativeAbsorbResult {
  ok: boolean;
  mode: OpenClawNativeMode;
  feature: OpenClawNativeFeature;
  absorbed: boolean;
  observationId?: string;
  candidateId?: string;
  operation?: MemoryOperation;
  validation?: {
    ok: boolean;
    errors: string[];
    warnings: string[];
  };
  flow: string[];
  promoted: boolean;
  becomesMemoryItem: boolean;
  becomesKnowledgeRaw: boolean;
  reason: string;
}

export class OpenClawNativeAbsorber {
  private readonly validator = new MemoryOperationValidator();

  constructor(
    private readonly store: SQLiteRuntimeStore,
    private readonly config: BridgeConfig,
  ) {}

  async absorb(request: OpenClawNativeAbsorbRequest): Promise<OpenClawNativeAbsorbResult> {
    const feature = this.normalizeFeature(request.feature ?? request.pluginId);
    const mode = this.resolveMode(feature);
    if (mode === "disabled") {
      return {
        ok: false,
        mode,
        feature,
        absorbed: false,
        flow: ["disabled"],
        promoted: false,
        becomesMemoryItem: false,
        becomesKnowledgeRaw: false,
        reason: "native_feature_disabled_by_oms_policy",
      };
    }

    const content = request.content.trim();
    if (!content) {
      return {
        ok: false,
        mode,
        feature,
        absorbed: false,
        flow: ["observation_rejected"],
        promoted: false,
        becomesMemoryItem: false,
        becomesKnowledgeRaw: false,
        reason: "native_output_content_required",
      };
    }

    const createdAt = new Date().toISOString();
    const pluginId = request.pluginId?.trim() || this.pluginIdForFeature(feature);
    const sourceId = request.sourceId?.trim();
    const observationId = `native-observation:${this.hash(`${pluginId}:${sourceId ?? ""}:${content}`).slice(0, 24)}`;
    await this.store.upsertRuntimeRecord({
      kind: "openclaw_native_observation",
      id: observationId,
      sessionId: this.config.sessionId,
      agentId: this.config.agentId,
      createdAt,
      updatedAt: createdAt,
      payload: {
        phase: "observation",
        feature,
        pluginId,
        mode,
        sourceId: sourceId ?? null,
        content,
        metadata: request.metadata ?? {},
      },
    });

    if (mode === "coexist") {
      return {
        ok: true,
        mode,
        feature,
        absorbed: false,
        observationId,
        flow: ["observation", "coexist_advisory_only"],
        promoted: false,
        becomesMemoryItem: false,
        becomesKnowledgeRaw: false,
        reason: "native_output_recorded_as_advisory_observation_only",
      };
    }

    if (!sourceId) {
      const validation = this.validator.validate({
        operationId: `native-operation:${observationId}`,
        type: "add",
        targetKind: "memory_item",
        sourceIds: [],
        proposedContent: content,
        reason: "absorbed_openclaw_native_output_requires_explicit_source_id",
        confidence: this.normalizeConfidence(request.confidence),
        createdBy: request.createdBy ?? "llm",
      });
      return {
        ok: false,
        mode,
        feature,
        absorbed: true,
        observationId,
        validation,
        flow: ["observation", "candidate_blocked_before_write"],
        promoted: false,
        becomesMemoryItem: false,
        becomesKnowledgeRaw: false,
        reason: "absorbed_native_output_requires_source_id_before_candidate_validation",
      };
    }

    const candidateId = `native-candidate:${this.hash(`${observationId}:${sourceId}`).slice(0, 24)}`;
    const operation: MemoryOperation = {
      operationId: `native-operation:${candidateId}`,
      type: "add",
      targetKind: "memory_item",
      sourceIds: [sourceId, observationId],
      proposedContent: content,
      reason: "absorbed_openclaw_native_output_enters_oms_validation_pipeline",
      confidence: this.normalizeConfidence(request.confidence),
      createdBy: request.createdBy ?? "llm",
    };
    const validation = this.validator.validate(operation);
    await this.store.upsertRuntimeRecord({
      kind: "openclaw_native_candidate",
      id: candidateId,
      sessionId: this.config.sessionId,
      agentId: this.config.agentId,
      createdAt,
      updatedAt: createdAt,
      payload: {
        phase: "candidate",
        status: validation.ok ? "validated_candidate" : "blocked_invalid_operation",
        feature,
        pluginId,
        observationId,
        sourceId,
        operation,
        validation,
        promotion: {
          requested: request.apply === true,
          status: validation.ok ? "pending_manual_promotion" : "blocked",
          memoryItemWrite: false,
          knowledgeRawWrite: false,
        },
      },
    });

    return {
      ok: validation.ok,
      mode,
      feature,
      absorbed: true,
      observationId,
      candidateId,
      operation,
      validation,
      flow: validation.ok
        ? ["observation", "candidate", "validation", "promotion_pending"]
        : ["observation", "candidate", "validation_blocked"],
      promoted: false,
      becomesMemoryItem: false,
      becomesKnowledgeRaw: false,
      reason: validation.ok
        ? "native_output_absorbed_as_validated_candidate_pending_explicit_promotion"
        : "native_output_candidate_failed_memory_operation_validation",
    };
  }

  private resolveMode(feature: OpenClawNativeFeature): OpenClawNativeMode {
    switch (feature) {
      case "memory_core":
        return this.config.openClawNativeMemoryCoreMode ?? this.config.openClawNativeMode;
      case "active_memory":
        return this.config.openClawNativeActiveMemoryMode ?? this.config.openClawNativeMode;
      case "memory_wiki":
        return this.config.openClawNativeMemoryWikiMode ?? this.config.openClawNativeMode;
      case "dreaming":
        return this.config.openClawNativeDreamingMode ?? this.config.openClawNativeMode;
      default:
        return this.config.openClawNativeMode;
    }
  }

  private normalizeFeature(value: string | undefined): OpenClawNativeFeature {
    const normalized = String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
    switch (normalized) {
      case "memory_core":
      case "memory":
        return "memory_core";
      case "active_memory":
        return "active_memory";
      case "memory_wiki":
      case "wiki":
        return "memory_wiki";
      case "dream":
      case "dreaming":
        return "dreaming";
      default:
        return "unknown";
    }
  }

  private pluginIdForFeature(feature: OpenClawNativeFeature): string {
    switch (feature) {
      case "memory_core":
        return "memory-core";
      case "active_memory":
        return "active-memory";
      case "memory_wiki":
        return "memory-wiki";
      case "dreaming":
        return "dreaming";
      default:
        return "openclaw-native";
    }
  }

  private normalizeConfidence(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : 0.5;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}
