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
    const verifiedTraceCount = sourceTrace.filter((trace) => trace.verified).length;
    const completeRawTraceCount = sourceTrace.filter((trace) => this.isCompleteRawTrace(trace)).length;
    const verifiedAnswerCount = answers.filter((candidate) => candidate.sourceVerified).length;
    const selectedItemCount = args.items.length;

    if (policy.strength === "off") {
      return {
        status: "sufficient",
        recommendedAction: "answer",
        reason: "retrievalStrength=off; verifier only allows current/recent context paths.",
        retrievalStrength: policy.strength,
        sourceTraceRequired: false,
        fullRawTraceRequired: false,
        verifiedTraceCount,
        completeRawTraceCount,
        verifiedAnswerCount,
        selectedItemCount,
        sourceTraceStatus: "not_required",
      };
    }

    if (policy.fullRawTraceRequired) {
      if (completeRawTraceCount > 0) {
        return this.result("sufficient", "answer", "forensic retrieval has complete raw source trace.", policy.strength, true, true, verifiedTraceCount, completeRawTraceCount, verifiedAnswerCount, selectedItemCount, "complete_raw");
      }
      return this.result(
        verifiedTraceCount > 0 ? "needs_expansion" : "insufficient",
        verifiedTraceCount > 0 ? "trace_raw" : "no_answer",
        "forensic retrieval requires complete raw trace; summary-only or trace-only evidence cannot be final fact.",
        policy.strength,
        true,
        true,
        verifiedTraceCount,
        completeRawTraceCount,
        verifiedAnswerCount,
        selectedItemCount,
        verifiedTraceCount > 0 ? "partial" : "missing",
      );
    }

    if (policy.sourceTraceRequired) {
      if (verifiedTraceCount > 0 || verifiedAnswerCount > 0) {
        return this.result("sufficient", "answer", "strict retrieval has verified source evidence.", policy.strength, true, false, verifiedTraceCount, completeRawTraceCount, verifiedAnswerCount, selectedItemCount, "verified");
      }
      return this.result(
        selectedItemCount > 0 ? "needs_expansion" : "insufficient",
        selectedItemCount > 0 ? "trace_raw" : "no_answer",
        "strict retrieval requires source verification before a final factual answer.",
        policy.strength,
        true,
        false,
        verifiedTraceCount,
        completeRawTraceCount,
        verifiedAnswerCount,
        selectedItemCount,
        "missing",
      );
    }

    if (selectedItemCount > 0 || verifiedAnswerCount > 0) {
      return this.result("sufficient", "answer", "retrieval evidence is adequate for non-strict presentation; unverified material remains a hint.", policy.strength, false, false, verifiedTraceCount, completeRawTraceCount, verifiedAnswerCount, selectedItemCount, verifiedTraceCount > 0 ? "verified" : "not_required");
    }

    return this.result("insufficient", "no_answer", "no retrieval candidates were selected.", policy.strength, false, false, verifiedTraceCount, completeRawTraceCount, verifiedAnswerCount, selectedItemCount, "missing");
  }

  private isCompleteRawTrace(trace: SourceTrace): boolean {
    return trace.verified &&
      trace.resolvedMessageCount > 0 &&
      trace.strategy !== "none" &&
      (trace.strategy === "message_ids" ||
        trace.strategy === "sequence_range" ||
        trace.strategy === "turn_range");
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
      verifiedAnswerCount,
      selectedItemCount,
      sourceTraceStatus,
    };
  }
}
