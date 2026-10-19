$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'NativeNvme.cs')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$log = New-Object byte[] 512
[BitConverter]::GetBytes([UInt64]345).CopyTo($log, 128)
[BitConverter]::GetBytes([UInt64]21757813).CopyTo($log, 48)
$log[1] = 54; $log[2] = 1; $log[5] = 3 # 310 K
$reading = [NativeNvme]::Decode(' KINGSTON ', $log)
Assert ($reading.PowerOnHours -eq 345) 'Incorrect power-on hours offset'
Assert ($reading.LifetimeWritesBytes -eq 11140000256000) 'Incorrect write counter conversion'
Assert ($reading.Temperature -eq 37 -and $reading.Wear -eq 3) 'Incorrect temperature or wear'
Assert ($reading.Serial -eq 'KINGSTON') 'Incorrect serial normalization'
$log[143] = 1; $log[63] = 1
$overflow = [NativeNvme]::Decode('test', $log)
Assert ($null -eq $overflow.PowerOnHours -and $null -eq $overflow.LifetimeWritesBytes) 'Unsafe 128-bit counters accepted'
$zero = [NativeNvme]::Decode('test', (New-Object byte[] 512))
Assert ($zero.PowerOnHours -eq 0 -and $zero.LifetimeWritesBytes -eq 0 -and $null -eq $zero.Temperature) 'Zero counter or absent temperature handling failed'
$buffer = New-Object byte[] 560
foreach ($entry in @(@(0,48), @(4,48), @(8,3), @(12,2), @(24,40), @(28,512))) {
  [BitConverter]::GetBytes([UInt32]$entry[1]).CopyTo($buffer, $entry[0])
}
$payload = [NativeNvme]::Extract($buffer, 560, 2, 512)
Assert ($payload.Length -eq 512) 'Valid descriptor rejected'
foreach ($returned in @(0, 47, 559, 561)) {
  $rejected = $false
  try { [void][NativeNvme]::Extract($buffer, $returned, 2, 512) } catch { $rejected = $true }
  Assert $rejected "Invalid returned length accepted: $returned"
}
[BitConverter]::GetBytes([UInt32]4294967295).CopyTo($buffer, 24)
$rejected = $false
try { [void][NativeNvme]::Extract($buffer, 560, 2, 512) } catch { $rejected = $true }
Assert $rejected 'Overflowing protocol offset accepted'
Write-Output 'Native NVMe compilation, counter decoding, and descriptor validation passed.'
$deviceQuery = [NativeNvme]::BuildQuery(50, 2, 2, 512)
Assert ([BitConverter]::ToUInt32($deviceQuery, 0) -eq 50) 'SMART device property not set'
Assert ([BitConverter]::ToUInt32($deviceQuery, 16) -eq 2) 'SMART log page not set'
Assert ([BitConverter]::ToUInt32($deviceQuery, 24) -eq 40) 'Protocol data offset incorrect'
$script:attempts = @()
$result = [NativeNvme]::QueryWithFallback(2, [Func[uint32,byte[]]] {
    param($property)
    $script:attempts += $property
    if ($property -eq 50) { throw 'Device query unsupported' }
    return [byte[]]@(1, 2)
})
Assert (($script:attempts -join ',') -eq '50,49') 'SMART fallback order incorrect'
Assert ($result.Length -eq 2) 'Fallback did not return successful response'
$failed = $false
try {
    [void][NativeNvme]::QueryWithFallback(2, [Func[uint32,byte[]]] { param($property); throw "Rejected property $property" })
} catch {
    $failed = $true
    Assert ($_.Exception.GetBaseException().Message -match '50.*49') 'Failure diagnostics omit attempted properties'
}
Assert $failed 'Failed queries accepted'
Write-Output 'Native NVMe query construction, fallback order, and failure diagnostics passed.'
$descriptor = New-Object byte[] 100
[BitConverter]::GetBytes([uint32]100).CopyTo($descriptor, 4)
[BitConverter]::GetBytes([uint32]40).CopyTo($descriptor, 24)
[Text.Encoding]::ASCII.GetBytes('WINDOWS-NAMESPACE-ID').CopyTo($descriptor, 40)
$identity = [NativeNvme]::Decode('CONTROLLER-SERIAL', (New-Object byte[] 512))
$identity.WindowsSerial = [NativeNvme]::DescriptorSerial($descriptor, 100)
Assert ([NativeNvme]::MatchesIdentity('windows-namespace-id ', $identity)) 'Same-handle Windows identity rejected'
Assert ([NativeNvme]::MatchesIdentity('CONTROLLER-SERIAL', $identity)) 'Controller identity rejected'
Assert (-not [NativeNvme]::MatchesIdentity('another-disk', $identity)) 'Different disk identity accepted'
Assert (-not [NativeNvme]::MatchesIdentity('', $identity)) 'Empty identity accepted'
foreach ($offset in @(0, 24, 100, 4294967295)) {
  [BitConverter]::GetBytes([uint32]$offset).CopyTo($descriptor, 24)
  $rejected = $false
  try { [void][NativeNvme]::DescriptorSerial($descriptor, 100) } catch { $rejected = $true }
  Assert $rejected "Invalid serial offset accepted: $offset"
}
Write-Output 'Same-handle Windows/controller identity matching and descriptor bounds checks passed.'
