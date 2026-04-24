# Verification Suite

This repo now verifies ChaunyOMS on four layers:

## 1. Unit and focused regression tests

Run:

```powershell
npm test
```

This covers:

- routing
- summary DAG traversal and integrity
- knowledge promotion
- project registry updates
- runtime ingress normalization
- config preset guidance
- semantic candidate fallback
- failure corpus regression
- long-session replay

## 2. Failure corpus

Failure corpus scenarios live in:

- [src/tests/fixtures/failure-corpus.json](/D:/chaunyoms/src/tests/fixtures/failure-corpus.json)

They lock degraded behavior such as:

- recall disabled fallback
- vector hint without authority
- embeddings-required prompt behavior

Run directly:

```powershell
npm run failure-corpus
```

## 3. Replay benchmark

Run:

```powershell
npm run benchmark
```

The benchmark prints structured JSON including:

- boot time
- ingest plus after-turn time
- retrieval time
- summary counts
- branch vs leaf counts
- recall hit count

The benchmark is not a hard performance gate yet. It is a repeatable measurement entrypoint.

## 4. Formal memory evaluation

Run:

```powershell
npm run eval:memory
```

This is the scored evaluation layer.

It writes reports under:

- `artifacts/evals/memory-eval-report.json`
- `artifacts/evals/memory-eval-report.md`

Metrics currently include:

- pass rate
- route accuracy
- exact fact recovery
- source verification
- knowledge update success
- project state success
- abstention success
- false recall rate
- average / p50 / p95 latency

## 5. CI

GitHub Actions now runs:

- `npm test`
- `npm run eval:memory`
- `npm run benchmark`
- `npm audit --omit=dev`

Workflow file:

- [.github/workflows/ci.yml](/D:/chaunyoms/.github/workflows/ci.yml)

## What this still is not

This is a strong repo-local validation layer, but it is still not the final ceiling.

Still worth adding later:

- retained benchmark history across commits
- larger real-session replay datasets
- explicit latency/error budgets
- flaky-test quarantine and reporting
