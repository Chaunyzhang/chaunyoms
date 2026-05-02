# Step 3 Profile Policy Plan

## Goal

Introduce a single `OpenClawProfilePolicy` so `lightweight` and `standard` behavior stops being scattered across retrieval and session runtime code.

## Scope For This Pass

1. Move profile-specific recall-routing decisions behind one policy.
2. Move profile-specific after-turn / assemble decisions behind the same policy.
3. Keep `ChaunyomsSessionRuntime` and `RetrievalDecisionService` as facades over the new policy.
4. Avoid changing storage layout or public entrypoints.

## Current Verification Baseline

- `npm test`
- `node dist/src/tests/test-openclaw-lightweight-afterturn-compacts.js`
- `node dist/src/tests/test-openclaw-lightweight-summary-fallback.js`
- `node scripts/run-openclaw-real-smoke.cjs --out-dir artifacts/evals/refactor-step-3-smoke`

## Policy Surface To Extract

The policy should answer:

- when `lightweight` disables user-message knowledge-intent classification
- when `lightweight` excludes MemoryItems from assembly
- when lightweight recall guidance should be injected
- when lightweight after-turn compaction should run
- when lightweight recall should force summary/DAG-first routing

## Stop Conditions

- lightweight after-turn compaction stops firing when it should
- lightweight summary fallback drifts
- short real smoke changes user-visible replies unexpectedly
