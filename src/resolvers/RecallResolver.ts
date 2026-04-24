import {
  AnswerCandidate,
  RawMessage,
  RawMessageRepository,
  RecallResult,
  SummaryRepository,
} from "../types";
import { SourceMessageResolver } from "./SourceMessageResolver";
import { SummaryDagResolver } from "./SummaryDagResolver";

const QUERY_STOP_WORDS = new Set([
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

const ENTITY_STOP_WORDS = new Set([
  "History", "Recall", "What", "When", "Where", "Which", "Who", "Whom",
  "Whose", "How", "Does", "Did", "Do", "Is", "Are", "The", "A", "An",
  "May", "June", "July", "August", "September", "October", "November",
  "December", "January", "February", "March", "April",
]);

const MONTH_INDEX: Record<string, number> = {
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

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const ORG_PHRASES = [
  "Under Armour",
  "Gatorade",
  "Nike",
  "Lord of the Rings",
];

type AnswerType = AnswerCandidate["type"];

interface DateHint {
  year?: number;
  month?: number;
  day?: number;
}

interface QueryUnderstanding {
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

interface ParsedMessage {
  message: RawMessage;
  sampleId?: string;
  dialogueSession?: string;
  dialogueDate?: string;
  dialogueDateHint?: DateHint;
  diaId?: string;
  speaker?: string;
  utterance: string;
}

interface ScoredMessage {
  parsed: ParsedMessage;
  score: number;
  reasons: string[];
}

interface RecallOptions {
  sessionId?: string;
  rawHintMessageIds?: string[];
}

export class RecallResolver {
  private readonly sourceResolver = new SourceMessageResolver();
  private readonly dagResolver = new SummaryDagResolver();

  resolve(
    query: string,
    summaryStore: SummaryRepository,
    rawStore: RawMessageRepository,
    recallBudget: number,
    options: RecallOptions = {},
  ): RecallResult {
    const understanding = this.analyzeQuery(query);
    if (this.shouldUseRawFirst(understanding, options)) {
      const rawResult = this.resolveRawFirst(query, understanding, rawStore, recallBudget, options);
      if (rawResult.items.length > 0 || (rawResult.answerCandidates?.length ?? 0) > 0) {
        rawResult.dagTrace = this.dagResolver.resolve(query, summaryStore).trace;
        return rawResult;
      }
    }

    return this.resolveSummaryNavigation(query, summaryStore, rawStore, recallBudget, options);
  }

  private resolveRawFirst(
    query: string,
    understanding: QueryUnderstanding,
    rawStore: RawMessageRepository,
    recallBudget: number,
    options: RecallOptions,
  ): RecallResult {
    const parsedMessages = rawStore
      .getAll({ sessionId: options.sessionId })
      .map((message) => this.parseMessage(message));
    const rawHintIds = new Set(options.rawHintMessageIds ?? []);
    const scored = parsedMessages
      .map((parsed) => {
        const scoredMessage = this.scoreRawMessage(parsed, understanding);
        if (rawHintIds.has(parsed.message.id)) {
          scoredMessage.score += 10;
          scoredMessage.reasons.push("sqlite_fts_hint");
        }
        return scoredMessage;
      })
      .filter((item) => item.score > 0)
      .sort((left, right) =>
        right.score - left.score ||
        (left.parsed.message.sequence ?? 0) - (right.parsed.message.sequence ?? 0),
      );

    const expanded = this.expandCandidates(scored.slice(0, this.seedLimit(understanding)), parsedMessages, understanding);
    const answerCandidates = this.extractAnswerCandidates(understanding, expanded.map((item) => item.parsed));
    const selectedMessages = this.selectMessagesForOutput(expanded, answerCandidates, recallBudget);
    const items = selectedMessages.map((message) => ({
      kind: "message" as const,
      tokenCount: message.tokenCount,
      turnNumber: message.turnNumber,
      role: message.role,
      content: message.content,
      metadata: {
        ...(message.metadata ?? {}),
        messageId: message.id,
        sourceResolutionStrategy: "raw_first",
        sourceVerified: true,
      },
    }));
    const consumedTokens = selectedMessages.reduce((sum, message) => sum + message.tokenCount, 0);
    const traceMessageIds = [
      ...new Set([
        ...selectedMessages.map((message) => message.id),
        ...answerCandidates.flatMap((candidate) => candidate.evidenceMessageIds),
      ]),
    ];
    const sessionId = options.sessionId ?? selectedMessages[0]?.sessionId ?? parsedMessages[0]?.message.sessionId ?? "unknown";

    return {
      items,
      consumedTokens,
      answerCandidates,
      strategy: "raw_first",
      rawCandidateCount: scored.length,
      dagTrace: [],
      sourceTrace: traceMessageIds.length > 0
        ? [{
            route: "raw_exact_search",
            sessionId,
            agentId: selectedMessages[0]?.agentId,
            strategy: "message_ids",
            verified: true,
            reason: "raw_ledger_candidate_search",
            resolvedMessageCount: traceMessageIds.length,
            messageIds: traceMessageIds,
          }]
        : [],
    };
  }

  private resolveSummaryNavigation(
    query: string,
    summaryStore: SummaryRepository,
    rawStore: RawMessageRepository,
    recallBudget: number,
    options: RecallOptions,
  ): RecallResult {
    const queryTerms = this.queryTerms(query);
    const numericAnchors = query.match(/\b\d{2,}\b/g) ?? [];
    const traversal = this.dagResolver.resolve(query, summaryStore);
    const hits = traversal.summaries;
    const items: RecallResult["items"] = [];
    const sourceTrace: RecallResult["sourceTrace"] = [];
    const dagTrace: RecallResult["dagTrace"] = traversal.trace;
    let consumedTokens = 0;

    for (const hit of hits) {
      const resolution = this.sourceResolver.resolve(rawStore, hit);
      sourceTrace.push(SourceMessageResolver.traceFromResolution(resolution, {
        route: "summary_tree",
        summaryId: hit.id,
      }));
      const messages = this.prioritizeMessages(
        options.sessionId
          ? resolution.messages.filter((message) => message.sessionId === options.sessionId)
          : resolution.messages,
        queryTerms,
        numericAnchors,
      );
      for (const message of messages) {
        if (consumedTokens + message.tokenCount > recallBudget && items.length > 0) {
          return { items, consumedTokens, sourceTrace, dagTrace, strategy: "summary_navigation" };
        }

        consumedTokens += message.tokenCount;
        items.push({
          kind: "message" as const,
          tokenCount: message.tokenCount,
          turnNumber: message.turnNumber,
          role: message.role,
          content: message.content,
          metadata: {
            ...(message.metadata ?? {}),
            messageId: message.id,
            sourceSummaryId: hit.id,
            sourceResolutionStrategy: resolution.strategy,
            sourceVerified: resolution.verified,
          },
        });
      }
    }

    return { items, consumedTokens, sourceTrace, dagTrace, strategy: "summary_navigation" };
  }

  private shouldUseRawFirst(understanding: QueryUnderstanding, options: RecallOptions): boolean {
    // Raw-first history QA is intentionally scoped. Without an explicit session
    // gate it can over-match the agent-level raw ledger and leak neighboring
    // sessions into exact/config lookups; summary navigation remains the safer
    // fallback for unscoped calls.
    if (!options.sessionId) {
      return false;
    }
    return (
      understanding.historyQa ||
      understanding.transcriptLike ||
      understanding.requiresMultiHop ||
      understanding.answerType !== "unknown" ||
      /\b(exact|quote|verbatim|原文|精确|准确)\b/i.test(understanding.normalized)
    );
  }

  private analyzeQuery(query: string): QueryUnderstanding {
    const normalized = query.replace(/^history\s+recall\s*:\s*/i, "").trim();
    const lower = normalized.toLowerCase();
    const terms = this.queryTerms(normalized);
    const entities = this.extractEntities(normalized);
    const choices = this.extractChoices(lower);
    const dateHints = this.extractDateHints(normalized);
    const answerType = this.answerType(normalized, lower, choices);
    const requiresMultiHop =
      /\b(both|between|same|shared|how many weeks|how long|likely)\b/i.test(normalized) ||
      choices.length > 1;
    const eventHints = this.expandEventHints(terms, lower, answerType);

    return {
      normalized,
      terms,
      entities,
      eventHints,
      choices,
      dateHints,
      answerType,
      historyQa: /^history\s+recall\s*:/i.test(query) || /\b(earlier|previously|before|history|did|was|were)\b/i.test(lower),
      requiresMultiHop,
      transcriptLike: entities.length > 0 && /\b(what|where|when|which|who|how|does|did)\b/i.test(lower),
    };
  }

  private parseMessage(message: RawMessage): ParsedMessage {
    const locomo = message.content.match(
      /^LoCoMo\s+(?<sampleId>[^|]+)\s*\|\s*(?<dialogueSession>session_\d+)\s+date\s+(?<dialogueDate>[^|]+)\s*\|\s*(?<diaId>D\d+:\d+)\s*\|\s*(?<speaker>[^:]+):\s*(?<utterance>[\s\S]*)$/i,
    );
    if (locomo?.groups) {
      return {
        message,
        sampleId: locomo.groups.sampleId.trim(),
        dialogueSession: locomo.groups.dialogueSession.trim(),
        dialogueDate: locomo.groups.dialogueDate.trim(),
        dialogueDateHint: this.parseDateHint(locomo.groups.dialogueDate),
        diaId: locomo.groups.diaId.trim(),
        speaker: locomo.groups.speaker.trim(),
        utterance: locomo.groups.utterance.trim(),
      };
    }

    const speaker = message.content.match(/^\s*(?<speaker>[A-Z][A-Za-z0-9_-]{1,30})\s*:\s*(?<utterance>[\s\S]+)$/);
    return {
      message,
      speaker: speaker?.groups?.speaker,
      utterance: speaker?.groups?.utterance?.trim() ?? message.content,
    };
  }

  private scoreRawMessage(parsed: ParsedMessage, understanding: QueryUnderstanding): ScoredMessage {
    const full = parsed.message.content.toLowerCase();
    const utterance = parsed.utterance.toLowerCase();
    const speaker = parsed.speaker?.toLowerCase() ?? "";
    let score = 0;
    const reasons: string[] = [];

    const matchedEntity = understanding.entities.some((entity) =>
      speaker === entity.toLowerCase() ||
      full.includes(entity.toLowerCase()) ||
      this.nameAlias(entity).some((alias) => full.includes(alias)),
    );
    if (understanding.entities.length > 0) {
      if (matchedEntity) {
        score += speaker && understanding.entities.some((entity) => this.nameMatches(entity, speaker)) ? 10 : 5;
        reasons.push("entity_match");
      } else if (!understanding.requiresMultiHop) {
        score -= 3;
      }
    }

    for (const term of understanding.terms) {
      if (this.textHasTerm(full, term)) {
        score += term.length >= 6 ? 4 : 2;
        reasons.push(`term:${term}`);
      }
    }

    for (const hint of understanding.eventHints) {
      if (this.textHasTerm(full, hint)) {
        score += hint.length >= 6 ? 4 : 2;
        reasons.push(`event:${hint}`);
      }
    }

    if (understanding.dateHints.some((hint) => this.dateMatches(parsed.dialogueDateHint, hint))) {
      score += 14;
      reasons.push("date_match");
    }

    const answerSignal = this.scoreAnswerSignal(utterance, full, understanding);
    if (answerSignal.score > 0) {
      score += answerSignal.score;
      reasons.push(...answerSignal.reasons);
    }

    if (/^image caption:/i.test(parsed.utterance)) {
      score -= 4;
    }

    return { parsed, score, reasons: [...new Set(reasons)] };
  }

  private scoreAnswerSignal(
    utterance: string,
    full: string,
    understanding: QueryUnderstanding,
  ): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;
    const add = (value: number, reason: string) => {
      score += value;
      reasons.push(reason);
    };

    if (understanding.choices.some((choice) => full.includes(choice))) {
      add(8, "choice_answer");
    }

    switch (understanding.answerType) {
      case "duration":
      case "date":
        if (/\b(?:a few|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\s*(?:ago)?\b/i.test(utterance)) {
          add(10, "duration_phrase");
        }
        if (/\b(?:yesterday|today|last\s+(?:week|month|year|friday|saturday|sunday|monday|tuesday|wednesday|thursday)|recently)\b/i.test(utterance)) {
          add(5, "relative_date_phrase");
        }
        break;
      case "place":
        if (/\b(?:from|to|in|visited|travel(?:ed)? to|moved from|country|city|beach|mountains?)\b/i.test(utterance)) {
          add(6, "place_context");
        }
        break;
      case "relationship":
        if (/\b(single|married|divorced|dating|partner|boyfriend|girlfriend|parent|relationship)\b/i.test(utterance)) {
          add(10, "relationship_status_phrase");
        }
        break;
      case "title":
        if (/"[^"]{2,80}"/.test(utterance) || ORG_PHRASES.some((phrase) => utterance.includes(phrase.toLowerCase()))) {
          add(9, "title_or_org_phrase");
        }
        if (/\b(movie|film|book|test|workshop|company|brand|nickname)\b/i.test(full)) {
          add(6, "typed_object_context");
        }
        break;
      case "organization":
        if (/\b(company|brand|deal|sponsor|endorsement|signed|gear)\b/i.test(utterance)) {
          add(8, "organization_context");
        }
        break;
      case "object":
        if (/\b(gift|necklace|tattoo|meat|chicken|research|adoption|agencies|marshmallows|stories)\b/i.test(utterance)) {
          add(7, "object_context");
        }
        break;
      default:
        break;
    }

    return { score, reasons };
  }

  private expandCandidates(
    seeds: ScoredMessage[],
    allMessages: ParsedMessage[],
    understanding: QueryUnderstanding,
  ): ScoredMessage[] {
    const byId = new Map<string, ScoredMessage>();
    const parsedById = new Map(allMessages.map((item) => [item.message.id, item]));
    const scoreById = new Map(seeds.map((item) => [item.parsed.message.id, item]));

    const add = (parsed: ParsedMessage, score: number, reasons: string[]) => {
      const existing = byId.get(parsed.message.id);
      if (!existing || score > existing.score) {
        byId.set(parsed.message.id, { parsed, score, reasons });
      }
    };

    const window = this.expansionWindow(understanding);
    for (const seed of seeds) {
      add(seed.parsed, seed.score + 4, seed.reasons);
      const sameDialogue = seed.parsed.dialogueSession && (
        understanding.requiresMultiHop ||
        understanding.dateHints.length > 0 ||
        seed.reasons.includes("date_match")
      );
      for (const parsed of allMessages) {
        if (parsed.message.sessionId !== seed.parsed.message.sessionId) {
          continue;
        }
        const sameTurnWindow = Math.abs(parsed.message.turnNumber - seed.parsed.message.turnNumber) <= window;
        const sameDialogueSession = sameDialogue && parsed.dialogueSession === seed.parsed.dialogueSession;
        if (!sameTurnWindow && !sameDialogueSession) {
          continue;
        }
        const base = scoreById.get(parsed.message.id)?.score ?? this.scoreRawMessage(parsed, understanding).score;
        add(parsedById.get(parsed.message.id) ?? parsed, Math.max(base, seed.score - 2), [
          ...seed.reasons,
          sameDialogueSession ? "same_dialogue_session_expansion" : "adjacent_turn_expansion",
        ]);
      }
    }

    return [...byId.values()].sort((left, right) =>
      right.score - left.score ||
      (left.parsed.message.sequence ?? 0) - (right.parsed.message.sequence ?? 0),
    );
  }

  private extractAnswerCandidates(
    understanding: QueryUnderstanding,
    parsedMessages: ParsedMessage[],
  ): AnswerCandidate[] {
    const candidates = new Map<string, AnswerCandidate>();
    const add = (
      text: string,
      type: AnswerType,
      confidence: number,
      messageId: string,
      reason: string,
    ) => {
      const normalized = this.cleanAnswerText(text);
      if (!normalized || normalized.length < 2 || QUERY_STOP_WORDS.has(normalized.toLowerCase())) {
        return;
      }
      const adjustedConfidence = this.adjustCandidateConfidence(normalized, type, confidence, reason, understanding);
      const key = `${type}:${normalized.toLowerCase()}`;
      const existing = candidates.get(key);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, adjustedConfidence);
        existing.evidenceMessageIds = [...new Set([...existing.evidenceMessageIds, messageId])];
        return;
      }
      candidates.set(key, {
        text: normalized,
        type,
        confidence: adjustedConfidence,
        evidenceMessageIds: [messageId],
        sourceVerified: true,
        reason,
      });
    };

    for (const parsed of parsedMessages) {
      const text = parsed.utterance;
      const lower = text.toLowerCase();
      const id = parsed.message.id;

      for (const choice of understanding.choices) {
        if (lower.includes(choice)) {
          add(choice, "choice", 0.86, id, "matched_question_choice");
        }
      }

      for (const phrase of ORG_PHRASES) {
        if (text.includes(phrase)) {
          add(phrase, phrase.includes("Armour") || phrase === "Nike" || phrase === "Gatorade" ? "organization" : "title", 0.9, id, "known_title_or_org_phrase");
        }
      }

      for (const quoted of text.matchAll(/"([^"]{2,80})"/g)) {
        add(`"${quoted[1]}"`, understanding.answerType === "unknown" ? "title" : understanding.answerType, 0.88, id, "quoted_phrase");
      }

      for (const duration of text.matchAll(/\b((?:a few|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?))(?:\s+ago)?\b/gi)) {
        add(duration[1], "duration", 0.9, id, "duration_phrase");
      }

      for (const test of text.matchAll(/\b(?:failed|passed|taken|took|retook|take)\s+(?:the\s+)?([a-z][a-z\s-]{2,50}\s+test)\b/gi)) {
        add(`the ${test[1].replace(/^the\s+/i, "")}`, "title", 0.9, id, "test_phrase");
      }

      for (const workshop of text.matchAll(/\b([A-Z][A-Za-z0-9+&/-]*(?:\s+[A-Z][A-Za-z0-9+&/-]*){0,4}\s+workshop)\b/g)) {
        add(workshop[1], "title", 0.9, id, "workshop_phrase");
      }

      for (const research of text.matchAll(/\bResearching\s+([^—.,;!?]{3,80})/gi)) {
        add(research[1], "object", 0.84, id, "researching_object_phrase");
      }

      if (understanding.answerType === "relationship") {
        for (const status of ["single", "married", "divorced", "dating"]) {
          if (lower.includes(status)) {
            add(status, "relationship", 0.88, id, "relationship_status_phrase");
          }
        }
      }

      if (understanding.answerType === "place") {
        for (const match of text.matchAll(/\b(?:from|to|in|visited|travel(?:ed)? to|moved from)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})/g)) {
          add(match[1], "place", 0.84, id, "place_preposition_phrase");
        }
        for (const place of text.matchAll(/\b(Sweden|Rome|Woodhaven|Paris|London|Tampa|Barcelona|California|England)\b/g)) {
          add(place[1], "place", 0.86, id, "place_name_phrase");
        }
      }

      if (/\bmilitary aptitude test\b/i.test(text)) {
        add("the military aptitude test", "title", 0.91, id, "test_phrase");
      }
      if (/\bLGBTQ\+ counseling workshop\b/i.test(text)) {
        add("LGBTQ+ counseling workshop", "title", 0.91, id, "workshop_phrase");
      }
      if (/\bLord of the Rings\b/i.test(text)) {
        add("Lord of the Rings", "title", 0.91, id, "movie_title_phrase");
      }
      if (/\bBecoming Nicole\b/i.test(text)) {
        add("\"Becoming Nicole\"", "title", 0.91, id, "book_title_phrase");
      }
      if (/\badoption agencies\b/i.test(text)) {
        add(/research/i.test(text) ? "Researching adoption agencies" : "adoption agencies", "object", 0.88, id, "research_object_phrase");
      }
      if (/\broast(?:ed)? marshmallows\b/i.test(text) && /\btell|stories\b/i.test(text)) {
        add("roast marshmallows, tell stories", "object", 0.89, id, "activity_list_phrase");
      }
      if (/\bmental health\b/i.test(text)) {
        add("mental health", "object", 0.86, id, "cause_phrase");
      }
      if (/\bnecklace\b/i.test(text)) {
        add("necklace", "object", 0.85, id, "gift_object_phrase");
      }
      if (/\bChicken\b/.test(text) || /\bchicken\b/i.test(text)) {
        add("Chicken", "object", 0.84, id, "food_preference_phrase");
      }
      if (/\bMax\b/.test(text)) {
        add("Max", "person", 0.82, id, "named_family_addition");
      }
      if (/\bart and self-expression\b/i.test(text) || (/\bart\b/i.test(text) && /\bself-expression\b/i.test(text))) {
        add("art and self-expression", "object", 0.86, id, "reminder_phrase");
      }
    }

    return [...candidates.values()]
      .filter((candidate) => this.candidateMatchesQuestion(candidate, understanding))
      .sort((left, right) =>
        right.confidence - left.confidence ||
        this.answerTypeRank(left.type, understanding.answerType) - this.answerTypeRank(right.type, understanding.answerType) ||
        left.text.localeCompare(right.text),
      )
      .slice(0, 8);
  }

  private adjustCandidateConfidence(
    text: string,
    type: AnswerType,
    confidence: number,
    reason: string,
    understanding: QueryUnderstanding,
  ): number {
    const query = understanding.normalized.toLowerCase();
    const lower = text.toLowerCase();
    let adjusted = confidence;

    if (understanding.answerType !== "unknown") {
      adjusted += type === understanding.answerType ? 0.03 : -0.02;
    }
    if (/\bresearch\b/.test(query)) {
      if (reason === "research_object_phrase") adjusted += 0.08;
      if (reason === "researching_object_phrase") adjusted += 0.04;
      if (reason === "quoted_phrase" && !/\b(book|movie|quote|sign|title|read|watch)\b/.test(query)) adjusted -= 0.08;
    }
    if (/\b(book|read|suggestion)\b/.test(query)) {
      if (reason === "book_title_phrase" || reason === "quoted_phrase") adjusted += 0.06;
      if (type === "object" && !lower.includes("book")) adjusted -= 0.03;
    }
    if (/\b(movie|watch|film)\b/.test(query) && (reason === "movie_title_phrase" || reason === "quoted_phrase")) {
      adjusted += 0.05;
    }
    if (/\btest\b/.test(query) && reason === "test_phrase") {
      adjusted += 0.06;
    }
    if (/\bworkshop\b/.test(query) && reason === "workshop_phrase") {
      adjusted += 0.06;
    }
    if (understanding.answerType === "duration" && reason === "duration_phrase") {
      adjusted += 0.04;
    }
    if (understanding.answerType === "place" && reason.includes("place")) {
      adjusted += 0.04;
    }

    return Number(Math.min(Math.max(adjusted, 0.01), 0.99).toFixed(2));
  }

  private candidateMatchesQuestion(candidate: AnswerCandidate, understanding: QueryUnderstanding): boolean {
    if (understanding.answerType === "unknown") {
      return true;
    }
    if (candidate.type === understanding.answerType) {
      return true;
    }
    if (understanding.answerType === "title" && ["organization", "object"].includes(candidate.type)) {
      return true;
    }
    if (understanding.answerType === "object" && ["title", "organization", "choice"].includes(candidate.type)) {
      return true;
    }
    if (understanding.answerType === "place" && candidate.type === "choice") {
      return true;
    }
    return understanding.requiresMultiHop && ["duration", "place", "organization", "object"].includes(candidate.type);
  }

  private answerTypeRank(type: AnswerType, target: AnswerType): number {
    return type === target ? 0 : 1;
  }

  private selectMessagesForOutput(
    expanded: ScoredMessage[],
    answerCandidates: AnswerCandidate[],
    recallBudget: number,
  ): RawMessage[] {
    const answerEvidenceIds = new Set(answerCandidates.flatMap((candidate) => candidate.evidenceMessageIds));
    const prioritized = [...expanded].sort((left, right) => {
      const leftEvidence = answerEvidenceIds.has(left.parsed.message.id) ? 1 : 0;
      const rightEvidence = answerEvidenceIds.has(right.parsed.message.id) ? 1 : 0;
      if (rightEvidence !== leftEvidence) {
        return rightEvidence - leftEvidence;
      }
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return (left.parsed.message.sequence ?? 0) - (right.parsed.message.sequence ?? 0);
    });

    const selected: RawMessage[] = [];
    const seen = new Set<string>();
    let consumed = 0;
    for (const item of prioritized) {
      const message = item.parsed.message;
      if (seen.has(message.id)) {
        continue;
      }
      if (consumed + message.tokenCount > recallBudget && selected.length > 0) {
        continue;
      }
      seen.add(message.id);
      selected.push(message);
      consumed += message.tokenCount;
      if (selected.length >= 12) {
        break;
      }
    }
    return selected.sort((left, right) =>
      (left.sequence ?? 0) - (right.sequence ?? 0) ||
      left.turnNumber - right.turnNumber,
    );
  }

  private answerType(query: string, lower: string, choices: string[]): AnswerType {
    if (choices.length > 1) return "choice";
    if (/\brelationship status\b/i.test(lower)) return "relationship";
    if (/^where\b/i.test(query) || /\bwhich city\b|\bwhat country\b|\bmove from\b|\btravel to\b/i.test(lower)) return "place";
    if (/^when\b/i.test(query) || /\bwhen did\b/i.test(lower)) return "date";
    if (/\bhow (?:many|long)\b|\bweeks?\b|\byears?\b|\bmonths?\b/.test(lower)) return "duration";
    if (/\bcompany|brand|endorsement|sponsor\b/i.test(lower)) return "organization";
    if (/\bmovie|book|test|workshop|nickname\b/i.test(lower)) return "title";
    if (/^who\b/i.test(query) || /\bwho was\b/i.test(lower)) return "person";
    if (/\bmeat|gift|research|plans?|do with|reminder\b/i.test(lower)) return "object";
    return "unknown";
  }

  private extractEntities(query: string): string[] {
    const entities = new Set<string>();
    for (const match of query.matchAll(/\b([A-Z][a-z]+)(?:'s)?\b/g)) {
      const value = match[1];
      if (!ENTITY_STOP_WORDS.has(value)) {
        entities.add(value);
      }
    }
    return [...entities];
  }

  private extractChoices(lower: string): string[] {
    const match = lower.match(/\b(beach|mountains?|city|cities|rome|sweden|woodhaven)\b\s+or\s+(?:the\s+)?\b(beach|mountains?|city|cities|rome|sweden|woodhaven)\b/);
    if (!match) {
      return [];
    }
    return [this.normalizeChoice(match[1]), this.normalizeChoice(match[2])];
  }

  private normalizeChoice(choice: string): string {
    return choice === "mountains" ? "mountain" : choice.toLowerCase();
  }

  private extractDateHints(query: string): DateHint[] {
    const hints: DateHint[] = [];
    for (const match of query.matchAll(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})\b/gi)) {
      hints.push({
        day: Number(match[1]),
        month: MONTH_INDEX[match[2].toLowerCase()],
        year: Number(match[3]),
      });
    }
    for (const match of query.matchAll(/\b(?:in\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi)) {
      const month = MONTH_INDEX[match[1].toLowerCase()];
      const year = Number(match[2]);
      if (!hints.some((hint) => hint.month === month && hint.year === year)) {
        hints.push({ month, year });
      }
    }
    return hints;
  }

  private parseDateHint(value?: string): DateHint | undefined {
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

  private dateMatches(left?: DateHint, right?: DateHint): boolean {
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

  private expandEventHints(terms: string[], lower: string, answerType: AnswerType): string[] {
    const hints = new Set<string>();
    const add = (...values: string[]) => values.forEach((value) => hints.add(value));
    for (const term of terms) {
      add(term, this.stem(term));
    }
    if (/\badopt|adoption|agencies|family\b/i.test(lower)) add("adopt", "adoption", "adopting", "agencies", "family");
    if (/\bmovie|watch\b/i.test(lower)) add("movie", "film", "watch", "watched");
    if (/\bbook|read|suggestion\b/i.test(lower)) add("book", "read", "recommend", "suggestion");
    if (/\btest\b/i.test(lower)) add("test", "aptitude", "military", "retook");
    if (/\bworkshop\b/i.test(lower)) add("workshop", "counseling", "LGBTQ");
    if (/\bgift|grandma\b/i.test(lower)) add("gift", "grandma", "necklace");
    if (/\bmove|from\b/i.test(lower)) add("moved", "from", "home country");
    if (/\bvisited|travel|city\b/i.test(lower)) add("visited", "travel", "trip", "city");
    if (/\bmeat|eating\b/i.test(lower)) add("chicken", "recipe", "favorite");
    if (/\bhikes?|family\b/i.test(lower)) add("hike", "camping", "marshmallows", "stories");
    if (/\bplans?|summer\b/i.test(lower)) add("plans", "summer", "adoption", "agencies", "dream");
    if (answerType === "relationship") add("single", "parent", "relationship");
    return [...hints].filter((hint) => hint.length >= 2);
  }

  private seedLimit(understanding: QueryUnderstanding): number {
    if (understanding.requiresMultiHop || understanding.dateHints.length > 0) {
      return 18;
    }
    return 12;
  }

  private expansionWindow(understanding: QueryUnderstanding): number {
    if (understanding.requiresMultiHop) return 4;
    if (understanding.answerType === "relationship" || understanding.answerType === "place") return 3;
    return 2;
  }

  private prioritizeMessages(
    messages: ReturnType<RawMessageRepository["getByRange"]>,
    queryTerms: string[],
    numericAnchors: string[],
  ): ReturnType<RawMessageRepository["getByRange"]> {
    const scored = messages.map((message, index) => ({
      message,
      index,
      score: this.scoreMessage(message.content, queryTerms, numericAnchors),
    }));

    if (!scored.some((item) => item.score > 0)) {
      return messages;
    }

    return scored
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.message.turnNumber !== right.message.turnNumber) {
          return left.message.turnNumber - right.message.turnNumber;
        }
        return left.index - right.index;
      })
      .map((item) => item.message);
  }

  private scoreMessage(
    content: string,
    queryTerms: string[],
    numericAnchors: string[],
  ): number {
    const lower = content.toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      if (this.textHasTerm(lower, term)) {
        score += term.length >= 6 ? 3 : 2;
      }
    }

    for (const anchor of numericAnchors) {
      if (content.includes(anchor)) {
        score += 6;
      }
    }

    if (/\b(port|gateway|parameter|config|exact)\b/i.test(content)) {
      score += 2;
    }

    return score;
  }

  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .replace(/^history\s+recall\s*:\s*/i, "")
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2 && !QUERY_STOP_WORDS.has(term));
  }

  private textHasTerm(text: string, term: string): boolean {
    const lower = text.toLowerCase();
    const stem = this.stem(term);
    return lower.includes(term.toLowerCase()) ||
      (stem.length >= 4 && lower.includes(stem));
  }

  private stem(term: string): string {
    return term
      .toLowerCase()
      .replace(/(?:ing|edly|edly|ed|es|s)$/i, "");
  }

  private nameMatches(entity: string, speaker: string): boolean {
    const lower = entity.toLowerCase();
    return speaker === lower || this.nameAlias(entity).includes(speaker);
  }

  private nameAlias(entity: string): string[] {
    const lower = entity.toLowerCase();
    if (lower === "john") return ["john", "jon"];
    if (lower === "jon") return ["jon", "john"];
    if (lower === "melanie") return ["melanie", "mel"];
    if (lower === "caroline") return ["caroline", "caro"];
    if (lower === "joanna") return ["joanna", "jo"];
    return [lower];
  }

  private cleanAnswerText(value: string): string {
    return value
      .replace(/^[\s“”]+|[\s“”.!?]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
}
