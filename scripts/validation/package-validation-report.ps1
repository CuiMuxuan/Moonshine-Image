param(
  [Parameter(Mandatory = $true)] [string] $ReportDir,
  [Parameter(Mandatory = $true)] [string] $OutputZip
)

$ErrorActionPreference = "Stop"
$resolvedReportDir = (Resolve-Path -LiteralPath $ReportDir).Path
$resolvedOutputZip = [System.IO.Path]::GetFullPath($OutputZip)
$parent = Split-Path -Parent $resolvedOutputZip
New-Item -ItemType Directory -Path $parent -Force | Out-Null
Compress-Archive -Path (Join-Path $resolvedReportDir "*") -DestinationPath $resolvedOutputZip -Force
Write-Output (ConvertTo-Json @{ reportDir = $resolvedReportDir; outputZip = $resolvedOutputZip } -Compress)
