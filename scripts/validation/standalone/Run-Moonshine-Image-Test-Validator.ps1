[CmdletBinding()]
param(
  [switch] $MetadataOnly,
  [switch] $SkipOffline,
  [switch] $NoOpenExplorer,
  [string] $OutputRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $bundleRoot "validator-config.json"
$nodePath = Join-Path $bundleRoot "node.exe"
$validatorPath = Join-Path $bundleRoot "scripts\validation\run-release-validation.mjs"
$publicKeyPath = Join-Path $bundleRoot "release-public-key.pem"

function Protect-Text {
  param([AllowNull()][object] $Value)
  $text = [string]$Value
  if ([string]::IsNullOrEmpty($text)) { return $text }

  foreach ($secretName in @(
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ACCOUNT_ID",
    "R2_ENDPOINT",
    "MOONSHINE_MANIFEST_PRIVATE_KEY_PEM",
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN"
  )) {
    $text = [regex]::Replace($text, "(?im)^\s*" + [regex]::Escape($secretName) + "\s*=.*$", "$secretName=<REDACTED>")
  }

  if ($env:USERPROFILE) {
    $text = $text.Replace($env:USERPROFILE, "<USERPROFILE>")
    $escapedProfile = $env:USERPROFILE.Replace("\", "\\")
    $text = $text.Replace($escapedProfile, "<USERPROFILE>")
  }
  if ($env:USERNAME) { $text = $text.Replace($env:USERNAME, "<USER>") }
  $text = [regex]::Replace($text, "(?i)(token|secret|password|private.?key)\s*[=:]\s*[^\s,;]+", '$1=<REDACTED>')
  $text = [regex]::Replace($text, "(?i)(https?://[^\s?]+)[^\s]*[?&](token|sig|signature|secret)=[^\s&]+", '$1?<REDACTED>=<REDACTED>')
  return $text
}

function Write-JsonFile {
  param([string] $Path, [object] $Value)
  $json = $Value | ConvertTo-Json -Depth 12
  $json = Protect-Text $json
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function Add-PathCandidate {
  param([System.Collections.Generic.List[string]] $List, [AllowNull()][string] $Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return }
  $resolved = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
  if (-not $List.Contains($resolved)) { $List.Add($resolved) }
}

function Find-MoonshineInstall {
  $roots = New-Object 'System.Collections.Generic.List[string]'
  $sources = New-Object 'System.Collections.Generic.List[string]'

  foreach ($registryPath in @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )) {
    try {
      foreach ($entry in @(Get-ItemProperty -Path $registryPath -ErrorAction SilentlyContinue)) {
        if ([string]$entry.DisplayName -like "Moonshine-Image*") {
          Add-PathCandidate $roots ([string]$entry.InstallLocation)
          $icon = [string]$entry.DisplayIcon
          if ($icon) {
            Add-PathCandidate $roots (($icon -replace ',\d+$', '') | Split-Path -Parent)
          }
          $sources.Add("registry")
        }
      }
    } catch {
      # Registry provider access is optional on locked-down machines.
    }
  }

  foreach ($commonRoot in @(
    (Join-Path $env:LOCALAPPDATA "Programs\Moonshine-Image"),
    (Join-Path $env:LOCALAPPDATA "Moonshine-Image"),
    (Join-Path $env:ProgramFiles "Moonshine-Image"),
    (Join-Path ${env:ProgramFiles(x86)} "Moonshine-Image")
  )) {
    Add-PathCandidate $roots $commonRoot
    $sources.Add("common-path")
  }

  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    $exe = Join-Path $root "Moonshine-Image.exe"
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
      return [ordered]@{ installRoot = $root; appExecutable = $exe; source = ($sources -join ",") }
    }
    $nested = @(Get-ChildItem -LiteralPath $root -Filter "Moonshine-Image.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($nested.Count -gt 0) {
      return [ordered]@{ installRoot = $root; appExecutable = $nested[0].FullName; source = ($sources -join ",") }
    }
  }

  return [ordered]@{ installRoot = $null; appExecutable = $null; source = "not-found" }
}

function Get-ActiveEnvironmentInfo {
  $userData = Join-Path $env:APPDATA "Moonshine-Image"
  $activePath = Join-Path $userData "environments\active.json"
  if (-not (Test-Path -LiteralPath $activePath -PathType Leaf)) {
    return [ordered]@{ userData = $userData; environmentRoot = $null; flavor = $null; activePointer = $null }
  }
  try {
    $active = Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json
    $flavor = [string]$active.accelerator
    if ([string]::IsNullOrWhiteSpace($flavor)) { $flavor = [string]$active.flavor }
    if ($flavor -notin @("cpu", "cu130")) { $flavor = $null }
    return [ordered]@{
      userData = $userData
      environmentRoot = $userData
      flavor = $flavor
      activePointer = $activePath
    }
  } catch {
    return [ordered]@{ userData = $userData; environmentRoot = $null; flavor = $null; activePointer = "invalid" }
  }
}

