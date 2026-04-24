import path from "node:path";

import { DurableMemoryStore } from "../stores/DurableMemoryStore";
import { KnowledgeRawStore } from "../stores/KnowledgeRawStore";
import { KnowledgeMarkdownStore } from "../stores/KnowledgeMarkdownStore";
import { ObservationStore } from "../stores/ObservationStore";
import { ProjectRegistryStore } from "../stores/ProjectRegistryStore";
import { RawMessageStore } from "../stores/RawMessageStore";
import { RuntimeStatsLogStore } from "../stores/RuntimeStatsLogStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import {
  BridgeConfig,
  DurableMemoryEntry,
  DurableMemoryRepository,
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
  private rawStore: RawMessageStore | null = null;
  private summaryStore: SummaryIndexStore | null = null;
  private observationStore: ObservationStore | null = null;
  private durableMemoryStore: DurableMemoryStore | null = null;
  private knowledgeRawStore: KnowledgeRawStore | null = null;
  private knowledgeStore: KnowledgeMarkdownStore | null = null;
  private projectStore: ProjectRegistryStore | null = null;
  private statsLogStore: RuntimeStatsLogStore | null = null;
  private schemaRegistry: DataSchemaRegistry | null = null;
  private migrationRunner: SessionDataMigrationRunner | null = null;
  private agentVault: AgentVault | null = null;
  private upgradeManager: SessionUpgradeManager | null = null;
  private boundAgentId: string | null = null;
  private boundSessionId: string | null = null;
  private boundConfig: Pick<BridgeConfig, "dataDir" | "workspaceDir" | "sharedDataDir" | "knowledgeBaseDir" | "memoryVaultDir"> | null = null;
  private readonly sourceMessageResolver = new SourceMessageResolver();

  constructor(private readonly logger: LoggerLike) {}

  async ensure(sessionId: string, config: BridgeConfig): Promise<SessionDataStores> {
    const agentDataDir = this.resolveAgentDataDir(config);
    const knowledgeDir = this.resolveSharedKnowledgeDir(config);
    if (
      this.rawStore &&
      this.summaryStore &&
      this.observationStore &&
      this.durableMemoryStore &&
      this.knowledgeRawStore &&
      this.knowledgeStore &&
      this.projectStore &&
      this.agentVault &&
      this.boundAgentId === config.agentId &&
      this.boundSessionId === sessionId &&
      this.boundConfig?.dataDir === config.dataDir &&
      this.boundConfig?.workspaceDir === config.workspaceDir &&
      this.boundConfig?.sharedDataDir === config.sharedDataDir &&
      this.boundConfig?.knowledgeBaseDir === config.knowledgeBaseDir &&
      this.boundConfig?.memoryVaultDir === config.memoryVaultDir
    ) {
      return this.getStores();
    }

    this.schemaRegistry = new DataSchemaRegistry(path.join(config.dataDir, "_state"));
    await this.schemaRegistry.init();
    this.migrationRunner = new SessionDataMigrationRunner(agentDataDir, config.agentId);
    this.upgradeManager = new SessionUpgradeManager(this.logger);
    const pendingMigrations = await this.migrationRunner.inspectPending();
    const pendingRegistryUpgrades = this.schemaRegistry.getPendingUpgrades();
    await this.upgradeManager.runProtectedUpgrade({
      dataDir: config.dataDir,
      paths: [
        {
          label: "agent_data",
          sourcePath: agentDataDir,
          snapshotRelativePath: path.join("agent_data"),
        },
        {
          label: "schema_registry",
          sourcePath: this.schemaRegistry.getFilePath(),
          snapshotRelativePath: path.join("schema_registry.json"),
        },
        {
          label: "knowledge_raw",
          sourcePath: path.join(agentDataDir, `${sessionId}.knowledge-raw.json`),
          snapshotRelativePath: path.join(`${sessionId}.knowledge_raw.json`),
        },
        {
          label: "knowledge_markdown",
          sourcePath: knowledgeDir,
          snapshotRelativePath: path.join("knowledge_markdown"),
        },
        {
          label: "agent_vault",
          sourcePath: path.join(config.memoryVaultDir, "agents", config.agentId),
          snapshotRelativePath: path.join("agent_vault"),
        },
      ],
      pendingMigrations,
      pendingRegistryUpgrades,
      apply: async () => {
        const migrations = await this.migrationRunner?.runAll() ?? [];
        const registryUpgrades = await this.schemaRegistry?.ensureCurrentVersions() ?? [];
        if (migrations.length > 0) {
          this.logger.info("session_data_migrations_applied", {
            agentId: config.agentId,
            migrated: migrations,
          });
        }
        if (registryUpgrades.length > 0) {
          this.logger.info("session_data_schema_registry_updated", {
            agentId: config.agentId,
            upgraded: registryUpgrades,
          });
        }
        return { migrations, registryUpgrades };
      },
      validate: async () => {
        await this.validateUpgradedState(agentDataDir, knowledgeDir, config);
      },
    });
    this.rawStore = new RawMessageStore(agentDataDir, config.agentId);
    this.summaryStore = new SummaryIndexStore(agentDataDir, config.agentId);
    this.observationStore = new ObservationStore(agentDataDir, config.agentId);
    this.durableMemoryStore = new DurableMemoryStore(agentDataDir, config.agentId);
    this.knowledgeRawStore = new KnowledgeRawStore(agentDataDir, sessionId);
    this.knowledgeStore = new KnowledgeMarkdownStore(knowledgeDir);
    this.projectStore = new ProjectRegistryStore(agentDataDir, config.agentId);
    this.statsLogStore = new RuntimeStatsLogStore(config.dataDir);
    this.agentVault = new AgentVault(config.memoryVaultDir, config.agentId);
    await this.rawStore.init();
    await this.summaryStore.init();
    await this.observationStore.init();
    await this.durableMemoryStore.init();
    await this.knowledgeRawStore.init();
    await this.knowledgeStore.init();
    await this.projectStore.init();
    await this.agentVault.ensureLayout();
    this.boundAgentId = config.agentId;
    this.boundSessionId = sessionId;
    this.boundConfig = {
      dataDir: config.dataDir,
      workspaceDir: config.workspaceDir,
      sharedDataDir: config.sharedDataDir,
      knowledgeBaseDir: config.knowledgeBaseDir,
      memoryVaultDir: config.memoryVaultDir,
    };
    return this.getStores();
  }

  getStores(): SessionDataStores {
    if (!this.rawStore || !this.summaryStore || !this.observationStore || !this.durableMemoryStore || !this.knowledgeRawStore || !this.knowledgeStore || !this.projectStore) {
      throw new Error("SessionDataLayer stores are not initialized");
    }
    return {
      rawStore: this.rawStore,
      summaryStore: this.summaryStore,
      observationStore: this.observationStore,
      durableMemoryStore: this.durableMemoryStore,
      knowledgeRawStore: this.knowledgeRawStore,
      knowledgeStore: this.knowledgeStore,
      projectStore: this.projectStore,
    };
  }

  async appendRawMessage(message: RawMessage): Promise<void> {
    await this.getStores().rawStore.append(message);
  }

  async appendObservation(entry: ObservationEntry): Promise<void> {
    await this.getStores().observationStore.append(entry);
  }

  async addDurableEntries(entries: DurableMemoryEntry[]): Promise<number> {
    return await this.getStores().durableMemoryStore.addEntries(entries);
  }

  async writeNavigationSnapshot(snapshot: string): Promise<string | null> {
    if (!this.agentVault || !snapshot.trim()) {
      return null;
    }
    return await this.agentVault.writeNavigation(snapshot);
  }

  async appendSummaryArtifact(entry: SummaryEntry): Promise<string | null> {
    if (!this.agentVault) {
      return null;
    }
    return await this.agentVault.appendSummary(entry);
  }

  async writeDurableMemoryArtifacts(): Promise<void> {
    if (!this.agentVault) {
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
      this.logger.info("summary_compaction_state_repaired", {
        repairedRanges,
      });
    }
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
}
