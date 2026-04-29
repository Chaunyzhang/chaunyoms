import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import {
  BridgeConfig,
  DagIntegrityReport,
  KnowledgeRawEntry,
} from "../types";
import {
  LifecycleContext,
} from "../host/OpenClawPayloadAdapter";
import {
  OmsAssetSyncResult,
  OmsAssetVerifyResult,
  OmsBackupResult,
  OmsKnowledgeCandidateListResult,
  OmsKnowledgeGovernanceResult,
  OmsKnowledgeReviewResult,
  OmsRestoreResult,
  OmsRuntimeStatus,
  OmsVerifyReport,
  OmsWipeResult,
} from "./ChaunyomsSessionRuntime";
import {
  SessionDataLayer,
  SessionDataStores,
  SummaryIntegrityInspection,
} from "../data/SessionDataLayer";
import { KnowledgeCandidateScorer } from "../engines/KnowledgeCandidateScorer";

interface OmsAdminDependencies {
  sessionData: SessionDataLayer;
  contextViewStore: { getItems(): unknown[]; clear(): void };
  knowledgeCandidateScorer: KnowledgeCandidateScorer;
  ensureSession: (sessionId: string, config: BridgeConfig) => Promise<SessionDataStores>;
  inspectDag: (context: Pick<LifecycleContext, "sessionId" | "config">) => Promise<DagIntegrityReport>;
  inspectAgentDag: (context: Pick<LifecycleContext, "sessionId" | "config">) => DagIntegrityReport;
  getLastCompactionDiagnostics: () => unknown;
}

export class OmsAdminService {
  constructor(private readonly deps: OmsAdminDependencies) {}

