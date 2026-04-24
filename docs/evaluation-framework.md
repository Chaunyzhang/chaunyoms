# Evaluation Framework

ChaunyOMS now has a formal memory evaluation layer in addition to unit tests and benchmarks.

## Entry points

Run the formal suite:

```powershell
npm run eval:memory
```

Run the full local verification gate:

```powershell
npm run check
```

## What `eval:memory` measures

The formal suite is meant to act like a scored exam, not just a pass/fail regression check.

Current report fields:

- `passRate`
- `routeAccuracyRate`
- `exactFactRecoveryRate`
- `sourceVerificationRate`
- `knowledgeUpdateSuccessRate`
- `projectStateSuccessRate`
- `abstentionSuccessRate`
- `falseRecallRate`
- `avgLatencyMs`
- `p50LatencyMs`
- `p95LatencyMs`

Artifacts are written to:

- `artifacts/evals/memory-eval-report.json`
- `artifacts/evals/memory-eval-report.md`

## Fixture format

The suite definition lives in:

- [src/evals/fixtures/core-memory-suite.json](/D:/chaunyoms/src/evals/fixtures/core-memory-suite.json)

Each case defines:

- tags
- query mode: `retrieve` or `route`
- replay messages or a generated scenario
- optional seeded unified knowledge
- expected output substrings
- forbidden substrings
- expected detail fields
- optional source-verification / compaction expectations

## Why this exists

`npm test` answers:

> did the known behaviors break?

`npm run eval:memory` answers:

> how good is the system on a defined scored memory exam?

`npm run benchmark` answers:

> how fast and how heavy is the system under replay load?

Together they cover:

- correctness
- scored memory quality
- degraded-mode safety
- performance

## Current limitations

This is a formal internal evaluation framework, but it is not the same thing as a fully external benchmark leaderboard.

Still worth adding later:

- real anonymized replay corpora
- benchmark history across commits
- stricter grading for partial answers
- direct adapters for public memory benchmarks such as LoCoMo or LongMemEval style datasets
