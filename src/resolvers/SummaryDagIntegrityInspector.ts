import {
  DagIntegrityIssue,
  DagIntegrityReport,
  RawMessageRepository,
  SummaryEntry,
  SummaryRepository,
} from "../types";
import { SourceMessageResolver } from "./SourceMessageResolver";

export class SummaryDagIntegrityInspector {
  private readonly sourceResolver = new SourceMessageResolver();

  inspect(
    summaryStore: SummaryRepository,
    rawStore: RawMessageRepository,
    options: { sessionId?: string } = {},
  ): DagIntegrityReport {
    const summaries = summaryStore.getActiveSummaries(options);
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    const issues: DagIntegrityIssue[] = [];
    let rootCount = 0;
    let branchCount = 0;
    let leafCount = 0;

    for (const summary of summaries) {
      const isBranch = (summary.nodeKind ?? "leaf") === "branch";
      const childIds = this.childIds(summary);
      const parentIds = this.parentIds(summary);
      if (parentIds.length === 0) {
        rootCount += 1;
      }
      if (isBranch) {
        branchCount += 1;
      } else {
        leafCount += 1;
      }

      if (isBranch && childIds.length === 0) {
        issues.push(this.issue("error", "branch_without_children", summary.id, "Branch summary has no structural children."));
      }
      if (!isBranch && childIds.length > 0) {
        issues.push(this.issue("warning", "leaf_with_children", summary.id, "Leaf summary carries child summary ids."));
      }

      for (const childId of childIds) {
        const child = byId.get(childId);
        if (!child) {
          issues.push(this.issue("error", "missing_child_summary", summary.id, `Child summary ${childId} does not exist.`, childId));
          continue;
        }
        if (!this.parentIds(child).includes(summary.id)) {
          issues.push(this.issue("error", "child_parent_backlink_missing", summary.id, `Child ${childId} does not link back to parent ${summary.id}.`, childId));
        }
      }

      for (const parentId of parentIds) {
        const parent = byId.get(parentId);
        if (!parent) {
          issues.push(this.issue("error", "missing_parent_summary", summary.id, `Parent summary ${parentId} does not exist.`, parentId));
          continue;
        }
        if (!this.childIds(parent).includes(summary.id)) {
          issues.push(this.issue("error", "parent_child_backlink_missing", summary.id, `Parent ${parentId} does not include child ${summary.id}.`, parentId));
        }
      }

      if (!isBranch) {
        const resolution = this.sourceResolver.resolve(rawStore, summary);
        if (resolution.messages.length === 0) {
          issues.push(this.issue("error", "source_messages_missing", summary.id, "Leaf source messages could not be resolved."));
        } else if (!resolution.verified) {
          issues.push(this.issue("error", "source_integrity_mismatch", summary.id, `Leaf source integrity failed: ${resolution.reason}.`));
        }
      }
    }

    return {
      ok: issues.every((issue) => issue.severity !== "error"),
      totalSummaries: summaries.length,
      rootCount,
      branchCount,
      leafCount,
      issueCount: issues.length,
      issues,
    };
  }

  private childIds(summary: SummaryEntry): string[] {
    return [...new Set([
      ...(summary.childSummaryIds ?? []),
      ...(summary.sourceSummaryIds ?? []),
    ])];
  }

  private parentIds(summary: SummaryEntry): string[] {
    return [...new Set([
      ...(summary.parentSummaryIds ?? []),
      ...(summary.parentSummaryId ? [summary.parentSummaryId] : []),
    ])];
  }

  private issue(
    severity: DagIntegrityIssue["severity"],
    code: DagIntegrityIssue["code"],
    summaryId: string,
    message: string,
    relatedSummaryId?: string,
  ): DagIntegrityIssue {
    return {
      severity,
      code,
      summaryId,
      relatedSummaryId,
      message,
    };
  }
}
