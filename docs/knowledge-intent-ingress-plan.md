# Knowledge Intent Ingress Plan

## Decision

Knowledge-base write intent should be tagged when a user message enters the runtime ingestion path, not inferred only later by keyword matching during summary-to-knowledge promotion.

The durable signal is `rawMessage.metadata.knowledgeIntent`. Downstream knowledge intake should prefer this metadata over text regexes.

## Why

- Keyword matching is brittle for Chinese phrasing and product usage.
- LLM intent classification can distinguish "remember this", "discuss whether to remember", and ordinary mentions of a knowledge base.
- Early tagging keeps the knowledge write signal attached to the raw source message, so compaction, summaries, knowledge candidates, and source trace all share the same origin.

## Implementation Shape

- Add a lightweight ingress classifier for user messages.
- Use the host LLM only when `knowledgeIntakeUserOverrideEnabled` is true and an LLM caller is available.
- Store a small metadata object:
  - `intent`: `promote_to_knowledge` or `none`
  - `confidence`: numeric confidence
  - `reason`: short reason
  - `target`: optional target such as `knowledge_base` or `wiki`
  - `classifier`: `llm` or `fallback_phrase`
- KnowledgeMaintenanceService should check `knowledgeIntent.intent === "promote_to_knowledge"` before phrase/regex fallback.

## Guardrails

- Tool outputs are not classified for knowledge promotion.
- Assistant messages are not treated as user override requests.
- LLM failure must not block raw message persistence.
- The fallback phrase matcher remains as a safety net, not the primary product path.
- Promotion still obeys review and knowledge governance settings.

## Implemented

- `KnowledgeIntentClassifier` now classifies explicit write-to-knowledge intent before raw message persistence.
- `ChaunyomsSessionRuntime.ingest` and `RuntimeIngressService.syncRuntimeMessages` attach the classifier result to user raw-message metadata.
- `KnowledgeMaintenanceService` consumes `rawMessage.metadata.knowledgeIntent` before falling back to phrase matching.
- Fallback phrases are still present for no-LLM or LLM-failure cases, but they are no longer the primary product path.
- Regression coverage includes LLM-positive, LLM-negative, Chinese fallback phrase, and end-to-end knowledge candidate promotion.
- A broad prefilter skips LLM classification for ordinary user messages with no save/remember/wiki/knowledge-style cues.
- Classification logs `knowledge_intent_classified` with latency so real OpenClaw sessions can be checked for overhead.
- Knowledge promotion is review-first by default; tests that need automatic Markdown promotion opt out explicitly.

## Watch Next

- Watch OpenClaw logs for `knowledge_intent_classified` latency in real sessions.
- If latency is still visible, make the prefilter configurable and tighten/loosen cue terms from observed false positives and false negatives.
- Keep promotion governance separate: classification means "the user asked to save", not "this content is automatically trusted knowledge."
