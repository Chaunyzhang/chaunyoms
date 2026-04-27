import path from "node:path";
import { rm } from "node:fs/promises";

import { DurableMemoryStore } from "../stores/DurableMemoryStore";
import { EvidenceAtomStore } from "../stores/EvidenceAtomStore";
import { KnowledgeRawStore } from "../stores/KnowledgeRawStore";
import { KnowledgeMarkdownStore } from "../stores/KnowledgeMarkdownStore";
import { ObservationStore } from "../stores/ObservationStore";
import { ProjectRegistryStore } from "../stores/ProjectRegistryStore";
import { RawMessageStore } from "../stores/RawMessageStore";
import { RuntimeStatsLogStore } from "../stores/RuntimeStatsLogStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { SQLiteRuntimeStore } from "./SQLiteRuntimeStore";
import {
  SQLiteDurableMemoryRepository,
  SQLiteEvidenceAtomRepository,
  SQLiteKnowledgeRawRepository,
  SQLiteObservationRepository,
  SQLiteProjectRegistryRepository,
  SQLiteRawMessageRepository,
  SQLiteSummaryRepository,
} from "./SQLitePrimaryRepositories";
import { ContextPlannerResult } from "../engines/ContextPlanner";
import {
  BridgeConfig,
  DurableMemoryEntry,
  DurableMemoryRepository,
  EvidenceAtomEntry,
  EvidenceAtomRepository,
  KnowledgeRawRepository,
  LoggerLike,
  KnowledgeRepository,
  ObservationEntry,
  ObservationRepository,
  ProjectRecord,
  ProjectRegistryRepository,
  RawMessage,
  RawMessageRepository,
  SummaryEntry,
  SummaryRepository,
} from "../types";
import { SourceMessageResolver } from "../resolvers/SourceMessageResolver";
import { DataSchemaRegistry } from "./DataSchemaRegistry";
import { SessionDataMigrationRunner } from "./SessionDataMigrationRunner";
import { AgentVault } from "./AgentVault";
import { SessionUpgradeManager } from "./SessionUpgradeManager";

export interface SessionDataStores {
  rawStore: RawMessageRepository;
  summaryStore: SummaryRepository;
  observationStore: ObservationRepository;
  durableMemoryStore: DurableMemoryRepository;
  evidenceAtomStore: EvidenceAtomRepository;
  knowledgeRawStore: KnowledgeRawRepository;
  knowledgeStore: KnowledgeRepository;
  projectStore: ProjectRegistryRepository;
}

export interface SummaryIntegrityInspection {
  total: number;
  verified: number;
  mismatched: number;
  unchecked: number;
  verifiedEntries: Array<{ sessionId: string; startTurn: number; endTurn: number }>;
}

export class SessionDataLayer {
  private rawStore: RawMessageRepository | null = null;
  private summaryStore: SummaryRepository | null = null;
  private observationStore: ObservationRepository | null = null;
  private durableMemoryStore: DurableMemoryRepository | null = null;
  private evidenceAtomStore: EvidenceAtomRepository | null = null;
  private knowledgeRawStore: KnowledgeRawRepository | null = null;
  private knowledgeStore: KnowledgeMarkdownStore | null = null;
  private projectStore: ProjectRegistryRepository | null = null;
  private statsLogStore: RuntimeStatsLogStore | null = null;
  private runtimeStore: SQLiteRuntimeStore | null = null;
  private schemaRegistry: DataSchemaRegistry | null = null;
  private migrationRunner: SessionDataMigrationRunner | null = null;
  private agentVault: AgentVault | null = null;
  private upgradeManager: SessionUpgradeManager | null = null;
  private boundAgentId: string | null = null;
  private boundSessionId: string | null = null;
  private boundConfig: Pick<
    BridgeConfig,
    | "dataDir"
    | "workspaceDir"
    | "sharedDataDir"
    | "knowledgeBaseDir"
    | "memoryVaultDir"
    | "sqliteJournalMode"
    | "agentVaultMirrorEnabled"
    | "summaryMarkdownMirrorEnabled"
    | "durableMarkdownMirrorEnabled"
    | "transcriptMirrorEnabled"
    | "knowledgeMarkdownEnabled"
    | "sqlitePrimaryEnabled"
    | "jsonPersistenceMode"
  > | null = null;
  private readonly sourceMessageResolver = new SourceMessageResolver();
  private runtimeMirrorSignature: string | null = null;
  private runtimeMirrorDirty = false;