  async getStatus(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: { scope?: "session" | "agent" } = {},
  ): Promise<OmsRuntimeStatus> {
    const stores = await this.deps.ensureSession(context.sessionId, context.config);
    await this.deps.sessionData.mirrorRuntimeState();
    const scope = options.scope ?? "agent";
    const scopedQuery = scope === "session" ? { sessionId: context.sessionId } : undefined;
    const rawMessages = stores.rawStore.getAll(scopedQuery);
    const summaries = stores.summaryStore.getAllSummaries(scopedQuery);
    const memoryItemDrafts = stores.memoryItemDraftStore.getAll();
    const evidenceAtoms = stores.evidenceAtomStore.getAll(scopedQuery);
    const knowledgeRawItems = stores.knowledgeRawStore.getAll();
    return {
      ok: true,
      scope,
      sessionId: context.sessionId,
      agentId: context.config.agentId,
      dataDir: context.config.dataDir,
      workspaceDir: context.config.workspaceDir,
      knowledgeBaseDir: stores.knowledgeStore.getBaseDir(),
      memoryVaultDir: context.config.memoryVaultDir,
      counts: {
        rawMessages: rawMessages.length,
        uncompactedRawMessages: rawMessages.filter((message) => !message.compacted).length,
        uncompactedTokens: stores.rawStore.totalUncompactedTokens(scopedQuery),
        summaries: summaries.length,
        summaryTokens: stores.summaryStore.getTotalTokens(scopedQuery),
        observations: stores.observationStore.count(),
        memoryItemDrafts: memoryItemDrafts.length,
        activeMemoryItemDrafts: memoryItemDrafts.filter((memory) => memory.recordStatus !== "superseded" && memory.recordStatus !== "archived").length,
        evidenceAtoms: evidenceAtoms.length,
        knowledgeRawItems: knowledgeRawItems.length,
        pendingKnowledgeRawItems: knowledgeRawItems.filter((entry) => entry.status === "review_pending" || entry.status === "pending" || entry.status === "processing").length,
        projects: stores.projectStore.getAll().filter((project) => project.status !== "archived").length,
        contextItems: this.deps.contextViewStore.getItems().length,
      },
      config: {
        configPreset: context.config.configPreset,
        contextWindow: context.config.contextWindow,
        contextThreshold: context.config.contextThreshold,
        freshTailTokens: context.config.freshTailTokens,
        maxFreshTailTurns: context.config.maxFreshTailTurns,
        strictCompaction: context.config.strictCompaction,
        compactionBarrierEnabled: context.config.compactionBarrierEnabled,
        runtimeCaptureEnabled: context.config.runtimeCaptureEnabled,
        memoryItemEnabled: context.config.memoryItemEnabled,
        autoRecallEnabled: context.config.autoRecallEnabled,
        retrievalStrength: context.config.retrievalStrength,
        knowledgePromotionEnabled: context.config.knowledgePromotionEnabled,
        knowledgePromotionManualReviewEnabled: context.config.knowledgePromotionManualReviewEnabled,
        kbCandidateEnabled: context.config.kbCandidateEnabled,
        kbWriteEnabled: context.config.kbWriteEnabled,
        kbPromotionMode: context.config.kbPromotionMode,
        kbPromotionStrictness: context.config.kbPromotionStrictness,
        kbExportEnabled: context.config.kbExportEnabled,
        semanticCandidateExpansionEnabled: context.config.semanticCandidateExpansionEnabled,
        semanticCandidateLimit: context.config.semanticCandidateLimit,
        graphEnabled: context.config.graphEnabled,
        ragEnabled: context.config.ragEnabled,
        rerankEnabled: context.config.rerankEnabled,
        graphProvider: context.config.graphProvider,
        ragProvider: context.config.ragProvider,
        rerankProvider: context.config.rerankProvider,
        embeddingEnabled: context.config.embeddingEnabled,
        embeddingProvider: context.config.embeddingProvider,
        embeddingModel: context.config.embeddingModel,
        embeddingDimensions: context.config.embeddingDimensions,
        vectorExtensionPath: context.config.vectorExtensionPath,
        vectorExtensionEntryPoint: context.config.vectorExtensionEntryPoint,
        vectorSearchMaxCandidates: context.config.vectorSearchMaxCandidates,
        bruteForceVectorMaxRows: context.config.bruteForceVectorMaxRows,
        ragFallbackToBruteForce: context.config.ragFallbackToBruteForce,
        graphBuilderEnabled: context.config.graphBuilderEnabled,
        graphBuilderProvider: context.config.graphBuilderProvider,
        graphMaxDepth: context.config.graphMaxDepth,
        graphMaxFanout: context.config.graphMaxFanout,
        graphMinConfidence: context.config.graphMinConfidence,
        graphCandidateLimit: context.config.graphCandidateLimit,
        rerankModel: context.config.rerankModel,
        rerankTimeoutMs: context.config.rerankTimeoutMs,
        rerankFallbackToDeterministic: context.config.rerankFallbackToDeterministic,
        featureIsolationMode: context.config.featureIsolationMode,
        heavyRetrievalPolicy: context.config.heavyRetrievalPolicy,
        ragPlannerPolicy: context.config.ragPlannerPolicy,
        graphPlannerPolicy: context.config.graphPlannerPolicy,
        rerankPlannerPolicy: context.config.rerankPlannerPolicy,
        candidateRerankThreshold: context.config.candidateRerankThreshold,
        laneCandidateRerankThreshold: context.config.laneCandidateRerankThreshold,
        candidateAmbiguityMargin: context.config.candidateAmbiguityMargin,
        strictModeRequiresRerankOnConflict: context.config.strictModeRequiresRerankOnConflict,
        emergencyBrake: context.config.emergencyBrake,
        sqliteJournalMode: context.config.sqliteJournalMode,
      },
      runtimeStore: this.deps.sessionData.getRuntimeStore().getStatus(),
      lastCompactionDiagnostics: this.deps.getLastCompactionDiagnostics() as OmsRuntimeStatus["lastCompactionDiagnostics"],
    };
  }

  async verify(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: { scope?: "session" | "agent" } = {},
  ): Promise<OmsVerifyReport> {
    await this.deps.ensureSession(context.sessionId, context.config);
    await this.deps.sessionData.mirrorRuntimeState();
    const scope = options.scope ?? "agent";
    const summaryDag = scope === "session"
      ? await this.deps.inspectDag(context)
      : this.deps.inspectAgentDag(context);
    const summaryIntegrity = this.deps.sessionData.inspectSummaryIntegrity();
    const runtimeStoreInstance = this.deps.sessionData.getRuntimeStore();
    const summarySourceTrace = runtimeStoreInstance.inspectSummarySourceTrace(
      scope === "session" ? { sessionId: context.sessionId } : {},
    );
    const runtimeStore = runtimeStoreInstance.verifyIntegrity();
    const errors = [
      ...(summaryDag.ok ? [] : summaryDag.issues.filter((issue) => issue.severity === "error").map((issue) => `${issue.code}: ${issue.message}`)),
      ...(summaryIntegrity.mismatched > 0 ? [`${summaryIntegrity.mismatched} summaries failed source hash verification.`] : []),
      ...runtimeStore.errors,
    ];
    const warnings = [
      ...summaryDag.issues.filter((issue) => issue.severity === "warning").map((issue) => `${issue.code}: ${issue.message}`),
      ...(summaryIntegrity.unchecked > 0 ? [`${summaryIntegrity.unchecked} summaries have no source hash to verify.`] : []),
      ...summarySourceTrace.warnings,
      ...runtimeStore.warnings,
    ];
    return {
      ok: summaryDag.ok && summaryIntegrity.mismatched === 0 && runtimeStore.ok && errors.length === 0,
      scope,
      sessionId: context.sessionId,
      agentId: context.config.agentId,
      summaryDag,
      summaryIntegrity,
      summarySourceTrace,
      runtimeStore,
      warnings,
      errors,
    };
  }