function Get-StartupLogTail {
  $logPath = Join-Path $env:APPDATA "Moonshine-Image\logs\startup.log"
  if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
    return [ordered]@{ present = $false; lines = @() }
  }
  try {
    return [ordered]@{
      present = $true
      lines = @(Get-Content -LiteralPath $logPath -Tail 80 -ErrorAction Stop | ForEach-Object { Protect-Text $_ })
    }
  } catch {
    return [ordered]@{ present = $true; lines = @("Could not read startup log: " + (Protect-Text $_.Exception.Message)) }
  }
}

function Get-PreferredOfflineBundle {
  param([string] $Root)
  $searchRoots = New-Object 'System.Collections.Generic.List[string]'
  $searchRoots.Add($Root)
  $parent = Split-Path -Parent $Root
  if ($parent -and -not $searchRoots.Contains($parent)) { $searchRoots.Add($parent) }
  $all = New-Object 'System.Collections.Generic.List[object]'
  foreach ($searchRoot in $searchRoots) {
    if (-not (Test-Path -LiteralPath $searchRoot -PathType Container)) { continue }
    foreach ($file in @(Get-ChildItem -LiteralPath $searchRoot -Filter "Moonshine-Image-v*-win-x64-*-offline.zip" -File -ErrorAction SilentlyContinue)) {
      if (-not ($all | Where-Object { $_.FullName -eq $file.FullName })) { $all.Add($file) }
    }
  }
  if ($all.Count -eq 0) { return [ordered]@{ selected = $null; candidates = @() } }
  $nvidia = $false
  try { $nvidia = $null -ne (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) } catch { $nvidia = $false }
  $preferred = if ($nvidia) { "cu130" } else { "cpu" }
  $selected = @($all | Where-Object { $_.Name -match ("-" + $preferred + "-offline\.zip$") } | Select-Object -First 1)
  if ($selected.Count -eq 0) { $selected = @($all | Select-Object -First 1) }
  $variant = if ($selected[0].Name -match "-cu130-offline\.zip$") { "cu130" } else { "cpu" }
  return [ordered]@{
    selected = [ordered]@{ path = $selected[0].FullName; variant = $variant }
    candidates = @($all | ForEach-Object { $_.FullName })
  }
}

function Get-SystemInfo {
  $os = $null
  $computer = $null
  $gpus = @()
  try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch {}
  try { $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop } catch {}
  try {
    $gpus = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | ForEach-Object {
      [ordered]@{ name = [string]$_.Name; driverVersion = [string]$_.DriverVersion }
    })
  } catch {}
  $nvidia = $null
  try {
    $nvidiaCommand = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($nvidiaCommand) {
      $nvidia = (& $nvidiaCommand.Source "--query-gpu=name,driver_version" "--format=csv,noheader" 2>&1 | Out-String).Trim()
    }
  } catch {}
  return [ordered]@{
    os = [ordered]@{
      caption = if ($os) { [string]$os.Caption } else { $null }
      version = if ($os) { [string]$os.Version } else { $null }
      build = if ($os) { [string]$os.BuildNumber } else { $null }
      architecture = if ($os) { [string]$os.OSArchitecture } else { [string]$env:PROCESSOR_ARCHITECTURE }
    }
    powershell = $PSVersionTable.PSVersion.ToString()
    processorCount = if ($computer) { [int]$computer.NumberOfLogicalProcessors } else { $null }
    totalMemoryBytes = if ($computer) { [int64]$computer.TotalPhysicalMemory } else { $null }
    gpu = $gpus
    nvidiaSmi = Protect-Text $nvidia
  }
}

