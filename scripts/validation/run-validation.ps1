param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $ValidatorArgs
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$nodeScript = Join-Path $PSScriptRoot "run-release-validation.mjs"
& node $nodeScript @ValidatorArgs
exit $LASTEXITCODE
