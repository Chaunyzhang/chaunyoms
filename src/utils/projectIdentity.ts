import { createHash } from "node:crypto";

import { ProjectStateSnapshot, RawMessage, SummaryEntry } from "../types";

export interface ProjectIdentity {
  projectId: string;
  topicId: string;
  canonicalKey: string;
  title: string;
}

const DEFAULT_TEXT = "general-workstream";
const STOPWORDS = new Set([
  "the", "and", "with", "that", "this", "from", "have", "will", "into", "about",
  "your", "just", "they", "them", "then", "than", "what", "when", "where", "which",
  "当前", "这个", "那个", "然后", "已经", "需要", "一下", "我们", "你们", "他们", "现在",
]);

export function deriveProjectIdentityFromMessages(
  messages: RawMessage[],
  fallbackScope: string,
): ProjectIdentity {
  const candidates = messages
    .map((message) => message.content)
    .filter(Boolean)
    .slice(-4);
  return deriveProjectIdentityFromText(candidates, fallbackScope);
}

export function deriveProjectIdentityFromSummary(
  summary: Pick<SummaryEntry, "summary" | "keywords" | "projectId" | "topicId">,
  fallbackScope: string,
): ProjectIdentity {
  const base = deriveProjectIdentityFromText(
    [summary.summary, ...(summary.keywords ?? [])],
    fallbackScope,
  );
  return {
    projectId: summary.projectId ?? base.projectId,
    topicId: summary.topicId ?? base.topicId,
    canonicalKey: base.canonicalKey,
    title: base.title,
  };
}

export function deriveProjectIdentityFromSnapshot(
  snapshot: Pick<ProjectStateSnapshot, "active" | "decision" | "todo" | "pending">,
  fallbackScope: string,
): ProjectIdentity {
  return deriveProjectIdentityFromText(
    [snapshot.active, snapshot.decision, snapshot.todo, snapshot.pending],
    fallbackScope,
  );
}

export function deriveProjectStatusFromSnapshot(
  snapshot: Pick<ProjectStateSnapshot, "blocker" | "risk" | "todo" | "next" | "active">,
): "active" | "blocked" | "planned" | "archived" {
  const blockerText = `${snapshot.blocker} ${snapshot.risk}`.toLowerCase();
  if (/(block|risk|error|fail|issue|阻塞|失败|风险)/i.test(blockerText) && !/none recorded/i.test(blockerText)) {
    return "blocked";
  }
  if (/(todo|next|plan|pending|待办|下一步)/i.test(`${snapshot.todo} ${snapshot.next}`)) {
    return "planned";
  }
  if (!snapshot.active || /none recorded/i.test(snapshot.active)) {
    return "archived";
  }
  return "active";
}

export function deriveProjectIdentityFromText(
  values: Array<string | undefined>,
  fallbackScope: string,
): ProjectIdentity {
  const combined = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const informative = extractInformativeText(combined) || fallbackScope || DEFAULT_TEXT;
  const canonicalKey = slugify(informative) || slugify(fallbackScope) || DEFAULT_TEXT;
  const title = toTitle(informative);
  return {
    projectId: `project-${canonicalKey}`,
    topicId: `topic-${canonicalKey}`,
    canonicalKey,
    title,
  };
}

export function buildStableEventId(scope: string, input: string): string {
  return `${scope}-${createHash("sha256").update(input, "utf8").digest("hex").slice(0, 20)}`;
}

function extractInformativeText(input: string): string {
  if (!input) {
    return "";
  }

  const cleaned = input
    .replace(/[`*_>#-]/g, " ")
    .replace(/\b(?:http|https):\/\/\S+/gi, " ")
    .replace(/\b[a-z]:\\[^\s]+/gi, " ")
    .replace(/\b\w+\.(?:ts|js|json|md|tsx|jsx|yml|yaml)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }

  const tokens = cleaned
    .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !STOPWORDS.has(token.toLowerCase()));

  if (tokens.length === 0) {
    return cleaned.slice(0, 64);
  }

  return tokens.slice(0, 6).join(" ");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
}

function toTitle(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69)}...`;
}
