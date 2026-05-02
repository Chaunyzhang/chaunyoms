# ChaunyOMS Real OpenClaw Test Protocol

## Purpose

This protocol defines the authoritative way to evaluate ChaunyOMS in a real OpenClaw environment.

The goal is not to prove that internal OMS tools can produce the right answer in isolation.
The goal is to prove that, when ChaunyOMS is installed into a real OpenClaw runtime, the final reply shown to the end user is correct, stable, and produced through the intended memory/retrieval path.

This protocol exists to prevent three common testing mistakes:

1. Treating OMS internal tool output as the final product instead of the OpenClaw user-visible reply.
2. Allowing unrelated fallback paths or direct raw-source shortcuts to silently answer the question.
3. Running benchmarks before the OpenClaw environment, plugin wiring, and external model/API path have been verified.

## Core Principle

The final judged artifact is:

`the reply that OpenClaw shows to the user`

Not:

- raw OMS tool output
- a harness-only synthetic answer
- a debug trace
- a source trace report
- a runtime DB snapshot

Internal OMS signals are evidence, not the product.

## Roles

### Builder / Evaluator Agent

The agent responsible for building or modifying the plugin is also responsible for final grading.

Responsibilities:

- install or attach ChaunyOMS to the real OpenClaw environment
- verify that the intended retrieval path is the one actually being exercised
- inspect runtime DB, logs, tool routes, and source traces
- judge whether the final OpenClaw reply is correct

### Harness

The harness is only a transport and observability aid.

Responsibilities:

- send turns into the real OpenClaw environment
- record timing
- capture logs and session artifacts
- help locate the relevant runtime DB/session id

The harness must **not** be treated as the final judge of correctness.

## Accepted Evaluation Lanes

### Lane A: Real OpenClaw Session Verification

Use this when validating:

- summary generation
- DAG navigation
- source trace integrity
- direct user-facing recall quality
- control-variable experiments such as disabling raw lookup tools

This is the highest-priority lane for product acceptance.

### Lane B: Standard Benchmark Suite

Use this when measuring larger-scale comparative quality once the real-environment lane is stable.

Standard benchmark set in this repo:

- `LoCoMo`
- `LongMemEval`
- `PersonaMem`
- `PrefEval10`

These should only be run after the environment preflight passes.

## Test Philosophy

Testing proceeds in phases. Do not skip phases.

### Phase 0: Define the Intended Retrieval Path

Before running any real test, explicitly define what is being tested.

Examples:

- `summary/DAG navigation + local source expansion`
- `direct raw-source recall disabled`
- `assistant turn ingestion from OpenClaw session store`
- `real lightweight after-turn compaction`

If a question is answered by some other path, that run does **not** validate the target feature.

### Phase 1: Real Environment Attachment

The plugin must be attached to a real OpenClaw environment through the real gateway path.

Preferred path:

- `OpenClaw + Gateway + real configured model provider + real OMS plugin`

Recommended ingress surface:

- `ACP`

Acceptable alternatives:

- direct OpenClaw CLI session driving
- real dashboard session driving

But the evaluator must clearly note which ingress path was used.

### Phase 2: Environment Preflight

Before running any scenario or benchmark, verify all of the following.

#### OpenClaw Environment

- gateway is running and reachable
- OpenClaw can create a fresh session
- the intended agent is selected
- the intended plugin is enabled
- conflicting plugins are disabled when needed for control-variable tests

#### OMS Environment

- OMS is loaded
- OMS memory slot and contextEngine slot are both bound
- expected config values are active
- runtime DB path is known
- current session can be mapped to runtime DB records

#### Model / API Environment

- expected provider is selected
- credentials are valid
- a small smoke prompt succeeds
- the API is actually being called
- there is no silent fallback to a different provider than intended

#### Test Control Variables

If the test is meant to isolate a path, verify the control variables explicitly.

Examples:

- `forceDagOnlyRecall=true`
- `lossless-claw` disabled
- `oms_grep` not registered
- no direct raw-source tool available in tool list

If the control variable cannot be verified, the run is invalid.

### Phase 3: Smoke Test

Run a minimal real scenario before any larger run.

The smoke test must prove:

- turns can be delivered in order
- assistant replies return normally
- OMS ingests user and assistant turns
- after-turn hooks execute
- summaries are attempted when expected
- no obvious queue, tick-timeout, or reconnect loop is active

If smoke is unstable, stop. Do not start benchmarks yet.

### Phase 4: Targeted Feature Validation

Run a short, deliberately designed scenario that isolates the specific feature under test.

Examples:

- store an early exact fact
- push it outside fresh context
- ask unrelated filler turns
- ask a final recall question

The evaluator must verify:

- whether summary generation occurred
- whether DAG candidates exist
- whether source trace points to the right region
- whether local expansion stays near the intended target
- whether the final OpenClaw reply is correct

### Phase 5: Standard Benchmark Execution

Only after the above phases are stable.

Run the standard suite:

- `LoCoMo`
- `LongMemEval`
- `PersonaMem`
- `PrefEval10`

During benchmark execution, the evaluator must monitor:

- API call health
- timeout rate
- per-case latency
- stuck processes
- gateway resets
- silent provider fallback
- evidence that the intended path is still active

If the benchmark begins failing due to environment instability rather than model/plugin behavior, stop and report the environment failure instead of collecting misleading scores.

