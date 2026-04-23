import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ProjectRecord, ProjectRegistryRepository } from "../types";

interface ProjectRegistryFileV1 {
  schemaVersion: 1;
  projects: ProjectRecord[];
}

export class ProjectRegistryStore implements ProjectRegistryRepository {
  private readonly filePath: string;
  private projects: ProjectRecord[] = [];

  constructor(private readonly baseDir: string, private readonly agentId: string) {
    this.filePath = path.join(baseDir, "project-registry.json");
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as ProjectRegistryFileV1 | ProjectRecord[];
      const entries = Array.isArray(parsed) ? parsed : parsed.projects;
      this.projects = Array.isArray(entries)
        ? entries.map((entry) => this.normalizeProject(entry))
        : [];
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async upsert(project: ProjectRecord): Promise<ProjectRecord> {
    const normalized = this.normalizeProject(project);
    const existingById = this.projects.findIndex((entry) => entry.id === normalized.id);
    const existingByKey = existingById >= 0
      ? existingById
      : this.projects.findIndex((entry) => entry.canonicalKey === normalized.canonicalKey);

    if (existingByKey >= 0) {
      const current = this.projects[existingByKey];
      this.projects[existingByKey] = this.normalizeProject({
        ...current,
        ...normalized,
        tags: this.mergeUnique(current.tags, normalized.tags),
        sourceSessionIds: this.mergeUnique(current.sourceSessionIds, normalized.sourceSessionIds),
        summaryIds: this.mergeUnique(current.summaryIds, normalized.summaryIds),
        memoryIds: this.mergeUnique(current.memoryIds, normalized.memoryIds),
        topicIds: this.mergeUnique(current.topicIds, normalized.topicIds),
        createdAt: current.createdAt,
        updatedAt: normalized.updatedAt,
      });
    } else {
      this.projects.push(normalized);
    }

    this.projects = this.projects
      .map((entry) => this.normalizeProject(entry))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    await this.flush();
    return this.findById(normalized.id) ?? normalized;
  }

  async reconcileProjects(projects: ProjectRecord[]): Promise<void> {
    const nextProjects = new Map<string, ProjectRecord>();
    for (const project of projects) {
      const normalized = this.normalizeProject(project);
      const existing = nextProjects.get(normalized.canonicalKey) ??
        this.projects.find((entry) => entry.canonicalKey === normalized.canonicalKey) ??
        null;
      if (existing) {
        nextProjects.set(normalized.canonicalKey, this.normalizeProject({
          ...existing,
          ...normalized,
          tags: this.mergeUnique(existing.tags, normalized.tags),
          sourceSessionIds: this.mergeUnique(existing.sourceSessionIds, normalized.sourceSessionIds),
          summaryIds: this.mergeUnique(existing.summaryIds, normalized.summaryIds),
          memoryIds: this.mergeUnique(existing.memoryIds, normalized.memoryIds),
          topicIds: this.mergeUnique(existing.topicIds, normalized.topicIds),
          createdAt: existing.createdAt,
          updatedAt: normalized.updatedAt,
        }));
      } else {
        nextProjects.set(normalized.canonicalKey, normalized);
      }
    }

    const incomingKeys = new Set(nextProjects.keys());
    const archived = this.projects
      .filter((entry) => !incomingKeys.has(entry.canonicalKey))
      .map((entry) => this.normalizeProject({
        ...entry,
        status: "archived",
      }));

    this.projects = [
      ...nextProjects.values(),
      ...archived,
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    await this.flush();
  }

  getAll(): ProjectRecord[] {
    return [...this.projects];
  }

  findById(id: string): ProjectRecord | null {
    return this.projects.find((entry) => entry.id === id) ?? null;
  }

  findByCanonicalKey(canonicalKey: string): ProjectRecord | null {
    return this.projects.find((entry) => entry.canonicalKey === canonicalKey) ?? null;
  }

  private async flush(): Promise<void> {
    const payload: ProjectRegistryFileV1 = {
      schemaVersion: 1,
      projects: this.projects,
    };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  private normalizeProject(project: ProjectRecord): ProjectRecord {
    const now = new Date().toISOString();
    return {
      ...project,
      agentId: project.agentId || this.agentId,
      canonicalKey: project.canonicalKey.trim(),
      title: project.title.trim() || project.canonicalKey,
      summary: project.summary?.trim() || "No summary recorded yet.",
      activeFocus: project.activeFocus?.trim() || "none recorded",
      currentDecision: project.currentDecision?.trim() || "none recorded",
      nextStep: project.nextStep?.trim() || "none recorded",
      todo: project.todo?.trim() || "none recorded",
      blocker: project.blocker?.trim() || "none recorded",
      risk: project.risk?.trim() || "none recorded",
      tags: this.mergeUnique(project.tags ?? []),
      sourceSessionIds: this.mergeUnique(project.sourceSessionIds ?? []),
      summaryIds: this.mergeUnique(project.summaryIds ?? []),
      memoryIds: this.mergeUnique(project.memoryIds ?? []),
      topicIds: this.mergeUnique(project.topicIds ?? []),
      createdAt: project.createdAt || now,
      updatedAt: project.updatedAt || now,
    };
  }

  private mergeUnique(...values: string[][]): string[] {
    return [...new Set(values.flat().filter((item) => typeof item === "string" && item.trim().length > 0))]
      .map((item) => item.trim());
  }
}
