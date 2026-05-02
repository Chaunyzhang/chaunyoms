import type { IngestPayload } from "../host/OpenClawPayloadAdapter";
import type {
  MemoryItemDraftRepository,
  RawMessage,
  RawMessageRepository,
} from "../types";
import type { RuntimeMessageIngress } from "./RuntimeMessageIngress";
import type { SecretIngressGate } from "./SecretIngressGate";
import type { OpenClawProfilePolicy } from "./OpenClawProfilePolicy";
import { estimateTokens } from "../utils/tokenizer";
import { KnowledgeIntentClassifier } from "../engines/KnowledgeIntentClassifier";
import { MemoryExtractionEngine } from "../engines/MemoryExtractionEngine";

export interface SessionIngestServiceDeps {
  appendObservation: (entry: import("../types").ObservationEntry) => Promise<void>;
  appendRawMessage: (message: RawMessage) => Promise<void>;
  profilePolicy: OpenClawProfilePolicy;
  knowledgeIntentClassifier: KnowledgeIntentClassifier;
  extractionEngine: MemoryExtractionEngine;
  persistMemoryItemDrafts: (store: MemoryItemDraftRepository, drafts: import("../types").MemoryItemDraftEntry[]) => Promise<void>;
  resolveNextTurnNumber: (rawStore: RawMessageRepository, role: RawMessage["role"]) => number;
  runtimeIngress: RuntimeMessageIngress;
  secretIngressGate: SecretIngressGate;
  writeMemoryItemArtifacts: () => Promise<void>;
}

export class SessionIngestService {
  constructor(private readonly deps: SessionIngestServiceDeps) {}

  async ingest(
    payload: IngestPayload,
    rawStore: RawMessageRepository,
    memoryItemDraftStore: MemoryItemDraftRepository,
  ): Promise<{ ingested: boolean }> {
    const ingressDecision = this.deps.runtimeIngress.inspect({
      id: payload.id,
      sourceKey: payload.id,
      role: payload.role,
      content: payload.content,
      text: payload.content,
      metadata: payload.metadata,
    });
    if (ingressDecision.storageTarget === "observation") {
      const sanitizedObservation = this.deps.secretIngressGate.sanitize(
        `observation:${payload.sessionId}:${payload.id}`,
        ingressDecision.normalizedText,
        payload.metadata ?? {},
      );
      await this.deps.appendObservation({
        id: `observation-${payload.id}`,
        sessionId: payload.sessionId,
        agentId: payload.config.agentId,
        role: payload.role,
        classification: ingressDecision.classification,
        content: sanitizedObservation.text,
        sourceKey: payload.id,
        createdAt: new Date().toISOString(),
        tokenCount: estimateTokens(sanitizedObservation.text),
        metadata: {
          ...sanitizedObservation.metadata,
          reason: ingressDecision.reason,
          sourceBoundary: "runtime_event_not_source",
        },
      });
      return { ingested: false };
    }

    if (!ingressDecision.persist || ingressDecision.storageTarget !== "raw_message") {
      return { ingested: false };
    }

    const sanitized = this.deps.secretIngressGate.sanitize(
      `ingest:${payload.sessionId}:${payload.id}`,
      ingressDecision.normalizedText,
      payload.metadata ?? {},
    );
    const turnNumber = payload.turnNumber ?? this.deps.resolveNextTurnNumber(rawStore, payload.role);
    const knowledgeIntent = this.deps.profilePolicy.shouldClassifyKnowledgeIntent(payload.config, payload.role)
      ? await this.deps.knowledgeIntentClassifier.classifyUserMessage(sanitized.text, payload.config)
      : null;
    const message: RawMessage = {
      id: payload.id,
      sessionId: payload.sessionId,
      agentId: payload.config.agentId,
      role: payload.role,
      content: sanitized.text,
      turnNumber,
      createdAt: new Date().toISOString(),
      tokenCount: estimateTokens(sanitized.text),
      compacted: false,
      metadata: {
        ...sanitized.metadata,
        ingressClassification: ingressDecision.classification,
        ingressReason: ingressDecision.reason,
        ...(knowledgeIntent ? { knowledgeIntent } : {}),
      },
    };
    await this.deps.appendRawMessage(message);
    await this.deps.persistMemoryItemDrafts(
      memoryItemDraftStore,
      this.deps.extractionEngine.extractFromRawMessage(message),
    );
    await this.deps.writeMemoryItemArtifacts();
    return { ingested: true };
  }
}
