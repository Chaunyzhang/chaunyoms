import { createHash } from "node:crypto";

import { MemoryIntentDetector } from "../runtime/MemoryIntentDetector";
import {
  DurableMemoryEntry,
  KnowledgeRawEntry,
  KnowledgeRawKind,
  MemoryIntent,
  ObservationEntry,
  RawMessage,
} from "../types";
import {
  buildStableEventId,
  deriveProjectIdentityFromMessages,
  deriveProjectIdentityFromText,
} from "../utils/projectIdentity";

const TEMPORARY_PATTERNS = [
  /等下/i,
  /待会/i,
  /今天先/i,
  /稍后/i,
  /this turn/i,
  /later today/i,
  /\bremind me\b/i,
];

export class KnowledgeRawAdmissionEngine {
  private readonly intentDetector = new MemoryIntentDetector();

  admitFromRawMessage(message: RawMessage, extracted: DurableMemoryEntry[]): KnowledgeRawEntry[] {
    const intent = this.intentDetector.inspectRawMessage(message);
    const admitted = extracted
      .map((entry) => this.toKnowledgeRaw(entry, intent.intent, intent.confidence, intent.trigger))
      .filter((entry): entry is KnowledgeRawEntry => Boolean(entry));

    if (admitted.length > 0 || intent.intent === "none" || intent.intent === "temporary_remember") {
      return admitted;
    }

    const fallback = this.buildFallbackFromRawMessage(message, intent.intent, intent.confidence, intent.trigger);
    return fallback ? [fallback] : admitted;
  }

  admitFromObservation(observation: ObservationEntry, extracted: DurableMemoryEntry[]): KnowledgeRawEntry[] {
    const intent = this.intentDetector.inspectObservation(observation);
    return extracted
      .map((entry) => this.toKnowledgeRaw(entry, intent.intent, intent.confidence, intent.trigger))
      .filter((entry): entry is KnowledgeRawEntry => Boolean(entry));
  }

  private toKnowledgeRaw(
    entry: DurableMemoryEntry,
    memoryIntent: MemoryIntent,
    confidence: number,
    trigger?: string,
  ): KnowledgeRawEntry | null {
    const text = entry.text.replace(/\s+/g, " ").trim();
    if (!text || TEMPORARY_PATTERNS.some((pattern) => pattern.test(text))) {
      return null;
    }

    const stabilityScore = this.scoreStability(entry, memoryIntent);
    const reusabilityScore = this.scoreReusability(entry, memoryIntent);
    if (stabilityScore < 0.45 || reusabilityScore < 0.5) {
      return null;
    }

    return {
      id: `knowledge-raw-${this.hash(`${entry.sessionId}|${entry.kind}|${text}`)}`,
      eventId: buildStableEventId("knowledge-raw", `${entry.sessionId}|${entry.kind}|${text}`),
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      projectId: entry.projectId,
      topicId: entry.topicId,
      kind: this.normalizeKind(entry, memoryIntent),
      recordStatus: entry.recordStatus ?? "active",
      supersededById: entry.supersededById,
      text,
      fingerprint: this.hash(`${entry.kind}|${text}|${memoryIntent}`),
      tags: [...new Set([...entry.tags, "knowledge-raw", memoryIntent].filter((tag) => tag && tag !== "none"))],
      createdAt: entry.createdAt,
      sourceType: entry.sourceType,
      sourceIds: entry.sourceIds,
      sourceSequenceMin: entry.sourceSequenceMin,
      sourceSequenceMax: entry.sourceSequenceMax,
      sourceStartTimestamp: entry.sourceStartTimestamp,
      sourceEndTimestamp: entry.sourceEndTimestamp,
      memoryIntent,
      memoryIntentConfidence: confidence,
      memoryIntentTrigger: trigger,
      stabilityScore,
      reusabilityScore,
      metadata: {
        ...(entry.metadata ?? {}),
        durableKind: entry.kind,
      },
    };
  }

