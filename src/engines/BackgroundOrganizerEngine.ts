import {
  DurableMemoryEntry,
  DurableMemoryRepository,
  LoggerLike,
  ProjectRecord,
  ProjectRegistryRepository,
  SummaryRepository,
} from "../types";
import {
  deriveProjectIdentityFromSummary,
  deriveProjectStatusFromSnapshot,
} from "../utils/projectIdentity";
import { parseProjectStateSnapshot } from "../utils/projectState";

export class BackgroundOrganizerEngine {
  constructor(private readonly logger: LoggerLike) {}

  async run(
    durableMemoryStore: DurableMemoryRepository,
    summaryStore: SummaryRepository,
    projectStore: ProjectRegistryRepository,
    agentId: string,
  ): Promise<void> {
    await this.consolidateDurableMemories(durableMemoryStore);
    await this.reconcileProjects(durableMemoryStore, summaryStore, projectStore, agentId);
  }

  private async consolidateDurableMemories(
    durableMemoryStore: DurableMemoryRepository,
  ): Promise<void> {
    const allEntries = durableMemoryStore.getAll();
    const activeEntries = allEntries
      .filter((entry) => entry.recordStatus !== "archived")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const groups = new Map<string, DurableMemoryEntry[]>();
    for (const entry of activeEntries) {
      const key = [
        entry.projectId ?? "no-project",
        entry.kind,
        normalizeMemoryText(entry.text),
      ].join("|");
      const bucket = groups.get(key) ?? [];
      bucket.push(entry);
      groups.set(key, bucket);
    }

    let changed = false;
    const nextEntries = allEntries.map((entry) => ({ ...entry }));
    for (const bucket of groups.values()) {
      if (bucket.length <= 1) {
        continue;
      }
      const keeper = bucket[0];
      for (const redundant of bucket.slice(1)) {
        const target = nextEntries.find((entry) => entry.id === redundant.id);
        if (!target || target.recordStatus === "superseded") {
          continue;
        }
        target.recordStatus = "superseded";
        target.supersededById = keeper.id;
        changed = true;
      }
    }

    if (changed) {
      this.logger.info("background_organizer_durable_reconciled", {
        activeBefore: activeEntries.length,
        activeAfter: nextEntries.filter((entry) => entry.recordStatus === "active").length,
      });
      await durableMemoryStore.replaceAll(nextEntries);
    }
  }

  private async reconcileProjects(
    durableMemoryStore: DurableMemoryRepository,
    summaryStore: SummaryRepository,
    projectStore: ProjectRegistryRepository,
    agentId: string,
  ): Promise<void> {
    const summaries = summaryStore.getActiveSummaries();
    const memories = durableMemoryStore.getAll().filter((entry) => entry.recordStatus === "active");
    const grouped = new Map<string, { summaries: typeof summaries; memories: typeof memories }>();

    for (const summary of summaries) {
      const identity = deriveProjectIdentityFromSummary(summary, agentId);
      const key = summary.projectId ?? identity.projectId;
      const bucket = grouped.get(key) ?? { summaries: [], memories: [] };
      bucket.summaries.push(summary);
      grouped.set(key, bucket);
    }

    for (const memory of memories) {
      const key = memory.projectId;
      if (!key) {
        continue;
      }
      const bucket = grouped.get(key) ?? { summaries: [], memories: [] };
      bucket.memories.push(memory);
      grouped.set(key, bucket);
    }

    const reconciledProjects: ProjectRecord[] = [];
    for (const [projectId, bucket] of grouped.entries()) {
      const latestSummary = [...bucket.summaries].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const latestProjectState = [...bucket.memories]
        .filter((entry) => entry.kind === "project_state")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const snapshot = latestProjectState ? parseProjectStateSnapshot(latestProjectState.text) : null;
      const identity = latestSummary
        ? deriveProjectIdentityFromSummary(latestSummary, projectId)
        : {
            projectId,
            topicId: bucket.memories[0]?.topicId ?? `topic-${projectId.replace(/^project-/, "")}`,
            canonicalKey: projectId.replace(/^project-/, ""),
            title: projectId.replace(/^project-/, "").replace(/-/g, " "),
          };

      const tags = [
        identity.canonicalKey,
        ...bucket.summaries.flatMap((entry) => entry.keywords),
        ...bucket.memories.flatMap((entry) => entry.tags),
      ].filter(Boolean);

      reconciledProjects.push({
        id: projectId,
        agentId,
        canonicalKey: identity.canonicalKey,
        title: snapshot?.projectTitle || identity.title,
        status: snapshot ? deriveProjectStatusFromSnapshot(snapshot) : (bucket.summaries.length > 0 ? "active" : "planned"),
        summary: latestSummary?.summary ?? latestProjectState?.text ?? "No summary recorded yet.",
        activeFocus: snapshot?.active ?? latestProjectState?.text ?? latestSummary?.summary ?? "none recorded",
        currentDecision: snapshot?.decision ?? latestSummary?.decisions?.[0] ?? "none recorded",
        nextStep: snapshot?.next ?? "none recorded",
        todo: snapshot?.todo ?? "none recorded",
        blocker: snapshot?.blocker ?? latestSummary?.blockers?.[0] ?? "none recorded",
        risk: snapshot?.risk ?? "none recorded",
        tags: [...new Set(tags)].slice(0, 24),
        sourceSessionIds: [
          ...new Set([
            ...bucket.summaries.map((entry) => entry.sessionId),
            ...bucket.memories.map((entry) => entry.sessionId),
          ]),
        ],
        summaryIds: bucket.summaries.map((entry) => entry.id),
        memoryIds: bucket.memories.map((entry) => entry.id),
        topicIds: [
          ...new Set([
            identity.topicId,
            ...bucket.summaries.map((entry) => entry.topicId).filter(Boolean) as string[],
            ...bucket.memories.map((entry) => entry.topicId).filter(Boolean) as string[],
          ]),
        ],
        latestSummaryId: latestSummary?.id,
        createdAt: latestSummary?.createdAt ?? latestProjectState?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    await projectStore.reconcileProjects(reconciledProjects);
  }
}

function normalizeMemoryText(input: string): string {
  return input
    .replace(/\s+/g, " ")
    .replace(/[^\w\u4e00-\u9fff]+/gi, " ")
    .trim()
    .toLowerCase();
}
