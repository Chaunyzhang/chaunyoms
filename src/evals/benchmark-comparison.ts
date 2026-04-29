export type BenchmarkScope = "development_sample" | "standard_public";

export interface BenchmarkComparisonReport {
  suite: string;
  scope: BenchmarkScope;
  systems: string[];
  metrics: {
    accuracy?: number;
    sourceVerificationRate?: number;
    falseRecallRate?: number;
    abstentionCorrectness?: number;
    p50LatencyMs?: number;
    p95LatencyMs?: number;
    retrievalTokens?: number;
    llmCallsPerQuery?: number;
    ingestCost?: number;
    traceCompleteness?: number;
    strictPassRate?: number;
    forensicPassRate?: number;
  };
  generatedAt: string;
  claimLevel: "regression_only" | "public_comparable";
}

export class BenchmarkComparisonGuard {
  classify(scope: BenchmarkScope): BenchmarkComparisonReport["claimLevel"] {
    return scope === "standard_public" ? "public_comparable" : "regression_only";
  }

  buildReport(args: {
    suite: string;
    scope: BenchmarkScope;
    systems: string[];
    metrics: BenchmarkComparisonReport["metrics"];
    generatedAt?: string;
  }): BenchmarkComparisonReport {
    return {
      suite: args.suite,
      scope: args.scope,
      systems: [...new Set(args.systems.filter(Boolean))],
      metrics: args.metrics,
      generatedAt: args.generatedAt ?? new Date().toISOString(),
      claimLevel: this.classify(args.scope),
    };
  }

  canClaimPublicComparison(report: BenchmarkComparisonReport): boolean {
    return report.scope === "standard_public" && report.claimLevel === "public_comparable";
  }
}
