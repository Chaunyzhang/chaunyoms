# ChaunyOMS Decoupling Refactor Plan

## Purpose

This document defines the preferred refactor direction for ChaunyOMS so that:

1. external entrypoints stay unified
2. internal modules have narrow responsibilities
3. behavior changes can be isolated and tested
4. future model, storage, and retrieval changes can be swapped without destabilizing the whole plugin

The intent is **not** to rewrite ChaunyOMS from scratch.
The intent is to preserve the current product behavior while reducing coupling inside the implementation.

## Non-Negotiables

These are the rules for the refactor.

1. User-visible OpenClaw behavior must remain the primary acceptance target.
2. Public entrypoints stay stable while internals move behind interfaces.
3. Every refactor step must be followed by a small real-environment smoke test.
4. If a step makes real-environment diagnosis harder, stop and restore observability before continuing.
5. Prefer extraction and routing over large behavior rewrites.

## Current Hotspots

The repo already has meaningful package-level structure, but several core files are carrying too many responsibilities.

Main hotspots:

- [ChaunyomsRetrievalService.ts](D:/chaunyoms/src/runtime/ChaunyomsRetrievalService.ts)
  Large application service that currently combines:
  route choice, planner integration, semantic expansion, evidence gate, rerank policy, OpenClaw profile override, formatting, diagnostics, and tool response shaping.

- [ChaunyomsSessionRuntime.ts](D:/chaunyoms/src/runtime/ChaunyomsSessionRuntime.ts)
  Large lifecycle owner that currently combines:
  bootstrap, ingest, assemble, compact, after-turn, navigation writes, project registry updates, and background work scheduling.

- [OpenClawPayloadAdapter.ts](D:/chaunyoms/src/host/OpenClawPayloadAdapter.ts)
  Large host adapter that currently combines:
  payload parsing, config resolution, model resolution, compatibility checking, runtime message extraction, and OpenClaw-specific heuristics.

- [SQLiteRuntimeStore.ts](D:/chaunyoms/src/data/SQLiteRuntimeStore.ts)
  Large infrastructure surface that currently combines:
  schema creation, FTS, vector/graph scaffolding, runtime records, usage stats, trace storage, and some domain-shaping behavior.

These files are not "bad" files.
They are just the current concentration points.
They make future updates more fragile because unrelated changes meet in the same file.

## Target Shape

The target architecture is:

### 1. Unified External Entry Layer

Keep only a few stable entrypoints visible from outside:

- OpenClaw lifecycle entrypoints
- OpenClaw tool entrypoints
- benchmark / smoke script entrypoints
- admin/report entrypoints

Everything else should be internal.

### 2. Thin Application Orchestration Layer

These classes coordinate work.
They should not contain deep domain logic.

Suggested orchestration services:

- `LifecycleOrchestrator`
- `RetrievalOrchestrator`
- `CompactionOrchestrator`
- `KnowledgeOrchestrator`
- `AdminOrchestrator`

### 3. Policy / Domain Layer

These modules contain the rules.
They should be pure or nearly pure.

Suggested policy modules:

- `RetrievalRoutePolicy`
- `OpenClawProfilePolicy`
- `EvidenceSelectionPolicy`
- `CompactionPolicy`
- `ProjectProjectionPolicy`
- `IngressFilteringPolicy`

### 4. Infrastructure Layer

These modules implement storage and host-specific behavior.
They must not decide product policy.

Suggested infrastructure modules:

- `OpenClawConfigReader`
- `OpenClawSessionStoreReader`
- `SQLiteMessageDao`
- `SQLiteSummaryDao`
- `SQLiteRuntimeRecordDao`
- `SQLiteFtsIndex`
- `SQLiteUsageDao`

## Recommended Module Boundaries

### Boundary A: Host Adapter

Current role:

- Parse OpenClaw payloads
- Resolve config
- Normalize runtime messages
- Resolve model and context window

Recommended split:

- `OpenClawPayloadReader`
  Reads raw host payload into a typed host envelope.

- `OpenClawConfigResolver`
  Converts host config + plugin config into `BridgeConfig`.

- `OpenClawModelResolver`
  Resolves current OpenClaw primary model, runtime model, fallback model, and model context window.

- `OpenClawRuntimeMessageExtractor`
  Extracts runtime message arrays only.

- `OpenClawCompatibilityInspector`
  Performs slot/plugin compatibility checks only.

Stable surface:

- `OpenClawPayloadAdapter.resolveLifecycleContext()`
- `OpenClawPayloadAdapter.resolveIngestPayload()`

These can remain, but internally should delegate to the smaller pieces above.

### Boundary B: Runtime Lifecycle

Current role:

- bootstrap
- ingest
- assemble
- compact
- afterTurn
- write navigation
- update project registry

Recommended split:

- `SessionBootstrapService`
- `SessionIngestService`
- `SessionAssembleService`
- `SessionAfterTurnService`
- `NavigationArtifactService`
- `ProjectRegistryUpdater`

Stable surface:

