# Step 4 Session Runtime Plan

## Goal

Make lifecycle and after-turn behavior independently modifiable by reducing how much `ChaunyomsSessionRuntime` owns directly.

## Scope For This Pass

1. Keep `ChaunyomsSessionRuntime` as the public lifecycle facade.
2. Extract bounded internal services instead of rewriting behavior.
3. Focus on:
   - after-turn orchestration
   - navigation artifact writes
   - project registry updates
   - ingest-specific runtime decisions

## Current Verification Baseline

- `npm test`
- `node dist/src/tests/test-navigation-write-on-compaction.js`
- `node dist/src/tests/test-project-routing-and-organization.js`
- `node scripts/run-openclaw-real-smoke.cjs --out-dir artifacts/evals/refactor-step-4-smoke`

## First Extraction Order

1. `NavigationArtifactService`
2. `ProjectRegistryUpdater`
3. `SessionAfterTurnService`
4. `SessionIngestPolicy/Service` only where the seam is already stable

## Stop Conditions

- navigation writes stop appearing after compaction
- project routing or organization tests drift
- real smoke final answer changes unexpectedly
- after-turn ordering becomes ambiguous