  constructor(private readonly logger: LoggerLike) {}

  async ensure(sessionId: string, config: BridgeConfig): Promise<SessionDataStores> {
    const agentDataDir = this.resolveAgentDataDir(config);
    const knowledgeDir = this.resolveSharedKnowledgeDir(config);
    if (
      this.rawStore &&
      this.summaryStore &&
      this.observationStore &&
      this.durableMemoryStore &&
      this.evidenceAtomStore &&
      this.knowledgeRawStore &&
      this.knowledgeStore &&
      this.projectStore &&
      this.runtimeStore &&
      this.agentVault &&
      this.boundAgentId === config.agentId &&
      this.boundSessionId === sessionId &&
      this.boundConfig?.dataDir === config.dataDir &&
      this.boundConfig?.workspaceDir === config.workspaceDir &&
      this.boundConfig?.sharedDataDir === config.sharedDataDir &&
      this.boundConfig?.knowledgeBaseDir === config.knowledgeBaseDir &&
      this.boundConfig?.memoryVaultDir === config.memoryVaultDir &&
      this.boundConfig?.sqliteJournalMode === config.sqliteJournalMode &&
      this.boundConfig?.agentVaultMirrorEnabled === config.agentVaultMirrorEnabled &&
      this.boundConfig?.summaryMarkdownMirrorEnabled === config.summaryMarkdownMirrorEnabled &&
      this.boundConfig?.durableMarkdownMirrorEnabled === config.durableMarkdownMirrorEnabled &&
      this.boundConfig?.transcriptMirrorEnabled === config.transcriptMirrorEnabled &&
      this.boundConfig?.knowledgeMarkdownEnabled === config.knowledgeMarkdownEnabled &&
      this.boundConfig?.sqlitePrimaryEnabled === config.sqlitePrimaryEnabled &&
      this.boundConfig?.jsonPersistenceMode === config.jsonPersistenceMode
    ) {
      return this.getStores();
    }

    // Current ChaunyOMS runtime is SQLite-first and no longer treats legacy JSON
    // migrations as a hot-path startup responsibility. Store classes below are
    // initialized for current writes, Markdown assets, and operational mirrors;
    // historical schema import/export remains an explicit offline concern.
    this.schemaRegistry = null;
    this.migrationRunner = null;
    this.upgradeManager = null;
    this.knowledgeStore = new KnowledgeMarkdownStore(knowledgeDir);
    this.statsLogStore = new RuntimeStatsLogStore(config.dataDir);
    this.runtimeStore = new SQLiteRuntimeStore({
      dbPath: path.join(agentDataDir, "chaunyoms-runtime.sqlite"),
      agentId: config.agentId,
      knowledgeBaseDir: knowledgeDir,
      logger: this.logger,
      journalMode: config.sqliteJournalMode,
    });
    await this.runtimeStore.init();
    if (config.sqlitePrimaryEnabled) {
      const runtimeStatus = this.runtimeStore.getStatus();
      if (!runtimeStatus.enabled) {
        throw new Error("SQLite primary storage is enabled but the SQLite runtime store is unavailable.");
      }
      this.rawStore = new SQLiteRawMessageRepository(this.runtimeStore);
      this.summaryStore = new SQLiteSummaryRepository(this.runtimeStore);
      this.observationStore = new SQLiteObservationRepository(this.runtimeStore, config.agentId);
      this.durableMemoryStore = new SQLiteDurableMemoryRepository(this.runtimeStore);
      this.evidenceAtomStore = new SQLiteEvidenceAtomRepository(this.runtimeStore);
      this.knowledgeRawStore = new SQLiteKnowledgeRawRepository(this.runtimeStore, sessionId, config.agentId);
      this.projectStore = new SQLiteProjectRegistryRepository(this.runtimeStore, config.agentId);
    } else {
      this.rawStore = new RawMessageStore(agentDataDir, config.agentId);
      this.summaryStore = new SummaryIndexStore(agentDataDir, config.agentId);
      this.observationStore = new ObservationStore(agentDataDir, config.agentId);
      this.durableMemoryStore = new DurableMemoryStore(agentDataDir, config.agentId);
      this.evidenceAtomStore = new EvidenceAtomStore(agentDataDir, config.agentId);
      this.knowledgeRawStore = new KnowledgeRawStore(agentDataDir, sessionId);
      this.projectStore = new ProjectRegistryStore(agentDataDir, config.agentId);
    }
    this.agentVault = new AgentVault(config.memoryVaultDir, config.agentId);
    await this.rawStore.init();
    await this.summaryStore.init();
    await this.observationStore.init();
    await this.durableMemoryStore.init();
    await this.evidenceAtomStore.init();
    await this.knowledgeRawStore.init();
    await this.knowledgeStore.init();
    await this.projectStore.init();
    if (config.agentVaultMirrorEnabled) {
      await this.agentVault.ensureLayout();
    }
    this.boundAgentId = config.agentId;
    this.boundSessionId = sessionId;
    this.boundConfig = {
      dataDir: config.dataDir,
      workspaceDir: config.workspaceDir,
      sharedDataDir: config.sharedDataDir,
      knowledgeBaseDir: config.knowledgeBaseDir,
      memoryVaultDir: config.memoryVaultDir,
      sqliteJournalMode: config.sqliteJournalMode,
      agentVaultMirrorEnabled: config.agentVaultMirrorEnabled,
      summaryMarkdownMirrorEnabled: config.summaryMarkdownMirrorEnabled,
      durableMarkdownMirrorEnabled: config.durableMarkdownMirrorEnabled,
      transcriptMirrorEnabled: config.transcriptMirrorEnabled,
      knowledgeMarkdownEnabled: config.knowledgeMarkdownEnabled,
      sqlitePrimaryEnabled: config.sqlitePrimaryEnabled,
      jsonPersistenceMode: config.jsonPersistenceMode,
    };
    this.runtimeMirrorSignature = null;
    this.runtimeMirrorDirty = false;
    return this.getStores();
  }

