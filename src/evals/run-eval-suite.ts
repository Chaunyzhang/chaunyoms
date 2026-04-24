import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";

import defaultSuite from "./fixtures/core-memory-suite.json";

import {
  cleanupEvalHarness,
  buildEvalHarness,
  finalizeReplay,
  materializeMessages,
  replayMessages,
  seedKnowledge,
  writeReportArtifacts,
} from "./runtimeHarness";
import {
  EvalAggregateMetrics,
  EvalCaseDefinition,
  EvalCaseResult,
  EvalRateMetric,
  EvalSuiteDefinition,
  EvalSuiteReport,
} from "./types";


interface EvalRunOptions {
  suitePath?: string;
  reportPrefix: string;
}

function parseArgs(argv: string[]): EvalRunOptions {
  const options: EvalRunOptions = {
    suitePath: process.env.CHAUNYOMS_EVAL_SUITE,
    reportPrefix: process.env.CHAUNYOMS_EVAL_REPORT_PREFIX ?? "memory-eval-report",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--suite") {
      options.suitePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--suite=")) {
      options.suitePath = arg.slice("--suite=".length);
      continue;
    }
    if (arg === "--report-prefix") {
      options.reportPrefix = argv[index + 1] ?? options.reportPrefix;
      index += 1;
      continue;
    }
    if (arg.startsWith("--report-prefix=")) {
      options.reportPrefix = arg.slice("--report-prefix=".length);
    }
  }

  return options;
}

async function loadSuiteDefinition(suitePath?: string): Promise<EvalSuiteDefinition> {
  if (!suitePath) {
    return defaultSuite as unknown as EvalSuiteDefinition;
  }

  const resolvedPath = path.resolve(process.cwd(), suitePath);
  return JSON.parse(await readFile(resolvedPath, "utf8")) as EvalSuiteDefinition;
}

