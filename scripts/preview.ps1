param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path $PSScriptRoot
Push-Location $pluginRoot
try {
  $previewArgs = @('scripts/preview.mjs')
  if ($NoOpen) { $previewArgs += '--no-open' }
  & node @previewArgs
  if ($LASTEXITCODE -ne 0) { throw 'Preview failed' }
} finally { Pop-Location }
