import { DurableMemoryStore } from "../stores/DurableMemoryStore";
import { KnowledgeMarkdownStore } from "../stores/KnowledgeMarkdownStore";
import { ObservationStore } from "../stores/ObservationStore";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import {
  BridgeConfig,
  DurableMemoryEntry,
  DurableMemoryRepository,
  LoggerLike,
  ObservationEntry,
  ObservationRepository,
  RawMessage,
  RawMessageRepository,
  SummaryRepository,
} from "../types";
import { hashRawMessages } from "../utils/integrity";
import { DataSchemaRegistry } from "./DataSchemaRegistry";
import { SessionDataMigrationRunner } from "./SessionDataMigrationRunner";

export interface SessionDataStores {
  rawStore: RawMessageRepository;
  summaryStore: SummaryRepository;
  observationStore: ObservationRepository;
  durableMemoryStore: DurableMemoryRepository;
  knowledgeStore: KnowledgeMarkdownStore;
}

export interface SummaryIntegrityInspection {
  total: number;
  verified: number;
  mismatched: number;
  unchecked: number;
  verifiedEntries: Array<{ startTurn: number; endTurn: number }>;
}

export class SessionDataLayer {
  private rawStore: RawMessageStore | null = null;
  private summaryStore: SummaryIndexStore | null = null;
  private observationStore: ObservationStore | null = null;
  private durableMemoryStore: DurableMemoryStore | null = null;
  private knowledgeStore: KnowledgeMarkdownStore | null = null;
  private schemaRegistry: DataSchemaRegistry | null = null;
  private migrationRunner: SessionDataMigrationRunner | null = null;
  private boundSessionId: string | null = null;
  private boundConfig: Pick<BridgeConfig, "dataDir" | "workspaceDir" | "sharedDataDir" | "knowledgeBaseDir"> | null = null;

  constructor(private readonly logger: LoggerLike) {}

  async ensure(sessionId: string, config: BridgeConfig): Promise<SessionDataStores> {
    if (
      this.rawStore &&
      this.summaryStore &&
      this.observationStore &&
      this.durableMemoryStore &&
      this.knowledgeStore &&
      this.boundSessionId === sessionId &&
      this.boundConfig?.dataDir === config.dataDir &&
      this.boundConfig?.workspaceDir === config.workspaceDir &&
      this.boundConfig?.sharedDataDir === config.sharedDataDir &&
      this.boundConfig?.knowledgeBaseDir === config.knowledgeBaseDir
    ) {
      return this.getStores();
    }

    this.schemaRegistry = new DataSchemaRegistry(config.dataDir);
    await this.schemaRegistry.init();
    this.migrationRunner = new SessionDataMigrationRunner(config.dataDir, sessionId);
    const migrated = await this.migrationRunner.runAll();
    if (migrated.length > 0) {
      this.logger.info("session_data_migrations_applied", {
        sessionId,
        migrated,
      });
    }
    this.rawStore = new RawMessageStore(config.dataDir, sessionId);
    this.summaryStore = new SummaryIndexStore(config.dataDir, sessionId);
    this.observationStore = new ObservationStore(config.dataDir, sessionId);
    this.durableMemoryStore = new DurableMemoryStore(config.dataDir, sessionId);
    this.knowledgeStore = new KnowledgeMarkdownStore(config.knowledgeBaseDir);
    await this.rawStore.init();
    await this.summaryStore.init();
    await this.observationStore.init();
    await this.durableMemoryStore.init();
    await this.knowledgeStore.init();
    const upgraded = await this.schemaRegistry.ensureCurrentVersions();
    if (upgraded.length > 0) {
      this.logger.info("session_data_schema_registry_updated", {
        sessionId,
        upgraded,
      });
    }
    this.boundSessionId = sessionId;
    this.boundConfig = {
      dataDir: config.dataDir,
      workspaceDir: config.workspaceDir,
      sharedDataDir: config.sharedDataDir,
      knowledgeBaseDir: config.knowledgeBaseDir,
    };
    return this.getStores();
  }

  getStores(): SessionDataStores {
    if (!this.rawStore || !this.summaryStore || !this.observationStore || !this.durableMemoryStore || !this.knowledgeStore) {
      throw new Error("SessionDataLayer stores are not initialized");
    }
    return {
      rawStore: this.rawStore,
      summaryStore: this.summaryStore,
      observationStore: this.observationStore,
      durableMemoryStore: this.durableMemoryStore,
      knowledgeStore: this.knowledgeStore,
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

  inspectSummaryIntegrity(): SummaryIntegrityInspection {
    const { rawStore, summaryStore } = this.getStores();
    const summaries = summaryStore.getAllSummaries();
    let verified = 0;
    let mismatched = 0;
    let unchecked = 0;
    const verifiedEntries: Array<{ startTurn: number; endTurn: number }> = [];

    for (const summary of summaries) {
      if (!summary.sourceHash || typeof summary.sourceMessageCount !== "number") {
        unchecked += 1;
        continue;
      }
      const sourceMessages = rawStore.getByRange(summary.startTurn, summary.endTurn);
      const actualHash = hashRawMessages(sourceMessages);
      const actualCount = sourceMessages.length;
      if (
        actualHash !== summary.sourceHash ||
        actualCount !== summary.sourceMessageCount
      ) {
        mismatched += 1;
      } else {
        verified += 1;
        verifiedEntries.push({
          startTurn: summary.startTurn,
          endTurn: summary.endTurn,
        });
      }
    }

    return { total: summaries.length, verified, mismatched, unchecked, verifiedEntries };
  }

  async repairCompactedFlagsFromSummaries(
    verifiedEntries: Array<{ startTurn: number; endTurn: number }>,
  ): Promise<void> {
    if (verifiedEntries.length === 0) {
      return;
    }

    const { rawStore } = this.getStores();
    let repairedRanges = 0;
    for (const entry of verifiedEntries) {
      const range = rawStore.getByRange(entry.startTurn, entry.endTurn);
      if (range.length === 0 || range.every((message) => message.compacted)) {
        continue;
      }
      await rawStore.markCompacted(entry.startTurn, entry.endTurn);
      repairedRanges += 1;
    }

    if (repairedRanges > 0) {
      this.logger.info("summary_compaction_state_repaired", {
        repairedRanges,
      });
    }
  }
}
