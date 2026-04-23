import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DurableMemoryEntry,
  ProjectStateSnapshot,
  SummaryEntry,
} from "../types";

interface AgentVaultPaths {
  agentRoot: string;
  coreDir: string;
  navigationDir: string;
  summariesDir: string;
  durableDir: string;
  transcriptsDir: string;
  navigationPath: string;
  memoryPath: string;
}

function ensureMarkdownText(text: string): string {
  return text.trim() ? `${text.trim()}\n` : "";
}

export class AgentVault {
  constructor(
    private readonly vaultRoot: string,
    private readonly agentId: string,
  ) {}

  async ensureLayout(): Promise<AgentVaultPaths> {
    const paths = this.paths();
    await Promise.all([
      mkdir(paths.agentRoot, { recursive: true }),
      mkdir(paths.coreDir, { recursive: true }),
      mkdir(paths.navigationDir, { recursive: true }),
      mkdir(paths.summariesDir, { recursive: true }),
      mkdir(paths.durableDir, { recursive: true }),
      mkdir(paths.transcriptsDir, { recursive: true }),
    ]);
    return paths;
  }

  async writeNavigation(snapshot: string): Promise<string> {
    const paths = await this.ensureLayout();
    await writeFile(paths.navigationPath, ensureMarkdownText(snapshot), "utf8");
    return paths.navigationPath;
  }

  async appendSummary(entry: SummaryEntry): Promise<string> {
    const datedDir = await this.ensureSummaryDateDir(entry.createdAt);
    const fileName = `s-${entry.createdAt.slice(0, 10)}-${entry.id.slice(0, 8)}.md`;
    const filePath = path.join(datedDir, fileName);
    const frontmatter = [
      "---",
      `id: ${entry.id}`,
      `agent_id: ${entry.agentId ?? this.agentId}`,
      `project_id: ${entry.projectId ?? ""}`,
      `topic_id: ${entry.topicId ?? ""}`,
      `record_status: ${entry.recordStatus ?? "active"}`,
      `summary_level: ${entry.summaryLevel ?? 1}`,
      `node_kind: ${entry.nodeKind ?? "leaf"}`,
      `memory_type: ${entry.memoryType ?? "general"}`,
      `phase: ${entry.phase ?? ""}`,
      `promotion_intent: ${entry.promotionIntent ?? "candidate"}`,
      `parent_summary_id: ${entry.parentSummaryId ?? ""}`,
      `session_id: ${entry.sessionId}`,
      `created_at: ${entry.createdAt}`,
      `start_turn: ${entry.startTurn}`,
      `end_turn: ${entry.endTurn}`,
      `source_first_message_id: ${entry.sourceFirstMessageId ?? ""}`,
      `source_last_message_id: ${entry.sourceLastMessageId ?? ""}`,
      "child_summary_ids:",
      ...(entry.childSummaryIds ?? []).map((item) => `  - ${item}`),
      "source_summary_ids:",
      ...(entry.sourceSummaryIds ?? []).map((item) => `  - ${item}`),
      "keywords:",
      ...entry.keywords.map((item) => `  - ${item}`),
      "constraints:",
      ...entry.constraints.map((item) => `  - ${item}`),
      "decisions:",
      ...entry.decisions.map((item) => `  - ${item}`),
      "blockers:",
      ...entry.blockers.map((item) => `  - ${item}`),
      "next_steps:",
      ...(entry.nextSteps ?? []).map((item) => `  - ${item}`),
      "key_entities:",
      ...(entry.keyEntities ?? []).map((item) => `  - ${item}`),
      "exact_facts:",
      ...entry.exactFacts.map((item) => `  - ${item}`),
      "---",
      "",
      "# Summary",
      "",
      entry.summary,
      "",
    ].join("\n");
    await writeFile(filePath, ensureMarkdownText(frontmatter), "utf8");
    return filePath;
  }

  async writeDurableMemoryMirror(entries: DurableMemoryEntry[]): Promise<void> {
    const paths = await this.ensureLayout();
    const grouped = {
      facts: entries.filter((entry) => entry.kind === "user_fact" || entry.kind === "project_state"),
      constraints: entries.filter((entry) => entry.kind === "constraint"),
      decisions: entries.filter((entry) => entry.kind === "assistant_decision"),
      diagnostics: entries.filter((entry) => entry.kind === "diagnostic" || entry.kind === "solution"),
    };

    await Promise.all([
      this.writeDurableBucket(path.join(paths.durableDir, "facts.md"), "Facts", grouped.facts),
      this.writeDurableBucket(path.join(paths.durableDir, "constraints.md"), "Constraints", grouped.constraints),
      this.writeDurableBucket(path.join(paths.durableDir, "decisions.md"), "Decisions", grouped.decisions),
      this.writeDurableBucket(path.join(paths.durableDir, "diagnostics.md"), "Diagnostics", grouped.diagnostics),
    ]);
  }

  async appendTranscript(messages: Array<{ role: string; createdAt: string; content: string }>): Promise<string> {
    const paths = await this.ensureLayout();
    const dateLabel = (messages[0]?.createdAt ?? new Date().toISOString()).slice(0, 10);
    const monthDir = path.join(paths.transcriptsDir, dateLabel.slice(0, 4), dateLabel.slice(0, 7));
    await mkdir(monthDir, { recursive: true });
    const filePath = path.join(monthDir, `${dateLabel}.md`);
    const existing = await this.readUtf8OrEmpty(filePath);
    const block = messages
      .map((message) => `## ${message.role} @ ${message.createdAt}\n\n${message.content.trim()}\n`)
      .join("\n");
    await writeFile(filePath, `${existing}${existing ? "\n" : "# Transcript\n\n"}${block}`, "utf8");
    return filePath;
  }

  private async ensureSummaryDateDir(createdAt: string): Promise<string> {
    const date = createdAt.slice(0, 10);
    const paths = await this.ensureLayout();
    const dir = path.join(paths.summariesDir, date.slice(0, 4), date.slice(0, 7), date);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async writeDurableBucket(filePath: string, title: string, entries: DurableMemoryEntry[]): Promise<void> {
    const content = [
      `# ${title}`,
      "",
      ...entries.map((entry) => `- [${entry.kind}] ${entry.text}`),
      "",
    ].join("\n");
    await writeFile(filePath, ensureMarkdownText(content), "utf8");
  }

  private async readUtf8OrEmpty(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return "";
    }
  }

  private paths(): AgentVaultPaths {
    const agentRoot = path.join(this.vaultRoot, "agents", this.agentId);
    return {
      agentRoot,
      coreDir: path.join(agentRoot, "core"),
      navigationDir: path.join(agentRoot, "navigation"),
      summariesDir: path.join(agentRoot, "summaries"),
      durableDir: path.join(agentRoot, "durable"),
      transcriptsDir: path.join(agentRoot, "transcripts"),
      navigationPath: path.join(agentRoot, "navigation", "NAVIGATION.md"),
      memoryPath: path.join(agentRoot, "core", "MEMORY.md"),
    };
  }
}
