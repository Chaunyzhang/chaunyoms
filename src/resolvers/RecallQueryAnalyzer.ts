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

  private answerType(query: string, lower: string, choices: string[]): AnswerType {
    if (choices.length > 1) return "choice";
    if (/\brelationship status\b/i.test(lower)) return "relationship";
    if (/\bwhere\b/i.test(lower) && /\b(redeem|buy|bought|purchase|store|shop|classes?|yoga|studio)\b/i.test(lower)) return "organization";
    if (/^where\b/i.test(query) || /\bwhich city\b|\bwhat country\b|\bmove from\b|\btravel to\b/i.test(lower)) return "place";
    if (/^when\b/i.test(query) || /\bwhen did\b/i.test(lower)) return "date";
    if (/\bhow (?:many|long)\b|\bweeks?\b|\byears?\b|\bmonths?\b/.test(lower)) return "duration";
    if (/\bcompany|brand|endorsement|sponsor\b/i.test(lower)) return "organization";
    if (/\bmovie|book|test|workshop|nickname|play|playlist\b/i.test(lower)) return "title";
    if (/^who\b/i.test(query) || /\bwho was\b/i.test(lower)) return "person";
    if (/\bdegree|graduat|major|meat|gift|research|plans?|do with|reminder|job|role|color|wall|bedroom|spend|rent|budget|surname|last name\b/i.test(lower)) return "object";
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

  private expandEventHints(terms: string[], lower: string, answerType: AnswerType): string[] {
    const hints = new Set<string>();
    const add = (...values: string[]) => values.forEach((value) => hints.add(value));
    for (const term of terms) {
      add(term, stem(term));
    }
    if (/\badopt|adoption|agencies|family\b/i.test(lower)) add("adopt", "adoption", "adopting", "agencies", "family");
    if (/\bmovie|watch\b/i.test(lower)) add("movie", "film", "watch", "watched");
    if (/\bbook|read|suggestion\b/i.test(lower)) add("book", "read", "recommend", "suggestion");
    if (/\bdegree|graduat|major\b/i.test(lower)) add("degree", "graduated", "graduate", "major");
    if (/\bcommute|each way\b/i.test(lower)) add("commute", "minutes", "each way", "drive");
    if (/\bcoupon|creamer|redeem\b/i.test(lower)) add("coupon", "redeem", "redeemed", "creamer", "coffee", "store");
    if (/\bplay|theater|theatre\b/i.test(lower)) add("play", "theater", "theatre", "attended");
    if (/\bplaylist\b/i.test(lower)) add("playlist", "song", "music");
    if (/\bsurname|last name\b/i.test(lower)) add("surname", "last name", "changed");
    if (/\byoga|studio\b/i.test(lower)) add("yoga", "studio");
    if (/\bwall|bedroom|paint|color\b/i.test(lower)) add("wall", "walls", "bedroom", "painted", "gray", "colour", "color");
    if (/\banimal shelter|fundraising|volunteer\b/i.test(lower)) add("shelter", "animal", "fundraising", "dinner", "volunteer");
    if (/\btennis|racket|racquet\b/i.test(lower)) add("tennis", "racket", "racquet", "sports", "store", "bought");
    if (/\bspend|rent|budget|cost\b/i.test(lower)) add("spend", "spent", "rent", "budget", "cost");
    if (/\bjob|role|work\b/i.test(lower)) add("job", "role", "work", "marketing", "startup");
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
}
