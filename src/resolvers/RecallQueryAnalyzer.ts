import {
  AnswerType,
  DateHint,
  ENTITY_STOP_WORDS,
  MONTH_INDEX,
  QueryUnderstanding,
  RecallOptions,
  queryTerms,
  stem,
} from "./RecallShared";

export class RecallQueryAnalyzer {
  analyze(query: string): QueryUnderstanding {
    const normalized = query.replace(/^history\s+recall\s*:\s*/i, "").trim();
    const lower = normalized.toLowerCase();
    const terms = queryTerms(normalized);
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

  shouldUseRawFirst(understanding: QueryUnderstanding, options: RecallOptions): boolean {
    if (options.allowRawFirst === false) {
      return false;
    }
    if (options.requireRawSource) {
      return true;
    }
    // Raw-first history QA is intentionally scoped. Agent-level calls may still
    // use raw-first when SQLite/FTS has already narrowed the candidate ids; that
    // preserves exact marker recall without wide-scanning unrelated sessions.
    if (!options.sessionId && (options.rawCandidateMessageIds?.length ?? 0) === 0) {
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


  private answerType(query: string, lower: string, choices: string[]): AnswerType {
    if (choices.length > 1) return "choice";
    if (/\brelationship status\b|\b(single|married|divorced|dating)\b/i.test(lower)) return "relationship";
    if (/\bwhat\s+country\b|\bwhich\s+country\b|\bwhich\s+city\b|^where\b|\bmove(?:d)?\s+from\b|\btravel(?:ed)?\s+to\b/i.test(lower)) return "place";
    if (/\bhow\s+long\b|\b(?:minutes?|hours?|days?|weeks?|months?|years?)\b/i.test(lower)) return "duration";
    if (/^when\b/i.test(query) || /\bwhen did\b/i.test(lower)) return "date";
    if (/\bcompany|brand|endorsement|sponsor|store|shop|studio|classes?|deal\b/i.test(lower)) return "organization";
    if (/\bmovie|book|play|playlist|song|album|test|workshop|nickname|title\b/i.test(lower)) return "title";
    if (/\bwhat|which|name|degree|graduat|major|gift|research|plans?|reminder|job|role|color|paint|spend|rent|budget|cost|purchase|speed|internet|certification|breed|ratio|capacity|upgrade|worth|recipe|surname|last name|favorite|favourite|prefer\b/i.test(lower)) return "object";
    if (/^who\b/i.test(query) || /\bwho was\b/i.test(lower)) return "person";
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
    const match = lower.match(/\b([a-z][a-z-]{2,40})\b\s+or\s+(?:the\s+)?\b([a-z][a-z-]{2,40})\b/);
    if (!match) {
      return [];
    }
    return [this.normalizeChoice(match[1]), this.normalizeChoice(match[2])];
  }

  private normalizeChoice(choice: string): string {
    return choice.toLowerCase().replace(/s\b/, "");
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


  private expandEventHints(terms: string[], lower: string, answerType: AnswerType): string[] {
    const hints = new Set<string>();
    const add = (...values: string[]) => values.forEach((value) => hints.add(value));
    for (const term of terms) {
      add(term, stem(term));
    }
    if (/\bmovie|film|watch\b/i.test(lower)) add("movie", "film", "watch", "watched");
    if (/\bbook|read|suggestion\b/i.test(lower)) add("book", "read", "recommend", "suggestion");
    if (/\bdegree|graduat|major\b/i.test(lower)) add("degree", "graduated", "graduate", "major");
    if (/\bcommute|each way\b/i.test(lower)) add("commute", "minutes", "each way", "drive");
    if (/\bdiscount|purchase|redeem\b/i.test(lower)) add("discount", "purchase", "redeem", "store");
    if (/\bplay|theater|theatre\b/i.test(lower)) add("play", "theater", "theatre", "production");
    if (/\bplaylist|song|album\b/i.test(lower)) add("playlist", "song", "music", "album");
    if (/\bstudy|abroad|program\b/i.test(lower)) add("study", "abroad", "program", "university");
    if (/\binternet|speed|plan\b/i.test(lower)) add("internet", "speed", "upgraded");
    if (/\bcertification|certificate\b/i.test(lower)) add("certification", "certificate", "completed");
    if (/\bpet|animal|breed\b/i.test(lower)) add("pet", "animal", "breed", "name");
    if (/\bratio\b/i.test(lower)) add("ratio");
    if (/\bcapacity|memory|upgrade\b/i.test(lower)) add("capacity", "upgrade");
    if (/\bpaint|wall|bedroom|color\b/i.test(lower)) add("paint", "wall", "bedroom", "color");
    if (/\bcompany|brand|endorsement|sponsor|deal\b/i.test(lower)) add("company", "brand", "deal", "sponsor", "endorsement");
    if (/\bjob|role|work|occupation\b/i.test(lower)) add("job", "role", "work", "occupation");
    if (/\bspend|spent|rent|budget|cost\b/i.test(lower)) add("spend", "spent", "rent", "budget", "cost");
    if (answerType === "relationship") add("single", "married", "divorced", "dating", "relationship");
    return [...hints].filter((hint) => hint.length >= 2);
  }


}
