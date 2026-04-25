import { createHash } from "node:crypto";

import { ContextItem } from "../types";

export type ContextCandidateSource =
  | "stable_prefix"
  | "recent_tail"
  | "active_memory"
  | "reviewed_asset"
  | "summary_context"
  | "raw_exact_search";

export type ContextCandidateAuthority =
  | "current_context"
  | "active_memory"
  | "reviewed_asset"
  | "source_backed_summary"
  | "raw_evidence"
  | "hint";

export interface ContextPlannerCandidate {
  id: string;
  source: ContextCandidateSource;
  authority: ContextCandidateAuthority;
  item: ContextItem;
  score: number;
  reasons: string[];
}

export interface ContextPlannerRejectedCandidate {
  id: string;
  source: ContextCandidateSource;
  authority: ContextCandidateAuthority;
  tokenCount: number;
  score: number;
  reasons: string[];
  rejectedReason: "duplicate_source" | "budget_exhausted";
}

export interface ContextPlannerResult {
  runId: string;
  createdAt: string;
  selected: ContextPlannerCandidate[];
  rejected: ContextPlannerRejectedCandidate[];
  selectedTokens: number;
  candidateCount: number;
  budget: number;
}

export class ContextPlanner {
  plan(
    candidates: ContextPlannerCandidate[],
    options: { budget: number; runId?: string; createdAt?: string },
  ): ContextPlannerResult {
    const createdAt = options.createdAt ?? new Date().toISOString();
    const runId = options.runId ?? `context-run-${this.hash(`${createdAt}:${candidates.length}:${options.budget}`).slice(0, 16)}`;
    const indexed = candidates.map((candidate, index) => ({ candidate, index }));
    const selectionOrder = [
      ...indexed.filter((item) => item.candidate.source === "stable_prefix"),
      ...indexed
        .filter((item) => item.candidate.source !== "stable_prefix" && item.candidate.source !== "recent_tail")
        .sort((left, right) => this.compareForSelection(left.candidate, right.candidate, left.index, right.index)),
      ...indexed.filter((item) => item.candidate.source === "recent_tail"),
    ];
    const seen = new Set<string>();
    const selected: ContextPlannerCandidate[] = [];
    const rejected: ContextPlannerRejectedCandidate[] = [];
    let selectedTokens = 0;

    for (const { candidate } of selectionOrder) {
      const dedupKey = this.dedupKey(candidate);
      if (seen.has(dedupKey)) {
        rejected.push(this.reject(candidate, "duplicate_source"));
        continue;
      }

      const tokenCount = Math.max(candidate.item.tokenCount, 0);
      if (
        options.budget > 0 &&
        selected.length > 0 &&
        selectedTokens + tokenCount > options.budget
      ) {
        rejected.push(this.reject(candidate, "budget_exhausted"));
        continue;
      }

      seen.add(dedupKey);
      selected.push(candidate);
      selectedTokens += tokenCount;
    }

    const selectedKeys = new Set(selected.map((candidate) => candidate.id));
    const selectedInOutputOrder = indexed
      .filter(({ candidate }) => selectedKeys.has(candidate.id))
      .sort((left, right) => this.compareForOutput(left.candidate, right.candidate, left.index, right.index))
      .map(({ candidate }) => candidate);

    return {
      runId,
      createdAt,
      selected: selectedInOutputOrder,
      rejected,
      selectedTokens,
      candidateCount: candidates.length,
      budget: options.budget,
    };
  }

  buildCandidate(
    item: ContextItem,
    source: ContextCandidateSource,
    index: number,
  ): ContextPlannerCandidate {
    const authority = this.resolveAuthority(item, source);
    return {
      id: this.resolveCandidateId(item, source, index),
      source,
      authority,
      item,
      score: this.scoreAuthority(authority) + this.scoreSource(source),
      reasons: [
        `source:${source}`,
        `authority:${authority}`,
      ],
    };
  }