$outputDirectory = $null
$reportDirectory = $null
$exitCode = 1
$zipPath = $null
try {
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Missing validator-config.json" }
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Missing bundled node.exe" }
  if (-not (Test-Path -LiteralPath $validatorPath -PathType Leaf)) { throw "Missing bundled validator script" }
  if (-not (Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) { throw "Missing release-public-key.pem" }
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

  if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $OutputRoot = if ($desktop -and (Test-Path -LiteralPath $desktop -PathType Container)) { $desktop } else { $env:TEMP }
  }
  $outputDirectory = [IO.Path]::GetFullPath($OutputRoot)
  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  $runName = "Moonshine-Image-validation-" + (Get-Date -Format "yyyyMMdd-HHmmss")
  $reportDirectory = Join-Path $outputDirectory $runName
  New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
  $wrapperLogPath = Join-Path $reportDirectory "validator-wrapper.log"

  function Write-ValidatorLog {
    param([string] $Level, [string] $Message)
    $line = "[$((Get-Date).ToString('o'))][$Level] $(Protect-Text $Message)"
    Add-Content -LiteralPath $wrapperLogPath -Value $line -Encoding UTF8
    Write-Host $line
  }

  Write-ValidatorLog "INFO" "Starting standalone validation. Reports are local-only."
  $install = Find-MoonshineInstall
  $environment = Get-ActiveEnvironmentInfo
  $startupLog = Get-StartupLogTail
  $offline = Get-PreferredOfflineBundle -Root $bundleRoot
  $system = Get-SystemInfo
  $discovery = [ordered]@{
    installRoot = Protect-Text $install.installRoot
    appExecutable = Protect-Text $install.appExecutable
    installSource = $install.source
    userData = Protect-Text $environment.userData
    environmentRoot = Protect-Text $environment.environmentRoot
    environmentFlavor = $environment.flavor
    activePointer = Protect-Text $environment.activePointer
    offlineSelected = if ($offline.selected) { [ordered]@{ path = Protect-Text $offline.selected.path; variant = $offline.selected.variant } } else { $null }
    offlineCandidates = @($offline.candidates | ForEach-Object { Protect-Text $_ })
  }
  Write-JsonFile (Join-Path $reportDirectory "system-info.json") ([ordered]@{ generatedAt = (Get-Date).ToUniversalTime().ToString("o"); system = $system; discovery = $discovery; startupLog = $startupLog })

  $reportPath = Join-Path $reportDirectory "validation-report.json"
  $validatorArgs = @(
    $validatorPath,
    "--source", [string]$config.source,
    "--channel", [string]$config.channel,
    "--app-version", [string]$config.appVersion,
    "--public-key-file", $publicKeyPath,
    "--mode", "canary",
    "--report", $reportPath
  )
  if ($MetadataOnly) { $validatorArgs += "--metadata-only" }
  if ($install.installRoot) { $validatorArgs += @("--install-root", $install.installRoot) }
  if ($install.appExecutable) { $validatorArgs += @("--app-executable", $install.appExecutable) }
  if ($environment.environmentRoot) {
    $validatorArgs += @("--environment-root", $environment.environmentRoot)
    if ($environment.flavor) { $validatorArgs += @("--environment-flavor", $environment.flavor) }
  }
  if (-not $SkipOffline -and $offline.selected) {
    $validatorArgs += @("--offline-bundle", $offline.selected.path, "--offline-variant", $offline.selected.variant)
    Write-ValidatorLog "INFO" ("Offline bundle selected: " + $offline.selected.variant)
  }
  Write-ValidatorLog "INFO" ("Sending validation requests to " + $config.source + " channel=" + $config.channel + " version=" + $config.appVersion)
  $nodeOutput = @(& $nodePath @validatorArgs 2>&1)
  $exitCode = [int]$LASTEXITCODE
  foreach ($line in $nodeOutput) {
    $text = Protect-Text ([string]$line)
    Add-Content -LiteralPath $wrapperLogPath -Value $text -Encoding UTF8
    Write-Host $text
  }
  if (Test-Path -LiteralPath $reportPath -PathType Leaf) {
    $rawReport = Get-Content -LiteralPath $reportPath -Raw
    [IO.File]::WriteAllText($reportPath, (Protect-Text $rawReport), (New-Object System.Text.UTF8Encoding($false)))
    try {
      $reportOk = [bool]((Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json).ok)
      if ($exitCode -eq 0 -and -not $reportOk) {
        $exitCode = 1
        Write-ValidatorLog "FAIL" "Validation report contains failed checks."
      }
    } catch {
      $exitCode = 1
      Write-ValidatorLog "FAIL" ("Could not read validation report status: " + $_.Exception.Message)
    }
  }
  Write-JsonFile (Join-Path $reportDirectory "run-summary.json") ([ordered]@{
      generatedAt = (Get-Date).ToUniversalTime().ToString("o")
      ok = ($exitCode -eq 0)
      exitCode = $exitCode
      source = [string]$config.source
      channel = [string]$config.channel
      appVersion = [string]$config.appVersion
      report = "validation-report.json"
      log = "validator-wrapper.log"
      note = "This report was generated locally and was not uploaded automatically."
    })
  Write-ValidatorLog $(if ($exitCode -eq 0) { "PASS" } else { "FAIL" }) ("Validator exit code: " + $exitCode)
} catch {
  $exitCode = 1
  if (-not $reportDirectory) {
    $fallback = Join-Path $env:TEMP ("Moonshine-Image-validation-error-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
    New-Item -ItemType Directory -Force -Path $fallback | Out-Null
    $reportDirectory = $fallback
  }
  $errorPath = Join-Path $reportDirectory "launcher-error.txt"
  [IO.File]::WriteAllText($errorPath, (Protect-Text $_.Exception.ToString()), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("Validator launcher failed: " + (Protect-Text $_.Exception.Message)) -ForegroundColor Red
} finally {
  if ($reportDirectory -and (Test-Path -LiteralPath $reportDirectory -PathType Container)) {
    $zipBase = Split-Path -Leaf $reportDirectory
    $zipPath = Join-Path (Split-Path -Parent $reportDirectory) ($zipBase + ".zip")
    try {
      if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
      Compress-Archive -Path (Join-Path $reportDirectory "*") -DestinationPath $zipPath -Force
      Write-Host "Report ZIP: $(Protect-Text $zipPath)"
      if (-not $NoOpenExplorer) {
        Start-Process explorer.exe -ArgumentList ("/select,`"" + $zipPath + "`"")
      }
    } catch {
      Write-Host ("Could not create report ZIP: " + (Protect-Text $_.Exception.Message)) -ForegroundColor Yellow
    }
  }
}
exit $exitCode