  getStores(): SessionDataStores {
    if (!this.rawStore || !this.summaryStore || !this.observationStore || !this.durableMemoryStore || !this.evidenceAtomStore || !this.knowledgeRawStore || !this.knowledgeStore || !this.projectStore) {
      throw new Error("SessionDataLayer stores are not initialized");
    }
    return {
      rawStore: this.rawStore,
      summaryStore: this.summaryStore,
      observationStore: this.observationStore,
      durableMemoryStore: this.durableMemoryStore,
      evidenceAtomStore: this.evidenceAtomStore,
      knowledgeRawStore: this.knowledgeRawStore,
      knowledgeStore: this.knowledgeStore,
      projectStore: this.projectStore,
    };
  }

  async appendRawMessage(message: RawMessage): Promise<void> {
    await this.rawStore?.append(message);
    this.runtimeMirrorDirty = this.boundConfig?.sqlitePrimaryEnabled ? false : true;
  }

  async appendRawMessages(messages: RawMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    if (this.rawStore?.appendMany) {
      await this.rawStore.appendMany(messages);
    } else {
      for (const message of messages) {
        await this.rawStore?.append(message);
      }
    }
    this.runtimeMirrorDirty = this.boundConfig?.sqlitePrimaryEnabled ? false : true;
  }

  async appendObservation(entry: ObservationEntry): Promise<void> {
    await this.getStores().observationStore.append(entry);
  }

  async addDurableEntries(entries: DurableMemoryEntry[]): Promise<number> {
    const durableMemoryStore = this.getStores().durableMemoryStore;
    const added = await durableMemoryStore.addEntries(entries);
    if (added > 0 && !this.boundConfig?.sqlitePrimaryEnabled) {
      this.runtimeMirrorDirty = true;
    }
    return added;
  }

  async upsertEvidenceAtoms(entries: EvidenceAtomEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.getStores().evidenceAtomStore.upsertMany(entries);
    this.runtimeMirrorDirty = this.boundConfig?.sqlitePrimaryEnabled ? false : true;
  }

  async writeNavigationSnapshot(snapshot: string): Promise<string | null> {
    if (!this.boundConfig?.agentVaultMirrorEnabled || !this.agentVault || !snapshot.trim()) {
      return null;
    }
    return await this.agentVault.writeNavigation(snapshot);
  }

