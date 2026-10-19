$ErrorActionPreference = 'Stop'
$warnings = @()
$disks = @()
try {
  $physical = @(Get-PhysicalDisk -ErrorAction Stop)
  foreach ($disk in $physical) {
    $r = $null
    try { $r = $disk | Get-StorageReliabilityCounter -ErrorAction Stop } catch {
      $warnings += "Reliability counters for $($disk.FriendlyName) are unavailable. Administrator access or hardware support may be required."
    }
    $disks += [pscustomobject]@{
      id = [string]$disk.DeviceId; name = [string]$disk.FriendlyName; uniqueId = ([string]$disk.UniqueId).Trim()
      serial = ([string]$disk.SerialNumber).Trim(); mediaType = [string]$disk.MediaType
      busType = [string]$disk.BusType; health = [string]$disk.HealthStatus
      operation = ($disk.OperationalStatus -join ', '); size = $disk.Size
      temperature = $r.Temperature; temperatureMax = $r.TemperatureMax
      wear = $r.Wear; powerOnHours = $r.PowerOnHours
      readErrors = $r.ReadErrorsUncorrected; writeErrors = $r.WriteErrorsUncorrected
      source = 'Windows Storage'; countersAvailable = ($null -ne $r)
    }
  }
} catch {
  $warnings += 'The Windows Storage provider is unavailable. Basic disk inventory is shown when possible; detailed health is unknown.'
  try {
    foreach ($d in @(Get-CimInstance Win32_DiskDrive -ErrorAction Stop)) {
      $disks += [pscustomobject]@{
        id = [string]$d.Index; name = [string]$d.Model; serial = ([string]$d.SerialNumber).Trim()
        mediaType = 'Unspecified'; busType = [string]$d.InterfaceType; health = 'Unknown'
        operation = [string]$d.Status; size = $d.Size; countersAvailable = $false; source = 'Basic inventory'
      }
    }
  } catch { $warnings += 'Drive access was denied or no supported provider is available. Run the app in an administrator terminal and refresh.' }
}
if ($disks.Count -gt 0) {
  try {
    Add-Type -Path @((Join-Path $PSScriptRoot 'NativeNvme.cs'), (Join-Path $PSScriptRoot 'NativeAta.cs')) -ErrorAction Stop
    # Enumerate actual Windows physical disk paths; Storage DeviceId need not equal a disk number.
    $devices = @(Get-CimInstance Win32_DiskDrive -ErrorAction Stop)
    $diskPaths = @()
    try { $diskPaths = @(Get-Disk -ErrorAction Stop) } catch { }
    foreach ($device in $devices) {
      $deviceSerial = ([string]$device.SerialNumber).Trim()
      if (-not $deviceSerial) { continue }
      # USB bridges may share a serial, or expose different serials to WMI and
      # Storage. Match Storage UniqueId to Get-Disk's physical Number first.
      $paths = @($diskPaths | Where-Object { $_.Number -eq $device.Index -and $_.UniqueId })
      $matches = @()
      if ($paths.Count -eq 1) {
        $pathIdentity = ([string]$paths[0].UniqueId).Trim()
        $matches = @($disks | Where-Object { $_.uniqueId -and $_.uniqueId.Trim() -eq $pathIdentity })
      }
      if ($matches.Count -ne 1) {
        $matches = @($disks | Where-Object { $_.serial -and $_.serial.Trim() -eq $deviceSerial })
      }
      if ($matches.Count -ne 1) { continue }
      $drive = $matches[0]
      $drive | Add-Member -NotePropertyName windowsModel -NotePropertyValue ([string]$device.Model).Trim() -Force
      try {
        $volumes = @()
        foreach ($partition in @(Get-CimAssociatedInstance -InputObject $device -Association Win32_DiskDriveToDiskPartition -ErrorAction Stop)) {
          foreach ($volume in @(Get-CimAssociatedInstance -InputObject $partition -Association Win32_LogicalDiskToPartition -ErrorAction Stop)) {
            $volumes += [pscustomobject]@{ letter = [string]$volume.DeviceID; label = [string]$volume.VolumeName }
          }
        }
        $drive | Add-Member -NotePropertyName volumes -NotePropertyValue @($volumes) -Force
      } catch { } # Volume labels are optional; health scanning can continue.
      if ($drive.busType -in @('USB', 'SATA', 'ATA') -or $device.InterfaceType -eq 'USB') {
        try {
          $ata = [NativeAta]::Read([int]$device.Index, $deviceSerial)
          $drive | Add-Member -NotePropertyName ataModel -NotePropertyValue $ata.Model -Force
          $drive | Add-Member -NotePropertyName ataSerial -NotePropertyValue $ata.Serial -Force
          $drive | Add-Member -NotePropertyName modelSource -NotePropertyValue 'Native USB SAT Identify' -Force
          if ($null -ne $ata.SmartErrors) {
            $drive | Add-Member -NotePropertyName smartErrors -NotePropertyValue $ata.SmartErrors -Force
          } elseif ($ata.SmartReadError) {
            $drive | Add-Member -NotePropertyName smartReadError -NotePropertyValue $ata.SmartReadError -Force
          }
          if ($null -ne $ata.LifetimeWritesBytes) {
            $drive | Add-Member -NotePropertyName lifetimeWritesBytes -NotePropertyValue $ata.LifetimeWritesBytes -Force
            $drive | Add-Member -NotePropertyName metricSources -NotePropertyValue @{ lifetimeWritesBytes = 'Native ATA Device Statistics' } -Force
          } elseif ($ata.WritesReadError) {
            $drive | Add-Member -NotePropertyName writesReadError -NotePropertyValue $ata.WritesReadError -Force
          }
        } catch {
          $drive | Add-Member -NotePropertyName modelReadError -NotePropertyValue $_.Exception.GetBaseException().Message -Force
        }
        continue
      }
      if ($drive.busType -ne 'NVMe' -and $drive.source -ne 'Basic inventory') { continue }
      try {
        $native = [NativeNvme]::Read([int]$device.Index)
        if (-not [NativeNvme]::MatchesIdentity($deviceSerial, $native)) {
          throw 'Neither the NVMe controller serial nor the Windows descriptor serial matches this disk. Readings were not attached.'
        }
        $sources = @{}
        foreach ($pair in @(@('powerOnHours', 'PowerOnHours'), @('lifetimeWritesBytes', 'LifetimeWritesBytes'), @('temperature', 'Temperature'), @('wear', 'Wear'))) {
          $key = $pair[0]; $value = $native.($pair[1])
          if ($null -eq $drive.$key -and $null -ne $value) {
            $drive | Add-Member -NotePropertyName $key -NotePropertyValue $value -Force
            $sources[$key] = 'Native Windows NVMe'
          }
        }
        if ($sources.Count -gt 0) {
          $drive | Add-Member -NotePropertyName metricSources -NotePropertyValue $sources -Force
          $drive.source += ' + Native Windows NVMe'
        }
      } catch {
        $reason = $_.Exception.GetBaseException().Message
        $warnings += "Native NVMe readings for $($drive.name) were unavailable: $reason"
      }
    }
  } catch { $warnings += "The native NVMe reader could not initialize or enumerate disk paths: $($_.Exception.GetBaseException().Message)" }
}
[pscustomobject]@{ scannedAt = [DateTime]::UtcNow.ToString('o'); drives = @($disks); warnings = @($warnings) } | ConvertTo-Json -Depth 6 -Compress
