param([string]$Harness = $env:DSH_SOURCE, [int]$Port = 3098, [switch]$Check, [switch]$NoOpen, [switch]$BrowserAutomation, [string]$ImageNetworkPatch = '')
$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path $PSScriptRoot
if (-not $Harness) { $Harness = Join-Path $pluginRoot '../deepseek-harness' }
$Harness = (Resolve-Path -LiteralPath $Harness).Path
$env:DSH_SOURCE = $Harness
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $pluginRoot 'artifacts\dsh-home' }
$overlay = Join-Path $pluginRoot 'preview\local.patch.yml'
New-Item -ItemType Directory -Path (Join-Path $pluginRoot 'artifacts') -Force | Out-Null
Push-Location $pluginRoot
try {
  node scripts/build.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed' }
} finally { Pop-Location }
Push-Location $Harness
try {
  $profile = Join-Path $env:DSH_HOME 'profiles\intelligent-ui\package.json'
  if (-not (Test-Path -LiteralPath $profile)) {
    # This is the exact command behind the repository's `pnpm dsh` script.
    & node --import tsx/esm apps/cli/src/bin.ts --profile intelligent-ui --from-default-profile web --patch $overlay --dump-config | Set-Content -LiteralPath (Join-Path $pluginRoot 'artifacts\composed-config.yml') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'DSH profile composition failed' }
  }
  if ($Check) {
    $checkArgs = @('--profile', 'intelligent-ui', '--patch', $overlay, '--dump-config')
    if ($ImageNetworkPatch) { $checkArgs += @('--patch', $ImageNetworkPatch) }
    & node --import tsx/esm apps/cli/src/bin.ts @checkArgs
  } else {
    $launchArgs = @('--profile', 'intelligent-ui', '--patch', $overlay, '--port', [string]$Port)
    if ($ImageNetworkPatch) { $launchArgs += @('--patch', $ImageNetworkPatch) }
    if ($BrowserAutomation) { $launchArgs += @('--patch', (Join-Path $Harness 'apps/web/tests/pin-browse-picker.overlay.yml')) }
    if ($NoOpen) { $launchArgs += '--no-open' }
    & node --import tsx/esm apps/cli/src/bin.ts @launchArgs
  }
  if ($LASTEXITCODE -ne 0) { throw 'DSH launcher failed' }
} finally { Pop-Location }