  async appendSummaryArtifact(entry: SummaryEntry): Promise<string | null> {
    await this.runtimeStore?.recordSummaries([entry]);
    if (
      !this.boundConfig?.agentVaultMirrorEnabled ||
      !this.boundConfig.summaryMarkdownMirrorEnabled ||
      !this.agentVault
    ) {
      return null;
    }
    return await this.agentVault.appendSummary(entry);
  }

  async writeDurableMemoryArtifacts(): Promise<void> {
    if (
      !this.boundConfig?.agentVaultMirrorEnabled ||
      !this.boundConfig.durableMarkdownMirrorEnabled ||
      !this.agentVault
    ) {
      return;
    }
    await this.agentVault.writeDurableMemoryMirror(
      this.getStores().durableMemoryStore.getAll().filter((entry) => entry.recordStatus === "active"),
    );
  }

  async appendAfterTurnStats(sessionId: string, stats: Record<string, unknown>): Promise<void> {
    if (!this.statsLogStore) {
      throw new Error("SessionDataLayer stats log store is not initialized");
    }
    await this.statsLogStore.append(sessionId, stats);
  }

  async upsertProjectRecord(project: ProjectRecord): Promise<ProjectRecord> {
    return await this.getStores().projectStore.upsert(project);
  }

  getRuntimeStore(): SQLiteRuntimeStore {
    if (!this.runtimeStore) {
      throw new Error("SessionDataLayer SQLite runtime store is not initialized");
    }
    return this.runtimeStore;
  }

  async wipeSession(sessionId: string, config: BridgeConfig): Promise<{
    removed: string[];
    skipped: string[];
    warnings: string[];
  }> {
    const removed: string[] = [];
    const skipped: string[] = [];
    const warnings: string[] = [
      "Session wipe removes session-scoped runtime/state files and SQLite ledger rows, but leaves shared Markdown knowledge assets untouched.",
      "Agent vault mirrors may still reflect historical summaries until the next organizer/rebuild pass.",
    ];
    await this.ensure(sessionId, config);
    await this.runtimeStore?.init().catch(() => undefined);
    if (this.runtimeStore) {
      this.runtimeStore.purgeSession(sessionId);
    }
    if (this.rawStore?.removeSession) {
      const count = await this.rawStore.removeSession(sessionId);
      if (count > 0) {
        removed.push(`raw_messages:${count}`);
      }
    }
    if (this.summaryStore?.removeSession) {
      const count = await this.summaryStore.removeSession(sessionId);
      if (count > 0) {
        removed.push(`summaries:${count}`);
      }
    }
    if (this.observationStore?.removeSession) {
      const count = await this.observationStore.removeSession(sessionId);
      if (count > 0) {
        removed.push(`observations:${count}`);
      }
    }
    if (this.durableMemoryStore?.removeSession) {
      const count = await this.durableMemoryStore.removeSession(sessionId);
      if (count > 0) {
        removed.push(`durable_memories:${count}`);
      }
    }
    if (this.evidenceAtomStore) {
      const count = await this.evidenceAtomStore.removeSession(sessionId);
      if (count > 0) {
        removed.push(`evidence_atoms:${count}`);
      }
    }
    if (this.projectStore) {
      const projects = this.projectStore.getAll().map((project) => ({
        ...project,
        sourceSessionIds: project.sourceSessionIds.filter((id) => id !== sessionId),
        status: project.sourceSessionIds.filter((id) => id !== sessionId).length > 0
          ? project.status
          : "archived" as const,
      }));
      await this.projectStore.reconcileProjects(projects);
    }
    const targets = [
      path.join(this.resolveAgentDataDir(config), `${sessionId}.knowledge-raw.json`),
      path.join(config.dataDir, "logs", `${sessionId}.after-turn.log`),
    ];
    for (const target of targets) {
      if (await this.removePathIfPresent(target)) {
        removed.push(target);
      } else {
        skipped.push(target);
      }
    }
    if (this.boundSessionId === sessionId && this.boundAgentId === config.agentId) {
      await this.resetBoundStores();
    }
    return { removed, skipped, warnings };
  }