  private buildFallbackFromRawMessage(
    message: RawMessage,
    memoryIntent: MemoryIntent,
    confidence: number,
    trigger?: string,
  ): KnowledgeRawEntry | null {
    const text = this.normalizeRememberedText(message.content);
    if (!text || TEMPORARY_PATTERNS.some((pattern) => pattern.test(text))) {
      return null;
    }

    const identity = deriveProjectIdentityFromMessages([message], message.sessionId);
    const kind = this.fallbackKind(text, memoryIntent);
    const stabilityScore = memoryIntent === "preference_memory" ? 0.88 : 0.72;
    const reusabilityScore = memoryIntent === "project_memory" ? 0.84 : 0.68;

    return {
      id: `knowledge-raw-${this.hash(`${message.sessionId}|fallback|${text}`)}`,
      eventId: buildStableEventId("knowledge-raw", `${message.sessionId}|fallback|${text}`),
      sessionId: message.sessionId,
      agentId: message.agentId,
      projectId: identity.projectId,
      topicId: identity.topicId,
      kind,
      text,
      fingerprint: this.hash(`fallback|${kind}|${text}|${memoryIntent}`),
      tags: [...new Set(["knowledge-raw", memoryIntent, kind, ...this.extractTags(text)].filter(Boolean))],
      createdAt: message.createdAt,
      sourceType: "raw_message",
      sourceIds: [message.id],
      sourceSequenceMin: message.sequence,
      sourceSequenceMax: message.sequence,
      sourceStartTimestamp: message.createdAt,
      sourceEndTimestamp: message.createdAt,
      memoryIntent,
      memoryIntentConfidence: confidence,
      memoryIntentTrigger: trigger,
      stabilityScore,
      reusabilityScore,
      metadata: {
        ...(message.metadata ?? {}),
        generatedBy: "knowledge_raw_fallback",
      },
    };
  }

  private scoreStability(entry: DurableMemoryEntry, memoryIntent: MemoryIntent): number {
    let score = 0.5;
    if (entry.kind === "constraint" || entry.kind === "project_state") score += 0.18;
    if (entry.kind === "assistant_decision" || entry.kind === "solution") score += 0.14;
    if (entry.tags.includes("config") || entry.tags.includes("change")) score += 0.1;
    if (memoryIntent === "project_memory" || memoryIntent === "preference_memory") score += 0.14;
    if (memoryIntent === "temporary_remember") score -= 0.4;
    return Math.max(0, Math.min(1, score));
  }

  private scoreReusability(entry: DurableMemoryEntry, memoryIntent: MemoryIntent): number {
    let score = 0.48;
    if (entry.kind === "constraint" || entry.kind === "solution" || entry.kind === "assistant_decision") score += 0.2;
    if (entry.kind === "diagnostic") score += 0.12;
    if (entry.text.length >= 24) score += 0.08;
    if (entry.tags.includes("config") || entry.tags.includes("plan")) score += 0.1;
    if (memoryIntent === "explicit_remember" || memoryIntent === "project_memory") score += 0.1;
    if (memoryIntent === "temporary_remember") score -= 0.35;
    return Math.max(0, Math.min(1, score));
  }

  private normalizeKind(entry: DurableMemoryEntry, memoryIntent: MemoryIntent): KnowledgeRawKind {
    if (memoryIntent === "preference_memory") {
      return "preference";
    }
    return entry.kind;
  }

  private fallbackKind(text: string, memoryIntent: MemoryIntent): KnowledgeRawKind {
    if (memoryIntent === "preference_memory") {
      return "preference";
    }
    if (/(必须|不能|不要|默认|only|must|should not|cannot|can't|config|配置|约束)/i.test(text)) {
      return "constraint";
    }
    if (/(决定|改为|采用|use|switch to|policy|规则)/i.test(text)) {
      return "assistant_decision";
    }
    const identity = deriveProjectIdentityFromText([text], "knowledge-raw");
    return identity.canonicalKey ? "user_fact" : "project_state";
  }

  private normalizeRememberedText(text: string): string {
    return text
      .replace(/^(?:请)?(?:帮我)?记(?:一下|住)?[:：,\s-]*/i, "")
      .replace(/^(?:remember this|please remember|note this)[:：,\s-]*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractTags(text: string): string[] {
    const tags = new Set<string>();
    const lower = text.toLowerCase();
    if (/config|配置|参数|setting|default|pnpm|npm/.test(lower)) tags.add("config");
    if (/project|repo|仓库|项目|workspace/.test(lower)) tags.add("project");
    if (/prefer|默认|以后|always/.test(lower)) tags.add("preference");
    if (/must|constraint|不能|必须|不要/.test(lower)) tags.add("constraint");
    return [...tags];
  }

  private hash(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 24);
  }
}
