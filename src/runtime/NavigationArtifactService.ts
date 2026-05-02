import type { LifecycleContext } from "../host/OpenClawPayloadAdapter";
import type {
  BridgeConfig,
  MemoryItemDraftRepository,
  RawMessageRepository,
  SummaryRepository,
  LoggerLike,
  NavigationRepository,
} from "../types";
import { buildProjectStateSnapshot, formatProjectStateSnapshot } from "../utils/projectState";
import { MemoryExtractionEngine } from "../engines/MemoryExtractionEngine";

export interface NavigationArtifactServiceDeps {
  extractionEngine: MemoryExtractionEngine;
  logger: LoggerLike;
  navigationRepository: NavigationRepository;
  persistMemoryItemDrafts: (store: MemoryItemDraftRepository, drafts: import("../types").MemoryItemDraftEntry[]) => Promise<void>;
  writeMemoryItemArtifacts: () => Promise<void>;
  writeNavigationSnapshot: (snapshot: string) => Promise<unknown>;
}

export class NavigationArtifactService {
  constructor(private readonly deps: NavigationArtifactServiceDeps) {}

  buildNavigationSnapshot(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
  ): string {
    return formatProjectStateSnapshot(
      buildProjectStateSnapshot(rawStore, summaryStore),
    );
  }

  async writeIfPending(args: {
    config: BridgeConfig;
    context: LifecycleContext;
    rawStore: RawMessageRepository;
    summaryStore: SummaryRepository;
    memoryItemDraftStore: MemoryItemDraftRepository;
    compactionTriggeredThisStep: boolean;
    navigationSnapshotPending: boolean;
  }): Promise<{ navigationSnapshotPending: boolean }> {
    if (args.config.emergencyBrake) {
      return { navigationSnapshotPending: false };
    }

    if (!args.navigationSnapshotPending && !args.compactionTriggeredThisStep) {
      return { navigationSnapshotPending: args.navigationSnapshotPending };
    }

    const navigationSnapshot = this.buildNavigationSnapshot(args.rawStore, args.summaryStore);
    const navigationWrite = await this.deps.navigationRepository.writeNavigationSnapshot(
      args.config.workspaceDir,
      navigationSnapshot,
    );
    if (navigationWrite.written) {
      this.deps.logger.info("navigation_snapshot_written", {
        filePath: navigationWrite.filePath,
      });
    }
    if (args.config.memoryItemEnabled) {
      const projectStateMemory = this.deps.extractionEngine.buildProjectStateMemory(
        args.context.sessionId,
        new Date().toISOString(),
        navigationSnapshot,
      );
      await this.deps.persistMemoryItemDrafts(args.memoryItemDraftStore, [projectStateMemory]);
      await this.deps.writeMemoryItemArtifacts();
    }
    await this.deps.writeNavigationSnapshot(navigationSnapshot);
    return { navigationSnapshotPending: false };
  }
}
