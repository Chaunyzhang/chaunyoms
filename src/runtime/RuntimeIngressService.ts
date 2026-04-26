import { createHash } from "node:crypto";

import { estimateTokens } from "../utils/tokenizer";
import { RuntimeMessageIngress } from "./RuntimeMessageIngress";
import { IngestPayload, LifecycleContext, RuntimeMessageSnapshot } from "../host/OpenClawPayloadAdapter";
import {
  ContextItem,
  DurableMemoryEntry,
  DurableMemoryRepository,
  RawMessage,
  RawMessageRepository,
} from "../types";
import { MemoryExtractionEngine } from "../engines/MemoryExtractionEngine";
import { SessionDataStores } from "../data/SessionDataLayer";

interface RuntimeIngressDependencies {
  runtimeIngress: RuntimeMessageIngress;
  extractionEngine: MemoryExtractionEngine;
  ensureSession: (sessionId: string, config: IngestPayload["config"]) => Promise<SessionDataStores>;
  appendRawMessages: (messages: RawMessage[]) => Promise<void>;
  persistDurableMemories: (
    durableMemoryStore: DurableMemoryRepository,
    entries: DurableMemoryEntry[],
  ) => Promise<void>;
}

export class RuntimeIngressService {
  constructor(private readonly deps: RuntimeIngressDependencies) {}

  async syncRuntimeMessages(
    sessionId: string,
    config: IngestPayload["config"],
    runtimeMessages: RuntimeMessageSnapshot[],
  ): Promise<{ importedMessages: number }> {
    if (!config.runtimeCaptureEnabled || config.emergencyBrake) {
      return { importedMessages: 0 };
    }

    const { rawStore, durableMemoryStore } = await this.deps.ensureSession(sessionId, config);
    const inspectedMessages = runtimeMessages.map((message) => ({
      message,
      decision: this.deps.runtimeIngress.inspect(message),
    }));
    const normalizedMessages = inspectedMessages
      .filter(({ decision }) => decision.persist)
      .map(({ message, decision }) => ({
        ...message,
        text: decision.normalizedText,
        storageTarget: decision.storageTarget,
        metadata: {
          ...(message.metadata ?? {}),
          runtimeClassification: decision.classification,
          runtimePersistenceReason: decision.reason,
        },
      }));

    if (normalizedMessages.length === 0) {
      return { importedMessages: 0 };
    }

    const rawCandidates = normalizedMessages.filter((message) => message.storageTarget === "raw_message");

    const existingMessages = rawStore
      .getAll()
      .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool");
    const existingSourceKeys = new Set(
      existingMessages
        .map((message) => {
          const sourceKey = message.metadata?.importedSourceKey;
          return typeof sourceKey === "string" ? sourceKey : null;
        })
        .filter((value): value is string => Boolean(value)),
    );
    const overlap = this.findRuntimeOverlap(existingMessages, rawCandidates);
    const pendingRawMessages = rawCandidates
      .slice(overlap)
      .filter((message) => !existingSourceKeys.has(message.sourceKey));

    let importedMessages = 0;
    let currentTurn = existingMessages[existingMessages.length - 1]?.turnNumber ?? 0;
    const rawMessagesToImport: RawMessage[] = [];
    const durableMemoryEntriesToImport: DurableMemoryEntry[] = [];

    for (let index = 0; index < pendingRawMessages.length; index += 1) {
      const message = pendingRawMessages[index];
      currentTurn = this.resolveRuntimeTurnNumber(currentTurn, message.role);
      const rawMessage: RawMessage = {
        id: message.id ?? this.buildRuntimeMessageId(sessionId, message.role, message.text, currentTurn, overlap + index),
        sessionId,
        agentId: config.agentId,
        role: message.role,
        content: message.text,
        turnNumber: currentTurn,
        createdAt: this.resolveRuntimeTimestamp(message.timestamp),
        tokenCount: estimateTokens(message.text),
        compacted: false,
        metadata: {
          ...(message.metadata ?? {}),
          importedFromRuntimeMessages: true,
          importedSourceKey: message.sourceKey,
          runtimeIndex: overlap + index,
        },
      };
      rawMessagesToImport.push(rawMessage);
      durableMemoryEntriesToImport.push(...this.deps.extractionEngine.extractFromRawMessage(rawMessage));
      existingSourceKeys.add(message.sourceKey);
      importedMessages += 1;
    }

    await this.deps.appendRawMessages(rawMessagesToImport);
    await this.deps.persistDurableMemories(durableMemoryStore, durableMemoryEntriesToImport);

    return { importedMessages };
  }