  async wipeAgent(config: BridgeConfig, options: {
    wipeKnowledgeBase?: boolean;
    wipeWorkspaceMemory?: boolean;
    wipeBackups?: boolean;
  } = {}): Promise<{
    removed: string[];
    skipped: string[];
    warnings: string[];
  }> {
    const removed: string[] = [];
    const skipped: string[] = [];
    const warnings: string[] = [];
    await this.ensure(config.sessionId, config);
    const sessionIds = this.rawStore
      ? [...new Set(this.rawStore.getAll().map((message) => message.sessionId).filter(Boolean))]
      : [];
    await this.runtimeStore?.init().catch(() => undefined);
    if (this.runtimeStore) {
      this.runtimeStore.purgeAgent(config.agentId);
      this.runtimeStore.dispose();
    }
    const targets = [
      path.join(config.dataDir, "agents", config.agentId),
      path.join(config.memoryVaultDir, "agents", config.agentId),
      ...sessionIds.map((sessionId) => path.join(config.dataDir, "logs", `${sessionId}.after-turn.log`)),
      ...(options.wipeWorkspaceMemory ? [path.join(config.workspaceDir, "memory")] : []),
      ...(options.wipeBackups ? [path.join(config.dataDir, "backups")] : []),
      ...(options.wipeKnowledgeBase ? [config.knowledgeBaseDir] : []),
    ];
    if (!options.wipeKnowledgeBase) {
      warnings.push("Shared Markdown knowledge assets were preserved. Pass wipeKnowledgeBase=true only when you explicitly want to remove reviewed knowledge docs too.");
    }
    if (!options.wipeWorkspaceMemory) {
      warnings.push("Workspace memory directory was preserved. Pass wipeWorkspaceMemory=true if you want to clear workspace-side ChaunyOMS state as well.");
    }
    for (const target of targets) {
      if (await this.removePathIfPresent(target)) {
        removed.push(target);
      } else {
        skipped.push(target);
      }
    }
    if (this.boundAgentId === config.agentId) {
      await this.resetBoundStores();
    }
    return { removed, skipped, warnings };
  }

  async mirrorRuntimeState(): Promise<void> {
    if (!this.runtimeStore || !this.rawStore || !this.summaryStore || !this.durableMemoryStore || !this.evidenceAtomStore) {
      return;
    }
    const messages = this.rawStore.getAll();
    const summaries = this.summaryStore.getAllSummaries();
    const memories = this.durableMemoryStore.getAll();
    const atoms = this.evidenceAtomStore.getAll();
    const signature = this.buildRuntimeMirrorSignature(messages, summaries, memories, atoms);
    if (!this.runtimeMirrorDirty && this.runtimeMirrorSignature === signature) {
      return;
    }
    await this.runtimeStore.mirror({
      messages,
      summaries,
      memories,
      atoms,
    });
    this.runtimeMirrorSignature = signature;
    this.runtimeMirrorDirty = false;
  }

  recordContextPlan(args: {
    sessionId: string;
    agentId: string;
    totalBudget: number;
    intent: string;
    plan: ContextPlannerResult;
  }): void {
    if (!this.runtimeStore) {
      return;
    }
    this.runtimeStore.recordContextPlan(args);
  }

  inspectSummaryIntegrity(): SummaryIntegrityInspection {
    const { rawStore, summaryStore } = this.getStores();
    const summaries = summaryStore.getAllSummaries();
    let verified = 0;
    let mismatched = 0;
    let unchecked = 0;
    const verifiedEntries: Array<{ sessionId: string; startTurn: number; endTurn: number }> = [];

    for (const summary of summaries) {
      if (!summary.sourceHash || typeof summary.sourceMessageCount !== "number") {
        unchecked += 1;
        continue;
      }
      const resolution = this.sourceMessageResolver.resolve(rawStore, summary);
      if (!resolution.verified) {
        mismatched += 1;
      } else {
        verified += 1;
        verifiedEntries.push({
          sessionId: summary.sessionId,
          startTurn: summary.startTurn,
          endTurn: summary.endTurn,
        });
      }
    }

    return { total: summaries.length, verified, mismatched, unchecked, verifiedEntries };
  }

  async repairCompactedFlagsFromSummaries(
    verifiedEntries: Array<{ sessionId: string; startTurn: number; endTurn: number }>,
  ): Promise<void> {
    if (verifiedEntries.length === 0) {
      return;
    }

    const { rawStore } = this.getStores();
    let repairedRanges = 0;
    for (const entry of verifiedEntries) {
      const query = { sessionId: entry.sessionId };
      const range = rawStore.getByRange(entry.startTurn, entry.endTurn, query);
      if (range.length === 0 || range.every((message) => message.compacted)) {
        continue;
      }
      await rawStore.markCompacted(entry.startTurn, entry.endTurn, query);
      repairedRanges += 1;
    }

    if (repairedRanges > 0) {
      this.runtimeMirrorDirty = true;
      await this.mirrorRuntimeState();
      this.logger.info("summary_compaction_state_repaired", {
        repairedRanges,
      });
    }
  }

