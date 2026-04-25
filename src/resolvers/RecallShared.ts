import {
  AnswerCandidate,
  RawMessage,
} from "../types";

export const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "answer", "are", "around", "as", "at", "about", "after",
  "again", "before", "between", "both", "by", "can", "close", "conversation",
  "could", "current", "did", "does", "do", "earlier", "exact", "for", "from",
  "had", "has", "have", "he", "her", "his", "history", "how", "in", "is",
  "it", "latest", "long", "many", "memory", "multiple", "near", "of", "on",
  "or", "question", "recall", "s", "she", "source", "status", "that", "the",
  "their", "there", "these", "they", "this", "to", "use", "was", "what",
  "when", "where", "which", "while", "who", "why", "with", "would", "you",
  "your",
]);

export const ENTITY_STOP_WORDS = new Set([
  "History", "Recall", "What", "When", "Where", "Which", "Who", "Whom",
  "Whose", "How", "Does", "Did", "Do", "Is", "Are", "The", "A", "An",
  "May", "June", "July", "August", "September", "October", "November",
  "December", "January", "February", "March", "April",
]);

export const MONTH_INDEX: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

export type AnswerType = AnswerCandidate["type"];

export interface DateHint {
  year?: number;
  month?: number;
  day?: number;
}

export interface QueryUnderstanding {
  normalized: string;
  terms: string[];
  entities: string[];
  eventHints: string[];
  choices: string[];
  dateHints: DateHint[];
  answerType: AnswerType;
  historyQa: boolean;
  requiresMultiHop: boolean;
  transcriptLike: boolean;
}

export interface ParsedMessage {
  message: RawMessage;
  sampleId?: string;
  dialogueSession?: string;
  dialogueDate?: string;
  dialogueDateHint?: DateHint;
  diaId?: string;
  speaker?: string;
  utterance: string;
}

export interface ScoredMessage {
  parsed: ParsedMessage;
  score: number;
  reasons: string[];
}

export interface RecallOptions {
  sessionId?: string;
  rawHintMessageIds?: string[];
}

export function parseMessage(message: RawMessage): ParsedMessage {
  const transcript = message.content.match(
    /^(?<source>LoCoMo|LongMemEval)\s+(?<sampleId>[^|]+)\s*\|\s*(?<dialogueSession>[^|]+?)\s+date\s+(?<dialogueDate>[^|]+)\s*\|\s*(?<diaId>[A-Z]\d+:\d+)\s*\|\s*(?<speaker>[^:]+):\s*(?<utterance>[\s\S]*)$/i,
  );
  if (transcript?.groups) {
    return {
      message,
      sampleId: transcript.groups.sampleId.trim(),
      dialogueSession: transcript.groups.dialogueSession.trim(),
      dialogueDate: transcript.groups.dialogueDate.trim(),
      dialogueDateHint: parseDateHint(transcript.groups.dialogueDate),
      diaId: transcript.groups.diaId.trim(),
      speaker: transcript.groups.speaker.trim(),
      utterance: transcript.groups.utterance.trim(),
    };
  }

  const speaker = message.content.match(/^\s*(?<speaker>[A-Z][A-Za-z0-9_-]{1,30})\s*:\s*(?<utterance>[\s\S]+)$/);
  return {
    message,
    speaker: speaker?.groups?.speaker,
    utterance: speaker?.groups?.utterance?.trim() ?? message.content,
  };
}

export function parseDateHint(value?: string): DateHint | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})\b/i);
  if (!match) {
    return undefined;
  }
  return {
    day: Number(match[1]),
    month: MONTH_INDEX[match[2].toLowerCase()],
    year: Number(match[3]),
  };
}

export function dateMatches(left?: DateHint, right?: DateHint): boolean {
  if (!left || !right) {
    return false;
  }
  if (right.year && left.year !== right.year) {
    return false;
  }
  if (right.month && left.month !== right.month) {
    return false;
  }
  if (right.day && left.day !== right.day) {
    return false;
  }
  return true;
}

export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/^history\s+recall\s*:\s*/i, "")
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !QUERY_STOP_WORDS.has(term));
}

export function textHasTerm(text: string, term: string): boolean {
  const lower = text.toLowerCase();
  const termStem = stem(term);
  return lower.includes(term.toLowerCase()) ||
    (termStem.length >= 4 && lower.includes(termStem));
}

export function stem(term: string): string {
  return term
    .toLowerCase()
    .replace(/(?:ing|edly|edly|ed|es|s)$/i, "");
}

export function nameMatches(entity: string, speaker: string): boolean {
  const lower = entity.toLowerCase();
  return speaker === lower || nameAlias(entity).includes(speaker);
}

export function nameAlias(entity: string): string[] {
  const lower = entity.toLowerCase();
  if (lower === "john") return ["john", "jon"];
  if (lower === "jon") return ["jon", "john"];
  if (lower === "melanie") return ["melanie", "mel"];
  if (lower === "caroline") return ["caroline", "caro"];
  if (lower === "joanna") return ["joanna", "jo"];
  return [lower];
}

export function cleanAnswerText(value: string): string {
  return value
    .replace(/^[\s“”"']+|[\s“”"'.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
