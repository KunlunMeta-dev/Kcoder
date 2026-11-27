$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$errors = $null
$source = Join-Path $PSScriptRoot 'windows-storage-owned-volume.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Only extract the pure guard. Never invoke the disk preparation script itself.
$guard = @($ast.FindAll({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-OwnedRawVhdDisk'
}, $false))
if ($guard.Count -ne 1) { throw 'Expected the single fixed metadata guard' }
. ([scriptblock]::Create($guard[0].Extent.Text))
$scenarios = @('valid','detached','image-path','device-path','disk0','disk-number','boot','system','bus',
  'missing-raw-bus','missing-cim-properties','offline','readonly','initialized','reported-partitions','partitions','volumes','ready-size','image-size','disk-size')
foreach ($scenario in $scenarios) {
  $ready = [pscustomobject]@{ image_path='C:\owned\cross-volume.vhdx'; physical_disk='\\.\PhysicalDrive1'; maximum_size_bytes=64MB }
  $image = [pscustomobject]@{ Attached=$true; ImagePath=$ready.image_path; DevicePath=$ready.physical_disk; Size=64MB }
  $disk = [pscustomobject]@{ Number=1; BusType='File Backed Virtual'; CimInstanceProperties=@{ BusType=[pscustomobject]@{ Value=15 } }
    IsBoot=$false; IsSystem=$false; IsOffline=$false; IsReadOnly=$false; Size=64MB; PartitionStyle='RAW'; NumberOfPartitions=0 }
  $partitions = 0
  $volumes = 0
  switch ($scenario) {
    'detached' { $image.Attached=$false }
    'image-path' { $image.ImagePath='C:\unrelated.vhdx' }
    'device-path' { $image.DevicePath='\\.\PhysicalDrive2' }
    'disk0' { $ready.physical_disk='\\.\PhysicalDrive0'; $image.DevicePath=$ready.physical_disk; $disk.Number=0 }
    'disk-number' { $disk.Number=2 }
    'boot' { $disk.IsBoot=$true }
    'system' { $disk.IsSystem=$true }
    'bus' { $disk.CimInstanceProperties['BusType'].Value=17 }
    'missing-raw-bus' { $disk.CimInstanceProperties.Remove('BusType') }
    'missing-cim-properties' { $disk.PSObject.Properties.Remove('CimInstanceProperties') }
    'offline' { $disk.IsOffline=$true }
    'readonly' { $disk.IsReadOnly=$true }
    'initialized' { $disk.PartitionStyle='GPT' }
    'reported-partitions' { $disk.NumberOfPartitions=1 }
    'partitions' { $partitions=1 }
    'volumes' { $volumes=1 }
    'ready-size' { $ready.maximum_size_bytes=3GB }
    'image-size' { $image.Size=128MB }
    'disk-size' { $disk.Size=128MB }
  }
  $rejected = $false
  try { Assert-OwnedRawVhdDisk $image $disk $ready $partitions $volumes }
  catch { $rejected=$true }
  if ($rejected -ne ($scenario -cne 'valid')) { throw ('Unexpected guard outcome: ' + $scenario) }
}
@{ passed=$scenarios.Count; failed=0; synthetic=$true; diskCmdletsInvoked=0; initialized=0; formatted=0 } | ConvertTo-Json -Compress
