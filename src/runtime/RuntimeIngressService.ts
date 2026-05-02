import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { estimateTokens } from "../utils/tokenizer";
import { RuntimeMessageIngress } from "./RuntimeMessageIngress";
import { IngestPayload, LifecycleContext, RuntimeMessageSnapshot } from "../host/OpenClawPayloadAdapter";
import {
  ContextItem,
  MemoryItemDraftEntry,
  MemoryItemDraftRepository,
  RawMessage,
  RawMessageRepository,
} from "../types";
import { MemoryExtractionEngine } from "../engines/MemoryExtractionEngine";
import { KnowledgeIntentClassifier } from "../engines/KnowledgeIntentClassifier";
import { SessionDataStores } from "../data/SessionDataLayer";
import { SecretIngressGate } from "./SecretIngressGate";
import { getOpenClawHomeDir } from "../host/HostPathResolver";

interface RuntimeIngressDependencies {
  runtimeIngress: RuntimeMessageIngress;
  extractionEngine: MemoryExtractionEngine;
  knowledgeIntentClassifier: KnowledgeIntentClassifier;
  ensureSession: (sessionId: string, config: IngestPayload["config"]) => Promise<SessionDataStores>;
  appendRawMessages: (messages: RawMessage[]) => Promise<void>;
  persistMemoryItemDrafts: (
    memoryItemDraftStore: MemoryItemDraftRepository,
    entries: MemoryItemDraftEntry[],
  ) => Promise<void>;
}

export class RuntimeIngressService {
  private readonly secretIngressGate = new SecretIngressGate();

  constructor(private readonly deps: RuntimeIngressDependencies) {}

  async syncRuntimeMessages(
    sessionId: string,
    config: IngestPayload["config"],
    runtimeMessages: RuntimeMessageSnapshot[],
  ): Promise<{ importedMessages: number }> {
    if (!config.runtimeCaptureEnabled || config.emergencyBrake) {
      return { importedMessages: 0 };
    }

    const { rawStore, memoryItemDraftStore } = await this.deps.ensureSession(sessionId, config);
    const alignedRuntimeMessages = await this.alignWithOpenClawSessionStore(sessionId, config, runtimeMessages);
    const inspectedMessages = alignedRuntimeMessages.map((message) => ({
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
    const memoryItemDraftsToImport: MemoryItemDraftEntry[] = [];

    for (let index = 0; index < pendingRawMessages.length; index += 1) {
      const message = pendingRawMessages[index];
      const sanitized = this.secretIngressGate.sanitize(
        `runtime-message:${message.sourceKey}`,
        message.text,
        message.metadata ?? {},
      );
      currentTurn = this.resolveRuntimeTurnNumber(currentTurn, message.role);
      const knowledgeIntent = message.role === "user" && config.openClawRuntimeProfile !== "lightweight"
        ? await this.deps.knowledgeIntentClassifier.classifyUserMessage(sanitized.text, config)
        : null;
      const rawMessage: RawMessage = {
        id: message.id ?? this.buildRuntimeMessageId(sessionId, message.role, sanitized.text, currentTurn, overlap + index),
        sessionId,
        agentId: config.agentId,
        role: message.role,
        content: sanitized.text,
        turnNumber: currentTurn,
        createdAt: this.resolveRuntimeTimestamp(message.timestamp),
        tokenCount: estimateTokens(sanitized.text),
        compacted: false,
        metadata: {
          ...sanitized.metadata,
          importedFromRuntimeMessages: true,
          importedSourceKey: message.sourceKey,
          runtimeIndex: overlap + index,
          ...(knowledgeIntent ? { knowledgeIntent } : {}),
        },
      };
      rawMessagesToImport.push(rawMessage);
      memoryItemDraftsToImport.push(...this.deps.extractionEngine.extractFromRawMessage(rawMessage));
      existingSourceKeys.add(message.sourceKey);
      importedMessages += 1;
    }

    await this.deps.appendRawMessages(rawMessagesToImport);
    await this.deps.persistMemoryItemDrafts(memoryItemDraftStore, memoryItemDraftsToImport);

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
      const sanitized = this.secretIngressGate.sanitize(
        `runtime-tail:${message.sourceKey}`,
        message.text,
        message.metadata ?? {},
      );
      const tokenCount = Math.max(estimateTokens(sanitized.text), 1);
      if (selected.length > 0 && consumed + tokenCount > Math.min(availableBudget, freshTailTokens)) {
        break;
      }
      selected.unshift({
        kind: "message",
        tokenCount,
        role: message.role,
        content: sanitized.text,
        metadata: {
          ...sanitized.metadata,
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

  private async alignWithOpenClawSessionStore(
    sessionId: string,
    config: IngestPayload["config"],
    runtimeMessages: RuntimeMessageSnapshot[],
  ): Promise<RuntimeMessageSnapshot[]> {
    const runtimeConversation = runtimeMessages.filter((message) =>
      message.role === "user" || message.role === "assistant",
    );
    const runtimeAssistantCount = runtimeConversation.filter((message) => message.role === "assistant").length;
    const runtimeUserCount = runtimeConversation.filter((message) => message.role === "user").length;
    if (runtimeUserCount === 0 || runtimeAssistantCount >= runtimeUserCount) {
      return runtimeMessages;
    }

    const sessionMessages = await this.readOpenClawSessionMessages(config.agentId, sessionId);
    const sessionAssistantCount = sessionMessages.filter((message) => message.role === "assistant").length;
    if (sessionAssistantCount <= runtimeAssistantCount) {
      return runtimeMessages;
    }

    const nonConversationRuntimeMessages = runtimeMessages.filter((message) =>
      message.role !== "user" && message.role !== "assistant",
    );
    return [...sessionMessages, ...nonConversationRuntimeMessages];
  }

  private async readOpenClawSessionMessages(
    agentId: string,
    sessionId: string,
  ): Promise<RuntimeMessageSnapshot[]> {
    const sessionPath = path.join(
      getOpenClawHomeDir(),
      "agents",
      agentId,
      "sessions",
      `${sessionId}.jsonl`,
    );
    try {
      const raw = await readFile(sessionPath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const snapshots: RuntimeMessageSnapshot[] = [];
      for (const line of lines) {
        const record = JSON.parse(line) as {
          type?: string;
          id?: string;
          timestamp?: string;
          message?: {
            role?: string;
            content?: unknown;
            timestamp?: number | string;
          };
        };
        if (record.type !== "message") {
          continue;
        }
        const role = record.message?.role;
        if (role !== "user" && role !== "assistant") {
          continue;
        }
        const text = this.extractTextFromSessionContent(record.message?.content);
        if (!text) {
          continue;
        }
        snapshots.push({
          sourceKey: record.id ? `session:${record.id}` : `session-derived:${role}:${this.normalizeMessageText(text)}`,
          id: typeof record.id === "string" ? record.id : undefined,
          role,
          content: record.message?.content,
          text,
          timestamp: record.timestamp ?? record.message?.timestamp,
          metadata: {
            source: "openclaw_session_store",
            origin: "openclaw_session_store",
            sessionStoreSessionId: sessionId,
          },
        });
      }
      return snapshots.slice(-24);
    } catch {
      return [];
    }
  }

  private extractTextFromSessionContent(content: unknown): string {
    if (typeof content === "string") {
      return content.trim();
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter((value) => value.trim().length > 0)
      .join("\n")
      .trim();
  }
}
