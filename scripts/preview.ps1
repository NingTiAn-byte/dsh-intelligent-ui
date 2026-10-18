param([string]$Harness = $env:DSH_SOURCE, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path $PSScriptRoot
if ($Harness) { $env:DSH_SOURCE = $Harness }
Push-Location $pluginRoot
try {
  $previewArgs = @('scripts/preview.mjs')
  if ($NoOpen) { $previewArgs += '--no-open' }
  & node @previewArgs
  if ($LASTEXITCODE -ne 0) { throw 'Preview failed' }
} finally { Pop-Location }
