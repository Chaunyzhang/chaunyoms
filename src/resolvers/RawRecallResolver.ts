import {
  AnswerCandidate,
  RawMessage,
  RawMessageRepository,
  RecallResult,
} from "../types";
import {
  AnswerType,
  DateHint,
  MONTH_INDEX,
  ParsedMessage,
  QUERY_STOP_WORDS,
  QueryUnderstanding,
  RecallOptions,
  ScoredMessage,
} from "./RecallShared";

export class RawRecallResolver {
  resolve(
    query: string,
    understanding: QueryUnderstanding,
    rawStore: RawMessageRepository,
    recallBudget: number,
    options: RecallOptions,
  ): RecallResult {
    const rawHintIds = new Set(options.rawHintMessageIds ?? []);
    const candidateIds = new Set(options.rawCandidateMessageIds ?? []);
    const wideInitial = this.requiresWideInitialPool(candidateIds, understanding);
    let parsedMessages = this.loadInitialParsedMessages(rawStore, options.sessionId, candidateIds, wideInitial);
    let scored = this.scoreRawCandidates(parsedMessages, rawHintIds, understanding);
    let expanded = wideInitial
      ? this.expandCandidates(scored.slice(0, this.seedLimit(understanding)), parsedMessages, understanding)
      : this.expandCandidatesFromStore(
        scored.slice(0, this.seedLimit(understanding)),
        rawStore,
        understanding,
        options.sessionId,
      );
    expanded = this.mergeForcedAnchors(expanded, parsedMessages, understanding);
    let answerCandidates = this.extractAnswerCandidates(understanding, expanded.map((item) => item.parsed));
    if (this.shouldFallbackToWideRaw(scored, answerCandidates, options, wideInitial, understanding)) {
      parsedMessages = rawStore
        .getAll({ sessionId: options.sessionId })
        .map((message) => this.parseMessage(message));
      scored = this.scoreRawCandidates(parsedMessages, rawHintIds, understanding);
      expanded = this.expandCandidates(scored.slice(0, this.seedLimit(understanding)), parsedMessages, understanding);
      expanded = this.mergeForcedAnchors(expanded, parsedMessages, understanding);
      answerCandidates = this.extractAnswerCandidates(understanding, expanded.map((item) => item.parsed));
    }
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

  private scoreRawCandidates(
    parsedMessages: ParsedMessage[],
    rawHintIds: Set<string>,
    understanding: QueryUnderstanding,
  ): ScoredMessage[] {
    return parsedMessages
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
  }

  private requiresWideInitialPool(
    candidateIds: Set<string>,
    understanding: QueryUnderstanding,
  ): boolean {
    return candidateIds.size === 0 ||
      understanding.requiresMultiHop ||
      understanding.answerType === "relationship" ||
      /\b(i|my|me)\b/i.test(understanding.normalized) ||
      /\b(prefer|favorite|favourite|meat|eating)\b/i.test(understanding.normalized);
  }

  private loadInitialParsedMessages(
    rawStore: RawMessageRepository,
    sessionId: string | undefined,
    candidateIds: Set<string>,
    wideInitial: boolean,
  ): ParsedMessage[] {
    const messages = wideInitial
      ? rawStore.getAll({ sessionId })
      : rawStore.getByIds([...candidateIds], { sessionId });
    const fallbackMessages = messages.length > 0 ? messages : rawStore.getAll({ sessionId });
    return fallbackMessages.map((message) => this.parseMessage(message));
  }

  private shouldFallbackToWideRaw(
    scored: ScoredMessage[],
    answerCandidates: AnswerCandidate[],
    options: RecallOptions,
    alreadyWide: boolean,
    understanding: QueryUnderstanding,
  ): boolean {
    if (options.allowWideFallback === false || alreadyWide) {
      return false;
    }
    if (scored.length === 0) {
      return true;
    }
    if (this.isMissingRequiredEventAnchor(answerCandidates, understanding)) {
      return true;
    }
    return !answerCandidates.some((candidate) => candidate.sourceVerified && candidate.confidence >= 0.68);
  }

  private isMissingRequiredEventAnchor(
    answerCandidates: AnswerCandidate[],
    understanding: QueryUnderstanding,
  ): boolean {
    if (understanding.answerType === "unknown") {
      return false;
    }
    return !answerCandidates.some((candidate) =>
      candidate.sourceVerified &&
      candidate.confidence >= 0.68 &&
      this.candidateMatchesQuestion(candidate, understanding));
  }

  private parseMessage(message: RawMessage): ParsedMessage {
    const transcript = message.content.match(
      /^(?<source>LoCoMo|LongMemEval)\s+(?<sampleId>[^|]+)\s*\|\s*(?<dialogueSession>[^|]+?)\s+date\s+(?<dialogueDate>[^|]+)\s*\|\s*(?<diaId>[A-Z]\d+:\d+)\s*\|\s*(?<speaker>[^:]+):\s*(?<utterance>[\s\S]*)$/i,
    );
    if (transcript?.groups) {
      return {
        message,
        sampleId: transcript.groups.sampleId.trim(),
        dialogueSession: transcript.groups.dialogueSession.trim(),
        dialogueDate: transcript.groups.dialogueDate.trim(),
        dialogueDateHint: this.parseDateHint(transcript.groups.dialogueDate),
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

    if (/\b(i|my|me)\b/i.test(understanding.normalized) && parsed.message.role === "user") {
      score += 4;
      reasons.push("personal_user_statement");
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

    const hasNumericFact = /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)\b/i.test(utterance);
    const hasAssignmentFact = /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[A-Za-z0-9_.:-]+\b/.test(utterance);
    const hasCapitalizedPhrase = /\b[A-Z][A-Za-z0-9&'/-]+(?:\s+[A-Z][A-Za-z0-9&'/-]+){0,6}\b/.test(utterance);
    const hasQuotedPhrase = /"[^"]{2,100}"/.test(utterance);
    if (hasAssignmentFact) {
      add(12, "assignment_fact_phrase");
    }

    switch (understanding.answerType) {
      case "duration":
      case "date":
        if (/\b(?:a few|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s*(?:ago|each way)?\b/i.test(utterance)) {
          add(10, "duration_phrase");
        }
        if (/\b(?:yesterday|today|recently|last\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(utterance)) {
          add(5, "relative_date_phrase");
        }
        if (/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(utterance)) {
          add(6, "date_phrase");
        }
        break;
      case "place":
        if (/\b(?:from|to|in|at|near|visited|travel(?:ed)? to|moved from|country|city|place)\b/i.test(utterance) && hasCapitalizedPhrase) {
          add(8, "place_context");
        }
        break;
      case "relationship":
        if (/\b(single|married|divorced|dating|partner|boyfriend|girlfriend|parent|relationship)\b/i.test(utterance)) {
          add(10, "relationship_status_phrase");
        }
        break;
      case "title":
        if (hasQuotedPhrase || /\b(?:called|named|titled|production of)\b/i.test(utterance)) {
          add(9, "title_phrase");
        }
        break;
      case "organization":
        if (/\b(?:company|brand|deal|sponsor|sponsorship|endorsement|signed|store|shop|studio|classes?|with|from|at)\b/i.test(utterance) && hasCapitalizedPhrase) {
          add(8, "organization_context");
        }
        break;
      case "object":
        if (hasAssignmentFact || hasNumericFact || hasQuotedPhrase || hasCapitalizedPhrase || /\b(?:is|was|are|were|called|named|favorite|favourite|prefer|bought|purchased|got|gave|received|remember|reminds?)\b/i.test(utterance)) {
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

  private expandCandidatesFromStore(
    seeds: ScoredMessage[],
    rawStore: RawMessageRepository,
    understanding: QueryUnderstanding,
    sessionId?: string,
  ): ScoredMessage[] {
    const byId = new Map<string, ScoredMessage>();
    const add = (parsed: ParsedMessage, score: number, reasons: string[]) => {
      const existing = byId.get(parsed.message.id);
      if (!existing || score > existing.score) {
        byId.set(parsed.message.id, { parsed, score, reasons: [...new Set(reasons)] });
      }
    };

    const window = this.expansionWindow(understanding);
    for (const seed of seeds) {
      add(seed.parsed, seed.score + 4, seed.reasons);
      const startTurn = Math.max(seed.parsed.message.turnNumber - window, 0);
      const endTurn = seed.parsed.message.turnNumber + window;
      const adjacentMessages = rawStore.getByRange(startTurn, endTurn, {
        sessionId: sessionId ?? seed.parsed.message.sessionId,
      });
      for (const message of adjacentMessages) {
        const parsed = this.parseMessage(message);
        const base = message.id === seed.parsed.message.id
          ? seed.score
          : this.scoreRawMessage(parsed, understanding).score;
        add(parsed, Math.max(base, seed.score - 2), [
          ...seed.reasons,
          "adjacent_turn_expansion",
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
      if (!normalized || (normalized.length < 2 && reason !== "count_phrase") || QUERY_STOP_WORDS.has(normalized.toLowerCase())) {
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
    const addOrganizationList = (text: string, confidence: number, messageId: string, reason: string) => {
      for (const phrase of this.extractOrganizationPhrases(text)) {
        add(phrase, "organization", confidence, messageId, reason);
      }
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

      for (const assignment of text.matchAll(/\b([A-Z][A-Z0-9_]{2,}\s*=\s*[A-Za-z0-9_.:-]+)\b/g)) {
        add(assignment[1].replace(/\s*=\s*/g, "="), "object", 0.97, id, "assignment_fact_phrase");
      }

      const quotedType = understanding.answerType === "unknown" ? "title" : understanding.answerType;
      if (["title", "object", "choice"].includes(quotedType)) {
        for (const quoted of text.matchAll(/"([^"]{2,100})"/g)) {
          add(`"${quoted[1]}"`, quotedType, 0.88, id, "quoted_phrase");
        }
      }

      for (const titled of text.matchAll(/\b(?:called|named|titled|production of|playlist called|movie called|book called|song called|album called)\s+"?([A-Z][A-Za-z0-9&'/-]+(?:\s+[A-Z][A-Za-z0-9&'/-]+){0,8})"?/g)) {
        add(titled[1], "title", 0.9, id, "typed_title_phrase");
      }

      for (const oldName of text.matchAll(/\b(?:old\s+name|previous\s+last\s+name|last\s+name\s+before[^,.;!?]*)\s+(?:was|is)?\s*([A-Z][A-Za-z'-]{1,40})\b/g)) {
        add(oldName[1], "object", 0.9, id, "name_change_phrase");
      }

      for (const named of text.matchAll(/\b(?:my\s+[a-z][a-z-]*'?s\s+name|name)\s+(?:is|was)\s+([A-Z][A-Za-z'-]{1,40})\b/g)) {
        add(named[1], "person", 0.9, id, "name_phrase");
      }

      for (const role of text.matchAll(/\b(?:previous\s+role|used\s+to\s+work|worked|working|job|role|occupation)\s+(?:was|is|as)?\s*(?:a\s+|an\s+)?([a-z][a-z\s-]{2,80}?\s+(?:at|for)\s+(?:a\s+|an\s+|the\s+)?[a-z][a-z\s-]{2,80}?)(?=\s+(?:and|but)\b|[.,;!?]|$)/gi)) {
        add(role[1], "object", 0.9, id, "job_phrase");
      }

      for (const count of text.matchAll(/\b(?:have|own|caught|watched|packed|brought|bought|purchased)\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty))\s+([a-z][a-z\s-]{1,40})\b/gi)) {
        add(count[1], "object", 0.9, id, "count_phrase");
      }
      for (const percent of text.matchAll(/\b(\d{1,3}%)(?:\s+(?:discount|off))?\b/gi)) {
        add(percent[1], "object", 0.92, id, "percent_phrase");
      }
      for (const speed of text.matchAll(/\b(\d+\s*(?:Mbps|Gbps|kbps))\b/gi)) {
        add(speed[1].replace(/\s+/g, ""), "object", 0.93, id, "network_speed_phrase");
      }
      for (const ratio of text.matchAll(/\b(\d+\s*:\s*\d+)(?:\s+ratio)?\b/gi)) {
        add(ratio[1].replace(/\s+/g, ""), "object", 0.93, id, "ratio_phrase");
      }
      for (const capacity of text.matchAll(/\b(\d+\s*(?:GB|TB|MB))\b/g)) {
        add(capacity[1].replace(/\s+/g, ""), "object", 0.9, id, "capacity_phrase");
      }
      for (const duration of text.matchAll(/\b((?:a few|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)(?:\s+each\s+way)?)(?:\s+ago)?\b/gi)) {
        add(duration[1], "duration", 0.9, id, "duration_phrase");
      }
      for (const date of text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi)) {
        add(date[0], "date", 0.9, id, "date_phrase");
      }
      for (const money of text.matchAll(/\$\d+(?:,\d{3})*(?:\.\d{2})?\b/g)) {
        add(money[0], "object", 0.9, id, "money_phrase");
      }

      for (const credential of text.matchAll(/\b(?:degree|certification|certificate|major)\s+(?:in|for)\s+([A-Z][A-Za-z&/-]+(?:\s+[A-Z][A-Za-z&/-]+){0,5})/g)) {
        add(credential[1], "object", 0.88, id, "credential_phrase");
      }
      for (const institution of text.matchAll(/\b(?:from|at)\s+(?:the\s+)?([A-Z][A-Za-z&.'-]+(?:\s+[A-Z][A-Za-z&.'-]+){0,8})(?:\s+in\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}))?/g)) {
        const value = institution[2] ? `${institution[1]} in ${institution[2]}` : institution[1];
        if (understanding.answerType === "place" || /\b(?:university|college|school|program|city|country|home country|study|degree|graduat)\b/i.test(text)) {
          add(value, "place", 0.86, id, "place_preposition_phrase");
        }
      }
      for (const place of text.matchAll(/\b(?:country|city|home country|place)\s*,?\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/g)) {
        add(place[1], "place", 0.88, id, "place_name_phrase");
      }
      if (understanding.answerType === "place") {
        for (const place of text.matchAll(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/g)) {
          const value = place[1];
          if (!QUERY_STOP_WORDS.has(value.toLowerCase()) && /\b(?:from|to|in|visited|travel|moved|country|city|home country)\b/i.test(text)) {
            add(value, "place", 0.78, id, "capitalized_place_candidate");
          }
        }
      }

      for (const orgList of text.matchAll(/\b(?:brands?\s+like|companies?\s+like|deals?\s+with|sponsorship\s+with|endorsement\s+with|working\s+with|collaborat(?:e|ing)\s+with|signed(?:\s+up)?|landed)\s+([A-Z][A-Za-z0-9&'/-]+(?:\s+(?:and|or|,)?\s*[A-Z][A-Za-z0-9&'/-]+){0,8})/g)) {
        addOrganizationList(orgList[1], 0.88, id, "brand_or_company_phrase");
      }
      for (const org of text.matchAll(/\b(?:at|from|using|via|near|inside|into|make it to|go to|shop at|classes at)\s+(?:a\s+|an\s+|the\s+)?((?:[A-Z][A-Za-z0-9&'/-]+|[a-z]+(?:-[a-z]+)?)(?:\s+(?:[A-Z][A-Za-z0-9&'/-]+|[a-z]+(?:-[a-z]+)?)){0,5}(?:\s+(?:store|shop|studio|center|centre|downtown))?)\b/g)) {
        const value = org[1].replace(/^(?:a|an|the)\s+/i, "");
        if (this.isPlausibleOrganizationPhrase(value)) {
          add(value, "organization", 0.86, id, "store_or_place_phrase");
        }
      }

      for (const color of text.matchAll(/\b(?:painted|repainted|walls?|bedroom).*?\b((?:a\s+)?(?:lighter|darker|soft|pale|bright|deep|warm|cool)?\s*(?:shade\s+of\s+)?(?:gray|grey|blue|green|yellow|white|black|red|pink|purple|beige|cream))\b/gi)) {
        add(color[1], "object", 0.86, id, "color_phrase");
      }
      for (const favorite of text.matchAll(/\b(?:favorite|favourite|prefer(?:red)?|love)\s+([^.,;!?]{3,80})/gi)) {
        add(favorite[1], "object", 0.82, id, "preference_phrase");
      }
      for (const reminder of text.matchAll(/\breminds?\s+me\s+of\s+([^.,;!?]{3,80})/gi)) {
        add(reminder[1], "object", 0.84, id, "reminder_phrase");
      }
      for (const worth of text.matchAll(/\bworth\s+([^.,;!?]{3,80})/gi)) {
        add(worth[1], "object", 0.84, id, "relative_value_phrase");
      }
      for (const research of text.matchAll(/\b(?:research(?:ing)?|looking\s+into|planning\s+to|plan\s+to)\s+([^?.,;!?]{3,100})/gi)) {
        add(research[1], "object", 0.82, id, "research_object_phrase");
      }

      if (understanding.answerType === "relationship") {
        for (const status of ["single", "married", "divorced", "dating"]) {
          if (lower.includes(status)) {
            add(status, "relationship", 0.88, id, "relationship_status_phrase");
          }
        }
      }
    }

    return [...candidates.values()]
      .filter((candidate) => this.candidateMatchesQuestion(candidate, understanding))
      .sort((left, right) => {
        const leftPriority = this.answerCandidatePriority(left, understanding);
        const rightPriority = this.answerCandidatePriority(right, understanding);
        if ((leftPriority < 5 || rightPriority < 5) && leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return right.confidence - left.confidence ||
          this.answerTypeRank(left.type, understanding.answerType) - this.answerTypeRank(right.type, understanding.answerType) ||
          leftPriority - rightPriority ||
          left.text.localeCompare(right.text);
      })
      .slice(0, 8);
  }


  private adjustCandidateConfidence(
    text: string,
    type: AnswerType,
    confidence: number,
    reason: string,
    understanding: QueryUnderstanding,
  ): number {
    let adjusted = confidence;

    if (understanding.answerType !== "unknown") {
      adjusted += type === understanding.answerType ? 0.04 : -0.03;
    }
    if (understanding.answerType === "object" && ["title", "organization", "person"].includes(type)) {
      adjusted += 0.01;
    }
    if (understanding.answerType === "place" && ["place", "organization"].includes(type)) {
      adjusted += 0.03;
    }
    if (understanding.answerType === "organization" && ["organization", "place"].includes(type)) {
      adjusted += 0.03;
    }
    if (/^(?:matched_question_choice|date_phrase|duration_phrase|count_phrase|ratio_phrase|capacity_phrase|network_speed_phrase)$/.test(reason)) {
      adjusted += 0.05;
    }
    if (understanding.terms.some((term) => this.textHasTerm(text, term))) {
      adjusted += 0.03;
    }
    if (understanding.entities.some((entity) => text.toLowerCase().includes(entity.toLowerCase()))) {
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
    if (understanding.answerType === "object" && candidate.type === "person" && candidate.reason === "pet_name_phrase") {
      return true;
    }
    if (understanding.answerType === "organization" && candidate.type === "place") {
      return true;
    }
    if (understanding.answerType === "place" && candidate.type === "organization") {
      return true;
    }
    if (understanding.answerType === "organization" && candidate.type === "object" && /store|studio|target/i.test(candidate.reason)) {
      return true;
    }
    if (understanding.answerType === "date" && candidate.reason === "date_phrase") {
      return true;
    }
    if (understanding.answerType === "place" && candidate.type === "choice") {
      return true;
    }
    return understanding.requiresMultiHop && ["duration", "place", "organization", "object"].includes(candidate.type);
  }


  private answerCandidatePriority(candidate: AnswerCandidate, understanding: QueryUnderstanding): number {
    if (candidate.type === understanding.answerType) {
      return 0;
    }
    if (understanding.answerType === "object" && ["title", "organization", "person"].includes(candidate.type)) {
      return 1;
    }
    if (understanding.answerType === "organization" && candidate.type === "place") {
      return 1;
    }
    if (understanding.answerType === "place" && candidate.type === "organization") {
      return 1;
    }
    if (understanding.answerType === "title" && candidate.type === "object") {
      return 2;
    }
    if (candidate.reason.endsWith("_phrase")) {
      return 3;
    }
    return 5;
  }

  private answerTypeRank(type: AnswerType, target: AnswerType): number {
    return type === target ? 0 : 1;
  }

  private selectMessagesForOutput(
    expanded: ScoredMessage[],
    answerCandidates: AnswerCandidate[],
    recallBudget: number,
  ): RawMessage[] {
    const answerEvidenceRank = new Map<string, number>();
    answerCandidates.forEach((candidate, index) => {
      for (const messageId of candidate.evidenceMessageIds) {
        const existing = answerEvidenceRank.get(messageId);
        const rank = index * 10;
        if (existing === undefined || rank < existing) {
          answerEvidenceRank.set(messageId, rank);
        }
      }
    });
    const prioritized = [...expanded].sort((left, right) => {
      const leftForced = left.reasons.includes("forced_answer_anchor") ? 1 : 0;
      const rightForced = right.reasons.includes("forced_answer_anchor") ? 1 : 0;
      if (leftForced !== rightForced) {
        return rightForced - leftForced;
      }
      const leftRank = answerEvidenceRank.get(left.parsed.message.id);
      const rightRank = answerEvidenceRank.get(right.parsed.message.id);
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        const leftRolePenalty = left.parsed.message.role === "user" ? 0 : 3;
        const rightRolePenalty = right.parsed.message.role === "user" ? 0 : 3;
        if (leftRank + leftRolePenalty !== rightRank + rightRolePenalty) {
          return (leftRank + leftRolePenalty) - (rightRank + rightRolePenalty);
        }
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

  private seedLimit(understanding: QueryUnderstanding): number {
    if (understanding.requiresMultiHop || understanding.dateHints.length > 0) {
      return 32;
    }
    if (understanding.historyQa) {
      return 32;
    }
    return 12;
  }

  private mergeForcedAnchors(
    expanded: ScoredMessage[],
    parsedMessages: ParsedMessage[],
    understanding: QueryUnderstanding,
  ): ScoredMessage[] {
    const byId = new Map(expanded.map((item) => [item.parsed.message.id, item]));
    for (const parsed of parsedMessages) {
      const reason = this.forcedAnchorReason(parsed.utterance, understanding);
      if (!reason) {
        continue;
      }
      const existing = byId.get(parsed.message.id);
      const score = Math.max(existing?.score ?? 0, 200);
      byId.set(parsed.message.id, {
        parsed,
        score,
        reasons: [...new Set([...(existing?.reasons ?? []), reason, "forced_answer_anchor"])],
      });
    }
    return [...byId.values()].sort((left, right) =>
      right.score - left.score ||
      (left.parsed.message.sequence ?? 0) - (right.parsed.message.sequence ?? 0),
    );
  }

  private forcedAnchorReason(utterance: string, understanding: QueryUnderstanding): string | null {
    const lower = utterance.toLowerCase();
    const queryTermOverlap = understanding.terms.some((term) => this.textHasTerm(lower, term));
    const signal = this.scoreAnswerSignal(lower, lower, understanding);
    if (queryTermOverlap && signal.score >= 6) {
      return "generic_answer_anchor";
    }
    if (understanding.answerType === "place" && /\b(?:from|to|in|visited|travel(?:ed)? to|moved from|country|city|home country)\b/i.test(utterance)) {
      return "place_anchor";
    }
    if ((understanding.answerType === "duration" || understanding.answerType === "date") && signal.score >= 5) {
      return "temporal_anchor";
    }
    if (understanding.answerType === "organization" && /\b(?:company|brand|deal|sponsor|store|shop|studio|with|from|at)\b/i.test(utterance)) {
      return "organization_anchor";
    }
    return null;
  }

  private expansionWindow(understanding: QueryUnderstanding): number {
    if (understanding.requiresMultiHop) return 4;
    if (understanding.answerType === "relationship" || understanding.answerType === "place") return 3;
    return 2;
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
    return [entity.toLowerCase()];
  }

  private extractOrganizationPhrases(value: string): string[] {
    return value
      .split(/\s*(?:,|;|\band\b|\bor\b)\s*/i)
      .map((phrase) => this.cleanAnswerText(phrase))
      .filter((phrase) => this.isPlausibleOrganizationPhrase(phrase));
  }

  private isPlausibleOrganizationPhrase(value: string): boolean {
    const cleaned = this.cleanAnswerText(value);
    if (!cleaned) {
      return false;
    }
    const lower = cleaned.toLowerCase();
    if (
      /^(?:any|all|one|some|those|these|that|this|my|your|their|real|other|new|different)\b/.test(lower) ||
      /\b(?:places?|things?|stuff|options?|possibilities|journey|support|values|interests|world)\b/.test(lower)
    ) {
      return false;
    }
    const hasDomainNoun = /\b(store|shop|studio|center|centre|downtown|company|brand)\b/i.test(cleaned);
    const hasCapitalizedToken = /\b[A-Z][A-Za-z0-9&'/-]+\b/.test(cleaned);
    return hasDomainNoun || hasCapitalizedToken;
  }

  private cleanAnswerText(value: string): string {
    return value
      .replace(/^[\s“”]+|[\s“”.!?]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
}
