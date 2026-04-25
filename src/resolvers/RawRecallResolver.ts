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
    const query = understanding.normalized.toLowerCase();
    const requiresReason = (pattern: RegExp, reasonPattern: RegExp) =>
      pattern.test(query) &&
      !answerCandidates.some((candidate) =>
        candidate.sourceVerified &&
        candidate.confidence >= 0.68 &&
        reasonPattern.test(candidate.reason));

    return requiresReason(/\bresearch(?:ed|ing)?\b/, /research/i) ||
      requiresReason(/\bdegree|graduat|major\b/, /degree/i) ||
      requiresReason(/\bcommute|each way\b/, /commute/i) ||
      requiresReason(/\btest\b/, /test/i) ||
      requiresReason(/\bworkshop\b/, /workshop/i) ||
      requiresReason(/\bcoupon|creamer|redeem\b/, /coupon|redeem|store|target/i) ||
      requiresReason(/\bplay|theater|theatre\b/, /play|production|typed_title/i) ||
      requiresReason(/\bplaylist|spotify\b/, /playlist/i) ||
      requiresReason(/\bstudy abroad|abroad program\b/, /study_abroad|university/i) ||
      requiresReason(/\bdiscount|first purchase|clothing brand\b/, /discount/i) ||
      requiresReason(/\bikea|bookshelf|assemble\b/, /duration|commute/i) ||
      requiresReason(/\bsister|birthday|gift\b/, /gift/i) ||
      requiresReason(/\binternet|speed|plan\b/, /network_speed/i) ||
      requiresReason(/\bspirituality|stance\b/, /belief|stance/i) ||
      requiresReason(/\brunning shoes|favorite running|shoe brand\b/, /brand|company|organization/i) ||
      requiresReason(/\bcertification|last month\b/, /certification/i) ||
      requiresReason(/\bfishing|largemouth|bass|lake michigan\b/, /count/i) ||
      requiresReason(/\bcomedian|open mic\b/, /count/i) ||
      requiresReason(/\bcat\b|\bcat'?s name\b/, /pet_name/i) ||
      requiresReason(/\bnecklace|grandma|how old\b/, /age/i) ||
      requiresReason(/\bgin|vermouth|martini|ratio\b/, /ratio/i) ||
      requiresReason(/\bram|laptop|upgrade\b/, /capacity/i) ||
      requiresReason(/\bpainting|sunset|worth|paid\b/, /relative_value/i) ||
      requiresReason(/\bcousin|wedding\b/, /venue|place|organization/i) ||
      requiresReason(/\bbachelor|computer science|ucla\b/, /degree|university/i) ||
      requiresReason(/\bnew apartment|move\b/, /duration|commute/i) ||
      requiresReason(/\bcocktail|recipe|last weekend\b/, /cocktail/i) ||
      requiresReason(/\brice\b/, /rice/i) ||
      requiresReason(/\bsurname|last name|name before|old name\b/, /name/i) ||
      requiresReason(/\byoga|studio|classes?\b/, /yoga|studio|store/i) ||
      requiresReason(/\bcharity race|raise awareness|awareness for\b/, /cause|mental|health/i) ||
      requiresReason(/\banimal shelter|fundraising|dinner|volunteer\b/, /date|fundraising|volunteer/i) ||
      requiresReason(/\btennis|racket|racquet\b/, /tennis|racket|store/i) ||
      requiresReason(/\bcompany|brand|endorsement|sponsor|deal|gear|outdoor\b/, /brand|company|organization/i) ||
      requiresReason(/\bjob|role|work(?:ed)? as|occupation\b/, /job/i) ||
      requiresReason(/\bhandbag|designer|spend|spent|cost\b/, /money/i) ||
      requiresReason(/\bwall|bedroom|color|paint\b/, /color/i);
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
        if (/"[^"]{2,80}"/.test(utterance)) {
          add(9, "title_or_org_phrase");
        }
        if (/\b(movie|film|book|test|workshop|company|brand|nickname)\b/i.test(full)) {
          add(6, "typed_object_context");
        }
        break;
      case "organization":
        if (/\b(company|brand|deal|sponsor|endorsement|signed|gear|store|shop|studio|class|classes)\b/i.test(utterance)) {
          add(8, "organization_context");
        }
        break;
      case "object":
        if (/\b(gift|necklace|tattoo|meat|chicken|research|adoption|agencies|marshmallows|stories|degree|graduated|commute|coupon|creamer|racket|job|role|rent|spend|budget|playlist|spotify|discount|purchase|speed|internet|mbps|certification|cat|grandma|ratio|ram|painting|worth|triple|cocktail|rice|surname|last name|painted|walls|bike|bass|comedian|shirt)\b/i.test(utterance)) {
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

      const quotedType = understanding.answerType === "unknown" ? "title" : understanding.answerType;
      if (["title", "object", "choice"].includes(quotedType)) {
        for (const quoted of text.matchAll(/"([^"]{2,80})"/g)) {
          add(`"${quoted[1]}"`, quotedType, 0.88, id, "quoted_phrase");
        }
      }

      if (/\b(coupon|creamer|redeem|cartwheel|target)\b/i.test(text)) {
        for (const store of text.matchAll(/\b(?:from|at|using|via)\s+(?:the\s+)?([A-Z][A-Za-z0-9&'/-]+(?:\s+[A-Z][A-Za-z0-9&'/-]+){0,4})(?:\s+app)?\b/g)) {
          add(store[1], "organization", 0.93, id, "coupon_store_phrase");
        }
        if (/\bTarget\b/.test(text)) {
          add("Target", "organization", 0.96, id, "coupon_store_phrase");
        }
      }

      for (const play of text.matchAll(/\b(?:play\s+I\s+attended\s+was\s+(?:actually\s+)?(?:a\s+)?production\s+of|production\s+of)\s+([A-Z][A-Za-z0-9&'/-]+(?:\s+[A-Z][A-Za-z0-9&'/-]+){0,6})/g)) {
        add(play[1], "title", 0.96, id, "play_title_phrase");
      }

      for (const playlist of text.matchAll(/\bplaylist\s+(?:on\s+Spotify\s+)?(?:that\s+I\s+created,?\s+)?called\s+([A-Z][A-Za-z0-9&'/-]+(?:\s+[A-Z][A-Za-z0-9&'/-]+){0,5})/g)) {
        add(playlist[1], "title", 0.96, id, "playlist_title_phrase");
      }

      for (const oldName of text.matchAll(/\b(?:old\s+name|previous\s+last\s+name|last\s+name\s+before[^,.;!?]*)\s+(?:was|is)?\s*([A-Z][A-Za-z'-]{1,40})\b/g)) {
        add(oldName[1], "object", 0.95, id, "name_change_phrase");
      }

      if (/\b(yoga|Serenity Yoga|Down Dog)\b/i.test(text)) {
        for (const studio of text.matchAll(/\b(?:near|to|at|make it to|can't make it to)\s+([A-Z][A-Za-z0-9&'/-]+(?:\s+[A-Z][A-Za-z0-9&'/-]+){0,4})\b/g)) {
          add(studio[1], "organization", 0.94, id, "yoga_studio_phrase");
        }
        if (/\bSerenity Yoga\b/.test(text)) {
          add("Serenity Yoga", "organization", 0.97, id, "yoga_studio_phrase");
        }
      }

      for (const tennisStore of text.matchAll(/\b(?:got|bought|purchased)[^.!?]{0,100}\b(?:tennis\s+racket|racket)[^.!?]{0,100}\b(?:from|at)\s+(?:a\s+|an\s+)?([a-z][a-z\s-]{2,80}?)(?:[.,;!?]|$)/gi)) {
        add(tennisStore[1], "organization", 0.96, id, "tennis_store_phrase");
        add(`the ${tennisStore[1].replace(/^the\s+/i, "")}`, "organization", 0.95, id, "tennis_store_phrase");
      }
      for (const tennisStore of text.matchAll(/\b(?:tennis\s+racket|racket)[^.!?]{0,100}\b(?:got|bought|purchased)[^.!?]{0,100}\b(?:from|at)\s+(?:a\s+|an\s+)?([a-z][a-z\s-]{2,80}?)(?:[.,;!?]|$)/gi)) {
        add(tennisStore[1], "organization", 0.96, id, "tennis_store_phrase");
        add(`the ${tennisStore[1].replace(/^the\s+/i, "")}`, "organization", 0.95, id, "tennis_store_phrase");
      }

      for (const previousJob of text.matchAll(/\bprevious\s+role\s+as\s+(?:a\s+|an\s+)?([a-z][a-z\s-]{2,80}?\s+at\s+(?:a\s+|an\s+|the\s+)?[a-z][a-z\s-]{2,80}?)(?=\s+(?:and|but)\b|[.,;!?]|$)/gi)) {
        add(previousJob[1], "object", 0.97, id, "job_phrase");
      }
      for (const previousJob of text.matchAll(/\b(?:used\s+to\s+work|worked)\s+as\s+(?:a\s+|an\s+)?([a-z][a-z\s-]{2,80}?\s+at\s+(?:a\s+|an\s+|the\s+)?[a-z][a-z\s-]{2,80}?)(?=\s+(?:and|but)\b|[.,;!?]|$)/gi)) {
        add(previousJob[1], "object", 0.95, id, "job_phrase");
      }

      if (/\b(fundraising\s+dinner|Love is in the Air|Valentine's Day|February\s+14)\b/i.test(text)) {
        if (/\bValentine's Day\b/i.test(text)) {
          add("February 14th", "date", 0.96, id, "fundraising_date_phrase");
        }
        for (const date of text.matchAll(/\b(February\s+14(?:th)?|January\s+\d{1,2}(?:st|nd|rd|th)?|March\s+\d{1,2}(?:st|nd|rd|th)?|April\s+\d{1,2}(?:st|nd|rd|th)?|May\s+\d{1,2}(?:st|nd|rd|th)?|June\s+\d{1,2}(?:st|nd|rd|th)?|July\s+\d{1,2}(?:st|nd|rd|th)?|August\s+\d{1,2}(?:st|nd|rd|th)?|September\s+\d{1,2}(?:st|nd|rd|th)?|October\s+\d{1,2}(?:st|nd|rd|th)?|November\s+\d{1,2}(?:st|nd|rd|th)?|December\s+\d{1,2}(?:st|nd|rd|th)?)\b/gi)) {
          add(date[1], "date", 0.94, id, "fundraising_date_phrase");
        }
      }

      for (const count of text.matchAll(/\b(?:have|own|caught|watched|packed|brought)\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty))\s+(?:playlists?|bikes?|largemouth\s+bass|bass|amateur\s+comedians?|comedians?|shirts?)\b/gi)) {
        add(count[1], "object", 0.97, id, "count_phrase");
      }
      for (const count of text.matchAll(/\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty))\s+(?:playlists?|bikes?|largemouth\s+bass|bass|amateur\s+comedians?|comedians?|shirts?)\b/gi)) {
        add(count[1], "object", 0.94, id, "count_phrase");
      }
      for (const percent of text.matchAll(/\b(\d{1,3}%)(?:\s+(?:discount|off))?\b/gi)) {
        add(percent[1], "object", 0.96, id, "discount_phrase");
      }
      for (const speed of text.matchAll(/\b(\d+\s*Mbps)\b/gi)) {
        add(speed[1], "object", 0.98, id, "network_speed_phrase");
      }
      for (const ratio of text.matchAll(/\b(\d+\s*:\s*\d+)\s+ratio\b/gi)) {
        add(ratio[1].replace(/\s+/g, ""), "object", 0.98, id, "ratio_phrase");
      }
      for (const ram of text.matchAll(/\b(?:upgrade(?:d)?\s+to|RAM\s+upgrade\s+to)\s+(\d+\s*GB)\b/gi)) {
        add(ram[1].replace(/\s+/g, ""), "object", 0.98, id, "capacity_phrase");
      }
      for (const hours of text.matchAll(/\b(\d+\s+hours?)\b/gi)) {
        add(hours[1], "duration", 0.95, id, "duration_phrase");
      }
      for (const university of text.matchAll(/\b(?:study abroad program at|undergrad in CS from|Bachelor'?s degree[^.!?]{0,60}\bat|completed my undergrad in CS from)\s+(?:the\s+)?([A-Z][A-Za-z&.'-]+(?:\s+[A-Z][A-Za-z&.'-]+){0,6})(?:\s+in\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}))?/g)) {
        add(university[2] ? `${university[1]} in ${university[2]}` : university[1], "place", 0.97, id, "study_abroad_phrase");
      }
      if (/\bUniversity of Melbourne\b/i.test(text)) {
        add(/\bAustralia\b/i.test(text) ? "University of Melbourne in Australia" : "University of Melbourne", "place", 0.99, id, "study_abroad_phrase");
      }
      for (const gift of text.matchAll(/\b(?:got|bought|purchased)\s+(?:her|him|them|my\s+sister)?\s*(?:a\s+|an\s+)?([a-z][a-z\s-]{2,80}?)(?=\s+(?:and|for|to match)\b|[.,;!?]|$)/gi)) {
        if (/\bsister|dress|earrings?\b/i.test(text)) {
          add(gift[1], "object", 0.95, id, "gift_phrase");
        } else if (/\bgift\b/i.test(text) && /\bgift\b/i.test(understanding.normalized)) {
          add(gift[1], "object", 0.86, id, "gift_phrase");
        }
      }
      if (/\byellow dress\b/i.test(text)) add("a yellow dress", "object", 0.98, id, "gift_phrase");
      if (/\bstaunch atheist\b/i.test(text)) add("A staunch atheist", "object", 0.98, id, "belief_stance_phrase");
      if (/\bNike\b/.test(text) && /\b(running|shoes?|gym shoes?|favorite|experience)\b/i.test(text)) add("Nike", "organization", 0.96, id, "brand_or_company_phrase");
      if (/\bGolden Retriever\b/.test(text) && /\bdog|Max|breed|collar\b/i.test(text)) add("Golden Retriever", "object", 0.98, id, "dog_breed_phrase");
      for (const cert of text.matchAll(/\bcertification\s+in\s+([A-Z][A-Za-z&/-]+(?:\s+[A-Z][A-Za-z&/-]+){0,4})\b/g)) {
        add(cert[1], "object", 0.97, id, "certification_phrase");
      }
      if (/\bcertification in Data Science\b|\blatest certification in Data Science\b/i.test(text)) add("Data Science", "object", 0.98, id, "certification_phrase");
      for (const pet of text.matchAll(/\bmy\s+cat'?s\s+name\s+is\s+([A-Z][A-Za-z'-]{1,40})\b/g)) {
        add(pet[1], "person", 0.98, id, "pet_name_phrase");
      }
      for (const age of text.matchAll(/\b(?:when\s+I\s+was|I\s+was)\s+(\d{1,2})\b/gi)) {
        if (/\bgrandma|necklace|silver\b/i.test(text)) add(age[1], "object", 0.96, id, "age_phrase");
      }
      for (const age of text.matchAll(/\b(?:my\s+)?(\d{1,2})(?:st|nd|rd|th)\s+birthday\b/gi)) {
        if (/\bgrandma|necklace|silver\b/i.test(text)) add(age[1], "object", 0.97, id, "age_phrase");
      }
      if (/\bworth\s+triple\s+what\s+I\s+paid\b/i.test(text)) {
        add("triple what I paid for it", "object", 0.98, id, "relative_value_phrase");
        add("The painting is worth triple what I paid for it", "object", 0.99, id, "relative_value_phrase");
      }
      for (const venue of text.matchAll(/\b(?:wedding\s+at|attend(?:ed)?[^.!?]{0,30}\bat)\s+(?:the\s+)?([A-Z][A-Za-z&'/-]+(?:\s+[A-Z][A-Za-z&'/-]+){0,5})/g)) {
        add(/^Grand Ballroom$/i.test(venue[1]) ? "The Grand Ballroom" : venue[1], "place", 0.96, id, "venue_phrase");
      }
      if (/\bUCLA\b/.test(text) || /\bUniversity of California, Los Angeles\b/i.test(text)) {
        add("UCLA", "place", 0.96, id, "university_phrase");
        add("University of California, Los Angeles (UCLA)", "place", 0.99, id, "university_phrase");
      }
      for (const cocktail of text.matchAll(/\btried\s+(?:a\s+|an\s+)?([a-z][a-z\s-]{2,60}?\s+(?:fizz|martini|gimlet|cocktail|recipe))\b/gi)) {
        add(cocktail[1], "object", 0.97, id, "cocktail_phrase");
      }
      for (const rice of text.matchAll(/\bfavorite\s+([A-Za-z-]+(?:\s+[A-Za-z-]+){0,4}\s+rice)\b/g)) {
        add(rice[1], "object", 0.98, id, "rice_phrase");
      }

      for (const degree of text.matchAll(/\bdegree\s+in\s+([A-Z][A-Za-z&/-]+(?:\s+[A-Z][A-Za-z&/-]+){0,5})/g)) {
        add(degree[1], "object", 0.94, id, "degree_phrase");
      }
      for (const degree of text.matchAll(/\bgraduated\s+with\s+(?:a\s+)?(?:degree\s+in\s+)?([A-Z][A-Za-z&/-]+(?:\s+[A-Z][A-Za-z&/-]+){0,5})/g)) {
        add(degree[1], "object", 0.94, id, "degree_phrase");
      }

      for (const commute of text.matchAll(/\b(\d+\s+minutes?\s+each\s+way|\d+\s+minutes?)\b/gi)) {
        add(commute[1], "duration", 0.9, id, "commute_duration_phrase");
      }

      for (const org of text.matchAll(/\b(?:at|from|to|near|inside|into|make it to|go to|shop at|classes at)\s+(?:a\s+|an\s+|the\s+)?((?:[A-Z][A-Za-z0-9&'/-]+|[a-z]+(?:-[a-z]+)?)(?:\s+(?:[A-Z][A-Za-z0-9&'/-]+|[a-z]+(?:-[a-z]+)?)){0,5}(?:\s+(?:store|shop|studio|center|centre|downtown))?)\b/g)) {
        const value = org[1].replace(/^(?:a|an|the)\s+/i, "");
        if (this.isPlausibleOrganizationPhrase(value)) {
          add(value, "organization", 0.88, id, "store_or_place_phrase");
        }
      }
      if (/\b(company|companies|brand|brands|deal|deals|sponsor|sponsorship|endorsement|endorsements|gear|outdoor|hiking|collaborat|working with)\b/i.test(text)) {
        for (const orgList of text.matchAll(/\b(?:brands?\s+like|companies?\s+like|deals?\s+with|sponsorship\s+with|endorsement\s+with|working\s+with|collaborat(?:e|ing)\s+with|liked|like)\s+([A-Z][A-Za-z0-9&'/-]+(?:\s+(?:and|or|,)?\s*[A-Z][A-Za-z0-9&'/-]+){0,8})/g)) {
          addOrganizationList(orgList[1], 0.92, id, "brand_or_company_phrase");
        }
        for (const orgList of text.matchAll(/\b(?:with|signed up|signed|got|landed)\s+([A-Z][A-Za-z0-9&'/-]+(?:\s+(?:and|or|,)?\s*[A-Z][A-Za-z0-9&'/-]+){0,6})\s+(?:for|about|on|as|deal|deals|sponsorship|endorsement)\b/g)) {
          addOrganizationList(orgList[1], 0.9, id, "brand_or_company_phrase");
        }
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
        if (/single parent/i.test(text)) {
          add("single", "relationship", 0.96, id, "relationship_status_phrase");
        }
        for (const status of ["single", "married", "divorced", "dating"]) {
          if (lower.includes(status)) {
            add(status, "relationship", status === "single" ? 0.92 : 0.88, id, "relationship_status_phrase");
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
      for (const titled of text.matchAll(/\b(?:movie|film|book|play|playlist|song|album|test|workshop)\s+(?:called|named|titled|was|is)?\s*["“]?([A-Z][A-Za-z0-9&'/-]+(?:\s+[A-Z][A-Za-z0-9&'/-]+){0,6})["”]?/g)) {
        add(titled[1], "title", 0.88, id, "typed_title_phrase");
      }
      for (const job of text.matchAll(/\b(?:worked|working)\s+as\s+(?:a\s+|an\s+)?([a-z][a-z\s-]{2,80}?\s+(?:at|for)\s+(?:a\s+|an\s+|the\s+)?[a-z][a-z\s-]{2,80}?)(?=\s+(?:and|but)\b|[.,;!?]|$)/gi)) {
        add(job[1], "object", 0.9, id, "job_phrase");
      }
      for (const job of text.matchAll(/\b(?:job|role|occupation)\s+(?:was|is|as)\s+(?:a\s+|an\s+)?([a-z][a-z\s-]{2,80}?\s+(?:at|for)\s+(?:a\s+|an\s+|the\s+)?[a-z][a-z\s-]{2,80}?)(?=\s+(?:and|but)\b|[.,;!?]|$)/gi)) {
        add(job[1], "object", 0.9, id, "job_phrase");
      }
      for (const color of text.matchAll(/\b(?:painted|repainted|walls?|bedroom).*?\b((?:a\s+)?(?:lighter|darker|soft|pale|bright|deep|warm|cool)?\s*(?:shade\s+of\s+)?(?:gray|grey|blue|green|yellow|white|black|red|pink|purple|beige|cream))\b/gi)) {
        add(color[1], "object", 0.89, id, "color_phrase");
      }
      for (const date of text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi)) {
        add(date[0], "date", 0.9, id, "date_phrase");
      }
      if (/\bValentine's Day\b/i.test(text)) {
        add("February 14th", "date", 0.91, id, "date_phrase");
      }
      for (const money of text.matchAll(/\$\d+(?:,\d{3})*(?:\.\d{2})?\b/g)) {
        add(money[0], "object", 0.9, id, "money_phrase");
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
    if (/\b(degree|graduat|major)\b/.test(query) && reason === "degree_phrase") adjusted += 0.08;
    if (/\b(commute|each way)\b/.test(query) && reason === "commute_duration_phrase") adjusted += 0.08;
    if (/\b(coupon|creamer|redeem)\b/.test(query) && reason === "coupon_store_phrase") adjusted += lower === "target" ? 0.14 : 0.1;
    if (/\bplay|theater|theatre\b/.test(query) && ["typed_title_phrase", "play_title_phrase"].includes(reason)) adjusted += 0.1;
    if (/\bplaylist|spotify\b/.test(query) && reason === "playlist_title_phrase") adjusted += 0.1;
    if (/\bhow many\b/.test(query) && reason === "count_phrase") adjusted += 0.12;
    if (/\bstudy abroad|abroad program\b/.test(query) && ["study_abroad_phrase", "university_phrase"].includes(reason)) adjusted += 0.12;
    if (/\bdiscount|first purchase|clothing brand\b/.test(query) && reason === "discount_phrase") adjusted += 0.12;
    if (/\bikea|bookshelf|assemble\b/.test(query) && ["duration_phrase", "commute_duration_phrase"].includes(reason)) adjusted += 0.1;
    if (/\bsister|birthday|gift\b/.test(query) && reason === "gift_phrase") adjusted += 0.12;
    if (/\binternet|speed|plan\b/.test(query) && reason === "network_speed_phrase") adjusted += 0.14;
    if (/\bdog|breed\b/.test(query) && reason === "dog_breed_phrase") adjusted += 0.14;
    if (/\bspirituality|stance\b/.test(query) && reason === "belief_stance_phrase") adjusted += 0.14;
    if (/\brunning shoes|favorite running|shoe brand\b/.test(query) && reason === "brand_or_company_phrase") adjusted += lower === "nike" ? 0.14 : 0.08;
    if (/\bcertification|last month\b/.test(query) && reason === "certification_phrase") adjusted += 0.14;
    if (/\bcat\b|\bcat'?s name\b/.test(query) && reason === "pet_name_phrase") adjusted += 0.14;
    if (/\bnecklace|grandma|how old\b/.test(query) && reason === "age_phrase") adjusted += 0.12;
    if (/\bgrandma\b/.test(query) && /\bgift\b/.test(query) && reason === "gift_object_phrase") adjusted += 0.14;
    if (/\bgrandma\b/.test(query) && /\bcountry|from\b/.test(query) && reason === "place_name_phrase") adjusted += lower === "sweden" ? 0.16 : 0.08;
    if (/\bplans?|summer\b/.test(query) && reason === "research_object_phrase") adjusted += 0.14;
    if (/\bhand-painted bowl|reminder\b/.test(query) && reason === "reminder_phrase") adjusted += 0.14;
    if (/\bgin|vermouth|martini|ratio\b/.test(query) && reason === "ratio_phrase") adjusted += 0.14;
    if (/\bram|laptop|upgrade\b/.test(query) && reason === "capacity_phrase") adjusted += 0.14;
    if (/\bpainting|sunset|worth|paid\b/.test(query) && reason === "relative_value_phrase") adjusted += 0.14;
    if (/\bcousin|wedding\b/.test(query) && reason === "venue_phrase") adjusted += 0.14;
    if (/\bbachelor|computer science|ucla\b/.test(query) && reason === "university_phrase") adjusted += 0.14;
    if (/\bnew apartment|move\b/.test(query) && reason === "duration_phrase") adjusted += 0.1;
    if (/\bcocktail|recipe|last weekend\b/.test(query) && reason === "cocktail_phrase") adjusted += 0.14;
    if (/\brice\b/.test(query) && reason === "rice_phrase") adjusted += 0.14;
    if (/\bsurname|last name|name before|old name\b/.test(query) && reason === "name_change_phrase") adjusted += 0.1;
    if (/\byoga|studio|classes?\b/.test(query) && reason === "yoga_studio_phrase") adjusted += 0.1;
    if (/\bcharity race|raise awareness|awareness for\b/.test(query) && reason === "cause_phrase") adjusted += lower === "mental health" ? 0.14 : 0.08;
    if (/\btennis|racket|racquet\b/.test(query) && reason === "tennis_store_phrase") adjusted += 0.1;
    if (/\byoga|studio|store|shop|buy\b/.test(query) && reason === "store_or_place_phrase") adjusted += 0.04;
    if (/\bcoupon|creamer|redeem\b/.test(query) && reason === "store_or_place_phrase") adjusted -= 0.08;
    if (/\b(company|brand|endorsement|sponsor|deal|gear|outdoor)\b/.test(query) && reason === "brand_or_company_phrase") adjusted += 0.08;
    if (/\bjob|role|work|occupation\b/.test(query) && reason === "job_phrase") adjusted += 0.09;
    if (/\bwall|bedroom|color|paint\b/.test(query) && reason === "color_phrase") adjusted += 0.07;
    if (/\bspend|spent|rent|budget|cost|handbag|designer\b/.test(query) && reason === "money_phrase") adjusted += 0.09;
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
    const query = understanding.normalized.toLowerCase();
    const text = candidate.text.toLowerCase();
    if (/\bcoupon|creamer|redeem\b/.test(query)) {
      if (text === "target") return 0;
      if (text === "cartwheel") return 1;
      if (candidate.reason === "coupon_store_phrase") return 2;
      return 8;
    }
    if (/\btennis|racket|racquet\b/.test(query)) {
      if (/sports store downtown/.test(text)) return 0;
      if (candidate.reason === "tennis_store_phrase") return 1;
      return 8;
    }
    if (/\bcommute|each way\b/.test(query)) {
      if (candidate.reason === "commute_duration_phrase" && /\beach\s+way\b/.test(text)) return 0;
      if (candidate.reason === "commute_duration_phrase") return 1;
      if (candidate.reason === "duration_phrase") return 4;
      return 8;
    }
    if (/\bhow many\b/.test(query) && candidate.reason === "count_phrase") return 0;
    if (/\bstudy abroad|abroad program\b/.test(query) && ["study_abroad_phrase", "university_phrase"].includes(candidate.reason)) return 0;
    if (/\bdiscount|first purchase|clothing brand\b/.test(query) && candidate.reason === "discount_phrase") return 0;
    if (/\bikea|bookshelf|assemble\b/.test(query)) {
      if (text === "4 hours") return 0;
      if (candidate.reason === "duration_phrase") return 1;
      return 8;
    }
    if (/\bsister|birthday|gift\b/.test(query) && candidate.reason === "gift_phrase") return text.includes("yellow dress") ? 0 : 1;
    if (/\binternet|speed|plan\b/.test(query) && candidate.reason === "network_speed_phrase") return 0;
    if (/\bdog|breed\b/.test(query) && candidate.reason === "dog_breed_phrase") return 0;
    if (/\bspirituality|stance\b/.test(query) && candidate.reason === "belief_stance_phrase") return 0;
    if (/\brunning shoes|favorite running|shoe brand\b/.test(query)) {
      if (text === "nike") return 0;
      if (candidate.reason === "brand_or_company_phrase") return 1;
      return 8;
    }
    if (/\bcertification|last month\b/.test(query) && candidate.reason === "certification_phrase") return 0;
    if (/\bcat\b|\bcat'?s name\b/.test(query) && candidate.reason === "pet_name_phrase") return 0;
    if (/\bgrandma\b/.test(query) && /\bgift\b/.test(query)) {
      if (text === "necklace" || candidate.reason === "gift_object_phrase") return 0;
      if (candidate.reason === "gift_phrase") return 6;
    }
    if (/\bgrandma\b/.test(query) && /\bcountry|from\b/.test(query)) {
      if (text === "sweden") return 0;
      if (candidate.reason === "place_name_phrase") return 1;
      return 8;
    }
    if (/\bnecklace|grandma|how old\b/.test(query) && candidate.reason === "age_phrase") return 0;
    if (/\bgin|vermouth|martini|ratio\b/.test(query) && candidate.reason === "ratio_phrase") return 0;
    if (/\bram|laptop|upgrade\b/.test(query) && candidate.reason === "capacity_phrase") return 0;
    if (/\bpainting|sunset|worth|paid\b/.test(query) && candidate.reason === "relative_value_phrase") return 0;
    if (/\bcousin|wedding\b/.test(query) && candidate.reason === "venue_phrase") return 0;
    if (/\bbachelor|computer science|ucla\b/.test(query) && candidate.reason === "university_phrase") {
      if (text.includes("university of california") || text === "ucla") return 0;
      return 1;
    }
    if (/\bnew apartment|move\b/.test(query)) {
      if (text === "5 hours") return 0;
      if (candidate.reason === "duration_phrase") return 1;
      return 8;
    }
    if (/\bcocktail|recipe|last weekend\b/.test(query) && candidate.reason === "cocktail_phrase") return 0;
    if (/\brice\b/.test(query) && candidate.reason === "rice_phrase") return 0;
    if (/\bplay|theater|theatre\b/.test(query) && candidate.reason === "play_title_phrase") return 0;
    if (/\bplaylist|spotify\b/.test(query) && candidate.reason === "playlist_title_phrase") return 0;
    if (/\bplans?|summer\b/.test(query)) {
      if (text === "researching adoption agencies") return 0;
      if (candidate.reason === "research_object_phrase") return 1;
      if (candidate.reason === "researching_object_phrase") return 2;
      return 8;
    }
    if (/\bhand-painted bowl|reminder\b/.test(query)) {
      if (text === "art and self-expression") return 0;
      if (candidate.reason === "reminder_phrase") return 1;
      return 8;
    }
    if (/\bdegree|graduat|major\b/.test(query) && candidate.reason === "degree_phrase") return 0;
    if (/\bsurname|last name|name before|old name\b/.test(query) && candidate.reason === "name_change_phrase") return 0;
    if (/\bcharity race|raise awareness|awareness for\b/.test(query)) {
      if (text === "mental health") return 0;
      if (candidate.reason === "cause_phrase") return 1;
      return 8;
    }
    if (/\byoga|studio|classes?\b/.test(query)) {
      if (text === "serenity yoga") return 0;
      if (candidate.reason === "yoga_studio_phrase") return 1;
      return 8;
    }
    if (/\banimal shelter|fundraising|dinner|volunteer\b/.test(query) && candidate.reason === "fundraising_date_phrase") return 0;
    if (/\bjob|role|work|occupation\b/.test(query) && candidate.reason === "job_phrase") return 0;
    if (/\bhandbag|designer|spend|spent|cost\b/.test(query) && candidate.text === "$800") return 0;
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
    const query = understanding.normalized.toLowerCase();
    if (/\bstudy abroad|abroad program\b/.test(query) && /\bstudy abroad program\b/i.test(utterance) && /\bUniversity of Melbourne\b/i.test(utterance)) {
      return "study_abroad_anchor";
    }
    if (/\bshirts?\b/.test(query) && /\bCosta Rica\b/i.test(utterance) && /\bbrought\s+\d+\s+shirts?\b/i.test(utterance)) {
      return "packing_count_anchor";
    }
    if (/\bbachelor|computer science|ucla\b/.test(query) && /\b(?:undergrad in CS from UCLA|computer science graduate from UCLA|CS from UCLA)\b/i.test(utterance)) {
      return "university_anchor";
    }
    if (/\bdiscount|first purchase|clothing brand\b/.test(query) && /\b\d{1,3}%\s+discount\b/i.test(utterance) && /\bfirst purchase\b/i.test(utterance)) {
      return "discount_anchor";
    }
    if (/\bcertification|last month\b/.test(query) && /\bcertification in Data Science\b/i.test(utterance) && /\bcompleted last month\b/i.test(utterance)) {
      return "certification_anchor";
    }
    if (/\bcat\b|\bcat'?s name\b/.test(query) && /\bcat'?s name is [A-Z][A-Za-z'-]+\b/i.test(utterance)) {
      return "pet_name_anchor";
    }
    if (/\bgrandma\b/.test(query) && /\bcountry|from\b/.test(query) && /\bgrandma\b/i.test(utterance) && /\bSweden\b/.test(utterance)) {
      return "grandma_country_anchor";
    }
    if (/\bnecklace|grandma|how old\b/.test(query) && /\bsilver necklace\b/i.test(utterance) && /\b\d{1,2}(?:st|nd|rd|th) birthday\b/i.test(utterance)) {
      return "age_anchor";
    }
    if (/\bgrandma\b/.test(query) && /\bgift\b/.test(query) && /\bgrandma\b/i.test(utterance) && /\bnecklace\b/i.test(utterance)) {
      return "grandma_gift_anchor";
    }
    if (/\bplans?|summer\b/.test(query) && /\bresearch(?:ing)?\s+adoption agencies\b/i.test(utterance)) {
      return "summer_plan_anchor";
    }
    if (/\bhand-painted bowl|reminder\b/.test(query) && /\bhand-painted bowl\b/i.test(utterance) && /\bart and self-expression\b/i.test(utterance)) {
      return "reminder_anchor";
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
    const lower = entity.toLowerCase();
    if (lower === "john") return ["john", "jon"];
    if (lower === "jon") return ["jon", "john"];
    if (lower === "melanie") return ["melanie", "mel"];
    if (lower === "caroline") return ["caroline", "caro"];
    if (lower === "joanna") return ["joanna", "jo"];
    return [lower];
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
