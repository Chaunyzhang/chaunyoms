import type { LifecycleContext } from "../host/OpenClawPayloadAdapter";
import type { BridgeConfig, RawMessageRepository, SummaryRepository } from "../types";
import {
  deriveProjectIdentityFromSnapshot,
  deriveProjectIdentityFromSummary,
  deriveProjectStatusFromSnapshot,
} from "../utils/projectIdentity";
import { buildProjectStateSnapshot } from "../utils/projectState";
import { SessionDataLayer } from "../data/SessionDataLayer";

export interface ProjectRegistryUpdaterDeps {
  getConfig: () => BridgeConfig;
  sessionData: SessionDataLayer;
}

export class ProjectRegistryUpdater {
  constructor(private readonly deps: ProjectRegistryUpdaterDeps) {}

  async update(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
  ): Promise<void> {
    const config = this.deps.getConfig();
    const snapshot = buildProjectStateSnapshot(rawStore, summaryStore);
    let identity = deriveProjectIdentityFromSnapshot(
      snapshot,
      `${config.agentId}-${context.sessionId}`,
    );
    const activeSummaries = summaryStore
      .getActiveSummaries()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    let projectSummaries = activeSummaries
      .filter((entry) => entry.projectId === identity.projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (projectSummaries.length === 0 && activeSummaries.length > 0) {
      identity = deriveProjectIdentityFromSummary(
        activeSummaries[0],
        `${config.agentId}-${context.sessionId}`,
      );
      snapshot.projectId = identity.projectId;
      snapshot.projectTitle = identity.title;
      projectSummaries = activeSummaries.filter((entry) => entry.projectId === identity.projectId);
    }

    const memoryItems = this.deps.sessionData.getRuntimeStore().listMemoryItems({ agentId: config.agentId });
    let projectMemories = memoryItems
      .filter((entry) => entry.status === "active" && entry.projectId === identity.projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (projectMemories.length === 0) {
      projectMemories = memoryItems
        .filter((entry) => entry.status === "active")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    await this.deps.sessionData.upsertProjectRecord({
      id: identity.projectId,
      agentId: config.agentId,
      canonicalKey: identity.canonicalKey,
      title: snapshot.projectTitle || identity.title,
      status: deriveProjectStatusFromSnapshot(snapshot),
      summary: projectSummaries[0]?.summary ?? snapshot.active,
      activeFocus: snapshot.active,
      currentDecision: snapshot.decision,
      nextStep: snapshot.next,
      todo: snapshot.todo,
      blocker: snapshot.blocker,
      risk: snapshot.risk,
      tags: [
        identity.canonicalKey,
        ...projectSummaries.flatMap((entry) => entry.keywords).slice(0, 12),
        ...projectMemories.flatMap((entry) => entry.tags).slice(0, 12),
      ],
      sourceSessionIds: [context.sessionId],
      summaryIds: projectSummaries.map((entry) => entry.id),
      memoryIds: projectMemories.map((entry) => entry.id),
      topicIds: [
        identity.topicId,
        ...projectSummaries.map((entry) => entry.topicId).filter((value): value is string => Boolean(value)),
        ...projectMemories.map((entry) => entry.topicId).filter((value): value is string => Boolean(value)),
      ],
      latestSummaryId: projectSummaries[0]?.id,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
  }
}
