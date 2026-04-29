import { BenchmarkComparisonGuard, BenchmarkComparisonReport } from "../evals/benchmark-comparison";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const guard = new BenchmarkComparisonGuard();
  assert(guard.classify("development_sample") === "regression_only", "development samples must not become public comparison claims");
  const devReport: BenchmarkComparisonReport = guard.buildReport({
    suite: "locomo-small",
    scope: "development_sample",
    systems: ["chaunyoms"],
    metrics: { accuracy: 0.8 },
    generatedAt: "2026-04-28T00:00:00.000Z",
  });
  assert(!guard.canClaimPublicComparison(devReport), "dev report must not be publicly comparable");
  assert(guard.canClaimPublicComparison({ ...devReport, suite: "locomo-full", scope: "standard_public", claimLevel: "public_comparable" }), "standard public report can be comparable");
  console.log("test-benchmark-comparison-guard passed");
}

void main();
