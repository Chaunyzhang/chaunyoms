import { estimateTokens } from "../utils/tokenizer";
import type {
  ContextItem,
  DagTraversalStep,
  EvidenceAtomEntry,
  RecallResult,
  SourceTrace,
} from "../types";
import type {
  AtomEvidenceHealth,
  CompactDagTraceArgs,
  CompactTraceArgs,
  EvidenceGateResult,
  PersistentEvidenceMergeResultArgs,
} from "./RetrievalServiceContracts";

export class EvidenceResolutionService {
  withPersistentEvidenceAtomHits(args: PersistentEvidenceMergeResultArgs): RecallResult {
    const { result, atoms, recallBudget } = args;
    if (atoms.length === 0) {
      return result;
    }
    const atomBudget = Math.max(300, Math.min(1600, Math.floor(recallBudget * 0.3)));
    const atomItems: ContextItem[] = [];
    let consumed = 0;
    for (const atom of atoms) {
      const item = this.buildPersistentEvidenceAtomItem(atom);
      if (consumed + item.tokenCount > atomBudget && atomItems.length > 0) {
        break;
      }
      atomItems.push(item);
      consumed += item.tokenCount;
    }
    if (atomItems.length === 0) {
      return result;
    }

    const existingAtomIds = new Set(
      result.items
        .map((item) => item.metadata?.atomId)
        .filter((value): value is string => typeof value === "string"),
    );
    const prependedItems = atomItems.filter((item) => {
      const atomId = item.metadata?.atomId;
      return typeof atomId !== "string" || !existingAtomIds.has(atomId);
    });
    if (prependedItems.length === 0) {
      return result;
    }

    return {
      ...result,
      items: [...prependedItems, ...result.items],
      consumedTokens: result.consumedTokens + prependedItems.reduce((sum, item) => sum + item.tokenCount, 0),
      sourceTrace: [
        ...prependedItems.map((item) => this.buildPersistentEvidenceAtomTrace(item)),
        ...result.sourceTrace,
      ],
      strategy: result.strategy ?? "summary_navigation",
    };
  }

  queryNeedsRawSource(query: string): boolean {
    return /(quote|verbatim|exact wording|original text|raw source|source span|trace raw|原文|原话|逐字|引用|精确出处|源消息|源码片段)/i.test(query);
  }

