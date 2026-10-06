# verify-install.ps1 — opencode-db-insight one-click install self-verification.
# Run from anywhere after git push:  pwsh <repo>/scripts/verify-install.ps1
#
# First run installs the plugin (opencode plugin add); later runs update it
# (opencode plugin update). Then the same chain verifies either path:
#   local HEAD pushed -> install/update -> plugin list commit match ->
#   on-disk installed version match -> installed file tree mirrors the
#   repo (src/test counts) -> host opencode.json registration.
# Prints a PASS/FAIL line per check; exits 0 only when every check passes.
#
# Note: `opencode plugin add/update` returns BEFORE the install lands on
# disk, so the script polls the host registry and the install stamps
# instead of racing them. This verifies the DISK state only — the running
# host still needs a full restart to actually load the new code.
param(
  [string]$PluginId = "github:dubuqiangu/opencode-db-insight",
  [int]$InstallTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path $PSScriptRoot -Parent
$script:failures = 0

function Assert-Check {
  param([string]$Label, [bool]$Condition, [string]$Detail = "")
  $suffix = if ($Detail) { "  ($Detail)" } else { "" }
  if ($Condition) {
    Write-Output ("PASS  " + $Label + $suffix)
  } else {
    Write-Output ("FAIL  " + $Label + $suffix)
    $script:failures++
  }
}

function Count-Files {
  param([string]$Directory)
  if (-not (Test-Path $Directory)) { return 0 }
  return @(Get-ChildItem $Directory -Recurse -File).Count
}

# What will actually ship: git-tracked files only. Untracked local artifacts
# (e.g. insight-exports/) must not trip the mirror check.
function Count-TrackedFiles {
  param([string]$RepositoryRoot, [string]$Path)
  $trackedPaths = git -C $RepositoryRoot ls-files -- $Path
  if (-not $trackedPaths) { return 0 }
  return @($trackedPaths).Count
}

# Newest install stamp that actually contains a complete package (partial
# installs from an in-flight update have no node_modules yet).
function Resolve-InstalledPackage {
  param([string]$CacheRoot)
  $stamps = Get-ChildItem $CacheRoot -Directory -Filter "git-opencode-db-insight-*" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue } |
    Sort-Object Name -Descending
  foreach ($stamp in $stamps) {
    $packageDir = Join-Path $stamp.FullName "node_modules\opencode-db-insight"
    if (Test-Path (Join-Path $packageDir "package.json")) { return $packageDir }
  }
  return $null
}

function Read-ListedCommit {
  $listLine = (opencode plugin list 2>$null | Select-String -Pattern "db-insight" | Select-Object -First 1).Line
  if (-not $listLine) { return $null }
  $plainLine = $listLine -replace "$([char]27)\[[0-9;]*m", ""
  foreach ($token in ($plainLine -split "\s+")) {
    if ($token -match "^[0-9a-f]{7,}$") { return $token }
  }
  return $null
}

# --- expected state, derived from the local repo (fail fast if unpushed) ------------
$packageJson = Get-Content (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedVersion = $packageJson.version
$localHead = (git -C $repoRoot rev-parse --short HEAD).Trim()
# Derive the upstream ref from the branch config instead of assuming a branch name.
$upstreamRef = (git -C $repoRoot rev-parse --abbrev-ref "@{upstream}" 2>$null | Out-String).Trim()
if (-not $upstreamRef) {
  Assert-Check "local HEAD is pushed (upstream branch configured)" $false "current branch has no upstream; push with -u first"
} else {
  $originHead = (git -C $repoRoot rev-parse --short $upstreamRef).Trim()
  Assert-Check "local HEAD is pushed (HEAD == $upstreamRef)" ($localHead -eq $originHead) "HEAD=$localHead origin=$originHead"
}

$expectedSrcCount = Count-TrackedFiles $repoRoot "src"
$expectedTestCount = Count-TrackedFiles $repoRoot "test"

# --- install-or-update: first run does `plugin add`, later runs `plugin update` -----
$hostConfigPath = Join-Path $env:USERPROFILE ".config\opencode\opencode.json"
$hostConfig = if (Test-Path $hostConfigPath) {
  Get-Content $hostConfigPath -Raw -Encoding UTF8
} else { "" }
$firstInstall = -not $hostConfig.Contains($PluginId)
if ($firstInstall) {
  Write-Output ("first install — running: opencode plugin add " + $PluginId)
} else {
  Write-Output ("already registered — running: opencode plugin update " + $PluginId)
}
Push-Location $env:USERPROFILE
try {
  $installOutput = if ($firstInstall) {
    (opencode plugin add $PluginId 2>&1 | Out-String).Trim()
  } else {
    (opencode plugin update $PluginId 2>&1 | Out-String).Trim()
  }
} finally {
  Pop-Location
}
Write-Output ("install: " + $installOutput)

# --- wait until the host registry reflects the pushed commit -----------------------
$installedCommit = $null
$installDeadline = (Get-Date).AddSeconds($InstallTimeoutSeconds)
while ((Get-Date) -lt $installDeadline) {
  $installedCommit = Read-ListedCommit
  if ($installedCommit -eq $localHead) { break }
  Start-Sleep -Seconds 2
}
Assert-Check "plugin list shows the pushed commit" ($installedCommit -eq $localHead) "installed=$installedCommit expected=$localHead"

# --- on-disk installed package (poll: the stamp lands slightly late) ----------------
$cacheRoot = Join-Path $env:USERPROFILE ".cache\opencode\npm"
$installedPkg = $null
$installedVersion = $null
$diskDeadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $diskDeadline) {
  $installedPkg = Resolve-InstalledPackage $cacheRoot
  if ($installedPkg) {
    $installedVersion = (Get-Content (Join-Path $installedPkg "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if ($installedVersion -eq $expectedVersion) { break }
  }
  Start-Sleep -Seconds 2
}
Assert-Check "on-disk installed version matches package.json" ($installedVersion -eq $expectedVersion) "installed=$installedVersion expected=$expectedVersion"

$installedSrcCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "src") } else { -1 }
$installedTestCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "test") } else { -1 }
Assert-Check "installed src tree mirrors the repo" ($installedSrcCount -eq $expectedSrcCount) "installed=$installedSrcCount repo=$expectedSrcCount"
Assert-Check "installed test tree mirrors the repo" ($installedTestCount -eq $expectedTestCount) "installed=$installedTestCount repo=$expectedTestCount"

# --- host registration (re-read: plugin add rewrites opencode.json) ----------------
$hostConfig = if (Test-Path $hostConfigPath) {
  Get-Content $hostConfigPath -Raw -Encoding UTF8
} else { "" }
Assert-Check "plugin registered in opencode.json" ($hostConfig.Contains($PluginId))

Write-Output "----"
if ($script:failures -eq 0) {
  Write-Output ("VERIFY OK — v$expectedVersion @ $localHead fully installed")
  exit 0
}
Write-Output ("VERIFY FAILED — $script:failures check(s) failed")
exit 1