  private buildRuntimeMirrorSignature(
    messages: RawMessage[],
    summaries: SummaryEntry[],
    memories: DurableMemoryEntry[],
    atoms: EvidenceAtomEntry[],
  ): string {
    const lastMessage = messages[messages.length - 1];
    const lastSummary = summaries[summaries.length - 1];
    const lastMemory = memories[memories.length - 1];
    const lastAtom = atoms[atoms.length - 1];
    const compactedMessages = messages.reduce((count, message) => count + (message.compacted ? 1 : 0), 0);
    const activeMemories = memories.reduce((count, memory) => count + (memory.recordStatus === "active" ? 1 : 0), 0);
    return [
      messages.length,
      compactedMessages,
      lastMessage?.id ?? "",
      lastMessage?.sequence ?? "",
      summaries.length,
      lastSummary?.id ?? "",
      lastSummary?.createdAt ?? "",
      memories.length,
      activeMemories,
      lastMemory?.id ?? "",
      lastMemory?.createdAt ?? "",
      atoms.length,
      lastAtom?.id ?? "",
      lastAtom?.createdAt ?? "",
    ].join("|");
  }

  private resolveAgentDataDir(config: BridgeConfig): string {
    return path.join(config.dataDir, "agents", config.agentId);
  }

  private resolveSharedKnowledgeDir(config: BridgeConfig): string {
    return config.knowledgeBaseDir;
  }

  private async validateUpgradedState(
    agentDataDir: string,
    knowledgeDir: string,
    config: BridgeConfig,
  ): Promise<void> {
    const rawStore = new RawMessageStore(agentDataDir, config.agentId);
    const summaryStore = new SummaryIndexStore(agentDataDir, config.agentId);
    const observationStore = new ObservationStore(agentDataDir, config.agentId);
    const durableMemoryStore = new DurableMemoryStore(agentDataDir, config.agentId);
    const knowledgeRawStore = new KnowledgeRawStore(agentDataDir, config.sessionId);
    const knowledgeStore = new KnowledgeMarkdownStore(knowledgeDir);
    const projectStore = new ProjectRegistryStore(agentDataDir, config.agentId);
    const vault = new AgentVault(config.memoryVaultDir, config.agentId);

    await rawStore.init();
    await summaryStore.init();
    await observationStore.init();
    await durableMemoryStore.init();
    await knowledgeRawStore.init();
    await knowledgeStore.init();
    await projectStore.init();
    await vault.ensureLayout();

    for (const summary of summaryStore.getAllSummaries()) {
      const startTurn = Number(summary.startTurn);
      const endTurn = Number(summary.endTurn);
      if (!Number.isFinite(startTurn) || !Number.isFinite(endTurn) || startTurn > endTurn) {
        throw new Error(`Invalid summary turn range after upgrade for summary ${summary.id}`);
      }
    }

    durableMemoryStore.getAll();
    knowledgeRawStore.getAll();
    projectStore.getAll();
    knowledgeStore.searchRelatedDocuments("upgrade validation", 1);
  }

  private async removePathIfPresent(target: string): Promise<boolean> {
    try {
      await rm(target, { recursive: true, force: true });
      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async resetBoundStores(): Promise<void> {
    this.runtimeStore?.dispose();
    this.rawStore = null;
    this.summaryStore = null;
    this.observationStore = null;
    this.durableMemoryStore = null;
    this.evidenceAtomStore = null;
    this.knowledgeRawStore = null;
    this.knowledgeStore = null;
    this.projectStore = null;
    this.statsLogStore = null;
    this.runtimeStore = null;
    this.schemaRegistry = null;
    this.migrationRunner = null;
    this.agentVault = null;
    this.upgradeManager = null;
    this.boundAgentId = null;
    this.boundSessionId = null;
    this.boundConfig = null;
    this.runtimeMirrorSignature = null;
    this.runtimeMirrorDirty = false;
  }
}
