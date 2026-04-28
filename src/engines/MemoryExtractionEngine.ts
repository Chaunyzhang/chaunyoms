import { createHash } from "node:crypto";

import { ObservationEntry, MemoryItemDraftEntry, RawMessage } from "../types";
import {
  buildStableEventId,
  deriveProjectIdentityFromMessages,
  deriveProjectIdentityFromText,
} from "../utils/projectIdentity";

const USER_MEMORY_PATTERNS = [
  /\b(?:must|need to|should|prefer|plan|will|want to|don't|do not|cannot|can't|blocker|risk|parameter|config|setting|exact)\b/i,
  /(?:需要|必须|偏好|计划|下一步|阻塞|风险|参数|配置|精确)/,
  /\b[a-zA-Z_][\w-]{1,40}\s*[:=]\s*[^\s,;]{1,80}/,
];

const ASSISTANT_MEMORY_PATTERNS = [
  /\b(?:root cause|fixed|fix|changed|decision|next step|recommend|keep|disable|enable|use|set|configured|will do|should)\b/i,
  /(?:根因|修复|改为|决定|下一步|建议|保持|禁用|启用|使用|设置|配置)/,
  /\b[a-zA-Z_][\w-]{1,40}\s*[:=]\s*[^\s,;]{1,80}/,
];

const TOOL_MEMORY_PATTERNS = [
  /\b(?:error|exception|failed|failure|warning|stderr|traceback|root cause)\b/i,
  /\b(?:created|updated|deleted|changed)\b/i,
  /\b(?:src|dist|package|config|port|timeout|token|parameter|setting)\b/i,
  /(?:报错|错误|失败|警告|修改|创建|删除|配置|参数)/,
];

const UNCERTAINTY_PATTERNS = [
  /\b(?:not sure|unclear|need more context|might need|may be missing)\b/i,
  /(?:不确定|不清楚|需要更多上下文|可能缺少信息)/,
];

const STRONG_FACT_ASSIGNMENT_RE = /\b([A-Z][A-Z0-9_]{1,40})\s*=\s*([^\s,;:=]{1,80})/;
const FACT_ASSIGNMENT_RE = /\b([A-Z][A-Z0-9_]{1,40}|[a-zA-Z][\w-]{1,40})\s*[:=]\s*([^\s,;:=]{1,80})/;
const FACT_UPDATE_RE = /\b(?:current|latest|now|updated|correction|corrected|override|new value)\b/i;
const FACT_UPDATE_ZH_RE = /(?:当前|现在|最新|更新为|修正|改为|新值)/;

export class MemoryExtractionEngine {
  extractFromRawMessage(message: RawMessage): MemoryItemDraftEntry[] {
    if (!message.content.trim()) {
      return [];
    }

    if (message.role === "user") {
      return this.extract(
        message,
        "user_fact",
        message.content,
        message.createdAt,
        "raw_message",
        [message.id],
        ["user", "conversation"],
        USER_MEMORY_PATTERNS,
      );
    }

    if (message.role === "assistant") {
      if (UNCERTAINTY_PATTERNS.some((pattern) => pattern.test(message.content))) {
        return [];
      }
      return this.extract(
        message,
        "assistant_decision",
        message.content,
        message.createdAt,
        "raw_message",
        [message.id],
        ["assistant", "decision"],
        ASSISTANT_MEMORY_PATTERNS,
      );
    }

    return [];
  }

  extractFromObservation(observation: ObservationEntry): MemoryItemDraftEntry[] {
    if (observation.classification !== "tool_output") {
      return [];
    }

    return this.extract(
      {
        id: observation.id,
        sessionId: observation.sessionId,
        agentId: observation.agentId,
        role: observation.role,
        content: observation.content,
        turnNumber: 0,
        createdAt: observation.createdAt,
        tokenCount: observation.tokenCount,
        compacted: false,
        metadata: observation.metadata,
      },
      this.classifyToolObservation(observation.content),
      observation.content,
      observation.createdAt,
      "observation",
      [observation.id],
      ["tool", observation.classification],
      TOOL_MEMORY_PATTERNS,
    );
  }

  buildProjectStateMemory(
    sessionId: string,
    createdAt: string,
    snapshot: string,
  ): MemoryItemDraftEntry {
    const identity = deriveProjectIdentityFromText([snapshot], sessionId);
    return {
      id: `memory-${this.hash(`${sessionId}|snapshot|${snapshot}`)}`,
      eventId: buildStableEventId("memory", `${sessionId}|snapshot|${snapshot}`),
      sessionId,
      projectId: identity.projectId,
      topicId: identity.topicId,
      kind: "project_state",
      recordStatus: "active",
      text: snapshot,
      fingerprint: this.hash(`snapshot|${snapshot}`),
      tags: ["project", "state", "navigation"],
      createdAt,
      sourceType: "snapshot",
      sourceIds: [],
      sourceStartTimestamp: createdAt,
      sourceEndTimestamp: createdAt,
    };
  }

