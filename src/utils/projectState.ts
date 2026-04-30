import {
  ProjectStateSnapshot,
  RawMessageRepository,
  SummaryRepository,
} from "../types";
import {
  deriveProjectIdentityFromMessages,
  deriveProjectIdentityFromSummary,
  deriveProjectIdentityFromSnapshot,
  deriveProjectStatusFromSnapshot,
} from "./projectIdentity";

const LINE_RE = /^-\s*([a-z_ ]+):\s*(.+)$/i;
const DEFAULT_NONE = "none recorded";
const PROJECT_STATE_HEADER = "# chaunyoms-project-state:v2";

function truncate(input: string, maxChars = 120): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function buildProjectStateSnapshot(
  rawStore: RawMessageRepository,
  summaryStore: SummaryRepository,
  now = new Date(),
): ProjectStateSnapshot {
  const latestMessages = rawStore.getAll().filter((message) => message.compacted).slice(-12);
  const latestSummary = summaryStore.getAllSummaries().at(-1);
  const summaryText = latestSummary?.summary ?? "";
  const summaryDecision = latestSummary?.decisions?.[0] ?? summaryText;
  const summaryNext = latestSummary?.nextSteps?.[0] ?? summaryText;
  const summaryBlocker = latestSummary?.blockers?.[0] ?? DEFAULT_NONE;
  const compactedLatestUser = [...latestMessages].reverse().find((item) => item.role === "user")?.content;
  const compactedLatestAssistant =
    [...latestMessages]
      .reverse()
      .find((item) => item.role === "assistant")
      ?.content;
  const compactedBlocker =
    [...latestMessages]
      .reverse()
      .find((item) =>
        /(blocker|blocked|error|fail|issue|risk|阻塞|卡住|失败|报错)/i.test(item.content),
      )
      ?.content;
  const latestUser = summaryText
    ? `summary:${latestSummary?.id ?? "latest"} ${summaryText}`
    : compactedLatestUser ?? "(none)";
  const latestAssistant = summaryDecision
    ? `summary:${latestSummary?.id ?? "latest"} ${summaryDecision}`
    : compactedLatestAssistant ?? "(none)";
  const blocker = summaryBlocker !== DEFAULT_NONE
    ? summaryBlocker
    : compactedBlocker ?? DEFAULT_NONE;

  const dateLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const active = latestUser !== "(none)" ? latestUser : "no active user thread recorded";
  const decision =
    latestAssistant !== "(none)"
      ? latestAssistant
      : "no recent assistant decision recorded";
  const todo = "review follow-up actions from latest turn";
  const next = summaryNext ||
    (latestAssistant !== "(none)"
      ? latestAssistant
      : "continue the active thread from the latest user request");
  const pending =
    latestUser !== "(none)"
      ? latestUser
      : "review outstanding work from the latest session";
  const risk =
    blocker === DEFAULT_NONE ? DEFAULT_NONE : "latest blocker needs follow-up";
  const preliminary = {
    schemaVersion: 2 as const,
    dateLabel,
    active: truncate(active),
    decision: truncate(decision),
    todo: truncate(todo),
    next: truncate(next),
    pending: truncate(pending),
    blocker: truncate(blocker),
    risk: truncate(risk),
    recall: latestSummary
      ? `summary:${latestSummary.id} messages ${latestSummary.sourceFirstMessageId ?? "unknown"}..${latestSummary.sourceLastMessageId ?? "unknown"}`
      : "none",
    projectId: "",
    projectTitle: "",
    projectStatus: "active" as const,
  };
  const projectIdentity = latestSummary
    ? deriveProjectIdentityFromSummary(latestSummary, dateLabel)
    : deriveProjectIdentityFromMessages(latestMessages, dateLabel);
  return {
    ...preliminary,
    projectId: projectIdentity.projectId,
    projectTitle: truncate(projectIdentity.title, 72),
    projectStatus: deriveProjectStatusFromSnapshot(preliminary),
  };
}

export function formatProjectStateSnapshot(
  snapshot: ProjectStateSnapshot,
): string {
  return [
    PROJECT_STATE_HEADER,
    `${snapshot.dateLabel}:`,
    `- project_id: ${snapshot.projectId}`,
    `- project_title: ${snapshot.projectTitle}`,
    `- project_status: ${snapshot.projectStatus}`,
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

  const dataLines =
    lines[0].toLowerCase().startsWith("# chaunyoms-project-state") ? lines.slice(1) : lines;
  if (dataLines.length === 0) {
    return null;
  }

  const dateLabel = dataLines[0].replace(/:$/, "").trim();
  const fields = new Map<string, string>();
  for (const line of dataLines.slice(1)) {
    const match = line.match(LINE_RE);
    if (!match) {
      continue;
    }
    fields.set(match[1].trim().toLowerCase(), match[2].trim());
  }

  if (fields.size === 0) {
    return null;
  }

  const snapshot: ProjectStateSnapshot = {
    schemaVersion: 2,
    dateLabel,
    projectId: fields.get("project_id") ?? "",
    projectTitle: fields.get("project_title") ?? DEFAULT_NONE,
    projectStatus: normalizeProjectStatus(fields.get("project_status")),
    active: fields.get("active") ?? DEFAULT_NONE,
    decision: fields.get("decision") ?? DEFAULT_NONE,
    todo: fields.get("todo") ?? DEFAULT_NONE,
    next: fields.get("next") ?? DEFAULT_NONE,
    pending: fields.get("pending") ?? DEFAULT_NONE,
    blocker: fields.get("blocker") ?? DEFAULT_NONE,
    risk: fields.get("risk") ?? DEFAULT_NONE,
    recall: fields.get("recall") ?? "none",
  };

  if (!snapshot.projectId) {
    const identity = deriveProjectIdentityFromSnapshot(snapshot, snapshot.dateLabel);
    snapshot.projectId = identity.projectId;
    snapshot.projectTitle = identity.title;
  }
  return snapshot;
}

export function prioritizeProjectStateSnapshot(
  snapshot: ProjectStateSnapshot,
  query: string,
): string {
  const normalizedQuery = query.toLowerCase();
  const preferredKeys = projectStateKeysForQuery(normalizedQuery);
  const orderedKeys: Array<keyof ProjectStateSnapshot> = [
    ...preferredKeys,
    "projectTitle",
    "projectStatus",
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
  const lines = [PROJECT_STATE_HEADER, `${snapshot.dateLabel}:`, `- project_id: ${snapshot.projectId}`];
  for (const key of orderedKeys) {
    if (
      key === "dateLabel" ||
      key === "schemaVersion" ||
      key === "projectId" ||
      seen.has(key)
    ) {
      continue;
    }
    const label = camelToSnake(key);
    lines.push(`- ${label}: ${snapshot[key]}`);
    seen.add(key);
  }

  return lines.join("\n");
}

function normalizeProjectStatus(value?: string): ProjectStateSnapshot["projectStatus"] {
  if (value === "blocked" || value === "planned" || value === "archived") {
    return value;
  }
  return "active";
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
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
    return ["projectStatus", "projectTitle", "active", "decision", "todo", "next", "pending"];
  }
  return ["projectTitle", "active", "decision", "todo", "next"];
}
