import {
  AnswerCandidate,
  ContextItem,
  RecallResult,
  RetrievalStrength,
  SourceTrace,
} from "../types";
import { RetrievalPolicyResolver } from "./RetrievalPolicyResolver";

export type RetrievalVerificationStatus =
  | "sufficient"
  | "needs_expansion"
  | "insufficient";

export type RetrievalVerificationAction =
  | "answer"
  | "trace_raw"
  | "no_answer";

export interface RetrievalVerificationResult {
  status: RetrievalVerificationStatus;
  recommendedAction: RetrievalVerificationAction;
  reason: string;
  retrievalStrength: RetrievalStrength;
  sourceTraceRequired: boolean;
  fullRawTraceRequired: boolean;
  verifiedTraceCount: number;
  completeRawTraceCount: number;
  rawEvidenceItemCount: number;
  verifiedAnswerCount: number;
  selectedItemCount: number;
  sourceTraceStatus: "not_required" | "missing" | "partial" | "verified" | "complete_raw";
}

export class RetrievalVerifier {
  private readonly policyResolver = new RetrievalPolicyResolver();

  verify(args: {
    retrievalStrength: RetrievalStrength;
    items: ContextItem[];
    sourceTrace: SourceTrace[];
    answerCandidates?: AnswerCandidate[];
    recallResult?: RecallResult;
  }): RetrievalVerificationResult {
    const policy = this.policyResolver.resolve(args.retrievalStrength);
    const sourceTrace = args.recallResult?.sourceTrace ?? args.sourceTrace;
    const answers = args.recallResult?.answerCandidates ?? args.answerCandidates ?? [];
    const rawEvidenceMessageIds = this.rawEvidenceMessageIds(args.items);
    const verifiedTraceCount = sourceTrace.filter((trace) => trace.verified).length;
    const completeRawTraceCount = sourceTrace.filter((trace) => this.isCompleteRawTrace(trace, rawEvidenceMessageIds)).length;
    const rawEvidenceItemCount = rawEvidenceMessageIds.size;
    const verifiedAnswerCount = answers.filter((candidate) => candidate.sourceVerified).length;
    const selectedItemCount = args.items.length;

    if (policy.fullRawTraceRequired) {
      if (completeRawTraceCount > 0 && rawEvidenceItemCount > 0) {
        return this.result("sufficient", "answer", `${policy.strength} retrieval has complete raw source trace.`, policy.strength, true, true, verifiedTraceCount, completeRawTraceCount, rawEvidenceItemCount, verifiedAnswerCount, selectedItemCount, "complete_raw");
      }
      const canExpand = selectedItemCount > 0 || rawEvidenceItemCount > 0 || verifiedTraceCount > 0;
      return this.result(
        canExpand ? "needs_expansion" : "insufficient",
        canExpand ? "trace_raw" : "no_answer",
        `${policy.strength} retrieval requires selected raw source messages; summary-only, atom-only, answer-candidate-only, or trace-only evidence cannot be final fact.`,
        policy.strength,
        true,
        true,
        verifiedTraceCount,
        completeRawTraceCount,
        rawEvidenceItemCount,
        verifiedAnswerCount,
        selectedItemCount,
        verifiedTraceCount > 0 ? "partial" : "missing",
      );
    }

    if (policy.sourceTraceRequired) {
      if (verifiedTraceCount > 0 || verifiedAnswerCount > 0) {
        return this.result("sufficient", "answer", "high retrieval has verified source evidence.", policy.strength, true, false, verifiedTraceCount, completeRawTraceCount, rawEvidenceItemCount, verifiedAnswerCount, selectedItemCount, "verified");
      }
      return this.result(
        selectedItemCount > 0 ? "needs_expansion" : "insufficient",
        selectedItemCount > 0 ? "trace_raw" : "no_answer",
        "high retrieval requires source verification before a final factual answer.",
        policy.strength,
        true,
        false,
        verifiedTraceCount,
        completeRawTraceCount,
        rawEvidenceItemCount,
        verifiedAnswerCount,
        selectedItemCount,
        "missing",
      );
    }

    if (selectedItemCount > 0 || verifiedAnswerCount > 0) {
      return this.result("sufficient", "answer", "retrieval evidence is adequate for non-strict presentation; unverified material remains a hint.", policy.strength, false, false, verifiedTraceCount, completeRawTraceCount, rawEvidenceItemCount, verifiedAnswerCount, selectedItemCount, verifiedTraceCount > 0 ? "verified" : "not_required");
    }

    return this.result("insufficient", "no_answer", "no retrieval candidates were selected.", policy.strength, false, false, verifiedTraceCount, completeRawTraceCount, rawEvidenceItemCount, verifiedAnswerCount, selectedItemCount, "missing");
  }

  private rawEvidenceMessageIds(items: ContextItem[]): Set<string> {
    return new Set(items
      .filter((item) => item.kind === "message")
      .map((item) => item.metadata?.messageId)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0));
  }

  private isCompleteRawTrace(trace: SourceTrace, rawEvidenceMessageIds: Set<string>): boolean {
    if (!(
      trace.verified &&
      trace.resolvedMessageCount > 0 &&
      trace.strategy !== "none" &&
      (trace.strategy === "message_ids" ||
        trace.strategy === "sequence_range" ||
        trace.strategy === "turn_range")
    )) {
      return false;
    }
    if (rawEvidenceMessageIds.size === 0) {
      return false;
    }
    if ((trace.messageIds?.length ?? 0) === 0) {
      return true;
    }
    return (trace.messageIds ?? []).some((id) => rawEvidenceMessageIds.has(id));
  }

  private result(
    status: RetrievalVerificationStatus,
    recommendedAction: RetrievalVerificationAction,
    reason: string,
    retrievalStrength: RetrievalStrength,
    sourceTraceRequired: boolean,
    fullRawTraceRequired: boolean,
    verifiedTraceCount: number,
    completeRawTraceCount: number,
    rawEvidenceItemCount: number,
    verifiedAnswerCount: number,
    selectedItemCount: number,
    sourceTraceStatus: RetrievalVerificationResult["sourceTraceStatus"],
  ): RetrievalVerificationResult {
    return {
      status,
      recommendedAction,
      reason,
      retrievalStrength,
      sourceTraceRequired,
      fullRawTraceRequired,
      verifiedTraceCount,
      completeRawTraceCount,
      rawEvidenceItemCount,
      verifiedAnswerCount,
      selectedItemCount,
      sourceTraceStatus,
    };
  }
}
