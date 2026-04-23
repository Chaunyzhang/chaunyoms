import { randomUUID } from "node:crypto";

import {
  LlmCaller,
  LoggerLike,
  SummaryEntry,
  SummaryRepository,
} from "../types";
import { estimateTokens } from "../utils/tokenizer";
import {
  buildStableEventId,
  deriveProjectIdentityFromSummary,
} from "../utils/projectIdentity";

interface SummaryResult {
  summary: string;
  keywords: string[];
  toneTag: string;
  constraints: string[];
  decisions: string[];
  blockers: string[];
  exactFacts: string[];
}

export class SummaryHierarchyEngine {
  constructor(
    private readonly llmCaller: LlmCaller | null,
    private readonly logger: LoggerLike,
  ) {}

  async rollUp(
    summaryStore: SummaryRepository,
    sessionId: string,
    agentId: string,
    summaryModel?: string,
    maxOutputTokens = 200,
  ): Promise<SummaryEntry | null> {
    const candidateGroup = this.selectRollupGroup(summaryStore.getRootSummaries());
    if (!candidateGroup) {
      return null;
    }

    const identity = deriveProjectIdentityFromSummary(
      candidateGroup[candidateGroup.length - 1],
      sessionId,
    );
    const result = await this.generateRollupSummary(candidateGroup, summaryModel, maxOutputTokens);
    const sourceMessageIds = [...new Set(candidateGroup.flatMap((entry) => entry.sourceMessageIds ?? []))];
    const sourceSummaryIds = candidateGroup.map((entry) => entry.id);
    const entry: SummaryEntry = {
      id: randomUUID(),
      eventId: buildStableEventId("summary", `${sessionId}|rollup|${sourceSummaryIds.join("|")}`),
      sessionId,
      agentId,
      projectId: candidateGroup[0].projectId ?? identity.projectId,
      topicId: candidateGroup[0].topicId ?? identity.topicId,
      recordStatus: "active",
      summary: result.summary,
      keywords: result.keywords,
      toneTag: result.toneTag,
      constraints: result.constraints,
      decisions: result.decisions,
      blockers: result.blockers,
      exactFacts: result.exactFacts,
      startTurn: candidateGroup[0].startTurn,
      endTurn: candidateGroup[candidateGroup.length - 1].endTurn,
      sourceFirstMessageId: candidateGroup[0].sourceFirstMessageId,
      sourceLastMessageId: candidateGroup[candidateGroup.length - 1].sourceLastMessageId,
      sourceMessageIds,
      sourceStartTimestamp: candidateGroup[0].sourceStartTimestamp,
      sourceEndTimestamp: candidateGroup[candidateGroup.length - 1].sourceEndTimestamp,
      sourceSequenceMin: candidateGroup[0].sourceSequenceMin,
      sourceSequenceMax: candidateGroup[candidateGroup.length - 1].sourceSequenceMax,
      sourceSummaryIds,
      childSummaryIds: [...sourceSummaryIds],
      summaryLevel: (candidateGroup[0].summaryLevel ?? 1) + 1,
      nodeKind: "branch",
      tokenCount: estimateTokens(result.summary),
      createdAt: new Date().toISOString(),
      sourceHash: undefined,
      sourceMessageCount: sourceMessageIds.length || undefined,
    };

    const added = await summaryStore.addSummary(entry);
    if (!added) {
      return null;
    }
    await summaryStore.attachParent(entry.id, sourceSummaryIds);
    return entry;
  }

  private selectRollupGroup(summaries: SummaryEntry[]): SummaryEntry[] | null {
    const grouped = new Map<string, SummaryEntry[]>();
    for (const summary of summaries
      .filter((entry) => entry.recordStatus === "active")
      .sort((left, right) => left.startTurn - right.startTurn || left.endTurn - right.endTurn)) {
      const key = `${summary.projectId ?? "none"}|${summary.summaryLevel ?? 1}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(summary);
      grouped.set(key, bucket);
    }

    for (const bucket of grouped.values()) {
      if (bucket.length < 3) {
        continue;
      }
      return bucket.slice(0, 3);
    }
    return null;
  }

  private async generateRollupSummary(
    children: SummaryEntry[],
    summaryModel: string | undefined,
    maxOutputTokens: number,
  ): Promise<SummaryResult> {
    if (!this.llmCaller) {
      return this.buildFallback(children);
    }

    try {
      const prompt = [
        "You are generating a higher-level rollup summary for a memory tree.",
        "Return JSON with exactly these keys: summary, keywords, toneTag, constraints, decisions, blockers, exactFacts.",
        "The output must merge child summaries into a navigation-level parent summary.",
        "Do not invent facts. Keep references stable and concise.",
        "",
        ...children.map((child, index) => [
          `Child summary ${index + 1} (${child.startTurn}-${child.endTurn}):`,
          child.summary,
          `keywords: ${child.keywords.join(", ")}`,
          `constraints: ${child.constraints.join("; ")}`,
          `decisions: ${child.decisions.join("; ")}`,
          `blockers: ${child.blockers.join("; ")}`,
          `exactFacts: ${child.exactFacts.join("; ")}`,
        ].join("\n")),
      ].join("\n\n");
      const raw = await this.llmCaller.call({
        prompt,
        model: summaryModel,
        maxOutputTokens,
        temperature: 0,
      });
      const parsed = this.tryParse(raw);
      if (parsed) {
        return parsed;
      }
    } catch (error) {
      this.logger.warn("summary_hierarchy_rollup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return this.buildFallback(children);
  }

  private buildFallback(children: SummaryEntry[]): SummaryResult {
    const summary = children.map((child) => child.summary).join(" ").slice(0, 600);
    return {
      summary: summary.trim(),
      keywords: [...new Set(children.flatMap((child) => child.keywords))].slice(0, 10),
      toneTag: "structured rollup",
      constraints: [...new Set(children.flatMap((child) => child.constraints))].slice(0, 8),
      decisions: [...new Set(children.flatMap((child) => child.decisions))].slice(0, 8),
      blockers: [...new Set(children.flatMap((child) => child.blockers))].slice(0, 8),
      exactFacts: [...new Set(children.flatMap((child) => child.exactFacts))].slice(0, 12),
    };
  }

  private tryParse(raw: string): SummaryResult | null {
    try {
      const parsed = JSON.parse(raw) as Partial<SummaryResult>;
      if (!parsed || typeof parsed.summary !== "string") {
        return null;
      }
      return {
        summary: parsed.summary.trim(),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
        toneTag: typeof parsed.toneTag === "string" ? parsed.toneTag : "structured rollup",
        constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map(String) : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
        blockers: Array.isArray(parsed.blockers) ? parsed.blockers.map(String) : [],
        exactFacts: Array.isArray(parsed.exactFacts) ? parsed.exactFacts.map(String) : [],
      };
    } catch {
      return null;
    }
  }
}
