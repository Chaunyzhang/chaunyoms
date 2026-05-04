# OpenClaw Standard Case Packs

This repo keeps standard test material as case packs, not as self-grading
benchmark runners.

## Plain Meaning

`summary trace verified` only means a summary can point back to source message
ids. It does not mean the current OpenClaw answer turn actually received the
answer-bearing raw text.

For real quality checks, the accepted condition is stricter:

- OMS selected a summary path for the current question.
- OMS expanded that summary/source trace to nearby raw messages.
- The raw message text was placed into OpenClaw context or returned by an OMS
  memory tool before OpenClaw answered.
- OpenClaw's final assistant reply answered from that raw evidence.
- Codex judged the transcript and runtime diagnostics outside the harness.

If the runtime only says the trace is verified but no raw source window reached
OpenClaw, the retrieval chain failed even if the final answer happens to be
right.

## Only Allowed Exam Flow

The case-pack builder may prepare files, but it must not send, inspect, score,
or judge.

Run:

```powershell
npm run openclaw:case-pack
```

The generated pack contains:

- `cases/<case>/material-001.md`, `material-002.md`, ...
- `cases/<case>/formal-question.md`
- `answer-key.jsonl`
- `manifest.json`

Send each material file with `npm run openclaw:send` and the same material
session key. After OpenClaw/OMS after-turn work is ready, send the formal
question with a fresh question session key. Codex then inspects OpenClaw's
final reply and OMS runtime diagnostics externally.

Every generated `formal-question.md` must explicitly tell OpenClaw to call the
OMS memory plugin/tool to search historical evidence before answering. This
keeps the formal question stage in the intended driver shape: OpenClaw invokes
OMS, OMS returns or injects raw evidence, and OpenClaw answers from that raw
evidence.

The same formal question prompt must also say the tool query is exactly the
full `Question:` or `User question:` text. Keyword rewrites, inferred terms, and
model-added guesses are invalid for these packs; OMS also canonicalizes a
rewritten `memory_search`/`memory_retrieve` query back to the current formal
question when it can identify one.

## Minimal Local Sources

The current minimum local standard sources are:

- LOCOMO: `artifacts/datasets/locomo/locomo10.json`
- LongMemEval-S: `artifacts/datasets/longmemeval/longmemeval_s_cleaned.json`
- PersonaMem: `artifacts/datasets/personamem/questions_32k.csv` plus
  `artifacts/datasets/personamem/shared_contexts_32k.jsonl`
- PrefEval: `artifacts/external/PrefEval/benchmark_dataset/explicit_preference/education_learning_styles.json`

These are used only to preserve material, questions, and expected answers. They
do not define an alternate exam runner.
