param(
  [string]$RunRoot = "artifacts/evals/formal-2026-04-29/standard-full-sf",
  [string]$BaseUrl = "",
  [string]$Model = "",
  [int]$LocomoCases = 0,
  [int]$LongMemEvalCases = 500,
  [int]$LongMemEvalMaxSessions = 60,
  [int]$PersonaMemCases = 0,
  [string]$PersonaMemSizes = "32k,128k,1M",
  [int]$PrefEvalCases = 0,
  [switch]$AllowPaidApi
)

$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
$env:NODE_NO_WARNINGS = "1"
if ($AllowPaidApi) {
  $env:CHAUNYOMS_EVAL_ALLOW_PAID = "1"
}
$paidApiArgs = if ($AllowPaidApi) { @("--allow-paid-api") } else { @() }
$sharedEvalArgs = @()
if ($BaseUrl) {
  $sharedEvalArgs += @("--base-url", $BaseUrl)
}
if ($Model) {
  $sharedEvalArgs += @("--model", $Model)
}
$locomoArgs = @()
if ($LocomoCases -gt 0) {
  $locomoArgs += @("--cases", "$LocomoCases")
}
$personaMemArgs = @()
if ($PersonaMemCases -gt 0) {
  $personaMemArgs += @("--cases", "$PersonaMemCases")
}
$prefEvalArgs = @()
if ($PrefEvalCases -gt 0) {
  $prefEvalArgs += @("--cases", "$PrefEvalCases")
}

New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null
$manifest = Join-Path $RunRoot "manifest.jsonl"
$driverLog = Join-Path $RunRoot "driver.log"
$preflightPath = Join-Path $RunRoot "api-preflight.json"

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
  if ($exit -ne 0) {
    throw "Benchmark '$Name' failed with exit code $exit"
  }
}

"[$(Get-Date -Format o)] preflight evaluation model" | Tee-Object -FilePath $driverLog -Append
$preflightCmd = @("node", "scripts/preflight-eval-model.cjs", "--out", $preflightPath) + $sharedEvalArgs + $paidApiArgs
& $preflightCmd[0] $preflightCmd[1..($preflightCmd.Length - 1)] 2>&1 | Tee-Object -FilePath $driverLog -Append
$preflight = Get-Content -Path $preflightPath -Raw | ConvertFrom-Json

Write-Manifest @{
  name = "standard-benchmark-driver"
  phase = "start"
  runRoot = $RunRoot
  baseUrlParam = $BaseUrl
  modelParam = $Model
  resolvedBaseUrl = $preflight.baseUrl
  resolvedModel = $preflight.model
  provider = $preflight.provider
  allowPaidApi = [bool]$AllowPaidApi
  locomoCases = $LocomoCases
  longMemEvalCases = $LongMemEvalCases
  longMemEvalMaxSessions = $LongMemEvalMaxSessions
  personaMemCases = $PersonaMemCases
  personaMemSizes = $PersonaMemSizes
  prefEvalCases = $PrefEvalCases
}

"[$(Get-Date -Format o)] npm run build" | Tee-Object -FilePath $driverLog -Append
npm run build 2>&1 | Tee-Object -FilePath $driverLog -Append

$locomoCommand = @(
  "node", "scripts/run-locomo-standard.cjs",
  "--data", "artifacts/datasets/locomo/locomo10.json",
  "--out-dir", (Join-Path $RunRoot "locomo-standard")
) + $locomoArgs + $sharedEvalArgs + $paidApiArgs
Invoke-Benchmark -Name "locomo-standard" -OutDir (Join-Path $RunRoot "locomo-standard") -Command $locomoCommand

$longMemEvalCommand = @(
  "node", "scripts/run-longmemeval-siliconflow.cjs",
  "--data", "artifacts/datasets/longmemeval/longmemeval_s_cleaned.json",
  "--out-dir", (Join-Path $RunRoot "longmemeval-s-standard"),
  "--cases", "$LongMemEvalCases",
  "--max-sessions", "$LongMemEvalMaxSessions"
) + $sharedEvalArgs + $paidApiArgs
Invoke-Benchmark -Name "longmemeval-s-standard" -OutDir (Join-Path $RunRoot "longmemeval-s-standard") -Command $longMemEvalCommand

foreach ($size in $PersonaMemSizes.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) {
  $out = Join-Path $RunRoot "personamem-$size-standard"
  $personaMemCommand = @(
    "node", "scripts/run-personamem-standard.cjs",
    "--questions", "artifacts/datasets/personamem/questions_$size.csv",
    "--contexts", "artifacts/datasets/personamem/shared_contexts_$size.jsonl",
    "--out-dir", $out
  ) + $personaMemArgs + $sharedEvalArgs + $paidApiArgs
  Invoke-Benchmark -Name "personamem-$size-standard" -OutDir $out -Command $personaMemCommand
}

$prefEvalCommand = @(
  "node", "scripts/run-prefeval10-standard.cjs",
  "--root", "artifacts/external/PrefEval",
  "--out-dir", (Join-Path $RunRoot "prefeval10-standard"),
  "--inter-turns", "10",
  "--forms", "explicit,implicit-choice,implicit-persona"
) + $prefEvalArgs + $sharedEvalArgs + $paidApiArgs
Invoke-Benchmark -Name "prefeval10-standard" -OutDir (Join-Path $RunRoot "prefeval10-standard") -Command $prefEvalCommand

Write-Manifest @{ name = "standard-benchmark-driver"; phase = "complete"; runRoot = $RunRoot }
"[$(Get-Date -Format o)] all standard benchmarks complete" | Tee-Object -FilePath $driverLog -Append
