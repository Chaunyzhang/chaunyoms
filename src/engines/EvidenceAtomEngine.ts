import { createHash } from "node:crypto";

import {
  EvidenceAtomEntry,
  EvidenceAtomType,
  SummaryEntry,
} from "../types";
import { buildStableEventId } from "../utils/projectIdentity";

const TYPE_TAGS: Record<EvidenceAtomType, string[]> = {
  constraint: ["constraint", "rule"],
  decision: ["decision"],
  exact_fact: ["fact", "exact"],
  blocker: ["blocker", "risk"],
  next_step: ["next_step", "todo"],
  entity: ["entity"],
};

export class EvidenceAtomEngine {
  fromSummary(summary: SummaryEntry): EvidenceAtomEntry[] {
    const seeds = [
      ...this.seed(summary, "constraint", summary.constraints),
      ...this.seed(summary, "decision", summary.decisions),
      ...this.seed(summary, "exact_fact", summary.exactFacts),
      ...this.seed(summary, "blocker", summary.blockers),
      ...this.seed(summary, "next_step", summary.nextSteps ?? []),
      ...this.seed(summary, "entity", summary.keyEntities ?? []),
    ];

    return seeds.map((seed) => this.toAtom(summary, seed));
  }

  private seed(
    summary: SummaryEntry,
    type: EvidenceAtomType,
    values: string[],
  ): Array<{ type: EvidenceAtomType; text: string; index: number }> {
    return values
      .map((value, index) => ({
        type,
        text: value.replace(/\s+/g, " ").trim(),
        index,
      }))
      .filter((seed) => seed.text.length >= 2)
      .filter((seed, index, all) =>
        all.findIndex((other) => other.type === seed.type && other.text === seed.text) === index,
      )
      .map((seed) => ({ ...seed, index: seed.index }));
  }

  private toAtom(
    summary: SummaryEntry,
    seed: { type: EvidenceAtomType; text: string; index: number },
  ): EvidenceAtomEntry {
    const stableKey = `${summary.id}|${seed.type}|${seed.index}|${seed.text}`;
    const id = `atom-${this.hash(stableKey).slice(0, 24)}`;
    const tags = [
      ...TYPE_TAGS[seed.type],
      ...(summary.keywords ?? []).slice(0, 8),
      ...(summary.keyEntities ?? []).slice(0, 8),
    ].map((tag) => tag.trim()).filter(Boolean);
    return {
      id,
      eventId: buildStableEventId("atom", stableKey),
      sessionId: summary.sessionId,
      agentId: summary.agentId,
      projectId: summary.projectId,
      topicId: summary.topicId,
      recordStatus: summary.recordStatus ?? "active",
      atomStatus: this.resolveAtomStatus(summary),
      type: seed.type,
      text: seed.text,
      retrievalText: [
        seed.text,
        seed.type,
        summary.keywords.join(" "),
        (summary.keyEntities ?? []).join(" "),
      ].filter(Boolean).join(" "),
      tags: [...new Set(tags)],
      confidence: summary.quality?.confidence ?? (summary.sourceBinding || summary.sourceHash ? 0.9 : 0.7),
      importance: this.importance(seed.type),
      stability: this.stability(seed.type, summary),
      sourceTraceComplete: summary.quality?.sourceTraceComplete ?? Boolean(summary.sourceBinding || summary.sourceHash),
      sourceSummaryId: summary.id,
      sourceBinding: summary.sourceBinding,
      sourceMessageIds: [...new Set(summary.sourceMessageIds ?? summary.sourceBinding?.messageIds ?? [])],
      startTurn: summary.startTurn,
      endTurn: summary.endTurn,
      sourceHash: summary.sourceHash,
      sourceMessageCount: summary.sourceMessageCount,
      createdAt: summary.createdAt,
      metadata: {
        summaryLevel: summary.summaryLevel ?? 1,
        nodeKind: summary.nodeKind ?? "leaf",
        atomIndex: seed.index,
        summaryQuality: summary.quality,
        sourceCoverage: summary.coverage,
        unresolvedConflicts: summary.quality?.unresolvedConflicts ?? summary.conflicts?.length ?? 0,
      },
    };
  }

  private resolveAtomStatus(summary: SummaryEntry): EvidenceAtomEntry["atomStatus"] {
    if ((summary.conflicts?.length ?? 0) > 0 || (summary.quality?.unresolvedConflicts ?? 0) > 0) {
      return "conflicted";
    }
    return summary.promotionIntent === "promote" || summary.promotionIntent === "priority_promote"
      ? "accepted"
      : "candidate";
  }

  private stability(type: EvidenceAtomType, summary: SummaryEntry): number {
    const base = type === "constraint" || type === "decision" ? 0.8 : type === "entity" ? 0.45 : 0.65;
    const traceBonus = summary.quality?.sourceTraceComplete === false ? -0.25 : 0.1;
    const conflictPenalty = (summary.conflicts?.length ?? 0) > 0 ? -0.35 : 0;
    return Math.max(0, Math.min(1, base + traceBonus + conflictPenalty));
  }

  private importance(type: EvidenceAtomType): number {
    switch (type) {
      case "constraint":
      case "decision":
        return 0.9;
      case "exact_fact":
        return 0.8;
      case "blocker":
        return 0.75;
      case "next_step":
        return 0.65;
      case "entity":
        return 0.4;
      default:
        return 0.5;
    }
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}
