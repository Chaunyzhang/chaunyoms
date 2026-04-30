param(
  [string]$RunRoot = "artifacts/evals/formal-2026-04-29/standard-full-sf",
  [string]$BaseUrl = "https://api.siliconflow.cn/v1",
  [string]$Model = "deepseek-ai/DeepSeek-V4-Flash",
  [int]$LongMemEvalCases = 500,
  [int]$LongMemEvalMaxSessions = 60,
  [string]$PersonaMemSizes = "32k,128k,1M",
  [switch]$AllowPaidApi
)

$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
$env:NODE_NO_WARNINGS = "1"
if ($AllowPaidApi) {
  $env:CHAUNYOMS_EVAL_ALLOW_PAID = "1"
}
$paidApiArgs = if ($AllowPaidApi) { @("--allow-paid-api") } else { @() }

New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null
$manifest = Join-Path $RunRoot "manifest.jsonl"
$driverLog = Join-Path $RunRoot "driver.log"

function Write-Manifest {
  param([hashtable]$Record)
  $Record.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  ($Record | ConvertTo-Json -Compress -Depth 8) | Add-Content -Path $manifest -Encoding UTF8
}

function Invoke-Benchmark {
  param(
    [string]$Name,
    [string[]]$Command,
    [string]$OutDir
  )
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $log = Join-Path $OutDir "background.log"
  Write-Manifest @{ name = $Name; phase = "start"; outDir = $OutDir; command = ($Command -join " ") }
  "[$(Get-Date -Format o)] START $Name" | Tee-Object -FilePath $driverLog -Append | Tee-Object -FilePath $log -Append
  $oldErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Command[0] $Command[1..($Command.Length - 1)] 2>&1 | Tee-Object -FilePath $log -Append
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }
  "[$(Get-Date -Format o)] END $Name exit=$exit" | Tee-Object -FilePath $driverLog -Append | Tee-Object -FilePath $log -Append
  Write-Manifest @{ name = $Name; phase = "end"; outDir = $OutDir; exitCode = $exit }
}

Write-Manifest @{
  name = "standard-benchmark-driver"
  phase = "start"
  runRoot = $RunRoot
  baseUrl = $BaseUrl
  model = $Model
  allowPaidApi = [bool]$AllowPaidApi
  longMemEvalCases = $LongMemEvalCases
  longMemEvalMaxSessions = $LongMemEvalMaxSessions
  personaMemSizes = $PersonaMemSizes
}

"[$(Get-Date -Format o)] npm run build" | Tee-Object -FilePath $driverLog -Append
npm run build 2>&1 | Tee-Object -FilePath $driverLog -Append

Invoke-Benchmark -Name "locomo-standard" -OutDir (Join-Path $RunRoot "locomo-standard") -Command @(
  "node", "scripts/run-locomo-standard.cjs",
  "--data", "artifacts/datasets/locomo/locomo10.json",
  "--out-dir", (Join-Path $RunRoot "locomo-standard"),
  "--base-url", $BaseUrl,
  "--model", $Model
) + $paidApiArgs

Invoke-Benchmark -Name "longmemeval-s-standard" -OutDir (Join-Path $RunRoot "longmemeval-s-standard") -Command @(
  "node", "scripts/run-longmemeval-siliconflow.cjs",
  "--data", "artifacts/datasets/longmemeval/longmemeval_s_cleaned.json",
  "--out-dir", (Join-Path $RunRoot "longmemeval-s-standard"),
  "--cases", "$LongMemEvalCases",
  "--max-sessions", "$LongMemEvalMaxSessions",
  "--base-url", $BaseUrl,
  "--model", $Model
) + $paidApiArgs

foreach ($size in $PersonaMemSizes.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) {
  $out = Join-Path $RunRoot "personamem-$size-standard"
  Invoke-Benchmark -Name "personamem-$size-standard" -OutDir $out -Command @(
    "node", "scripts/run-personamem-standard.cjs",
    "--questions", "artifacts/datasets/personamem/questions_$size.csv",
    "--contexts", "artifacts/datasets/personamem/shared_contexts_$size.jsonl",
    "--out-dir", $out,
    "--base-url", $BaseUrl,
    "--model", $Model
  ) + $paidApiArgs
}

Invoke-Benchmark -Name "prefeval10-standard" -OutDir (Join-Path $RunRoot "prefeval10-standard") -Command @(
  "node", "scripts/run-prefeval10-standard.cjs",
  "--root", "artifacts/external/PrefEval",
  "--out-dir", (Join-Path $RunRoot "prefeval10-standard"),
  "--inter-turns", "10",
  "--forms", "explicit,implicit-choice,implicit-persona",
  "--base-url", $BaseUrl,
  "--model", $Model
) + $paidApiArgs

Write-Manifest @{ name = "standard-benchmark-driver"; phase = "complete"; runRoot = $RunRoot }
"[$(Get-Date -Format o)] all standard benchmarks complete" | Tee-Object -FilePath $driverLog -Append
