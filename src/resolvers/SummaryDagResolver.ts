import {
  DagTraversalStep,
  SummaryEntry,
  SummaryRepository,
} from "../types";

interface ScoredSummary {
  summary: SummaryEntry;
  score: number;
  reasons: string[];
}

export interface SummaryDagTraversalResult {
  summaries: SummaryEntry[];
  trace: DagTraversalStep[];
}

export class SummaryDagResolver {
  resolve(
    query: string,
    summaryStore: SummaryRepository,
    options: {
      sessionId?: string;
      maxRoots?: number;
      maxLeaves?: number;
      maxChildrenPerBranch?: number;
    } = {},
  ): SummaryDagTraversalResult {
    const summaries = summaryStore.getActiveSummaries({ sessionId: options.sessionId });
    if (summaries.length === 0) {
      return { summaries: [], trace: [] };
    }

    const terms = this.queryTerms(query);
    const numericAnchors = query.match(/\b\d{2,}\b/g) ?? [];
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    const scored = summaries
      .map((summary) => this.scoreSummary(summary, terms, numericAnchors))
      .filter((item) => item.score > 0)
      .sort(this.sortScored);
    const roots = summaries.filter((summary) => this.isRoot(summary, byId));
    const scoredRoots = roots
      .map((summary) => this.scoreSummary(summary, terms, numericAnchors))
      .filter((item) => item.score > 0)
      .sort(this.sortScored);

    const rootCandidates = (scoredRoots.length > 0 ? scoredRoots : scored)
      .slice(0, options.maxRoots ?? 3);
    const trace: DagTraversalStep[] = [];
    const leaves: ScoredSummary[] = [];
    const seenLeaves = new Set<string>();

    for (const root of rootCandidates) {
      trace.push(this.traceStep(root, "root_candidate"));
      this.descend({
        node: root,
        byId,
        terms,
        numericAnchors,
        trace,
        leaves,
        seenLeaves,
        path: new Set<string>(),
        maxChildrenPerBranch: options.maxChildrenPerBranch ?? 4,
        maxLeaves: options.maxLeaves ?? 8,
      });
      if (leaves.length >= (options.maxLeaves ?? 8)) {
        break;
      }
    }

    for (const directLeaf of scored.filter((item) => this.isLeaf(item.summary)).slice(0, options.maxLeaves ?? 8)) {
      if (seenLeaves.has(directLeaf.summary.id)) {
        continue;
      }
      seenLeaves.add(directLeaf.summary.id);
      leaves.push(directLeaf);
      trace.push(this.traceStep(directLeaf, "direct_leaf_hit"));
      if (leaves.length >= (options.maxLeaves ?? 8)) {
        break;
      }
    }

    const preciseLeaves = numericAnchors.length > 0
      ? leaves.filter((item) => item.reasons.includes("numeric_anchor"))
      : leaves;
    const finalLeaves = preciseLeaves.length > 0 ? preciseLeaves : leaves;

    return {
      summaries: finalLeaves.sort(this.sortScored).slice(0, options.maxLeaves ?? 8).map((item) => item.summary),
      trace,
    };
  }

  private descend(args: {
    node: ScoredSummary;
    byId: Map<string, SummaryEntry>;
    terms: string[];
    numericAnchors: string[];
    trace: DagTraversalStep[];
    leaves: ScoredSummary[];
    seenLeaves: Set<string>;
    path: Set<string>;
    maxChildrenPerBranch: number;
    maxLeaves: number;
  }): void {
    const { node, byId, terms, numericAnchors, trace, leaves, seenLeaves, path } = args;
    if (path.has(node.summary.id) || leaves.length >= args.maxLeaves) {
      return;
    }
    const nextPath = new Set(path);
    nextPath.add(node.summary.id);

    const childIds = (node.summary.childSummaryIds && node.summary.childSummaryIds.length > 0)
      ? node.summary.childSummaryIds
      : node.summary.sourceSummaryIds ?? [];
    const children = childIds
      .map((id) => byId.get(id))
      .filter((summary): summary is SummaryEntry => Boolean(summary));

    if (children.length === 0 || this.isLeaf(node.summary)) {
      if (!seenLeaves.has(node.summary.id)) {
        seenLeaves.add(node.summary.id);
        leaves.push(node);
        trace.push(this.traceStep(node, this.isLeaf(node.summary) ? "leaf_selected" : "branch_fallback"));
      }
      return;
    }

    const scoredChildren = children
      .map((summary) => this.scoreSummary(summary, terms, numericAnchors, node.score))
      .sort(this.sortScored)
      .slice(0, args.maxChildrenPerBranch);

    for (const child of scoredChildren) {
      trace.push(this.traceStep(child, "descend"));
      this.descend({
        ...args,
        node: child,
        path: nextPath,
      });
      if (leaves.length >= args.maxLeaves) {
        break;
      }
    }
  }