  evaluateEvidenceGate(
    query: string,
    items: ContextItem[],
    result: RecallResult,
  ): EvidenceGateResult {
    const atomHealth = this.evaluateAtomEvidenceHealth(items);
    const { atomHitCount, usableAtomCount } = atomHealth;
    const verifiedTraceCount = result.sourceTrace.filter((trace) => trace.verified).length;
    const verifiedAnswerCount = (result.answerCandidates ?? []).filter((candidate) => candidate.sourceVerified).length;
    if (items.length === 0 && verifiedAnswerCount === 0) {
      return {
        status: "insufficient",
        reason: "no selected context item or verified answer candidate",
        atomHitCount,
        usableAtomCount,
        verifiedTraceCount,
        recommendedAction: "no_answer",
        nextActionHint: "Do not answer from memory; ask a targeted clarification or report not found.",
        targetIds: [],
      };
    }
    if (this.queryNeedsRawSource(query)) {
      const targetIds = this.extractTraceTargetIds(items, result);
      return {
        status: verifiedTraceCount > 0 ? "sufficient" : "needs_expansion",
        reason: verifiedTraceCount > 0
          ? "raw-source-sensitive query has verified trace"
          : "raw-source-sensitive query should trace raw spans before answering",
        atomHitCount,
        usableAtomCount,
        verifiedTraceCount,
        recommendedAction: verifiedTraceCount > 0 ? "answer" : "trace_raw",
        nextActionHint: verifiedTraceCount > 0
          ? "Answer, but cite the traced source handle when precision matters."
          : "Call oms_trace/oms_expand on a listed atomId, summaryId, or messageId before answering.",
        targetIds,
      };
    }
    if (usableAtomCount > 0 || verifiedAnswerCount > 0) {
      return {
        status: "sufficient",
        reason: usableAtomCount > 0
          ? "selected context includes usable evidence atoms"
          : "selected answer candidates have verified source evidence",
        atomHitCount,
        usableAtomCount,
        verifiedTraceCount,
        recommendedAction: "answer",
        nextActionHint: "Answer from the selected evidence atoms; expand only if the user asks for exact wording.",
        targetIds: this.extractTraceTargetIds(items, result),
      };
    }
    if (atomHitCount > 0 && atomHealth.blockedReasons.length > 0) {
      const reason = `evidence atoms are not directly usable: ${[...new Set(atomHealth.blockedReasons)].join(", ")}`;
      return {
        status: verifiedTraceCount > 0 ? "needs_expansion" : "insufficient",
        reason,
        atomHitCount,
        usableAtomCount,
        verifiedTraceCount,
        recommendedAction: verifiedTraceCount > 0 ? "expand_l1" : "no_answer",
        nextActionHint: verifiedTraceCount > 0
          ? "Expand the listed summary/source before answering because the atom quality gate blocked direct use."
          : "Do not answer from blocked evidence atoms; run a narrower query or report not found.",
        targetIds: this.extractTraceTargetIds(items, result),
      };
    }
    if (verifiedTraceCount > 0) {
      return {
        status: "needs_expansion",
        reason: "verified summary/source trace exists, but no evidence atom was selected",
        atomHitCount,
        usableAtomCount,
        verifiedTraceCount,
        recommendedAction: "expand_l1",
        nextActionHint: "Expand the listed summaryId before making a specific claim.",
        targetIds: this.extractTraceTargetIds(items, result),
      };
    }
    return {
      status: "insufficient",
      reason: "selected hits are not source-verified enough for grounded answer",
      atomHitCount,
      usableAtomCount,
      verifiedTraceCount,
      recommendedAction: "no_answer",
      nextActionHint: "Do not answer from weak similarity alone; run a narrower query or report not found.",
      targetIds: this.extractTraceTargetIds(items, result),
    };
  }

  compactSourceTrace(args: CompactTraceArgs): Array<Record<string, unknown>> {
    const { sourceTrace } = args;
    return sourceTrace.slice(0, 6).map((trace) => ({
      route: trace.route,
      summaryId: trace.summaryId,
      strategy: trace.strategy,
      verified: trace.verified,
      reason: trace.reason,
      resolvedMessageCount: trace.resolvedMessageCount,
      turnStart: trace.turnStart,
      turnEnd: trace.turnEnd,
      sequenceMin: trace.sequenceMin,
      sequenceMax: trace.sequenceMax,
      messageIds: trace.messageIds?.slice(0, 3),
      messageIdCount: trace.messageIds?.length ?? 0,
    }));
  }

  compactDagTrace(args: CompactDagTraceArgs): Array<Record<string, unknown>> {
    const { dagTrace } = args;
    return dagTrace.slice(0, 8).map((step) => ({
      summaryId: step.summaryId,
      summaryLevel: step.summaryLevel,
      nodeKind: step.nodeKind,
      score: step.score,
      action: step.action,
      reasons: step.reasons.slice(0, 6),
      childCount: step.childSummaryIds?.length ?? 0,
    }));
  }

  private buildPersistentEvidenceAtomItem(atom: EvidenceAtomEntry): ContextItem {
    const content = [
      `[evidence_atom:${atom.type}] ${atom.text}`,
      `sourceSummaryId: ${atom.sourceSummaryId}`,
      atom.sourceMessageIds && atom.sourceMessageIds.length > 0
        ? `sourceMessageIds: ${atom.sourceMessageIds.slice(0, 6).join(", ")}`
        : "",
    ].filter(Boolean).join("\n");
    return {
      kind: "summary",
      summaryId: atom.sourceSummaryId,
      tokenCount: Math.max(estimateTokens(content), 1),
      content,
      metadata: {
        atomId: atom.id,
        sessionId: atom.sessionId,
        evidenceAtom: atom.text,
        persistentEvidenceAtom: true,
        evidenceType: atom.type,
        sourceSummaryId: atom.sourceSummaryId,
        sourceBinding: atom.sourceBinding,
        sourceHash: atom.sourceHash,
        sourceMessageCount: atom.sourceMessageCount,
        sourceVerified: Boolean(atom.sourceBinding || atom.sourceHash),
        sourceMessageIds: atom.sourceMessageIds ?? [],
        confidence: atom.confidence,
        importance: atom.importance,
        stability: atom.stability,
        atomStatus: atom.atomStatus ?? "candidate",
        sourceTraceComplete: atom.sourceTraceComplete,
      },
    };
  }

