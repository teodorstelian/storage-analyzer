param([string]$RigPulsePath = (Join-Path $PSScriptRoot '..\rig-pulse'))
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RigPulsePath).Path
$config = Join-Path $repo 'prometheus\prometheus.yml'
$dashboardDir = Join-Path $repo 'grafana\dashboards'
if (!(Test-Path -LiteralPath (Join-Path $repo 'compose.yaml')) -or !(Test-Path -LiteralPath $config) -or !(Test-Path -LiteralPath $dashboardDir)) { throw 'Expected the Rig Pulse Compose, Prometheus and Grafana directories.' }
$original = [IO.File]::ReadAllText($config)
if ($original -match 'job_name:\s*[''"]?drive-health') { throw 'drive-health already exists. Review that job instead of adding a duplicate.' }
# This installer supports the existing Rig Pulse layout, with scrape_configs last.
if ($original -notmatch '(?ms)^scrape_configs:\s*\r?\n(?:[ \t].*|\r?\n)*\z') { throw 'Unexpected Prometheus layout: add the README scrape job manually.' }
$backup = "$config.drive-health-$(Get-Date -Format yyyyMMddHHmmss).bak"
Copy-Item -LiteralPath $config -Destination $backup
$job = @'

  - job_name: drive-health
    scrape_interval: 30s
    static_configs:
      - targets: ['host.docker.internal:9431']
'@
try {
  [IO.File]::WriteAllText($config, $original.TrimEnd() + "`n" + $job + "`n", [Text.UTF8Encoding]::new($false))
  & docker compose --project-directory $repo exec -T prometheus promtool check config /etc/prometheus/prometheus.yml
  if ($LASTEXITCODE -ne 0) { throw 'Prometheus configuration validation failed.' }
} catch {
  [IO.File]::WriteAllText($config, $original, [Text.UTF8Encoding]::new($false))
  throw
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'grafana\drive-health.json') -Destination (Join-Path $dashboardDir 'drive-health.json')
Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'http://127.0.0.1:9090/-/reload' | Out-Null
Write-Host "Installed. Backup: $backup"
Write-Host 'Grafana will discover the dashboard within 10 seconds. Verify the drive-health target at http://127.0.0.1:9090/targets'