  private compareForSelection(
    left: ContextPlannerCandidate,
    right: ContextPlannerCandidate,
    leftIndex: number,
    rightIndex: number,
  ): number {
    return right.score - left.score ||
      this.scoreAuthority(right.authority) - this.scoreAuthority(left.authority) ||
      this.scoreSource(right.source) - this.scoreSource(left.source) ||
      Math.max(left.item.tokenCount, 0) - Math.max(right.item.tokenCount, 0) ||
      leftIndex - rightIndex;
  }

  private compareForOutput(
    _left: ContextPlannerCandidate,
    _right: ContextPlannerCandidate,
    leftIndex: number,
    rightIndex: number,
  ): number {
    return leftIndex - rightIndex;
  }

  private resolveAuthority(
    item: ContextItem,
    source: ContextCandidateSource,
  ): ContextCandidateAuthority {
    if (source === "recent_tail") {
      return "current_context";
    }
    if (source === "active_memory") {
      return "active_memory";
    }
    if (source === "reviewed_asset") {
      return "reviewed_asset";
    }
    if (source === "raw_exact_search") {
      return "raw_evidence";
    }
    if (source === "summary_context") {
      return item.metadata?.sourceBinding || item.metadata?.sourceHash
        ? "source_backed_summary"
        : "hint";
    }
    return "hint";
  }

  private scoreAuthority(authority: ContextCandidateAuthority): number {
    switch (authority) {
      case "current_context":
        return 100;
      case "active_memory":
        return 90;
      case "reviewed_asset":
        return 85;
      case "source_backed_summary":
        return 70;
      case "raw_evidence":
        return 65;
      case "hint":
        return 30;
      default:
        return 0;
    }
  }

  private scoreSource(source: ContextCandidateSource): number {
    switch (source) {
      case "recent_tail":
        return 10;
      case "active_memory":
        return 8;
      case "reviewed_asset":
        return 7;
      case "summary_context":
        return 5;
      case "raw_exact_search":
        return 4;
      case "stable_prefix":
        return 2;
      default:
        return 0;
    }
  }

  private resolveCandidateId(
    item: ContextItem,
    source: ContextCandidateSource,
    index: number,
  ): string {
    if (item.summaryId) {
      return `${source}:summary:${item.summaryId}`;
    }
    const metadataId = item.metadata?.id ?? item.metadata?.docId ?? item.metadata?.memoryId;
    if (typeof metadataId === "string" && metadataId.trim().length > 0) {
      return `${source}:${metadataId}`;
    }
    if (typeof item.metadata?.layer === "string") {
      return `${source}:${item.metadata.layer}:${this.hash(item.content).slice(0, 12)}`;
    }
    return `${source}:${index}:${this.hash(item.content).slice(0, 12)}`;
  }

  private dedupKey(candidate: ContextPlannerCandidate): string {
    const item = candidate.item;
    if (item.summaryId) {
      return `summary:${item.summaryId}`;
    }
    const sourceSummaryId = item.metadata?.sourceSummaryId;
    if (typeof sourceSummaryId === "string" && sourceSummaryId.trim()) {
      return `source-summary:${sourceSummaryId}`;
    }
    const memoryId = item.metadata?.memoryId;
    if (typeof memoryId === "string" && memoryId.trim()) {
      return `memory:${memoryId}`;
    }
    const docId = item.metadata?.docId;
    if (typeof docId === "string" && docId.trim()) {
      return `asset:${docId}`;
    }
    return `content:${this.hash(`${candidate.source}:${item.content}`)}`;
  }

  private reject(
    candidate: ContextPlannerCandidate,
    rejectedReason: ContextPlannerRejectedCandidate["rejectedReason"],
  ): ContextPlannerRejectedCandidate {
    return {
      id: candidate.id,
      source: candidate.source,
      authority: candidate.authority,
      tokenCount: candidate.item.tokenCount,
      score: candidate.score,
      reasons: candidate.reasons,
      rejectedReason,
    };
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}