  private buildPersistentEvidenceAtomTrace(item: ContextItem): SourceTrace {
    const sourceMessageIds = Array.isArray(item.metadata?.sourceMessageIds)
      ? item.metadata.sourceMessageIds.filter((value): value is string => typeof value === "string")
      : [];
    return {
      route: "summary_tree",
      summaryId: item.summaryId,
      sessionId: typeof item.metadata?.sessionId === "string" ? item.metadata.sessionId : "",
      strategy: sourceMessageIds.length > 0 ? "message_ids" : "none",
      verified: item.metadata?.sourceVerified === true,
      reason: "persistent_evidence_atom_hit",
      sourceHash: typeof item.metadata?.sourceHash === "string" ? item.metadata.sourceHash : undefined,
      sourceMessageCount: typeof item.metadata?.sourceMessageCount === "number" ? item.metadata.sourceMessageCount : undefined,
      resolvedMessageCount: sourceMessageIds.length,
      messageIds: sourceMessageIds,
    };
  }

  private evaluateAtomEvidenceHealth(items: ContextItem[]): AtomEvidenceHealth {
    const atomItems = items.filter((item) =>
      item.metadata?.persistentEvidenceAtom === true || item.metadata?.evidenceAtom === true || typeof item.metadata?.atomId === "string",
    );
    const blockedReasons: string[] = [];
    let usableAtomCount = 0;
    for (const item of atomItems) {
      const reasons = this.atomBlockReasons(item);
      if (reasons.length === 0) {
        usableAtomCount += 1;
      } else {
        blockedReasons.push(...reasons);
      }
    }
    return {
      atomHitCount: atomItems.length,
      usableAtomCount,
      blockedReasons,
    };
  }

  private atomBlockReasons(item: ContextItem): string[] {
    const reasons: string[] = [];
    const status = typeof item.metadata?.atomStatus === "string" ? item.metadata.atomStatus : "candidate";
    if (status === "conflicted" || status === "expired" || status === "superseded") {
      reasons.push(status);
    }
    if (item.metadata?.sourceTraceComplete === false || item.metadata?.sourceVerified === false) {
      reasons.push("source_trace_incomplete");
    }
    const confidence = typeof item.metadata?.confidence === "number" ? item.metadata.confidence : undefined;
    if (typeof confidence === "number" && confidence < 0.55) {
      reasons.push("low_confidence");
    }
    const stability = typeof item.metadata?.stability === "number" ? item.metadata.stability : undefined;
    if (typeof stability === "number" && stability < 0.35) {
      reasons.push("low_stability");
    }
    return reasons;
  }

  private extractTraceTargetIds(items: ContextItem[], result: RecallResult): string[] {
    const ids = new Set<string>();
    for (const item of items) {
      const atomId = item.metadata?.atomId;
      if (typeof atomId === "string" && atomId.trim()) {
        ids.add(`atom:${atomId}`);
      }
      const summaryId = item.summaryId ?? item.metadata?.sourceSummaryId;
      if (typeof summaryId === "string" && summaryId.trim()) {
        ids.add(`summary:${summaryId}`);
      }
      const messageId = item.metadata?.messageId;
      if (typeof messageId === "string" && messageId.trim()) {
        ids.add(`message:${messageId}`);
      }
    }
    for (const trace of result.sourceTrace) {
      if (trace.summaryId) {
        ids.add(`summary:${trace.summaryId}`);
      }
      for (const messageId of trace.messageIds ?? []) {
        ids.add(`message:${messageId}`);
        if (ids.size >= 8) {
          break;
        }
      }
      if (ids.size >= 8) {
        break;
      }
    }
    return [...ids].slice(0, 8);
  }
}