function assertNever(_value: never): never {
  throw new Error("Unexpected value");
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rateMetric(passed: number, total: number): EvalRateMetric {
  return {
    rate: total === 0 ? 0 : Number((passed / total).toFixed(4)),
    passed,
    total,
  };
}

function percentageLabel(metric: EvalRateMetric): string {
  return `${(metric.rate * 100).toFixed(1)}% (${metric.passed}/${metric.total})`;
}

function evaluateCaseResult(
  caseDef: EvalCaseDefinition,
  response: { content: Array<Record<string, unknown>>; details: Record<string, unknown> },
  latencyMs: number,
  summaryCount: number,
  branchCount: number,
): EvalCaseResult {
  const outputText = String(response.content[0]?.text ?? "");
  const matchedIncludes = (caseDef.expected.mustInclude ?? []).filter((item) => outputText.includes(item));
  const violatedExcludes = (caseDef.expected.mustNotInclude ?? []).filter((item) => outputText.includes(item));
  const failures: string[] = [];

  for (const item of caseDef.expected.mustInclude ?? []) {
    if (!outputText.includes(item)) {
      failures.push(`missing expected text: ${item}`);
    }
  }
  for (const item of caseDef.expected.mustNotInclude ?? []) {
    if (outputText.includes(item)) {
      failures.push(`found forbidden text: ${item}`);
    }
  }
  for (const [key, value] of Object.entries(caseDef.expected.detailEquals ?? {})) {
    if (response.details[key] !== value) {
      failures.push(`detail mismatch for ${key}: expected ${String(value)}, got ${String(response.details[key])}`);
    }
  }

  const sourceTrace = Array.isArray(response.details.sourceTrace)
    ? response.details.sourceTrace as Array<Record<string, unknown>>
    : [];
  const sourceVerified = sourceTrace.some((trace) => trace.verified === true);
  if (caseDef.expected.requireSourceVerified && !sourceVerified) {
    failures.push("expected verified source trace");
  }
  if (typeof caseDef.expected.minSummaryCount === "number" && summaryCount < caseDef.expected.minSummaryCount) {
    failures.push(`expected at least ${caseDef.expected.minSummaryCount} summaries, got ${summaryCount}`);
  }
  if (caseDef.expected.requireBranchSummary && branchCount <= 0) {
    failures.push("expected at least one branch summary");
  }

  return {
    id: caseDef.id,
    title: caseDef.title,
    tags: caseDef.tags,
    passed: failures.length === 0,
    latencyMs: Number(latencyMs.toFixed(2)),
    outputText,
    matchedIncludes,
    violatedExcludes,
    sourceVerified,
    summaryCount,
    branchCount,
    details: response.details,
    failures,
  };
}

function aggregateMetrics(results: EvalCaseResult[]): EvalAggregateMetrics {
  const totalCases = results.length;
  const passedCases = results.filter((item) => item.passed).length;
  const exactFactCases = results.filter((item) => item.tags.includes("exact_fact"));
  const sourceCases = results.filter((item) => item.tags.includes("source_verified"));
  const updateCases = results.filter((item) => item.tags.includes("knowledge_update"));
  const projectCases = results.filter((item) => item.tags.includes("project_state"));
  const abstentionCases = results.filter((item) => item.tags.includes("abstention"));
  const routeCases = results.filter((item) => item.tags.includes("route_accuracy"));
  const falseRecallCases = results.filter((item) => item.violatedExcludes.length > 0);
  const latencies = results.map((item) => item.latencyMs);

  return {
    totalCases,
    passedCases,
    passRate: rateMetric(passedCases, totalCases),
    routeAccuracyRate: rateMetric(
      routeCases.filter((item) => item.passed).length,
      routeCases.length,
    ),
    exactFactRecoveryRate: rateMetric(
      exactFactCases.filter((item) => item.passed).length,
      exactFactCases.length,
    ),
    sourceVerificationRate: rateMetric(
      sourceCases.filter((item) => item.sourceVerified).length,
      sourceCases.length,
    ),
    knowledgeUpdateSuccessRate: rateMetric(
      updateCases.filter((item) => item.passed).length,
      updateCases.length,
    ),
    projectStateSuccessRate: rateMetric(
      projectCases.filter((item) => item.passed).length,
      projectCases.length,
    ),
    abstentionSuccessRate: rateMetric(
      abstentionCases.filter((item) => item.passed).length,
      abstentionCases.length,
    ),
    falseRecallRate: rateMetric(falseRecallCases.length, totalCases),
    avgLatencyMs: Number(average(latencies).toFixed(2)),
    p50LatencyMs: Number(percentile(latencies, 50).toFixed(2)),
    p95LatencyMs: Number(percentile(latencies, 95).toFixed(2)),
  };
}

function reportMarkdown(report: EvalSuiteReport): string {
  const lines = [
    `# ${report.title}`,
    "",
    report.description,
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Metrics",
    "",
    `- totalCases: ${report.metrics.totalCases}`,
    `- passedCases: ${report.metrics.passedCases}`,
    `- passRate: ${percentageLabel(report.metrics.passRate)}`,
    `- routeAccuracyRate: ${percentageLabel(report.metrics.routeAccuracyRate)}`,
    `- exactFactRecoveryRate: ${percentageLabel(report.metrics.exactFactRecoveryRate)}`,
    `- sourceVerificationRate: ${percentageLabel(report.metrics.sourceVerificationRate)}`,
    `- knowledgeUpdateSuccessRate: ${percentageLabel(report.metrics.knowledgeUpdateSuccessRate)}`,
    `- projectStateSuccessRate: ${percentageLabel(report.metrics.projectStateSuccessRate)}`,
    `- abstentionSuccessRate: ${percentageLabel(report.metrics.abstentionSuccessRate)}`,
    `- falseRecallRate: ${percentageLabel(report.metrics.falseRecallRate)}`,
    `- avgLatencyMs: ${report.metrics.avgLatencyMs}`,
    `- p50LatencyMs: ${report.metrics.p50LatencyMs}`,
    `- p95LatencyMs: ${report.metrics.p95LatencyMs}`,
    "",
    "## Case Results",
    "",
  ];

  for (const result of report.results) {
    lines.push(`### ${result.id}`);
    lines.push("");
    lines.push(`- passed: ${result.passed}`);
    lines.push(`- latencyMs: ${result.latencyMs}`);
    lines.push(`- sourceVerified: ${result.sourceVerified}`);
    lines.push(`- summaryCount: ${result.summaryCount}`);
    lines.push(`- branchCount: ${result.branchCount}`);
    lines.push(`- failures: ${result.failures.join("; ") || "none"}`);
    lines.push("");
  }

  return lines.join("\n");
}

async function runCase(caseDef: EvalCaseDefinition): Promise<EvalCaseResult> {
  const { dir, config, runtime, retrieval } = await buildEvalHarness(caseDef);
  try {
    const messages = materializeMessages(caseDef);
    if (Array.isArray(caseDef.seedKnowledge) && caseDef.seedKnowledge.length > 0) {
      await seedKnowledge(runtime, config, caseDef.seedKnowledge);
    }
    if (messages.length > 0) {
      await replayMessages(runtime, config, messages, caseDef.afterTurnEvery);
      await finalizeReplay(runtime, config);
    }

    const startedAt = performance.now();
    let response: { content: Array<Record<string, unknown>>; details: Record<string, unknown> };
    switch (caseDef.mode) {
      case "retrieve":
        response = await retrieval.executeMemoryRetrieve({
          sessionId: config.sessionId,
          config,
          query: caseDef.query,
        });
        break;
      case "route":
        response = await retrieval.executeMemoryRoute({
          sessionId: config.sessionId,
          config,
          query: caseDef.query,
        });
        break;
      default:
        assertNever(caseDef.mode);
    }
    const latencyMs = performance.now() - startedAt;
    const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
    const summaries = stores.summaryStore.getAllSummaries({ sessionId: config.sessionId });
    const branchCount = summaries.filter((entry) => entry.nodeKind === "branch").length;
    return evaluateCaseResult(caseDef, response, latencyMs, summaries.length, branchCount);
  } finally {
    await cleanupEvalHarness(dir);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const suiteDefinition = await loadSuiteDefinition(options.suitePath);
  const results: EvalCaseResult[] = [];
  for (const caseDef of suiteDefinition.cases) {
    results.push(await runCase(caseDef));
  }

  const report: EvalSuiteReport = {
    suiteId: suiteDefinition.suiteId,
    title: suiteDefinition.title,
    description: suiteDefinition.description,
    generatedAt: new Date().toISOString(),
    metrics: aggregateMetrics(results),
    results,
  };

  const json = JSON.stringify(report, null, 2);
  const markdown = reportMarkdown(report);
  const reportDir = path.join(process.cwd(), "artifacts", "evals");
  await writeReportArtifacts(
    reportDir,
    `${options.reportPrefix}.json`,
    `${options.reportPrefix}.md`,
    json,
    markdown,
  );

  console.log(json);
}

void main();
