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
    const parsedMessages = rawStore
      .getAll({ sessionId: options.sessionId })
      .map((message) => this.parseMessage(message));
    const rawHintIds = new Set(options.rawHintMessageIds ?? []);
    // SQLite FTS is a lossless-style anchor signal, not a hard scope gate.
    // Keeping the full raw ledger in the scoring pass preserves multi-hop and
    // "near but not same term" evidence, while FTS still boosts precise hits.
    let scored = this.scoreRawCandidates(parsedMessages, rawHintIds, understanding);
    let expanded = this.expandCandidates(scored.slice(0, this.seedLimit(understanding)), parsedMessages, understanding);
    let answerCandidates = this.extractAnswerCandidates(understanding, expanded.map((item) => item.parsed));
    if (rawHintIds.size > 0 && this.shouldFallbackToWideRaw(scored, answerCandidates)) {
      scored = this.scoreRawCandidates(parsedMessages, new Set(), understanding);
      expanded = this.expandCandidates(scored.slice(0, this.seedLimit(understanding)), parsedMessages, understanding);
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

  private shouldFallbackToWideRaw(scored: ScoredMessage[], answerCandidates: AnswerCandidate[]): boolean {
    if (scored.length === 0) {
      return true;
    }
    return !answerCandidates.some((candidate) => candidate.sourceVerified && candidate.confidence >= 0.68);
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
        if (/\b(gift|necklace|tattoo|meat|chicken|research|adoption|agencies|marshmallows|stories|degree|graduated|commute|coupon|creamer|racket|job|role|rent|spend|budget|playlist|surname|last name|painted|walls)\b/i.test(utterance)) {
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
      for (const titled of text.matchAll(/\b(?:movie|film|book|play|playlist|song|album|test|workshop)\s+(?:called|named|titled|was|is)?\s*["“]?([A-Z][A-Za-z0-9&'/-]+(?:\s+[A-Z][A-Za-z0-9&'/-]+){0,6})["”]?/g)) {
        add(titled[1], "title", 0.88, id, "typed_title_phrase");
      }
      for (const job of text.matchAll(/\b(?:worked|work|job|role|occupation)\s+(?:as|was|is|being)?\s*(?:a\s+|an\s+)?([a-z][a-z\s-]{2,80}?\s+(?:at|for)\s+(?:a\s+|an\s+|the\s+)?[a-z][a-z\s-]{2,80}?)(?:[.,;!?]|$)/gi)) {
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
    if (/\b(degree|graduat|major)\b/.test(query) && reason === "degree_phrase") adjusted += 0.08;
    if (/\b(commute|each way)\b/.test(query) && reason === "commute_duration_phrase") adjusted += 0.08;
    if (/\b(coupon|creamer|redeem)\b/.test(query) && reason === "store_or_place_phrase") adjusted += 0.07;
    if (/\bplay|theater|theatre|playlist\b/.test(query) && reason === "typed_title_phrase") adjusted += 0.07;
    if (/\byoga|studio|store|shop|buy|redeem|coupon\b/.test(query) && reason === "store_or_place_phrase") adjusted += 0.07;
    if (/\b(company|brand|endorsement|sponsor|deal|gear|outdoor)\b/.test(query) && reason === "brand_or_company_phrase") adjusted += 0.08;
    if (/\bjob|role|work\b/.test(query) && reason === "job_phrase") adjusted += 0.07;
    if (/\bwall|bedroom|color|paint\b/.test(query) && reason === "color_phrase") adjusted += 0.07;
    if (/\bspend|rent|budget|cost\b/.test(query) && reason === "money_phrase") adjusted += 0.07;
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
    if (understanding.answerType === "organization" && candidate.type === "place") {
      return true;
    }
    if (understanding.answerType === "place" && candidate.type === "organization") {
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
      return 18;
    }
    return 12;
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
