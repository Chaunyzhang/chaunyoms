import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { ProjectStateSnapshot } from "../types";

const LINE_RE = /^-\s*([a-z_ ]+):\s*(.+)$/i;
const DEFAULT_NONE = "none recorded";

function truncate(input: string, maxChars = 120): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function buildProjectStateSnapshot(
  rawStore: RawMessageStore,
  summaryStore: SummaryIndexStore,
  now = new Date(),
): ProjectStateSnapshot {
  const latestMessages = rawStore.getAll().slice(-12);
  const latestUser =
    [...latestMessages].reverse().find((item) => item.role === "user")?.content ??
    "(none)";
  const latestAssistant =
    [...latestMessages]
      .reverse()
      .find((item) => item.role === "assistant")
      ?.content ?? "(none)";
  const blocker =
    [...latestMessages]
      .reverse()
      .find((item) =>
        /(blocker|blocked|error|fail|issue|risk|阻塞|卡住|失败|报错)/i.test(item.content),
      )
      ?.content ?? DEFAULT_NONE;
  const latestSummary = summaryStore.getAllSummaries().at(-1);

  const dateLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const active = latestUser !== "(none)" ? latestUser : "no active user thread recorded";
  const decision =
    latestAssistant !== "(none)"
      ? latestAssistant
      : "no recent assistant decision recorded";
  const todo = "review follow-up actions from latest turn";
  const next =
    latestAssistant !== "(none)"
      ? latestAssistant
      : "continue the active thread from the latest user request";
  const pending =
    latestUser !== "(none)"
      ? latestUser
      : "review outstanding work from the latest session";
  const risk =
    blocker === DEFAULT_NONE ? DEFAULT_NONE : "latest blocker needs follow-up";

  return {
    dateLabel,
    active: truncate(active),
    decision: truncate(decision),
    todo: truncate(todo),
    next: truncate(next),
    pending: truncate(pending),
    blocker: truncate(blocker),
    risk: truncate(risk),
    recall: latestSummary
      ? `summary:${latestSummary.id} turns ${latestSummary.startTurn}-${latestSummary.endTurn}`
      : "none",
  };
}

export function formatProjectStateSnapshot(
  snapshot: ProjectStateSnapshot,
): string {
  return [
    `${snapshot.dateLabel}:`,
    `- active: ${snapshot.active}`,
    `- decision: ${snapshot.decision}`,
    `- todo: ${snapshot.todo}`,
    `- next: ${snapshot.next}`,
    `- pending: ${snapshot.pending}`,
    `- blocker: ${snapshot.blocker}`,
    `- risk: ${snapshot.risk}`,
    `- recall: ${snapshot.recall}`,
  ].join("\n");
}

export function parseProjectStateSnapshot(
  content: string,
): ProjectStateSnapshot | null {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  const dateLabel = lines[0].replace(/:$/, "").trim();
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = line.match(LINE_RE);
    if (!match) {
      continue;
    }
    fields.set(match[1].trim().toLowerCase(), match[2].trim());
  }

  if (fields.size === 0) {
    return null;
  }

  return {
    dateLabel,
    active: fields.get("active") ?? DEFAULT_NONE,
    decision: fields.get("decision") ?? DEFAULT_NONE,
    todo: fields.get("todo") ?? DEFAULT_NONE,
    next: fields.get("next") ?? DEFAULT_NONE,
    pending: fields.get("pending") ?? DEFAULT_NONE,
    blocker: fields.get("blocker") ?? DEFAULT_NONE,
    risk: fields.get("risk") ?? DEFAULT_NONE,
    recall: fields.get("recall") ?? "none",
  };
}

export function prioritizeProjectStateSnapshot(
  snapshot: ProjectStateSnapshot,
  query: string,
): string {
  const normalizedQuery = query.toLowerCase();
  const preferredKeys = projectStateKeysForQuery(normalizedQuery);
  const orderedKeys: Array<keyof ProjectStateSnapshot> = [
    ...preferredKeys,
    "active",
    "decision",
    "todo",
    "next",
    "pending",
    "blocker",
    "risk",
    "recall",
  ];

  const seen = new Set<keyof ProjectStateSnapshot>();
  const lines = [`${snapshot.dateLabel}:`];
  for (const key of orderedKeys) {
    if (key === "dateLabel" || seen.has(key)) {
      continue;
    }
    lines.push(`- ${key}: ${snapshot[key]}`);
    seen.add(key);
  }

  return lines.join("\n");
}

function projectStateKeysForQuery(
  query: string,
): Array<keyof ProjectStateSnapshot> {
  if (/(next|下一步|next action|next step|follow[- ]?up)/i.test(query)) {
    return ["next", "todo", "pending", "active"];
  }
  if (/(blocker|blocked|阻塞|卡点|dependency|risk)/i.test(query)) {
    return ["blocker", "risk", "pending", "todo"];
  }
  if (/(pending|未解决|unresolved|open thread)/i.test(query)) {
    return ["pending", "todo", "next", "active"];
  }
  if (/(decision|决策|why)/i.test(query)) {
    return ["decision", "active", "recall"];
  }
  if (/(status|state|progress|当前状态|项目状态|active|current)/i.test(query)) {
    return ["active", "decision", "todo", "next", "pending"];
  }
  return ["active", "decision", "todo", "next"];
}