  private scoreSummary(
    summary: SummaryEntry,
    terms: string[],
    numericAnchors: string[],
    inheritedScore = 0,
  ): ScoredSummary {
    const buckets: Array<{ text: string; weight: number; reason: string }> = [
      { text: summary.summary, weight: 3, reason: "summary_text" },
      { text: summary.keywords.join(" "), weight: 4, reason: "keywords" },
      { text: summary.exactFacts.join(" "), weight: 6, reason: "exact_facts" },
      { text: summary.constraints.join(" "), weight: 5, reason: "constraints" },
      { text: summary.decisions.join(" "), weight: 4, reason: "decisions" },
      { text: summary.blockers.join(" "), weight: 3, reason: "blockers" },
      { text: (summary.nextSteps ?? []).join(" "), weight: 2, reason: "next_steps" },
      { text: (summary.keyEntities ?? []).join(" "), weight: 5, reason: "key_entities" },
      { text: `${summary.memoryType ?? ""} ${summary.phase ?? ""} ${summary.projectId ?? ""} ${summary.topicId ?? ""}`, weight: 2, reason: "metadata" },
    ];

    let score = Math.floor(inheritedScore / 3);
    const reasons: string[] = inheritedScore > 0 ? ["parent_context"] : [];
    for (const term of terms) {
      for (const bucket of buckets) {
        if (bucket.text.toLowerCase().includes(term)) {
          score += term.length >= 6 ? bucket.weight + 1 : bucket.weight;
          reasons.push(bucket.reason);
        }
      }
    }
    for (const anchor of numericAnchors) {
      if (buckets.some((bucket) => bucket.text.includes(anchor))) {
        score += 8;
        reasons.push("numeric_anchor");
      }
    }

    if ((summary.summaryLevel ?? 1) > 1 && score > 0) {
      score += 1;
      reasons.push("branch_navigation");
    }

    return {
      summary,
      score,
      reasons: [...new Set(reasons)],
    };
  }

  private traceStep(item: ScoredSummary, action: DagTraversalStep["action"]): DagTraversalStep {
    return {
      summaryId: item.summary.id,
      sessionId: item.summary.sessionId,
      summaryLevel: item.summary.summaryLevel ?? 1,
      nodeKind: item.summary.nodeKind ?? "leaf",
      score: item.score,
      reasons: item.reasons,
      action,
      parentSummaryIds: item.summary.parentSummaryIds,
      childSummaryIds: item.summary.childSummaryIds,
    };
  }

  private isRoot(summary: SummaryEntry, byId: Map<string, SummaryEntry>): boolean {
    const parents = [
      ...(summary.parentSummaryIds ?? []),
      ...(summary.parentSummaryId ? [summary.parentSummaryId] : []),
    ];
    return parents.length === 0 || parents.every((id) => !byId.has(id));
  }

  private isLeaf(summary: SummaryEntry): boolean {
    return (summary.nodeKind ?? "leaf") === "leaf" ||
      ((summary.childSummaryIds ?? []).length === 0 && (summary.sourceSummaryIds ?? []).length === 0);
  }

  private sortScored(left: ScoredSummary, right: ScoredSummary): number {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if ((left.summary.summaryLevel ?? 1) !== (right.summary.summaryLevel ?? 1)) {
      return (right.summary.summaryLevel ?? 1) - (left.summary.summaryLevel ?? 1);
    }
    return left.summary.startTurn - right.summary.startTurn;
  }

  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
  }
}
