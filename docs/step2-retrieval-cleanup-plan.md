# Step 2 Retrieval Cleanup Plan

## Goal

Reduce the size and coupling of `ChaunyomsRetrievalService` while preserving the current public tool surface and user-visible retrieval behavior.

## Scope For This Pass

1. Extract route-decision logic first.
2. Keep `ChaunyomsRetrievalService` as the facade entrypoint.
3. Avoid behavior rewrites while moving code.
4. Prefer deletion from the facade over adding new layers of indirection.

## Current Baseline To Protect

- `npm test`
- `node dist/src/tests/test-delegated-dag-expansion.js`
- `node dist/src/tests/test-summary-dag-traversal.js`
- `node scripts/run-openclaw-real-smoke.cjs --case-file src/tests/fixtures/openclaw-real-smoke-case.md --out-dir artifacts/evals/refactor-step-2-smoke`

## First Extraction Seam

Create a dedicated route-decision service responsible for:

- retrieval route choice
- planner interaction
- planner validation handoff
- route-plan / explanation packaging

`ChaunyomsRetrievalService` should continue to own:

- tool entrypoints
- runtime store access
- recall execution
- diagnostics attachment

## Stop Conditions

- exact-anchor recall broadens or loses source precision
- delegated DAG tests drift
- real smoke final answer changes unexpectedly
