import { RetrievalStrength } from "../types";

export interface RetrievalPolicy {
  strength: RetrievalStrength;
  sourceTraceRequired: boolean;
  fullRawTraceRequired: boolean;
  allowSummaryOnlyFinalFact: boolean;
  allowUnverifiedHint: boolean;
  evidencePresentation: "none" | "hidden_by_default" | "show_when_needed" | "show_source_trace";
}

export class RetrievalPolicyResolver {
  resolve(strength: RetrievalStrength): RetrievalPolicy {
    switch (strength) {
      case "low":
        return {
          strength,
          sourceTraceRequired: false,
          fullRawTraceRequired: false,
          allowSummaryOnlyFinalFact: true,
          allowUnverifiedHint: true,
          evidencePresentation: "hidden_by_default",
        };
      case "high":
        return {
          strength,
          sourceTraceRequired: true,
          fullRawTraceRequired: true,
          allowSummaryOnlyFinalFact: false,
          allowUnverifiedHint: false,
          evidencePresentation: "show_source_trace",
        };
      case "xhigh":
        return {
          strength,
          sourceTraceRequired: true,
          fullRawTraceRequired: true,
          allowSummaryOnlyFinalFact: false,
          allowUnverifiedHint: false,
          evidencePresentation: "show_source_trace",
        };
      case "custom":
        return {
          strength,
          sourceTraceRequired: false,
          fullRawTraceRequired: false,
          allowSummaryOnlyFinalFact: true,
          allowUnverifiedHint: true,
          evidencePresentation: "hidden_by_default",
        };
      case "medium":
      default:
        return {
          strength,
          sourceTraceRequired: false,
          fullRawTraceRequired: false,
          allowSummaryOnlyFinalFact: true,
          allowUnverifiedHint: true,
          evidencePresentation: "hidden_by_default",
        };
    }
  }
}
