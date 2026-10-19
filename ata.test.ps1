$ErrorActionPreference = 'Stop'
Add-Type -Path @((Join-Path $PSScriptRoot 'NativeNvme.cs'), (Join-Path $PSScriptRoot 'NativeAta.cs'))
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Put-AtaString($buffer, $offset, $length, $text) {
  $bytes = [Text.Encoding]::ASCII.GetBytes($text.PadRight($length))
  for ($i = 0; $i -lt $length; $i += 2) {
    $buffer[$offset + $i] = $bytes[$i + 1]
    $buffer[$offset + $i + 1] = $bytes[$i]
  }
}
$data = New-Object byte[] 512
$data[0] = 64
Put-AtaString $data 54 40 'WDC WD10EZEX-00BBHA0'
Put-AtaString $data 20 20 'WD-SERIAL-123'
$identity = [NativeAta]::Decode($data)
Assert ($identity.Model -eq 'WDC WD10EZEX-00BBHA0') 'ATA model word order incorrect'
Assert ($identity.Serial -eq 'WD-SERIAL-123') 'ATA serial word order incorrect'
$sat16 = [NativeAta]::IdentifyCdb(16)
Assert ($sat16[0] -eq 0x85 -and $sat16[6] -eq 1 -and $sat16[14] -eq 0xEC) 'SAT-16 Identify command incorrect'
$sat12 = [NativeAta]::IdentifyCdb(12)
Assert ($sat12[0] -eq 0xA1 -and $sat12[4] -eq 1 -and $sat12[9] -eq 0xEC) 'SAT-12 Identify command incorrect'
Assert ($sat12[1] -eq 8 -and $sat12[2] -eq 14) 'Identify must use PIO data-in'
foreach ($invalid in @((New-Object byte[] 512), (New-Object byte[] 511))) {
  $failed = $false
  try { [void][NativeAta]::Decode($invalid) } catch { $failed = $true }
  Assert $failed 'Invalid Identify response accepted'
}
$data[54] = 1
$failed = $false
try { [void][NativeAta]::Decode($data) } catch { $failed = $true }
Assert $failed 'Non-printable model accepted'
Write-Output 'USB SAT helper compilation, ATA model decoding, command construction, and invalid-data checks passed.'
$stats = New-Object byte[] 512
$stats[0] = 1; $stats[2] = 1
[BitConverter]::GetBytes([uint64]2000000000).CopyTo($stats, 24)
$stats[31] = 192
Assert ([NativeAta]::DecodeWrites($stats, 512) -eq 1024000000000) '512-byte write conversion failed'
Assert ([NativeAta]::DecodeWrites($stats, 4096) -eq 8192000000000) '4Kn write conversion failed'
$writesCdb = [NativeAta]::WritesCdb()
Assert ($writesCdb[14] -eq 0x2F -and $writesCdb[8] -eq 4 -and $writesCdb[10] -eq 1 -and $writesCdb[1] -eq 9) 'READ LOG EXT command incorrect'
foreach ($flags in @(0,64,128,224)) {
  $stats[31] = $flags
  $failed = $false
  try { [void][NativeAta]::DecodeWrites($stats, 512) } catch { $failed = $true }
  Assert $failed 'Unsupported/invalid/normalized counter accepted'
}
$stats[31] = 192
[BitConverter]::GetBytes([uint64]0).CopyTo($stats, 24); $stats[31] = 192
Assert ([NativeAta]::DecodeWrites($stats, 512) -eq 0) 'Zero write counter rejected'
[BitConverter]::GetBytes([uint64]281474976710655).CopyTo($stats, 24); $stats[31] = 192
$failed = $false
try { [void][NativeAta]::DecodeWrites($stats, 4096) } catch { $failed = $true }
Assert $failed 'Unsafe byte total accepted'
[BitConverter]::GetBytes([uint16]0x5000).CopyTo($data, 212)
[BitConverter]::GetBytes([uint32]2048).CopyTo($data, 234)
Put-AtaString $data 54 40 '4KN TEST'
Assert (([NativeAta]::Decode($data)).LogicalSectorBytes -eq 4096) 'IDENTIFY logical sector size not used'
Write-Output 'ATA Device Statistics decoding, sector sizes, validity flags, and write command tests passed.'
$fixedSense = New-Object byte[] 18
$fixedSense[0] = 0x70; $fixedSense[2] = 5; $fixedSense[7] = 10; $fixedSense[12] = 0x24
Assert ([NativeAta]::SenseDescription($fixedSense) -match 'Invalid command field') 'Fixed sense decoding failed'
Assert ([NativeAta]::SenseDescription([byte[]]@(0x72,5,0x20,0)) -match 'Unsupported command') 'Descriptor sense decoding failed'
Assert ([NativeAta]::SenseDescription([byte[]]@(0x70)) -match 'No SCSI sense') 'Truncated sense not handled'
Write-Output 'Fixed and descriptor SCSI sense diagnostics passed.'
$smart = New-Object byte[] 512
$smart[0] = 1; $smart[2] = 199; $smart[7] = 252
$smart[14] = 197; $smart[19] = 2
$sum = 0; foreach ($b in $smart) { $sum += $b }
$smart[511] = (256 - ($sum % 256)) % 256
$counters = [NativeAta]::DecodeSmartErrors($smart, 'WDC WD10EZEX-08WN4A0')
Assert ($counters['crcErrors'] -eq 252 -and $counters['pendingSectors'] -eq 2) 'SMART raw counters incorrect'
Assert (-not $counters.ContainsKey('reallocatedSectors')) 'Absent counter invented'
$cdb = [NativeAta]::SmartCdb(12)
Assert ($cdb[3] -eq 0xD0 -and $cdb[9] -eq 0xB0 -and $cdb[6] -eq 0x4F -and $cdb[7] -eq 0xC2) 'SMART READ DATA command incorrect'
$smart[511] = $smart[511] -bxor 1
$failed = $false
try { [void][NativeAta]::DecodeSmartErrors($smart, 'WDC test') } catch { $failed = $true }
Assert $failed 'Invalid SMART checksum accepted'
Write-Output 'SMART attribute decoding, absent counters, checksum, and read command checks passed.'
