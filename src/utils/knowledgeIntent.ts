export type KnowledgeIntentClassifierName = "llm" | "fallback_phrase";

export interface KnowledgeIntentSignal {
  intent: "promote_to_knowledge" | "none";
  confidence: number;
  reason: string;
  target?: "knowledge_base" | "wiki" | "memory" | "unspecified";
  classifier: KnowledgeIntentClassifierName;
  latencyMs?: number;
}

const KNOWLEDGE_INTENT_CUE_RE =
  /(\bremember\b|\bsave\b|\bstor(?:e|ing)\b|\bpreserve\b|\bkeep\b|\bnote\b|\bwiki\b|\bknowledge\b|\bdoctrine\b|\bpolicy\b|\brule\b|\bguideline\b|\bcanonical\b|\breusable\b|\u8bb0\u4f4f|\u8bb0\u4e0b|\u4fdd\u5b58|\u5b58\u5230|\u653e\u8fdb|\u653e\u5230|\u52a0\u5165|\u5199\u8fdb|\u5199\u5230|\u6c89\u6dc0|\u77e5\u8bc6\u5e93|\u77e5\u8bc6|wiki|\u89c4\u5219|\u89c4\u8303|\u957f\u671f|\u4ee5\u540e|\u590d\u7528|\u56fa\u5b9a\u4e0b\u6765)/i;

const DEFAULT_KNOWLEDGE_OVERRIDE_PHRASES = [
  "\u8bb0\u4f4f\u8fd9\u4e2a",
  "\u8bb0\u4f4f\u8fd9\u6761",
  "\u8bb0\u4e0b\u6765",
  "\u5e2e\u6211\u8bb0\u4e00\u4e0b",
  "\u4fdd\u5b58\u8fd9\u4e2a",
  "\u4fdd\u5b58\u4e3a\u77e5\u8bc6",
  "\u653e\u8fdb\u77e5\u8bc6\u5e93",
  "\u653e\u5230\u77e5\u8bc6\u5e93",
  "\u5b58\u5230\u77e5\u8bc6\u5e93",
  "\u52a0\u5165\u77e5\u8bc6\u5e93",
  "\u6c89\u6dc0\u5230\u77e5\u8bc6\u5e93",
  "\u5199\u8fdbwiki",
  "\u5199\u8fdb wiki",
  "\u5199\u5230wiki",
  "\u5199\u5230 wiki",
  "\u653e\u8fdbwiki",
  "\u653e\u8fdb wiki",
  "remember this",
  "remember this for later",
  "save this to knowledge",
  "put this in the knowledge base",
  "put this in knowledge base",
  "add this to wiki",
  "store this in the knowledge base",
  "store this in knowledge base",
];

export function hasKnowledgeIntentCue(content: string): boolean {
  return KNOWLEDGE_INTENT_CUE_RE.test(content);
}

export function detectKnowledgeIntentPhrase(content: string): KnowledgeIntentSignal | null {
  const normalized = content.toLowerCase().replace(/\s+/g, " ");
  const phrase = DEFAULT_KNOWLEDGE_OVERRIDE_PHRASES.find((candidate) =>
    normalized.includes(candidate.toLowerCase()),
  );
  if (!phrase) {
    return null;
  }
  return {
    intent: "promote_to_knowledge",
    confidence: 0.76,
    reason: `explicit phrase: ${phrase}`,
    target: /wiki/i.test(phrase) ? "wiki" : "knowledge_base",
    classifier: "fallback_phrase",
  };
}

export function isPromoteKnowledgeIntent(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.intent === "promote_to_knowledge" &&
    typeof record.confidence === "number" &&
    record.confidence >= 0.5;
}
