param(
  [string]$DshCli = $env:DSH_CLI,
  [int]$Port = 3098,
  [string]$Profile = 'intelligent-ui',
  [switch]$Check,
  [switch]$NoOpen,
  [string]$ImageNetworkPatch = ''
)
$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path $PSScriptRoot
if (-not $DshCli) { $DshCli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' }
if (-not (Test-Path -LiteralPath $DshCli)) { throw 'Set DSH_CLI or -DshCli to the official rc.2 dsh launcher.' }
$version = (& $DshCli --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne '0.2.1-rc.2') { throw "Expected dsh 0.2.1-rc.2; found $version" }
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $pluginRoot 'artifacts\dsh-home' }
New-Item -ItemType Directory -Path (Join-Path $pluginRoot 'artifacts') -Force | Out-Null
Push-Location $pluginRoot
try {
  node scripts/build.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed' }
  $manifest = Join-Path $env:DSH_HOME "profiles\$Profile\package.json"
  if (-not (Test-Path -LiteralPath $manifest)) {
    & $DshCli --profile $Profile --from-default-profile web --dump-config | Set-Content (Join-Path $pluginRoot 'artifacts\composed-config.yml')
    if ($LASTEXITCODE -ne 0) { throw 'Profile creation failed' }
  }
  & $DshCli plugin --profile $Profile add $pluginRoot --ignore-scripts --config.auto-install-peers=false
  if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed' }
  $launchArgs = @('--profile', $Profile)
  if ($ImageNetworkPatch) { $launchArgs += @('--patch', (Resolve-Path -LiteralPath $ImageNetworkPatch).Path) }
  if ($Check) { $launchArgs += '--dump-config' }
  else {
    $launchArgs += @('--port', [string]$Port)
    if ($NoOpen) { $launchArgs += '--no-open' }
  }
  & $DshCli @launchArgs
  if ($LASTEXITCODE -ne 0) { throw 'DSH launcher failed' }
} finally { Pop-Location }
