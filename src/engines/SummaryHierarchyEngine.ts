import { randomUUID } from "node:crypto";

import {
  LlmCaller,
  LoggerLike,
  SummaryEntry,
  SummaryRepository,
  SummaryResult,
} from "../types";
import { estimateTokens } from "../utils/tokenizer";
import {
  buildStableEventId,
  deriveProjectIdentityFromSummary,
} from "../utils/projectIdentity";

const SUMMARY_PHASES = new Set([
  "planning",
  "implementation",
  "validation",
  "fixing",
  "review",
  "active",
]);

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
      memoryType: result.memoryType,
      phase: result.phase,
      constraints: result.constraints,
      decisions: result.decisions,
      blockers: result.blockers,
      nextSteps: result.nextSteps,
      keyEntities: result.keyEntities,
      exactFacts: result.exactFacts,
      promotionIntent: result.promotionIntent,
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
      throw new Error("LLM caller unavailable for summary hierarchy rollup");
    }

    try {
      const prompt = [
        "You are generating a higher-level rollup summary for a memory tree.",
        "Return JSON with exactly these keys: summary, keywords, toneTag, memoryType, phase, constraints, decisions, blockers, nextSteps, keyEntities, exactFacts, promotionIntent.",
        "The output must merge child summaries into a navigation-level parent summary.",
        "Do not invent facts. Keep references stable and concise.",
        "",
        ...children.map((child, index) => [
          `Child summary ${index + 1} (${child.startTurn}-${child.endTurn}):`,
          child.summary,
          `memoryType: ${child.memoryType ?? "general"}`,
          `phase: ${child.phase ?? ""}`,
          `keywords: ${child.keywords.join(", ")}`,
          `constraints: ${child.constraints.join("; ")}`,
          `decisions: ${child.decisions.join("; ")}`,
          `blockers: ${child.blockers.join("; ")}`,
          `nextSteps: ${(child.nextSteps ?? []).join("; ")}`,
          `keyEntities: ${(child.keyEntities ?? []).join("; ")}`,
          `exactFacts: ${child.exactFacts.join("; ")}`,
          `promotionIntent: ${child.promotionIntent ?? "candidate"}`,
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
      throw new Error("LLM rollup response was not valid JSON summary output");
    } catch (error) {
      this.logger.warn("summary_hierarchy_rollup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
        memoryType: typeof parsed.memoryType === "string" ? parsed.memoryType as SummaryResult["memoryType"] : "project_state",
        phase: this.normalizePhase(parsed.phase),
        constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map(String) : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
        blockers: Array.isArray(parsed.blockers) ? parsed.blockers.map(String) : [],
        nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps.map(String) : [],
        keyEntities: Array.isArray(parsed.keyEntities) ? parsed.keyEntities.map(String) : [],
        exactFacts: Array.isArray(parsed.exactFacts) ? parsed.exactFacts.map(String) : [],
        promotionIntent: typeof parsed.promotionIntent === "string" ? parsed.promotionIntent as SummaryResult["promotionIntent"] : "candidate",
      };
    } catch {
      return null;
    }
  }

  private normalizePhase(value: unknown): SummaryResult["phase"] {
    const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
    return SUMMARY_PHASES.has(candidate) ? candidate as SummaryResult["phase"] : undefined;
  }
}