## Anti-Cheating / Anti-Leak Rules

The test is invalid if the target feature is bypassed by another path.

Examples:

- testing DAG recall while direct raw-source lookup is still available
- testing summary navigation while the answer remains in fresh visible context
- testing real OpenClaw while actually falling back to a separate embedded lane
- testing OMS while another plugin answers the question through a different memory path

For any feature-focused validation, the evaluator must explicitly inspect whether an alternate path answered the question.

## Required Observability

Every real-environment run should collect, where possible:

- OpenClaw session log
- OMS runtime DB snapshot
- `after-turn` stats log
- latest `context_runs`
- selected retrieval candidates
- source trace / DAG trace
- final OpenClaw reply

These are supporting artifacts. They do not replace final grading on the user-visible reply.

## Grading Rules

### Primary Grading Rule

Grade from the user perspective:

- Did OpenClaw give the correct final reply?

### Secondary Diagnostic Rules

Only after primary grading, ask:

- Did it use the intended path?
- Did OMS summarize when expected?
- Did DAG/sourceTrace hit the intended region?
- Did local expansion stay near the target evidence?
- Did an unintended fallback answer instead?

### Example

If the final OpenClaw reply is correct but was produced through a forbidden raw fallback while the test goal was DAG-only recall:

- Product correctness: `correct`
- Feature validation: `failed`

Both must be reported separately.

## Stop Conditions

Stop and report immediately when any of the following occurs:

- gateway repeatedly closes or times out
- provider/API calls are not actually being made
- session delivery order is unstable
- the plugin is not the component under test anymore
- the control-variable constraint is violated
- the benchmark is dominated by environment errors rather than answer-quality outcomes

Do not continue a large run just to produce numbers if the environment is invalid.

## Recommended Reporting Format

Every report should clearly separate:

### 1. Environment Status

- OpenClaw state
- OMS state
- provider/API health
- active control variables

### 2. User-Visible Result

- final OpenClaw answer
- expected answer
- correct / incorrect

### 3. Retrieval Path

- intended path
- actual path
- whether fallback occurred

### 4. Stability

- per-turn latency
- timeouts
- crashes
- queue/run collisions

### 5. Decision

- pass
- fail
- invalid due to environment

## Repo Quickstart

This repo now includes a reproducible real-environment smoke path that can be reused on another machine once OpenClaw is installed and configured.

### Preconditions

1. `openclaw health` returns successfully
2. `~/.openclaw/openclaw.json` points `plugins.slots.memory` and `plugins.slots.contextEngine` to `oms`
3. The OpenClaw primary model is configured and credentials are valid
4. `npm run build` succeeds in the plugin repo

### Real Environment Preflight

```powershell
node scripts/preflight-eval-model.cjs --out artifacts/evals/real-openclaw-preflight.json --allow-paid-api
```

This must report:

- `source = openclaw_json`
- a real `modelRef`
- a live `baseUrl`
- `apiKey = set`

### Minimal Real Smoke

The fastest reusable real-user path is:

```powershell
node scripts/run-openclaw-real-smoke.cjs
```

Default case file:

- [openclaw-real-filter-smoke-case.md](D:/chaunyoms/src/tests/fixtures/openclaw-real-filter-smoke-case.md)

This wrapper performs:

1. ACP delivery into the real OpenClaw gateway
2. waits for real session-store persistence
3. captures the real OpenClaw user-visible assistant reply
4. runs OMS runtime and smoke inspection reports
5. writes a single bundle report to `artifacts/evals/.../report.json`

### Longer Real Smoke

For a slightly richer recall scenario:

```powershell
node scripts/run-openclaw-real-smoke.cjs --case-file src/tests/fixtures/openclaw-real-smoke-case.md
```

Case files:

- [openclaw-real-filter-smoke-case.md](D:/chaunyoms/src/tests/fixtures/openclaw-real-filter-smoke-case.md)
- [openclaw-real-smoke-case.md](D:/chaunyoms/src/tests/fixtures/openclaw-real-smoke-case.md)

### What To Inspect

After a smoke run, inspect:

1. `report.json`
2. the harness JSON emitted for the case
3. the real OpenClaw session file
4. `openclaw-runtime-report`
5. `openclaw-session-smoke`

For the filter-validation lane, verify specifically:

- the final OpenClaw reply is correct
- SQLite `messages` rows do not retain `[Working directory: ...]`
- SQLite `messages` rows do not retain trailing `NO_REPLY`
- replay pollution checks remain green

### Known Boundary

If `openclaw agent` or ACP gateway transport begins returning disconnects/timeouts, stop and mark the run invalid due to environment instability. Do not treat that as an OMS quality result.

## Practical Workflow Summary

1. Attach OMS to the real OpenClaw environment through ACP or another real session path.
2. Verify plugin binding, config, API, and control variables.
3. Run a small smoke test.
4. Run a targeted feature scenario and grade the final OpenClaw reply yourself.
5. Confirm the intended feature path was actually used.
6. Only then run the standard benchmark suite.
7. Stop immediately if environment errors dominate.

## Current Policy for This Repo

For ChaunyOMS release validation, the default authoritative test order is:

1. real OpenClaw environment preflight
2. real OpenClaw smoke test
3. targeted feature validation
4. standard benchmark suite

And the authoritative judge is:

`the builder/evaluator agent inspecting the real OpenClaw reply and supporting runtime evidence`

not the harness alone.