  async exportAgentCapsule(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: { agentId?: string; label?: string } = {},
  ): Promise<Record<string, unknown>> {
    const stores = await this.deps.ensureSession(context.sessionId, context.config);
    await this.deps.sessionData.mirrorRuntimeState();
    const agentId = (options.agentId || context.config.agentId).trim();
    if (!agentId || agentId !== context.config.agentId) {
      return {
        ok: false,
        agentId,
        reason: "Only the current configured agent can be exported by this runtime instance.",
      };
    }

    const safeLabel = (options.label ?? "").trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const capsuleDir = path.join(context.config.dataDir, "agent_capsules", agentId, `${stamp}${safeLabel ? `-${safeLabel}` : ""}`);
    await mkdir(capsuleDir, { recursive: true });

    const runtimeStore = this.deps.sessionData.getRuntimeStore();
    const runtimeStatus = runtimeStore.getStatus();
    const capsuleSqlite = path.join(capsuleDir, "capsule.sqlite");
    const capsuleSql = path.join(capsuleDir, "capsule.sql");
    const manifestPath = path.join(capsuleDir, "manifest.json");
    const checksumsPath = path.join(capsuleDir, "checksums.txt");
    const restorePath = path.join(capsuleDir, "README.restore.txt");

    const copied: string[] = [];
    const skipped: string[] = [];
    if (await this.copyIfPresent(runtimeStatus.dbPath, capsuleSqlite)) {
      copied.push("capsule.sqlite");
    } else {
      skipped.push("capsule.sqlite");
    }

    const rawMessages = stores.rawStore.getAll();
    const summaries = stores.summaryStore.getAllSummaries();
    const memoryItemDrafts = stores.memoryItemDraftStore.getAll();
    const evidenceAtoms = stores.evidenceAtomStore.getAll();
    const knowledgeRaw = stores.knowledgeRawStore.getAll();
    const memoryItems = runtimeStore.listMemoryItems({ agentId });
    const verify = await this.verify(context, { scope: "agent" });
    const manifest = {
      schemaVersion: 1,
      capsuleKind: "full_agent_capsule",
      createdAt: new Date().toISOString(),
      agentId,
      sessionId: context.sessionId,
      runtimeSchema: "sqlite-first",
      includes: {
        completeSource: true,
        sqlite: copied.includes("capsule.sqlite"),
        sqlText: true,
        sourceTrace: true,
        memoryItems: true,
      },
      counts: {
        rawMessages: rawMessages.length,
        summaries: summaries.length,
        memoryItemDrafts: memoryItemDrafts.length,
        evidenceAtoms: evidenceAtoms.length,
        knowledgeRaw: knowledgeRaw.length,
        memoryItems: memoryItems.length,
        sourceEdges: runtimeStatus.counts.sourceEdges,
        traceEdges: runtimeStatus.counts.traceEdges,
      },
      config: {
        agentId: context.config.agentId,
        retrievalStrength: context.config.retrievalStrength,
        kbPromotionMode: context.config.kbPromotionMode,
        kbPromotionStrictness: context.config.kbPromotionStrictness,
      },
      verify: {
        ok: verify.ok,
        warnings: verify.warnings,
        errors: verify.errors,
      },
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(capsuleSql, [
      "-- ChaunyOMS full Agent Capsule text manifest",
      `-- agent_id: ${agentId}`,
      `-- created_at: ${manifest.createdAt}`,
      "-- The authoritative restore artifact is capsule.sqlite; this file is for Git-visible review.",
      `-- counts: ${JSON.stringify(manifest.counts)}`,
      "",
    ].join("\n"), "utf8");
    await writeFile(restorePath, [
      "# Restore ChaunyOMS Agent Capsule",
      "",
      "1. Verify first with `oms_agent_verify`.",
      "2. Import defaults to dry-run. Use `oms_agent_import` with `apply=true` only after backup review.",
      "3. `capsule.sqlite` is the complete runtime brain package for this agent and contains the Source ledger plus traceable summaries/memory.",
      "4. Markdown/Obsidian exports are not part of the runtime brain and should remain a separate Git repository.",
      "",
    ].join("\n"), "utf8");
    const checksums = await this.buildChecksums([manifestPath, capsuleSql, capsuleSqlite, restorePath]);
    await writeFile(checksumsPath, checksums.join("\n") + "\n", "utf8");

    return {
      ok: copied.includes("capsule.sqlite") && verify.ok,
      capsuleDir,
      manifestPath,
      checksumsPath,
      agentId,
      copied,
      skipped,
      counts: manifest.counts,
      warnings: verify.warnings,
      errors: verify.errors,
    };
  }

  async verifyAgentCapsule(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    capsulePathInput: string,
  ): Promise<Record<string, unknown>> {
    const capsuleDir = path.resolve(capsulePathInput);
    const allowedRoot = path.resolve(context.config.dataDir, "agent_capsules");
    if (!this.isPathInside(capsuleDir, allowedRoot)) {
      return {
        ok: false,
        capsuleDir,
        errors: ["capsulePath must be inside dataDir/agent_capsules for this runtime."],
        warnings: [],
      };
    }
    const manifestPath = path.join(capsuleDir, "manifest.json");
    const checksumsPath = path.join(capsuleDir, "checksums.txt");
    const sqlitePath = path.join(capsuleDir, "capsule.sqlite");
    const sqlPath = path.join(capsuleDir, "capsule.sql");
    const restorePath = path.join(capsuleDir, "README.restore.txt");
    const errors: string[] = [];
    const warnings: string[] = [];
    let manifest: Record<string, unknown> | null = null;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      errors.push(`manifest.json missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const filePath of [sqlitePath, sqlPath, restorePath, checksumsPath]) {
      try {
        await readFile(filePath);
      } catch {
        errors.push(`${path.basename(filePath)} is missing`);
      }
    }
    if (manifest && this.asRecord(manifest.includes).completeSource !== true) {
      errors.push("manifest does not declare completeSource=true");
    }
    const counts = manifest ? this.asRecord(manifest.counts) : {};
    if (Number(counts.rawMessages ?? 0) <= 0) {
      warnings.push("capsule has zero raw Source messages; this may be valid for a new agent but is not a useful full brain export.");
    }
    if (errors.length === 0) {
      const expected = await readFile(checksumsPath, "utf8");
      const checksumErrors = await this.verifyChecksums(capsuleDir, expected);
      errors.push(...checksumErrors);
    }
    return {
      ok: errors.length === 0,
      capsuleDir,
      manifest,
      counts,
      errors,
      warnings,
    };
  }

  async importAgentCapsule(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    capsulePathInput: string,
    apply = false,
  ): Promise<Record<string, unknown>> {
    const verification = await this.verifyAgentCapsule(context, capsulePathInput);
    if (!verification.ok) {
      return {
        ok: false,
        apply,
        verification,
        reason: "capsule_verification_failed",
      };
    }
    if (!apply) {
      return {
        ok: true,
        apply,
        verification,
        warnings: ["Dry run only. Re-run with apply=true to replace the current agent runtime SQLite with capsule.sqlite."],
      };
    }
    const backup = await this.backup(context, `pre-capsule-import-${context.config.agentId}`);
    const target = this.deps.sessionData.getRuntimeStore().getPath();
    await cp(path.join(String(verification.capsuleDir), "capsule.sqlite"), target, { force: true });
    return {
      ok: true,
      apply,
      verification,
      backupDir: backup.backupDir,
      imported: ["capsule.sqlite"],
      target,
    };
  }

  async backup(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    label = "",
  ): Promise<OmsBackupResult> {
    await this.deps.ensureSession(context.sessionId, context.config);
    await this.deps.sessionData.mirrorRuntimeState();
    const safeLabel = label.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(context.config.dataDir, "backups", `chaunyoms-${stamp}${safeLabel ? `-${safeLabel}` : ""}`);
    const copied: string[] = [];
    const skipped: string[] = [];
    await mkdir(backupDir, { recursive: true });
    const sources = this.restoreCopyPlan(context.config, backupDir).map((item) => ({
      label: item.label,
      source: item.target,
      target: item.source,
    }));
    for (const source of sources) {
      if (await this.copyIfPresent(source.source, source.target)) {
        copied.push(source.label);
      } else {
        skipped.push(source.label);
      }
    }
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      sessionId: context.sessionId,
      agentId: context.config.agentId,
      paths: sources,
      config: {
        dataDir: context.config.dataDir,
        workspaceDir: context.config.workspaceDir,
        knowledgeBaseDir: context.config.knowledgeBaseDir,
        memoryVaultDir: context.config.memoryVaultDir,
      },
    };
    const manifestPath = path.join(backupDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    return { ok: true, backupDir, manifestPath, copied, skipped };
  }

  async verifyMigration(context: Pick<LifecycleContext, "sessionId" | "config">): Promise<Record<string, unknown>> {
    const stores = await this.deps.ensureSession(context.sessionId, context.config);
    await this.deps.sessionData.mirrorRuntimeState();
    const runtimeStatus = this.deps.sessionData.getRuntimeStore().getStatus();
    const rawMessages = stores.rawStore.getAll();
    const summaries = stores.summaryStore.getAllSummaries();
    const memories = stores.memoryItemDraftStore.getAll();
    const atoms = stores.evidenceAtomStore.getAll();
    const comparisons = {
      messages: { repository: rawMessages.length, sqlite: runtimeStatus.counts.messages },
      summaries: { repository: summaries.length, sqlite: runtimeStatus.counts.summaries },
      memories: { repository: memories.length, sqlite: runtimeStatus.counts.memories },
      evidenceAtoms: { repository: atoms.length, sqlite: runtimeStatus.counts.evidenceAtoms },
    };
    const mismatches = Object.entries(comparisons)
      .filter(([, value]) => value.repository !== value.sqlite)
      .map(([key, value]) => `${key}: repository=${value.repository} sqlite=${value.sqlite}`);
    return {
      ok: runtimeStatus.enabled && mismatches.length === 0,
      mode: "sqlite_primary",
      comparisons,
      runtimeStore: runtimeStatus,
      errors: mismatches,
      warnings: [],
    };
  }

  async exportJsonBackup(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    label = "",
  ): Promise<Record<string, unknown>> {
    const stores = await this.deps.ensureSession(context.sessionId, context.config);
    await this.deps.sessionData.mirrorRuntimeState();
    const safeLabel = label.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const exportDir = path.join(context.config.dataDir, "backups", `sqlite-json-export-${stamp}${safeLabel ? `-${safeLabel}` : ""}`);
    await mkdir(exportDir, { recursive: true });
    const files = {
      raw: path.join(exportDir, "raw-messages.json"),
      summaries: path.join(exportDir, "summaries.json"),
      memoryItemDrafts: path.join(exportDir, "memory-item-drafts.json"),
      evidenceAtoms: path.join(exportDir, "evidence-atoms.json"),
      observations: path.join(exportDir, "observations.json"),
      projects: path.join(exportDir, "projects.json"),
      knowledgeRaw: path.join(exportDir, "knowledge-raw.json"),
    };
    await writeFile(files.raw, JSON.stringify(stores.rawStore.getAll(), null, 2), "utf8");
    await writeFile(files.summaries, JSON.stringify(stores.summaryStore.getAllSummaries(), null, 2), "utf8");
    await writeFile(files.memoryItemDrafts, JSON.stringify(stores.memoryItemDraftStore.getAll(), null, 2), "utf8");
    await writeFile(files.evidenceAtoms, JSON.stringify(stores.evidenceAtomStore.getAll(), null, 2), "utf8");
    await writeFile(files.observations, JSON.stringify(stores.observationStore.getAll(), null, 2), "utf8");
    await writeFile(files.projects, JSON.stringify(stores.projectStore.getAll(), null, 2), "utf8");
    await writeFile(files.knowledgeRaw, JSON.stringify(stores.knowledgeRawStore.getAll(), null, 2), "utf8");
    await writeFile(path.join(exportDir, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      agentId: context.config.agentId,
      sessionId: context.sessionId,
      source: "sqlite_primary_export",
      files,
    }, null, 2), "utf8");
    return { ok: true, exportDir, files };
  }

  async cleanupLegacyJson(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    apply = false,
  ): Promise<Record<string, unknown>> {
    await this.deps.ensureSession(context.sessionId, context.config);
    const agentDir = path.join(context.config.dataDir, "agents", context.config.agentId);
    const patterns = [
      /\.raw\.jsonl$/i,
      /\.summaries\.json$/i,
      /\.observations\.jsonl$/i,
      /\.memory-item-draft\.json$/i,
      /\.knowledge-raw\.json$/i,
      /\.evidence-atoms\.json$/i,
      /^project-registry\.json$/i,
    ];
    const entries = await this.listDirectory(agentDir);
    const candidates = entries
      .filter((entry) => patterns.some((pattern) => pattern.test(path.basename(entry))))
      .map((entry) => path.join(agentDir, entry));
    const removed: string[] = [];
    if (apply) {
      for (const candidate of candidates) {
        await rm(candidate, { force: true, recursive: false });
        removed.push(candidate);
      }
    }
    return {
      ok: true,
      apply,
      agentDir,
      candidates,
      removed,
      warnings: apply
        ? ["Legacy JSON hot-path files removed. SQLite remains the runtime source of truth."]
        : ["Dry run only. Re-run with apply=true after exporting a backup if you want to delete legacy JSON files."],
    };
  }

  async migrateJsonToSqlite(context: Pick<LifecycleContext, "sessionId" | "config">): Promise<Record<string, unknown>> {
    const verification = await this.verifyMigration(context);
    return {
      ok: verification.ok,
      mode: "sqlite_first_final_shape",
      imported: 0,
      verification,
      warnings: [
        "Final-shape P2 no longer performs implicit legacy JSON import on the hot path.",
        "Use oms_export_json_backup before cleanup if you need an archival copy; legacy data adaptation is intentionally not automatic.",
      ],
    };
  }

  async restore(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    backupDirInput: string,
    apply = false,
  ): Promise<OmsRestoreResult> {
    await this.deps.ensureSession(context.sessionId, context.config);
    const backupsRoot = path.resolve(context.config.dataDir, "backups");
    const backupDir = path.resolve(backupDirInput);
    if (!backupDir.startsWith(backupsRoot)) {
      return {
        ok: false,
        backupDir,
        apply,
        manifest: null,
        copied: [],
        skipped: [],
        reason: "backupDir must be inside the ChaunyOMS dataDir/backups directory",
      };
    }
    const manifestPath = path.join(backupDir, "manifest.json");
    let manifest: Record<string, unknown> | null = null;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      return {
        ok: false,
        backupDir,
        apply,
        manifest: null,
        copied: [],
        skipped: [],
        reason: `manifest.json is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!apply) {
      return {
        ok: true,
        backupDir,
        apply,
        manifest,
        copied: [],
        skipped: ["dry_run_only"],
        reason: "Restore manifest validated. Re-run with apply=true to overlay files.",
      };
    }
    const rollbackBackup = await this.backup(context, "pre-restore");
    const copies = this.restoreCopyPlan(context.config, backupDir);
    try {
      const copied: string[] = [];
      const skipped: string[] = [];
      for (const item of copies) {
        if (await this.copyIfPresent(item.source, item.target)) {
          copied.push(item.label);
        } else {
          skipped.push(item.label);
        }
      }
      return {
        ok: true,
        backupDir,
        apply,
        manifest,
        rollbackBackupDir: rollbackBackup.backupDir,
        copied,
        skipped,
      };
    } catch (error) {
      const rollback = this.restoreCopyPlan(context.config, rollbackBackup.backupDir);
      let rollbackApplied = false;
      try {
        for (const item of rollback) {
          await this.copyIfPresent(item.source, item.target);
        }
        rollbackApplied = true;
      } catch {
        rollbackApplied = false;
      }
      return {
        ok: false,
        backupDir,
        apply,
        manifest,
        rollbackBackupDir: rollbackBackup.backupDir,
        rollbackApplied,
        copied: [],
        skipped: [],
        reason: `restore failed${rollbackApplied ? " and rollback was applied" : " and rollback failed"}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async curateKnowledge(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    apply = false,
  ): Promise<OmsKnowledgeGovernanceResult> {
    await this.deps.ensureSession(context.sessionId, context.config);
    await this.deps.sessionData.mirrorRuntimeState();
    const runtimeStore = this.deps.sessionData.getRuntimeStore();
    const report = runtimeStore.inspectKnowledgeGovernance();
    const actions: string[] = [];
    if (report.duplicateCanonicalKeys.length > 0) {
      actions.push("Review duplicate canonical keys and mark stale assets superseded after human confirmation.");
    }
    if (report.assetsWithoutProvenance.length > 0) {
      actions.push("Attach source_refs or linked_summary_ids before treating these assets as reviewed knowledge.");
    }
    if (apply) {
      actions.push("No automatic destructive curation was applied; ChaunyOMS keeps knowledge cleanup advisory unless a specific supersede/link action is requested.");
    }
    return {
      ok: report.warnings.length === 0,
      apply,
      report,
      actions,
      warnings: report.warnings,
    };
  }

  async syncKnowledgeAssets(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    mode: "sync" | "reindex" = "sync",
  ): Promise<OmsAssetSyncResult> {
    const { knowledgeStore } = await this.deps.ensureSession(context.sessionId, context.config);
    const markdown = await knowledgeStore.syncAssetIndex(mode);
    const runtime = await this.deps.sessionData.getRuntimeStore().syncAssetsFromMarkdownIndex(mode);
    return {
      ok: markdown.ok && runtime.ok,
      mode,
      markdown,
      runtime,
    };
  }

  async verifyKnowledgeAssets(
    context: Pick<LifecycleContext, "sessionId" | "config">,
  ): Promise<OmsAssetVerifyResult> {
    const { knowledgeStore } = await this.deps.ensureSession(context.sessionId, context.config);
    const markdown = await knowledgeStore.verifyAssetIndex();
    await this.deps.sessionData.getRuntimeStore().syncAssetsFromMarkdownIndex("sync");
    const runtime = this.deps.sessionData.getRuntimeStore().inspectKnowledgeGovernance();
    const warnings = [...markdown.warnings, ...runtime.warnings];
    return {
      ok: markdown.ok && runtime.warnings.length === 0,
      markdown,
      runtime,
      warnings,
    };
  }

  async listKnowledgeCandidates(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: { status?: string; limit?: number } = {},
  ): Promise<OmsKnowledgeCandidateListResult> {
    const { knowledgeRawStore } = await this.deps.ensureSession(context.sessionId, context.config);
    const limit = Math.max(Math.min(options.limit ?? 20, 100), 1);
    const candidates = knowledgeRawStore.getAll()
      .filter((entry) => !options.status || entry.status === options.status)
      .sort((left, right) =>
        (right.score?.total ?? 0) - (left.score?.total ?? 0) ||
        right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((entry) => ({
        id: entry.id,
        oneLineSummary: entry.oneLineSummary ?? this.deps.knowledgeCandidateScorer.summarize(entry.sourceSummary),
        score: entry.score?.total ?? null,
        recommendation: entry.score?.recommendation ?? null,
        status: entry.status,
        reviewState: entry.review?.state ?? null,
        sourceSummaryId: entry.sourceSummaryId,
        intakeReason: entry.intakeReason,
        createdAt: entry.createdAt,
      }));
    return {
      ok: true,
      total: candidates.length,
      candidates,
    };
  }

  async reviewKnowledgeCandidate(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    args: {
      id: string;
      action: "approve" | "reject";
      reviewer?: string;
      note?: string;
      onApprove?: () => void;
    },
  ): Promise<OmsKnowledgeReviewResult> {
    const { knowledgeRawStore } = await this.deps.ensureSession(context.sessionId, context.config);
    const candidate = await knowledgeRawStore.markReview(args);
    if (!candidate) {
      return {
        ok: false,
        action: args.action,
        candidate: null,
        reason: "knowledge_candidate_not_found",
      };
    }
    if (args.action === "approve") {
      args.onApprove?.();
    }
    return {
      ok: true,
      action: args.action,
      candidate,
    };
  }

  async wipeSession(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: {
      apply?: boolean;
      backupBeforeApply?: boolean;
    } = {},
  ): Promise<OmsWipeResult> {
    await this.deps.ensureSession(context.sessionId, context.config);
    if (!options.apply) {
      return {
        ok: true,
        scope: "session",
        apply: false,
        sessionId: context.sessionId,
        removed: [],
        skipped: [],
        warnings: [
          "Dry run only. Re-run with apply=true to remove session-scoped files and SQLite rows.",
          "Shared Markdown knowledge assets are preserved by session wipe.",
        ],
        reason: "dry_run_only",
      };
    }
    const backup = options.backupBeforeApply === false
      ? null
      : await this.backup(context, `pre-wipe-session-${context.sessionId}`);
    const result = await this.deps.sessionData.wipeSession(context.sessionId, context.config);
    this.deps.contextViewStore.clear();
    return {
      ok: true,
      scope: "session",
      apply: true,
      sessionId: context.sessionId,
      removed: result.removed,
      skipped: result.skipped,
      warnings: result.warnings,
      backupDir: backup?.backupDir,
    };
  }

  async wipeAgent(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: {
      apply?: boolean;
      backupBeforeApply?: boolean;
      wipeKnowledgeBase?: boolean;
      wipeWorkspaceMemory?: boolean;
      wipeBackups?: boolean;
    } = {},
  ): Promise<OmsWipeResult> {
    await this.deps.ensureSession(context.sessionId, context.config);
    if (!options.apply) {
      return {
        ok: true,
        scope: "agent",
        apply: false,
        sessionId: context.sessionId,
        agentId: context.config.agentId,
        removed: [],
        skipped: [],
        warnings: [
          "Dry run only. Re-run with apply=true to remove agent-scoped runtime data.",
          "wipeKnowledgeBase=false keeps shared reviewed Markdown knowledge assets in place.",
        ],
        reason: "dry_run_only",
      };
    }
    const backup = options.backupBeforeApply === false
      ? null
      : await this.backup(context, `pre-wipe-agent-${context.config.agentId}`);
    const result = await this.deps.sessionData.wipeAgent(context.config, {
      wipeKnowledgeBase: options.wipeKnowledgeBase,
      wipeWorkspaceMemory: options.wipeWorkspaceMemory,
      wipeBackups: options.wipeBackups,
    });
    this.deps.contextViewStore.clear();
    return {
      ok: true,
      scope: "agent",
      apply: true,
      sessionId: context.sessionId,
      agentId: context.config.agentId,
      removed: result.removed,
      skipped: result.skipped,
      warnings: result.warnings,
      backupDir: backup?.backupDir,
    };
  }

  private restoreCopyPlan(config: BridgeConfig, backupDir: string): Array<{ label: string; source: string; target: string }> {
    return [
      { label: "agent_data", source: path.join(backupDir, "agent_data"), target: path.join(config.dataDir, "agents", config.agentId) },
      { label: "knowledge", source: path.join(backupDir, "knowledge"), target: config.knowledgeBaseDir },
      { label: "agent_vault", source: path.join(backupDir, "agent_vault"), target: path.join(config.memoryVaultDir, "agents", config.agentId) },
      { label: "workspace_memory", source: path.join(backupDir, "workspace_memory"), target: path.join(config.workspaceDir, "memory") },
    ];
  }

  private async buildChecksums(filePaths: string[]): Promise<string[]> {
    const rows: string[] = [];
    for (const filePath of filePaths) {
      try {
        const content = await readFile(filePath);
        rows.push(`${this.sha256(content)}  ${path.basename(filePath)}`);
      } catch {
        // Missing optional files are reflected in the manifest skipped list.
      }
    }
    return rows;
  }

  private async verifyChecksums(capsuleDir: string, checksumsText: string): Promise<string[]> {
    const errors: string[] = [];
    for (const line of checksumsText.split(/\r?\n/)) {
      const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
      if (!match) {
        continue;
      }
      const expected = match[1].toLowerCase();
      const fileName = match[2].trim();
      try {
        const actual = this.sha256(await readFile(path.join(capsuleDir, fileName)));
        if (actual !== expected) {
          errors.push(`${fileName} checksum mismatch`);
        }
      } catch {
        errors.push(`${fileName} listed in checksums.txt but missing`);
      }
    }
    return errors;
  }

  private sha256(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private isPathInside(candidatePath: string, allowedRoot: string): boolean {
    const relative = path.relative(allowedRoot, candidatePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private async copyIfPresent(source: string, target: string): Promise<boolean> {
    try {
      await cp(source, target, { recursive: true, force: true });
      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async listDirectory(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}
