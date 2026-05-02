# OMS standard memory benchmark status

This document separates **standard benchmark datasets** from project unit tests and from older OMS-native smoke suites.

## What counts as standard here

| Benchmark | Standard source | Local source path | OMS runner | Full run scope |
| --- | --- | --- | --- | --- |
| LOCOMO-10 | `snap-research/locomo` dataset; protocol cross-checked against `mem0ai/memory-benchmarks/benchmarks/locomo` | `D:\chaunyoms\artifacts\datasets\locomo\locomo10.json` | `D:\chaunyoms\scripts\run-locomo-standard.cjs` | 10 conversations, categories `1,2,3,4` by default |
| LongMemEval-S | cleaned LongMemEval-S dataset used by the existing OMS runner | `D:\chaunyoms\artifacts\datasets\longmemeval\longmemeval_s_cleaned.json` | `D:\chaunyoms\scripts\run-longmemeval-siliconflow.cjs` | 500 cases, up to 60 haystack sessions by default |
| PersonaMem | official `bowen-upenn/PersonaMem` HuggingFace dataset | `D:\chaunyoms\artifacts\datasets\personamem\questions_*.csv` and `shared_contexts_*.jsonl` | `D:\chaunyoms\scripts\run-personamem-standard.cjs` | `32k`, `128k`, and `1M` splits |
| PrefEval-10 | official `amazon-science/PrefEval` benchmark repo/dataset | `D:\chaunyoms\artifacts\external\PrefEval\benchmark_dataset` | `D:\chaunyoms\scripts\run-prefeval10-standard.cjs` | explicit + implicit-choice + implicit-persona, `inter_turns=10` |

## Important correction

Older LOCOMO artifacts such as `D:\chaunyoms\artifacts\evals\formal-2026-04-29\locomo-full-source-recall-suite.json` are **not** the final standard benchmark protocol. They are useful as deterministic source-recall diagnostics, but they must not be reported as public-comparison LOCOMO scores.

MiniMax failed runs that returned unsupported-plan/model errors are also **not valid benchmark scores**.

## How to run the full standard set

The full set is intentionally outside `D:\chaunyoms\src\tests`. Unit tests should stay fast and deterministic; benchmark corpora belong under `D:\chaunyoms\artifacts`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-standard-benchmarks.ps1 -AllowPaidApi
```

The driver writes a manifest and per-benchmark logs under:

```text
D:\chaunyoms\artifacts\evals\formal-2026-04-29\standard-full-sf-active
```

Default judge/reader route:

- The driver now runs an explicit API preflight before the first benchmark.
- Base URL/model resolution is dynamic:
  - OpenClaw real-environment config is the default source of truth:
    `~/.openclaw/openclaw.json -> agents.defaults.model.primary -> models.providers`
  - `CHAUNYOMS_EVAL_BASE_URL` or explicit `-BaseUrl` wins
  - otherwise MiniMax is preferred when `MINIMAX_API_KEY` is present
  - otherwise the fallback is `https://api.siliconflow.cn/v1`
- Model resolution is dynamic:
  - `CHAUNYOMS_EVAL_MODEL` or explicit `-Model` wins
  - otherwise OMS follows the real OpenClaw primary model and provider API shape
- API key resolution: `CHAUNYOMS_EVAL_API_KEY` first, then provider-specific keys.

External model calls are blocked unless `-AllowPaidApi`, `--allow-paid-api`, or `CHAUNYOMS_EVAL_ALLOW_PAID=1` is set. This prevents accidental paid benchmark runs.

Override example:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-standard-benchmarks.ps1 `
  -RunRoot artifacts/evals/formal-2026-04-29/standard-full-custom `
  -BaseUrl https://api.siliconflow.cn/v1 `
  -Model deepseek-ai/DeepSeek-V4-Flash `
  -AllowPaidApi
```

Fast smoke example:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-standard-benchmarks.ps1 `
  -RunRoot artifacts/evals/verify-standard/driver-smoke `
  -LocomoCases 1 `
  -LongMemEvalCases 1 `
  -PersonaMemSizes 32k `
  -PersonaMemCases 1 `
  -PrefEvalCases 1 `
  -AllowPaidApi
```

## Reporting rule

Only report a score as a benchmark score when:

1. The run used one of the standard dataset sources above.
2. The run completed without provider/model-plan errors.
3. The `summary.json` and `run-meta.json` are present in the run directory.
4. The model/provider used for answer generation and judging is recorded.

If a run is interrupted, report it as an in-progress or failed run, not as a final score.