  private extract(
    sourceMessage: RawMessage,
    kind: MemoryItemDraftEntry["kind"],
    content: string,
    createdAt: string,
    sourceType: MemoryItemDraftEntry["sourceType"],
    sourceIds: string[],
    baseTags: string[],
    patterns: RegExp[],
  ): MemoryItemDraftEntry[] {
    const segments = this.toSegments(content)
      .filter((segment) => segment.length >= 12)
      .filter((segment) => !this.isLowSignal(segment))
      .filter((segment) => patterns.some((pattern) => pattern.test(segment)))
      .slice(0, 3);

    const identity = deriveProjectIdentityFromMessages([sourceMessage], sourceMessage.sessionId);

    return segments.map((segment) => {
      const structuredFact = this.extractStructuredFact(segment);
      return {
        id: `memory-${this.hash(`${sourceMessage.sessionId}|${kind}|${segment}`)}`,
        eventId: buildStableEventId("memory", `${sourceMessage.sessionId}|${kind}|${segment}`),
        sessionId: sourceMessage.sessionId,
        agentId: sourceMessage.agentId,
        projectId: identity.projectId,
        topicId: identity.topicId,
        kind,
        recordStatus: "active",
        text: segment,
        fingerprint: this.hash(`${kind}|${segment}`),
        tags: [...baseTags, ...this.extractTags(segment)],
        createdAt,
        sourceType,
        sourceIds,
        sourceSequenceMin: sourceMessage.sequence,
        sourceSequenceMax: sourceMessage.sequence,
        sourceStartTimestamp: createdAt,
        sourceEndTimestamp: createdAt,
        metadata: structuredFact
          ? {
              factKey: structuredFact.factKey,
              factValue: structuredFact.factValue,
              factScope: structuredFact.factScope,
              factRecencyHint: structuredFact.factRecencyHint,
            }
          : undefined,
      };
    });
  }

  private classifyToolObservation(content: string): MemoryItemDraftEntry["kind"] {
    if (/\b(?:error|exception|failed|failure|warning|stderr|traceback)\b/i.test(content)) {
      return "diagnostic";
    }
    if (/\b(?:config|parameter|setting|port|timeout|token)\b/i.test(content)) {
      return "constraint";
    }
    return "solution";
  }

  private toSegments(content: string): string[] {
    return content
      .split(/\r?\n+/)
      .flatMap((line) => line.split(/(?<=[.!?。！？])\s+/))
      .map((segment) => segment.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((segment) => (segment.length > 220 ? `${segment.slice(0, 217)}...` : segment));
  }

  private isLowSignal(segment: string): boolean {
    if (/^(?:ok|done|completed|thanks|hello|hi)\b/i.test(segment)) {
      return true;
    }
    if (segment.length < 12) {
      return true;
    }
    return false;
  }

  private extractTags(segment: string): string[] {
    const tags = new Set<string>();
    const lower = segment.toLowerCase();
    if (/error|exception|failed|warning|traceback/.test(lower)) tags.add("error");
    if (/config|setting|parameter|token|timeout|port/.test(lower)) tags.add("config");
    if (/fix|fixed|changed|updated|created|deleted/.test(lower)) tags.add("change");
    if (/next step|plan|todo|decision|risk|blocker/.test(lower)) tags.add("plan");
    const structuredFact = this.extractStructuredFact(segment);
    if (structuredFact) {
      tags.add("fact");
      tags.add(structuredFact.factKey.toLowerCase());
      if (structuredFact.factRecencyHint) {
        tags.add("current");
      }
    }
    return [...tags];
  }

  private extractStructuredFact(segment: string): {
    factKey: string;
    factValue: string;
    factScope: "session";
    factRecencyHint: boolean;
  } | null {
    const match = segment.match(STRONG_FACT_ASSIGNMENT_RE) ?? segment.match(FACT_ASSIGNMENT_RE);
    if (!match) {
      return null;
    }
    return {
      factKey: match[1].trim().toUpperCase(),
      factValue: match[2].trim(),
      factScope: "session",
      factRecencyHint:
        FACT_UPDATE_RE.test(segment) ||
        FACT_UPDATE_ZH_RE.test(segment),
    };
  }

  private hash(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 24);
  }
}