- `ChaunyomsSessionRuntime.bootstrap`
- `ChaunyomsSessionRuntime.ingest`
- `ChaunyomsSessionRuntime.assemble`
- `ChaunyomsSessionRuntime.compact`
- `ChaunyomsSessionRuntime.afterTurn`

These remain the public lifecycle API, but should mostly forward into the smaller services.

### Boundary C: Retrieval

Current role:

- choose route
- run planner
- run summary/raw recall
- run semantic expansion
- run evidence verifier
- shape final text and details

Recommended split:

- `RetrievalDecisionService`
  Inputs: query, context, runtime status.
  Output: normalized decision object.

- `RecallExecutionService`
  Inputs: decision, query, stores.
  Output: raw recall result.

- `EvidenceResolutionService`
  Inputs: recall result.
  Output: evidence gate, verifier, answer candidates.

- `RetrievalPresentationService`
  Inputs: recall + evidence result.
  Output: tool text + details envelope.

- `RetrievalAuditService`
  Inputs: decision + execution result.
  Output: planner audit / usage feedback / diagnostics persistence.

Stable surface:

- `executeMemoryRoute`
- `executeMemoryRetrieve`
- `executeOmsGrep`
- `executeOmsExpand`
- `executeOmsTrace`
- `executeOmsReplay`

These remain the public tool surface, but internally should dispatch into the smaller services.

### Boundary D: Runtime Ingress

Current role:

- classify runtime messages
- drop wrappers/control-plane
- align with OpenClaw session store
- import raw runtime messages

Current structure is already closer to the target than the rest.

Recommended shape:

- Keep [RuntimeMessageIngress.ts](D:/chaunyoms/src/runtime/RuntimeMessageIngress.ts) as the policy surface
- Keep [RuntimeIngressService.ts](D:/chaunyoms/src/runtime/RuntimeIngressService.ts) as the orchestration surface
- Do not move retrieval logic into these files

This part is already one of the cleaner seams in the codebase and should be preserved.

### Boundary E: Runtime Store

Current role:

- schema creation
- writes
- reads
- FTS
- vector setup
- runtime records
- usage feedback
- source/trace edges

Recommended split:

- `RuntimeSchemaManager`
- `RawMessageDao`
- `SummaryDao`
- `MemoryItemDao`
- `RuntimeRecordDao`
- `TraceEdgeDao`
- `FtsIndex`
- `UsageFeedbackDao`
- `VectorIndexAdapter`

Stable surface:

- `SQLiteRuntimeStore`

This should remain as a facade, but it should delegate internally to smaller DAOs instead of continuing to accumulate mixed concerns.

## Interface Strategy

The easiest way to improve stability is to create replaceable ports before moving behavior.

Recommended ports:

- `ModelResolverPort`
- `RuntimeMessageSourcePort`
- `RetrievalRoutePolicyPort`
- `RecallExecutorPort`
- `EvidenceResolverPort`
- `NavigationWriterPort`
- `ProjectProjectionPort`
- `RuntimeStorePort`

Each port should be small and explicit.
Do not create giant "service interfaces" that simply mirror existing god classes.

## Refactor Sequence

This is the recommended order.

The order matters because it keeps observability intact while coupling is reduced.

### Step 0: Freeze Baselines

Goal:

- lock current behavior before structural movement

Work:

- identify current smoke commands and benchmark commands
- record one clean local `npm test`
- record one real short smoke
- record one benchmark result

Required verification after the step:

```powershell
npm test
node scripts/preflight-eval-model.cjs --out artifacts/evals/real-openclaw-preflight.json --allow-paid-api
node scripts/run-openclaw-real-smoke.cjs --out-dir artifacts/evals/refactor-step-0-smoke
npm run benchmark
```

Pass criteria:

- `npm test` green
- real smoke returns a correct user-visible answer
- benchmark still runs and prints retrieve latency

Stop if:

- baseline itself is unstable

### Step 1: Split Host Adapter Internals

Goal:

- make OpenClaw-specific logic easy to reason about and replace

Work:

- extract config resolution
- extract model resolution
- extract runtime message extraction
- extract compatibility checking

Do not change public adapter methods yet.

Required verification after the step:

```powershell
npm test
node dist/src/tests/test-openclaw-model-resolution.js
node scripts/run-openclaw-real-smoke.cjs --out-dir artifacts/evals/refactor-step-1-smoke
```

Pass criteria:

- model resolution still follows OpenClaw primary model
- real smoke still uses the correct model/provider

Stop if:

- OpenClaw model or context window selection changes unexpectedly

### Step 2: Split Retrieval Orchestration

Goal:

- reduce the size and coupling of `ChaunyomsRetrievalService`

Work:

- extract route decision
- extract recall execution
- extract evidence resolution
- extract response presentation
- keep one facade class as the tool entrypoint

Required verification after the step:

```powershell
npm test
node dist/src/tests/test-delegated-dag-expansion.js
node dist/src/tests/test-summary-dag-traversal.js
node scripts/run-openclaw-real-smoke.cjs --case-file src/tests/fixtures/openclaw-real-smoke-case.md --out-dir artifacts/evals/refactor-step-2-smoke
```

