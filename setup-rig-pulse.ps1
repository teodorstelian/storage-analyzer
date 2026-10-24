param([string]$RigPulsePath = (Join-Path $PSScriptRoot '..\rig-pulse'))
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RigPulsePath).Path
if (!(Test-Path -LiteralPath (Join-Path $repo 'compose.yaml'))) { throw 'Expected a Rig Pulse repository.' }
Write-Host 'Rig Pulse now owns the scrape configuration and Grafana dashboards.'
Write-Host "In $repo\.env, set ENABLE_DRIVE_HEALTH=true."
Write-Host "Then run from $repo : docker compose up -d --force-recreate"
Write-Host 'Enable exporting metrics in Drive Health as well. No files were copied or changed.'
