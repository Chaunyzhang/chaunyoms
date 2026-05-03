# ChaunyOMS Real OpenClaw Test Protocol

## One Allowed Flow

This is the only supported real OpenClaw test flow for this repo.
This document is the only source of truth for that flow. Do not restate,
fork, or reinterpret these rules in roadmap docs, tool descriptions, dashboard
flows, background QA tools, or benchmark harnesses.

1. Send one material chunk to OpenClaw as a normal user message.
2. Wait until OpenClaw finishes that turn and replies.
3. Send the next material chunk to the same OpenClaw conversation.
4. Wait until OpenClaw finishes that turn and replies.
5. Repeat until all material chunks have been sent.
6. Outside the harness, inspect/wait for the normal OpenClaw/OMS after-turn work
   to be ready enough for the test.
7. Start a new OpenClaw conversation for the formal question so visible context
   from the material conversation is cleared.
8. Send the formal question in that new conversation.
9. Wait until OpenClaw finishes that question turn and replies.
10. Outside the harness, inspect the OpenClaw transcript/logs and optional OMS
   runtime report.

Do not ask the answer in the material conversation.

The material conversation exists only to provide source material and trigger
normal OpenClaw/OMS after-turn work. The question conversation must be fresh so
the answer has to come from OMS/OpenClaw memory behavior, not from visible
conversation context.

Do not use any other real OpenClaw test method.

For QA-style questions, the allowed responsibilities are strictly split:

- The sender harness sends one message and waits for the OpenClaw turn to end.
- OpenClaw LLM is the driver. It decides to call OMS tools from the fresh
  question conversation, reads the tool result, and produces the formal
  user-visible answer.
- OMS is only a tool/service provider. It may ingest, summarize, compact,
  index, retrieve, expand, and return evidence, but it must not be treated as
  the answerer or as a harness-side judge.
- Codex inspects transcript/runtime evidence outside the harness and judges
  whether the flow and answer are correct.
- The required retrieval path is:
  `OpenClaw LLM calls OMS tool -> OMS follows summary/sourceRefs/source_edges
  back to nearby raw source -> OMS returns raw evidence -> OpenClaw LLM answers`.

Automatic context assembly can still exist as an OpenClaw integration detail,
but it is not the primary acceptance path for real summary-subsystem QA. A run
passes only when the OpenClaw transcript shows the LLM itself used the OMS tool
surface and then answered from the returned evidence.

For tests whose purpose is to validate the summary subsystem, this expectation
is a hard acceptance criterion, not a preference:

- The formal question must run with direct raw recall disabled
  (`forceDagOnlyRecall=true` / `disableDirectRawRecall=true`).
- The OpenClaw transcript must show an OpenClaw LLM-initiated `memory_search`,
  `memory_retrieve`, `memory_get`, `oms_expand`, or equivalent OMS memory tool
  call for the formal question.
- The OMS tool result must show a summary route such as `summary_tree` /
  `summary_tree_recall`, or an equivalent summary-derived source trace.
- The evidence must trace from summary/sourceRefs/source_edges to raw source
  messages near the answer-bearing turn.
- `raw_exact_search`, message FTS, raw table scan hits, filesystem reads, or
  exec/search tools are not acceptable substitutes for summary-derived evidence
  in a summary-subsystem test.
- If no summary path expands to nearby raw evidence returned by an OMS tool, the
  test result is a retrieval-chain failure even when OpenClaw's final text
  happens to match the expected answer.
- Do not report answer accuracy for a summary-subsystem test unless transcript
  and runtime evidence both show the OpenClaw LLM tool call chain and the OMS
  summary-to-raw evidence path.

## Message Rule

Each message sent to OpenClaw must be under roughly 3000 tokens.

This limit applies only to the user-message text sent through ACP. It does not
limit local transcript inspection, log reading, runtime DB reports, or final
analysis.

## Timing Rule

When reporting quality or performance, separate retrieval time from environment
latency.

Use OMS runtime/context diagnostics for retrieval timing and candidate-shaping
costs. Do not treat harness elapsed time, ACP connection time, gateway cold
start, provider/model queueing, model generation, or transcript/log inspection
as retrieval time.

Harness `durationMs` is only an end-to-end send observation. It is useful for
spotting environment instability, but it must not be used as the retrieval-speed
score.

## Harness Boundary

The harness is only a sender.

It may:

- start `openclaw acp`
- create an ACP session
- send one user message from a case file
- record that send's `stopReason` and elapsed time
- write a small send report under `artifacts/evals/...`

It must not:

- parse OpenClaw's final assistant reply
- read `sessions.json`
- read transcript JSONL
- read the OMS runtime SQLite DB
- collect retrieval evidence
- run smoke checks
- judge or score answers
- decide whether summaries or compaction are ready

All result inspection happens outside the harness.

## Sequential Send Command

Use one sender process per user message.

Reuse the same material `--session-key` while sending material chunks. Use a
different question `--session-key` for the formal question:

```powershell
$materialSessionKey = "agent:main:harness-my-real-test-material"
$questionSessionKey = "agent:main:harness-my-real-test-question"

node scripts/run-openclaw-real-smoke.cjs `
  --case-file artifacts\evaluations\material-001.md `
  --out-dir artifacts\evals\my-real-test\material-001 `
  --session-key $materialSessionKey

node scripts/run-openclaw-real-smoke.cjs `
  --case-file artifacts\evaluations\material-002.md `
  --out-dir artifacts\evals\my-real-test\material-002 `
  --session-key $materialSessionKey

# After all material turns finish, inspect/wait outside the harness for
# OpenClaw/OMS after-turn work to be ready enough for this test.
# The formal question must use a fresh session key.

node scripts/run-openclaw-real-smoke.cjs `
  --case-file artifacts\evaluations\formal-question.md `
  --out-dir artifacts\evals\my-real-test\formal-question `
  --session-key $questionSessionKey
```

Each per-message case file has exactly one turn:

```markdown
## Turn 1
User message text goes here.
```

## Inspection After Sending

After the formal question turn finishes, resolve the real OpenClaw `sessionId`
from the question `sessionKey`:

```powershell
$sessionKey = "agent:main:harness-my-real-test-question"
$store = Join-Path $env:USERPROFILE ".openclaw\agents\main\sessions\sessions.json"
$entry = (Get-Content $store -Raw | ConvertFrom-Json).PSObject.Properties[$sessionKey].Value
$entry.sessionId
```

Read the OpenClaw transcript:

```powershell
$file = Join-Path $env:USERPROFILE ".openclaw\agents\main\sessions\$($entry.sessionId).jsonl"
Get-Content $file -Tail 120
```

Optional OMS runtime diagnostic:

```powershell
node --experimental-sqlite scripts\openclaw-runtime-report.cjs --session=<sessionId>
```

This diagnostic is external inspection only. It is not part of the harness and
it does not replace reading the OpenClaw transcript.

## Explicitly Forbidden Real-Test Alternatives

Do not use these as real OpenClaw tests:

- one ACP process containing multiple material/question turns
- background QA worker flows such as `oms_test_start` or `qa_start`
- dashboard-driven real-test flows
- direct `openclaw agent` CLI driving
- OMS-native benchmark runners as substitutes for real OpenClaw conversation
- asking the formal question in the same visible conversation used to send
  material
- harness-side answer capture, harness-side evidence capture, or harness-side
  judging

If a run does not follow the exact material-conversation then fresh-question-
conversation sequence above, it is not a valid real OpenClaw test for this repo.
