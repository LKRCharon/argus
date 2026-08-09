[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$DaemonArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Find-BunBinary {
  $candidates = @()
  if ($env:BUN_BIN) { $candidates += $env:BUN_BIN }

  $pathBun = Get-Command bun.exe -ErrorAction SilentlyContinue
  if ($pathBun -and $pathBun.CommandType -eq "Application") {
    $candidates += $pathBun.Source
  }

  $candidates += (Join-Path $env:USERPROFILE ".bun\bin\bun.exe")
  $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path -LiteralPath $wingetRoot) {
    Get-ChildItem -LiteralPath $wingetRoot -Directory -Filter "Oven-sh.Bun_*" -ErrorAction SilentlyContinue |
      ForEach-Object { $candidates += (Join-Path $_.FullName "bun-windows-x64\bun.exe") }
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $candidate
    }
  }
  return $null
}

function Find-NativeCodexBinary {
  if ($env:CODEX_BIN -and (Test-Path -LiteralPath $env:CODEX_BIN -PathType Leaf)) {
    return $env:CODEX_BIN
  }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { return $null }

  $globalRoot = & $npm.Source root -g 2>$null | Select-Object -First 1
  if (-not $globalRoot) { return $null }
  $globalRoot = $globalRoot.Trim()

  $scope = Join-Path $globalRoot "@openai"
  if (-not (Test-Path -LiteralPath $scope)) { return $null }

  $package = Get-ChildItem -LiteralPath $scope -Directory -Filter "codex-win32-*" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $package) { return $null }

  $candidate = Join-Path $package.FullName "vendor\x86_64-pc-windows-msvc\bin\codex.exe"
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  return $null
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$daemon = Join-Path $repoRoot "packages\daemon\src\index.ts"
if (-not (Test-Path -LiteralPath $daemon -PathType Leaf)) {
  throw "Cannot find the agentlink daemon at $daemon"
}

if (-not $env:AGENTLINK_HOME) {
  $env:AGENTLINK_HOME = Join-Path $env:LOCALAPPDATA "Argus\agentlink"
}
New-Item -ItemType Directory -Path $env:AGENTLINK_HOME -Force | Out-Null

if (-not $env:AGENTLINK_DEVICE_NAME) { $env:AGENTLINK_DEVICE_NAME = $env:COMPUTERNAME }
if (-not $env:AGENTLINK_DEVICE_PLATFORM) { $env:AGENTLINK_DEVICE_PLATFORM = "windows" }
if (-not $env:CODEX_BIN) {
  $nativeCodex = Find-NativeCodexBinary
  if ($nativeCodex) { $env:CODEX_BIN = $nativeCodex }
}

$bun = Find-BunBinary
if (-not $bun) {
  throw "Bun was not found. Set BUN_BIN or install Bun before starting Argus Host."
}

$relay = if ($env:AGENTLINK_RELAY) { $env:AGENTLINK_RELAY } else { "wss://relay.limen.codes/ws" }
$env:AGENTLINK_RELAY = $relay
Write-Host "[argus-host] device=$env:AGENTLINK_DEVICE_NAME platform=$env:AGENTLINK_DEVICE_PLATFORM"
Write-Host "[argus-host] state=$env:AGENTLINK_HOME relay=$relay"
if ($env:CODEX_BIN) { Write-Host "[argus-host] codex=$env:CODEX_BIN" }
else { Write-Warning "No native Codex CLI was found. Set CODEX_BIN before using Codex controls." }

& $bun run $daemon @DaemonArgs
exit $LASTEXITCODE