  resolveActiveUserQuery(
    rawStore: RawMessageRepository,
    runtimeMessages: RuntimeMessageSnapshot[],
  ): string | undefined {
    for (let index = runtimeMessages.length - 1; index >= 0; index -= 1) {
      const message = runtimeMessages[index];
      if (message.role === "user" && message.text.trim().length > 0) {
        return message.text.trim();
      }
    }
    const messages = rawStore.getAll();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "user" && message.content.trim().length > 0) {
        return message.content.trim();
      }
    }
    return undefined;
  }

  buildRuntimeMessageTailFallback(
    context: LifecycleContext,
    availableBudget: number,
    freshTailTokens: number,
    maxFreshTailTurns: number,
  ): ContextItem[] {
    const selected: ContextItem[] = [];
    let consumed = 0;
    let turns = 0;
    for (let index = context.runtimeMessages.length - 1; index >= 0; index -= 1) {
      const message = context.runtimeMessages[index];
      if (!message.text.trim()) {
        continue;
      }
      const tokenCount = Math.max(estimateTokens(message.text), 1);
      if (selected.length > 0 && consumed + tokenCount > Math.min(availableBudget, freshTailTokens)) {
        break;
      }
      selected.unshift({
        kind: "message",
        tokenCount,
        role: message.role,
        content: message.text,
        metadata: {
          ...(message.metadata ?? {}),
          source: "runtime_tail_fallback",
          sourceKey: message.sourceKey,
        },
      });
      consumed += tokenCount;
      if (message.role === "user") {
        turns += 1;
      }
      if (turns >= maxFreshTailTurns) {
        break;
      }
    }
    return selected;
  }

  private resolveRuntimeTurnNumber(currentTurn: number, role: RawMessage["role"]): number {
    if (role === "user") {
      return Math.max(currentTurn + 1, 1);
    }
    return currentTurn > 0 ? currentTurn : 1;
  }

  private findRuntimeOverlap(
    existingMessages: RawMessage[],
    runtimeMessages: Array<RuntimeMessageSnapshot & { storageTarget?: string }>,
  ): number {
    const maxOverlap = Math.min(existingMessages.length, runtimeMessages.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      let matched = true;
      for (let index = 0; index < overlap; index += 1) {
        const existing = existingMessages[existingMessages.length - overlap + index];
        const runtime = runtimeMessages[index];
        if (
          existing.role !== runtime.role ||
          this.normalizeMessageText(existing.content) !== this.normalizeMessageText(runtime.text)
        ) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return overlap;
      }
    }
    return 0;
  }

  private normalizeMessageText(content: string): string {
    return content.replace(/\s+/g, " ").trim();
  }

  private buildRuntimeMessageId(
    sessionId: string,
    role: RawMessage["role"],
    content: string,
    turnNumber: number,
    runtimeIndex: number,
  ): string {
    const digest = createHash("sha256")
      .update(`${sessionId}|${role}|${turnNumber}|${runtimeIndex}|${this.normalizeMessageText(content)}`, "utf8")
      .digest("hex")
      .slice(0, 24);
    return `runtime-${digest}`;
  }

  private resolveRuntimeTimestamp(timestamp?: number | string): string {
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
    if (typeof timestamp === "string" && timestamp.trim().length > 0) {
      const parsed = new Date(timestamp);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    return new Date().toISOString();
  }
}
