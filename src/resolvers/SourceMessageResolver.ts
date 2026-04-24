import {
  EvidenceBinding,
  RawMessage,
  RawMessageRepository,
  SourceTrace,
  SummaryEntry,
} from "../types";
import { hashRawMessages } from "../utils/integrity";

export type SourceMessageResolutionStrategy =
  | "message_ids"
  | "sequence_range"
  | "turn_range"
  | "none";

export interface SourceMessageResolution {
  binding: EvidenceBinding;
  messages: RawMessage[];
  strategy: SourceMessageResolutionStrategy;
  verified: boolean;
  reason: string;
  actualHash?: string;
  actualMessageCount?: number;
}

export class SourceMessageResolver {
  static bindingFromSummary(summary: SummaryEntry): EvidenceBinding {
    if (summary.sourceBinding) {
      return {
        ...summary.sourceBinding,
        scope: summary.sourceBinding.scope ?? "agent",
        sessionId: summary.sourceBinding.sessionId || summary.sessionId,
        agentId: summary.sourceBinding.agentId ?? summary.agentId,
        messageIds: [...new Set(summary.sourceBinding.messageIds ?? [])],
        sourceHash: summary.sourceBinding.sourceHash ?? summary.sourceHash,
        sourceMessageCount:
          summary.sourceBinding.sourceMessageCount ?? summary.sourceMessageCount,
      };
    }

    return {
      scope: "agent",
      sessionId: summary.sessionId,
      agentId: summary.agentId,
      messageIds: [...new Set(summary.sourceMessageIds ?? [])],
      sequenceMin: summary.sourceSequenceMin,
      sequenceMax: summary.sourceSequenceMax,
      turnStart: summary.startTurn,
      turnEnd: summary.endTurn,
      sourceHash: summary.sourceHash,
      sourceMessageCount: summary.sourceMessageCount,
    };
  }

  static bindingFromMessages(args: {
    sessionId: string;
    agentId?: string;
    messages: RawMessage[];
    sourceHash?: string;
    sourceMessageCount?: number;
  }): EvidenceBinding {
    const { sessionId, agentId, messages } = args;
    return {
      scope: "agent",
      sessionId,
      agentId,
      messageIds: [...new Set(messages.map((message) => message.id))],
      sequenceMin: messages[0]?.sequence,
      sequenceMax: messages[messages.length - 1]?.sequence,
      turnStart: messages[0]?.turnNumber,
      turnEnd: messages[messages.length - 1]?.turnNumber,
      sourceHash: args.sourceHash ?? hashRawMessages(messages),
      sourceMessageCount: args.sourceMessageCount ?? messages.length,
    };
  }

  static traceFromResolution(
    resolution: SourceMessageResolution,
    args: {
      route: SourceTrace["route"];
      summaryId?: string;
    },
  ): SourceTrace {
    const { binding } = resolution;
    return {
      route: args.route,
      summaryId: args.summaryId,
      sessionId: binding.sessionId,
      agentId: binding.agentId,
      strategy: resolution.strategy,
      verified: resolution.verified,
      reason: resolution.reason,
      sourceHash: binding.sourceHash,
      actualHash: resolution.actualHash,
      sourceMessageCount: binding.sourceMessageCount,
      resolvedMessageCount: resolution.messages.length,
      turnStart: binding.turnStart,
      turnEnd: binding.turnEnd,
      sequenceMin: binding.sequenceMin,
      sequenceMax: binding.sequenceMax,
      messageIds: binding.messageIds.length > 0 ? binding.messageIds : undefined,
    };
  }

  resolve(
    rawStore: RawMessageRepository,
    bindingOrSummary: EvidenceBinding | SummaryEntry,
  ): SourceMessageResolution {
    const binding = this.normalizeBinding(bindingOrSummary);
    const query = { sessionId: binding.sessionId };

    if (binding.messageIds.length > 0) {
      const byIds = rawStore.getByIds(binding.messageIds, query);
      if (byIds.length > 0) {
        return this.finalize(binding, byIds, "message_ids");
      }
    }

    if (
      Number.isFinite(binding.sequenceMin) &&
      Number.isFinite(binding.sequenceMax)
    ) {
      const bySequence = rawStore.getBySequenceRange(
        binding.sequenceMin as number,
        binding.sequenceMax as number,
        query,
      );
      if (bySequence.length > 0) {
        return this.finalize(binding, bySequence, "sequence_range");
      }
    }

    if (
      Number.isFinite(binding.turnStart) &&
      Number.isFinite(binding.turnEnd)
    ) {
      const byTurn = rawStore.getByRange(
        binding.turnStart as number,
        binding.turnEnd as number,
        query,
      );
      if (byTurn.length > 0) {
        return this.finalize(binding, byTurn, "turn_range");
      }
    }

    return {
      binding,
      messages: [],
      strategy: "none",
      verified: false,
      reason: "source_messages_not_found",
    };
  }

  private normalizeBinding(bindingOrSummary: EvidenceBinding | SummaryEntry): EvidenceBinding {
    if ("summary" in bindingOrSummary) {
      return SourceMessageResolver.bindingFromSummary(bindingOrSummary);
    }

    return {
      ...bindingOrSummary,
      scope: bindingOrSummary.scope ?? "agent",
      messageIds: [...new Set(bindingOrSummary.messageIds ?? [])],
    };
  }

  private finalize(
    binding: EvidenceBinding,
    messages: RawMessage[],
    strategy: SourceMessageResolutionStrategy,
  ): SourceMessageResolution {
    const actualHash = hashRawMessages(messages);
    const actualMessageCount = messages.length;
    const countMatches =
      typeof binding.sourceMessageCount !== "number" ||
      binding.sourceMessageCount === actualMessageCount;
    const hashMatches =
      !binding.sourceHash ||
      binding.sourceHash === actualHash;
    const verified = countMatches && hashMatches;
    return {
      binding,
      messages,
      strategy,
      verified,
      reason: verified ? "source_messages_verified" : "source_messages_integrity_mismatch",
      actualHash,
      actualMessageCount,
    };
  }
}
