import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { BridgeConfig, LoggerLike, SummaryEntry } from "../types";
import { SecretFinding, SecretScanner } from "./SecretScanner";

export type BrainPackSnapshotReason =
  | "manual"
  | "turn_count"
  | "interval"
  | "major_change"
  | "before_upgrade"
  | "before_wipe"
  | "release_gate";

export interface BrainPackExportResult {
  ok: boolean;
  snapshotId: string;
  outputDir: string;
  files: string[];
  redactionReport: {
    okForGit: boolean;
    blockedGit: boolean;
    findingCount: number;
    findings: SecretFinding[];
  };
  manifest: Record<string, unknown>;
}

export class BrainPackExporter {
  private readonly scanner = new SecretScanner();

  constructor(
    private readonly store: SQLiteRuntimeStore,
    private readonly config: BridgeConfig,
    private readonly logger?: LoggerLike,
  ) {}

  async export(options: { reason?: BrainPackSnapshotReason; outputDir?: string } = {}): Promise<BrainPackExportResult> {
    const reason = options.reason ?? "manual";
    const createdAt = new Date().toISOString();
    const snapshotId = `brainpack-${createdAt.replace(/[:.]/g, "-")}-${this.hash(`${this.config.agentId}:${reason}:${createdAt}`).slice(0, 8)}`;
    const outputDir = path.resolve(options.outputDir || this.config.brainPackOutputDir || path.join(this.config.workspaceDir, "agent-brainpack"));
    const outputSafety = this.validateOutputDir(outputDir);
    if (!outputSafety.ok) {
      const finding: SecretFinding = {
        type: "unsafe_output_dir",
        severity: "block",
        action: "blocked",
        path: outputDir,
        hash: this.hash(outputDir),
        start: 0,
        end: 0,
      };
      this.logger?.warn("brainpack_output_dir_blocked", { outputDir, reason: outputSafety.reason });
      return {
        ok: false,
        snapshotId,
        outputDir,
        files: [],
        redactionReport: {
          okForGit: false,
          blockedGit: true,
          findingCount: 1,
          findings: [finding],
        },
        manifest: {
          brainpackVersion: 1,
          snapshotId,
          snapshotReason: reason,
          createdAt,
          agentId: this.config.agentId,
          blocked: true,
          blockReason: outputSafety.reason,
        },
      };
    }
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });

    const findings: SecretFinding[] = [];
    const fileHashes: Record<string, string> = {};
    const files: string[] = [];
    let strictProjectionBlocked = false;
    const writeProjection = async (relativePath: string, content: string): Promise<void> => {
      const safeRelativePath = relativePath.replace(/\\/g, "/");
      const scan = this.scanner.scanText(safeRelativePath, content, this.config.brainPackRedactionMode);
      findings.push(...scan.findings);
      if (scan.blocked) {
        strictProjectionBlocked = true;
        return;
      }
      const finalText = scan.redactedText;
      const target = path.join(outputDir, safeRelativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, finalText, "utf8");
      fileHashes[safeRelativePath] = this.hash(finalText);
      files.push(safeRelativePath);
    };
    const writeControlReport = async (relativePath: string, content: string): Promise<void> => {
      const safeRelativePath = relativePath.replace(/\\/g, "/");
      const scan = this.scanner.scanText(safeRelativePath, content, "redact");
      const target = path.join(outputDir, safeRelativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, scan.redactedText, "utf8");
      fileHashes[safeRelativePath] = this.hash(scan.redactedText);
      files.push(safeRelativePath);
    };

    const status = this.store.getStatus();
    const memoryItems = this.store.listMemoryItems({ agentId: this.config.agentId });
    const evidenceAtoms = this.store.listEvidenceAtoms();
    const knowledgeRaw = this.store.listRuntimeRecords("knowledge_raw", { agentId: this.config.agentId });
    const usageStats = this.store.listRetrievalUsageStats({ agentId: this.config.agentId, limit: 1000 });
    const summaries = this.store
      .listSummaries()
      .filter((summary) => !summary.agentId || summary.agentId === this.config.agentId);
    const baseSummaries = summaries.filter((summary) => this.isBaseSummary(summary));
    const decisions = memoryItems.filter((item) => item.kind === "decision");
    const openLoops = memoryItems.filter((item) => item.kind === "project_state" || item.tags.includes("open_loop"));

    await writeProjection("README.md", this.renderReadme(snapshotId, createdAt));
    await writeProjection("identity.md", `# Identity\n\n- Agent ID: ${this.config.agentId}\n- Session ID at export: ${this.config.sessionId}\n- Workspace: ${this.config.workspaceDir}\n`);
    await writeProjection("agent-profile.md", this.renderAgentProfile(memoryItems));
    await writeProjection("project-state.md", this.renderProjectState(memoryItems));
    await writeProjection("principles.md", this.renderKindList("Principles", memoryItems.filter((item) => item.kind === "principle")));
    await writeProjection("working-style.md", this.renderKindList("Working Style", memoryItems.filter((item) => item.kind === "preference" || item.kind === "procedure")));
    await writeProjection("open-loops.md", this.renderKindList("Open Loops", openLoops));
    await writeProjection("memory/memory-items.jsonl", memoryItems.map((item) => JSON.stringify(this.safeMemoryItem(item))).join("\n") + (memoryItems.length ? "\n" : ""));
    await writeProjection("memory/memory-index.md", this.renderMemoryIndex(memoryItems));
    await writeProjection("memory/evidence-atoms.jsonl", evidenceAtoms.map((atom) => JSON.stringify(this.safeAtom(atom as unknown as Record<string, unknown>))).join("\n") + (evidenceAtoms.length ? "\n" : ""));
    await writeProjection("memory/knowledge-raw-index.jsonl", knowledgeRaw.map((record) => JSON.stringify({
      id: record.id,
      sessionId: record.sessionId,
      agentId: record.agentId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      status: record.payload.status,
      sourceSummaryId: record.payload.sourceSummaryId,
      oneLineSummary: record.payload.oneLineSummary,
      intakeReason: record.payload.intakeReason,
    })).join("\n") + (knowledgeRaw.length ? "\n" : ""));
    await writeProjection("summaries/base-summaries.jsonl", baseSummaries.map((summary) => JSON.stringify(this.safeBaseSummary(summary))).join("\n") + (baseSummaries.length ? "\n" : ""));
    await writeProjection("summaries/summary-tree.jsonl", summaries.map((summary) => JSON.stringify(this.safeSummaryTreeNode(summary))).join("\n") + (summaries.length ? "\n" : ""));
    await writeProjection("summaries/source-map.jsonl", summaries.map((summary) => JSON.stringify(this.safeSummarySourceMap(summary))).join("\n") + (summaries.length ? "\n" : ""));
    await writeProjection("summaries/summary-index.md", this.renderSummaryIndex(summaries));
    await writeProjection("trace/source-refs.jsonl", memoryItems.flatMap((item) => (item.sourceRefs ?? []).map((ref) => JSON.stringify({ memoryItemId: item.id, ...ref }))).join("\n") + "\n");
    await writeProjection("trace/trace-edges.jsonl", "");
    await writeProjection("decisions/decisions.jsonl", decisions.map((item) => JSON.stringify(this.safeMemoryItem(item))).join("\n") + (decisions.length ? "\n" : ""));
    await writeProjection("decisions/decision-log.md", this.renderKindList("Decision Log", decisions));
    await writeProjection("retrieval/usage-stats.jsonl", usageStats.map((stats) => JSON.stringify(stats)).join("\n") + (usageStats.length ? "\n" : ""));
    await writeProjection("retrieval/retrieval-policy.md", this.renderRetrievalPolicy());
    await writeProjection("reports/benchmark-summary.json", JSON.stringify({ status: "not_a_standard_public_benchmark", generatedAt: createdAt }, null, 2));
    await writeProjection("reports/snapshot-report.json", JSON.stringify({ snapshotId, createdAt, counts: status.counts }, null, 2));

    const blockedGit = strictProjectionBlocked || (
      this.config.brainPackRedactionMode === "report_only" &&
      findings.some((finding) => finding.severity === "block")
    );
    const redactionReport = {
      okForGit: !blockedGit,
      blockedGit,
      findingCount: findings.length,
      findings,
    };
    if (blockedGit) {
      await rm(outputDir, { recursive: true, force: true });
      await mkdir(outputDir, { recursive: true });
      files.length = 0;
      for (const key of Object.keys(fileHashes)) {
        delete fileHashes[key];
      }
      await writeControlReport("reports/redaction-report.json", JSON.stringify(redactionReport, null, 2));
      const manifest = {
        brainpackVersion: 1,
        snapshotId,
        snapshotReason: reason,
        createdAt,
        agentId: this.config.agentId,
        blocked: true,
        blockReason: this.config.brainPackRedactionMode === "strict"
          ? "strict_redaction_gate_detected_high_risk_plaintext"
          : "report_only_redaction_gate_detected_high_risk_plaintext",
        redactionReportPath: "reports/redaction-report.json",
      };
      this.logger?.warn("brainpack_git_blocked_by_redaction_gate", { outputDir, findingCount: findings.length });
      return {
        ok: false,
        snapshotId,
        outputDir,
        files,
        redactionReport,
        manifest,
      };
    }
    await writeProjection("reports/redaction-report.json", JSON.stringify(redactionReport, null, 2));

    const manifestBase = {
      brainpackVersion: 1,
      snapshotId,
      snapshotReason: reason,
      createdAt,
      agentId: this.config.agentId,
      projectId: undefined,
      workspaceId: this.hash(this.config.workspaceDir).slice(0, 16),
      sourceRuntime: {
        schemaVersion: "sqlite-v1",
        runtimeStoreId: this.hash(this.store.getPath()).slice(0, 16),
        watermark: createdAt,
      },
      counts: {
        rawMessages: status.counts.messages,
        summaries: status.counts.summaries,
        memoryItems: status.counts.memoryItems,
        evidenceAtoms: status.counts.evidenceAtoms,
        knowledgeRaw: knowledgeRaw.length,
        sourceEdges: status.counts.sourceEdges,
        traceEdges: status.counts.traceEdges,
        contextRuns: status.counts.contextRuns,
        retrievalCandidates: status.counts.retrievalCandidates,
      },
      projection: {
        rawTranscriptPolicy: this.config.brainPackIncludeRawTranscript === "never" ? "excluded" : this.config.brainPackIncludeRawTranscript,
        toolOutputPolicy: this.config.brainPackIncludeToolOutputs === "never" ? "excluded" : this.config.brainPackIncludeToolOutputs,
        secretPolicy: this.config.brainPackRedactionMode === "strict" ? "strict_block" : this.config.brainPackRedactionMode === "redact" ? "redacted" : "reported",
        deterministicOrdering: this.config.brainPackDeterministicOrdering,
      },
      integrity: {
        manifestHash: "",
        fileHashes,
      },
    };
    const manifestHash = this.hash(JSON.stringify(manifestBase, null, 2));
    const manifest = {
      ...manifestBase,
      integrity: {
        ...manifestBase.integrity,
        manifestHash,
      },
    };
    await writeProjection("manifest.json", JSON.stringify(manifest, null, 2));

    return {
      ok: true,
      snapshotId,
      outputDir,
      files,
      redactionReport,
      manifest,
    };
  }

  private renderReadme(snapshotId: string, createdAt: string): string {
    return `# ChaunyOMS Agent BrainPack\n\nSnapshot: ${snapshotId}\nCreated: ${createdAt}\n\nThis directory is a Git-safe projection of the local SQLite runtime soul. It is not the runtime source of truth and intentionally excludes raw transcripts, tool outputs, databases, WAL/SHM files, and credentials.\n`;
  }

  private renderAgentProfile(memoryItems: Array<{ kind: string; text: string; tags: string[] }>): string {
    const principles = memoryItems.filter((item) => item.kind === "principle").slice(0, 20);
    const preferences = memoryItems.filter((item) => item.kind === "preference").slice(0, 20);
    return [
      "# Agent Profile",
      "",
      "## Principles",
      ...principles.map((item) => `- ${item.text}`),
      "",
      "## Preferences",
      ...preferences.map((item) => `- ${item.text}`),
    ].join("\n");
  }

  private renderProjectState(memoryItems: Array<{ kind: string; text: string }>): string {
    return this.renderKindList("Project State", memoryItems.filter((item) => item.kind === "project_state"));
  }

  private renderKindList(title: string, memoryItems: Array<{ text: string; updatedAt?: string; id?: string }>): string {
    return [`# ${title}`, "", ...memoryItems.map((item) => `- ${item.text}${item.updatedAt ? ` _(updated ${item.updatedAt})_` : ""}${item.id ? ` [${item.id}]` : ""}`)].join("\n");
  }

  private renderMemoryIndex(memoryItems: Array<{ id: string; kind: string; text: string; tags: string[] }>): string {
    return ["# Memory Index", "", ...memoryItems.map((item) => `- **${item.kind}** ${item.id}: ${item.text} ${item.tags.length ? `(${item.tags.join(", ")})` : ""}`)].join("\n");
  }

  private renderSummaryIndex(summaries: SummaryEntry[]): string {
    const sorted = [...summaries].sort((left, right) =>
      (left.summaryLevel ?? 1) - (right.summaryLevel ?? 1) ||
      left.startTurn - right.startTurn ||
      left.createdAt.localeCompare(right.createdAt),
    );
    return [
      "# Summary Index",
      "",
      "BrainPack carries summary maps and source handles, not the full raw transcript. Use a private Agent Capsule / SQLite archive for full-source replay.",
      "",
      ...sorted.map((summary) =>
        `- **${this.summaryKind(summary)}** ${summary.id} (level ${summary.summaryLevel ?? 1}, turns ${summary.startTurn}-${summary.endTurn}) sourceMessages=${this.sourceMessageIds(summary).length} children=${summary.childSummaryIds?.length ?? 0}`,
      ),
    ].join("\n");
  }

  private renderRetrievalPolicy(): string {
    return [
      "# Retrieval Policy",
      "",
      `- Retrieval strength default: ${this.config.retrievalStrength}`,
      `- Usage feedback enabled: ${this.config.usageFeedbackEnabled}`,
      `- Graph: ${this.config.graphEnabled ? this.config.graphProvider : "off"}`,
      `- RAG: ${this.config.ragEnabled ? this.config.ragProvider : "off"}`,
      `- Rerank: ${this.config.rerankEnabled ? this.config.rerankProvider : "off"}`,
      "- Enhancements are candidate/ranking aids only; strict and forensic answers still require source verification.",
    ].join("\n");
  }

  private safeMemoryItem(item: unknown): Record<string, unknown> {
    const record = item as Record<string, unknown>;
    const { metadata, ...rest } = record;
    return {
      ...rest,
      metadata: this.safeMetadata(metadata),
    };
  }

  private safeAtom(atom: Record<string, unknown>): Record<string, unknown> {
    return {
      id: atom.id,
      sessionId: atom.sessionId,
      agentId: atom.agentId,
      type: atom.type,
      text: atom.text,
      tags: atom.tags,
      confidence: atom.confidence,
      importance: atom.importance,
      sourceTraceComplete: atom.sourceTraceComplete,
      sourceSummaryId: atom.sourceSummaryId,
      sourceMessageIds: atom.sourceMessageIds,
      createdAt: atom.createdAt,
    };
  }

  private safeBaseSummary(summary: SummaryEntry): Record<string, unknown> {
    return {
      id: summary.id,
      sessionId: summary.sessionId,
      agentId: summary.agentId,
      projectId: summary.projectId,
      topicId: summary.topicId,
      summary: summary.summary,
      keywords: summary.keywords,
      memoryType: summary.memoryType,
      phase: summary.phase,
      constraints: summary.constraints,
      decisions: summary.decisions,
      blockers: summary.blockers,
      nextSteps: summary.nextSteps,
      exactFacts: summary.exactFacts,
      summaryLevel: summary.summaryLevel ?? 1,
      nodeKind: summary.nodeKind ?? "leaf",
      parentSummaryId: summary.parentSummaryId,
      parentSummaryIds: summary.parentSummaryIds,
      sourceMessageIds: this.sourceMessageIds(summary),
      sourceRefs: summary.sourceRefs ?? [],
      sourceHash: summary.sourceHash,
      sourceMessageCount: summary.sourceMessageCount,
      createdAt: summary.createdAt,
      redaction: this.summaryRedactionMetadata(summary),
    };
  }

  private safeSummaryTreeNode(summary: SummaryEntry): Record<string, unknown> {
    return {
      id: summary.id,
      sessionId: summary.sessionId,
      agentId: summary.agentId,
      kind: this.summaryKind(summary),
      summary: summary.summary,
      summaryLevel: summary.summaryLevel ?? 1,
      nodeKind: summary.nodeKind ?? "leaf",
      parentSummaryId: summary.parentSummaryId,
      parentSummaryIds: summary.parentSummaryIds ?? [],
      childSummaryIds: summary.childSummaryIds ?? [],
      sourceSummaryIds: summary.sourceSummaryIds ?? [],
      sourceMessageIds: this.sourceMessageIds(summary),
      sourceHash: summary.sourceHash,
      sourceMessageCount: summary.sourceMessageCount,
      startTurn: summary.startTurn,
      endTurn: summary.endTurn,
      createdAt: summary.createdAt,
      redaction: this.summaryRedactionMetadata(summary),
    };
  }

  private safeSummarySourceMap(summary: SummaryEntry): Record<string, unknown> {
    return {
      summaryId: summary.id,
      summaryKind: this.summaryKind(summary),
      sourceFirstMessageId: summary.sourceFirstMessageId,
      sourceLastMessageId: summary.sourceLastMessageId,
      sourceMessageIds: this.sourceMessageIds(summary),
      sourceBinding: summary.sourceBinding ? {
        scope: summary.sourceBinding.scope,
        sessionId: summary.sourceBinding.sessionId,
        agentId: summary.sourceBinding.agentId,
        messageIds: summary.sourceBinding.messageIds,
        sequenceMin: summary.sourceBinding.sequenceMin,
        sequenceMax: summary.sourceBinding.sequenceMax,
        turnStart: summary.sourceBinding.turnStart,
        turnEnd: summary.sourceBinding.turnEnd,
        sourceHash: summary.sourceBinding.sourceHash,
        sourceMessageCount: summary.sourceBinding.sourceMessageCount,
      } : undefined,
      sourceRefs: summary.sourceRefs ?? [],
      sourceSummaryIds: summary.sourceSummaryIds ?? [],
      childSummaryIds: summary.childSummaryIds ?? [],
      sourceHash: summary.sourceHash,
      sourceMessageCount: summary.sourceMessageCount,
      redaction: this.summaryRedactionMetadata(summary),
    };
  }

  private isBaseSummary(summary: SummaryEntry): boolean {
    return (summary.summaryLevel ?? 1) === 1 && (summary.nodeKind ?? "leaf") === "leaf";
  }

  private summaryKind(summary: SummaryEntry): "base" | "branch" {
    return this.isBaseSummary(summary) ? "base" : "branch";
  }

  private sourceMessageIds(summary: SummaryEntry): string[] {
    return [...new Set([
      ...(summary.sourceMessageIds ?? []),
      ...(summary.sourceBinding?.messageIds ?? []),
      ...(summary.sourceRefs ?? []).map((ref) => ref.messageId),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
  }

  private summaryRedactionMetadata(summary: SummaryEntry): Record<string, unknown> | undefined {
    const metadata = summary.quality && typeof summary.quality === "object"
      ? { sourceTraceComplete: summary.quality.sourceTraceComplete, needsHumanReview: summary.quality.needsHumanReview }
      : {};
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private safeMetadata(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (/key|token|secret|password|cookie|authorization/i.test(key)) {
        output[key] = "[REDACTED_FIELD]";
      } else {
        output[key] = item;
      }
    }
    return output;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  private validateOutputDir(outputDir: string): { ok: true } | { ok: false; reason: string } {
    const allowedRoots = [
      this.config.workspaceDir,
      this.config.sharedDataDir,
    ].filter((value) => value.trim().length > 0).map((value) => path.resolve(value));
    if (allowedRoots.some((root) => this.isWithinDirectory(outputDir, root))) {
      return { ok: true };
    }
    return { ok: false, reason: "brainpack_output_dir_must_stay_inside_workspace_or_shared_data_dir" };
  }

  private isWithinDirectory(target: string, root: string): boolean {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }
}