Pass criteria:

- exact-anchor recall still returns the precise source
- delegated DAG selection still avoids distractor sources
- real smoke final answer remains correct

Stop if:

- exact fact recall starts broadening again

### Step 3: Introduce Profile Policies

Goal:

- remove scattered `lightweight` and `standard` logic branches

Work:

- create `OpenClawProfilePolicy`
- move profile-specific recall overrides into it
- move profile-specific after-turn decisions into it

Required verification after the step:

```powershell
npm test
node dist/src/tests/test-openclaw-lightweight-afterturn-compacts.js
node dist/src/tests/test-openclaw-lightweight-summary-fallback.js
node scripts/run-openclaw-real-smoke.cjs --out-dir artifacts/evals/refactor-step-3-smoke
```

Pass criteria:

- lightweight compaction still happens when expected
- short real smoke still works
- no drift in user-visible reply

Stop if:

- `lightweight`/`standard` behavior becomes ambiguous

### Step 4: Split Session Runtime Internals

Goal:

- make lifecycle and after-turn behavior independently modifiable

Work:

- extract `SessionAfterTurnService`
- extract `NavigationArtifactService`
- extract `ProjectRegistryUpdater`
- extract `SessionIngestService`

Keep `ChaunyomsSessionRuntime` as a facade only.

Required verification after the step:

```powershell
npm test
node dist/src/tests/test-navigation-write-on-compaction.js
node dist/src/tests/test-project-routing-and-organization.js
node scripts/run-openclaw-real-smoke.cjs --out-dir artifacts/evals/refactor-step-4-smoke
```

Pass criteria:

- compaction-triggered navigation writes still happen
- multi-project routing tests still pass
- real smoke still lands correct reply

Stop if:

- after-turn side effects become order-dependent or disappear

### Step 5: DAO-ize SQLite Runtime Store

Goal:

- make storage evolvable without destabilizing retrieval logic

Work:

- split schema management from reads/writes
- split FTS handling from core message DAO
- split usage feedback from message storage

Keep `SQLiteRuntimeStore` as the public facade.

Required verification after the step:

```powershell
npm test
node dist/src/tests/test-sqlite-runtime-store.js
npm run benchmark
```

Pass criteria:

- `npm test` still green
- runtime benchmark still completes
- retrieve latency does not regress materially

Stop if:

- FTS readiness or raw search semantics change unexpectedly

### Step 6: Normalize Real Test Surfaces

Goal:

- make real-environment testing part of the architecture, not ad hoc tooling

Work:

- keep fixture cases versioned
- keep smoke wrapper versioned
- keep preflight and runtime/session reports versioned
- ensure all required docs are in git, not local only

Required verification after the step:

```powershell
node scripts/preflight-eval-model.cjs --out artifacts/evals/refactor-step-6-preflight.json --allow-paid-api
node scripts/run-openclaw-real-smoke.cjs --out-dir artifacts/evals/refactor-step-6-smoke
```

Pass criteria:

- another machine can run the same commands with only OpenClaw configuration in place

Stop if:

- critical test knowledge still exists only in local untracked scripts

## Real Test Flow After Every Step

This is the mandatory micro real-test loop after each structural refactor step.

### Phase A: Environment Preflight

```powershell
openclaw health
node scripts/preflight-eval-model.cjs --out artifacts/evals/current-preflight.json --allow-paid-api
```

Check:

- gateway reachable
- OMS still bound to `memory` and `contextEngine`
- OpenClaw primary model still resolves correctly

### Phase B: Minimal Filter Smoke

```powershell
node scripts/run-openclaw-real-smoke.cjs --case-file src/tests/fixtures/openclaw-real-filter-smoke-case.md --out-dir artifacts/evals/current-filter-smoke
```

Check:

- final OpenClaw reply is correct
- runtime SQLite messages do not retain `[Working directory: ...]`
- runtime SQLite messages do not retain `NO_REPLY`

### Phase C: Slightly Richer Recall Smoke

```powershell
node scripts/run-openclaw-real-smoke.cjs --case-file src/tests/fixtures/openclaw-real-smoke-case.md --out-dir artifacts/evals/current-rich-smoke
```

Check:

- final OpenClaw recall answer is correct
- expected retrieval path was exercised
- no replay pollution was introduced

### Phase D: Stop Rule

Stop immediately if:

- ACP transport starts mis-ordering turns
- gateway disconnects dominate the run
- final OpenClaw reply becomes incorrect
- runtime DB regains wrapper/noise pollution

Do not continue the refactor if the debug surface is no longer trustworthy.

## Release Gates

A refactor wave is release-eligible only when:

1. `npm test` passes in a clean checkout
2. short real smoke passes
3. richer real smoke passes
4. runtime benchmark still passes

Optional but recommended:

5. standard benchmark smoke subset passes

## Recommendation

Do not attempt one giant decoupling pass.

The recommended delivery shape is:

- one architectural seam at a time
- one clean-checkout `npm test` after each seam
- one small real OpenClaw smoke after each seam

That is the best tradeoff between structural cleanup and future debug cost.
