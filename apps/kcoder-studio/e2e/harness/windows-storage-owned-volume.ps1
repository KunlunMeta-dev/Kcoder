$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Assert-OwnedRawVhdDisk($Image, $Disk, $Ready, [int]$PartitionCount, [int]$VolumeCount) {
  if (!$Image.Attached -or $Image.ImagePath -cne $Ready.image_path -or $Image.DevicePath -cne $Ready.physical_disk) {
    throw 'Original READY image is not attached at its original physical disk'
  }
  if ($Ready.physical_disk -notmatch '^\\\\\.\\PhysicalDrive([1-9][0-9]*)$') { throw 'Disk0 and unexpected physical paths are forbidden' }
  $expectedNumber = [uint32]$Matches[1]
  if ([uint64]$Ready.maximum_size_bytes -ne 64MB -or [uint64]$Image.Size -ne 64MB -or [uint64]$Disk.Size -ne 64MB -or [uint64]$Disk.Size -gt 2GB) {
    throw 'Only the fixed new 64 MiB image is permitted'
  }
  # MSFT_Disk BusType 15 is File Backed Virtual; no physical or existing disk is accepted.
  if ($Disk.Number -ne $expectedNumber -or [uint16]$Disk.CimInstanceProperties['BusType'].Value -ne 15 -or $Disk.IsBoot -or $Disk.IsSystem -or $Disk.IsOffline -or $Disk.IsReadOnly) {
    throw 'Original image must resolve to its online, writable, non-system FileBackedVirtual disk'
  }
  if ([string]$Disk.PartitionStyle -cne 'RAW' -or $Disk.NumberOfPartitions -ne 0 -or $PartitionCount -ne 0 -or $VolumeCount -ne 0) {
    throw 'Only a new RAW disk without any partition or volume may be initialized'
  }
}

$root = [IO.Path]::GetFullPath($env:KCODER_E2E_OWNED_VHDX_ROOT).TrimEnd('\')
$owner = Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$receipt = Get-Content -LiteralPath (Join-Path $root 'vhdx-ready.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ready = $receipt.ready
if ($receipt.group -cne 'vhd-config-cross-volume' -or $owner.owner -cne $ready.owner -or
    $ready.image_path -cne (Join-Path $root 'cross-volume.vhdx') -or !$ready.dynamic -or
    $ready.permanent_lifetime -or $ready.automatic_drive_letter) { throw 'Unexpected owned VHD request' }
$helper = Get-Process -Id $receipt.job.helperPid -ErrorAction Stop
$target = Get-Process -Id $receipt.job.targetPid -ErrorAction Stop
try {
  # Force retained native process handles so later HasExited cannot adopt a reused PID.
  $null = $helper.Handle
  $null = $target.Handle
  if ($helper.StartTime.ToUniversalTime().Ticks.ToString() -cne $receipt.job.helperCreationTicks -or
      $target.StartTime.ToUniversalTime().Ticks.ToString() -cne $receipt.job.targetCreationTicks) { throw 'Original fixture process identity changed' }
  function Get-OriginalImageDisk {
    # These Process objects retain the original identities; never adopt a reused PID.
    if ($helper.HasExited -or $target.HasExited) { throw 'Original fixture Job must remain alive' }
    $images = @(Get-DiskImage -ImagePath $ready.image_path -ErrorAction Stop)
    if ($images.Count -ne 1) { throw 'Expected exactly the original owned image' }
    $image = $images[0]
    if (!$image.Attached -or $image.ImagePath -cne $ready.image_path -or $image.DevicePath -cne $ready.physical_disk) { throw 'Original image attachment changed' }
    $disks = @($image | Get-Disk -ErrorAction Stop)
    if ($disks.Count -ne 1) { throw 'Expected exactly the original image disk' }
    $disk = $disks[0]
    if ($ready.physical_disk -notmatch '^\\\\\.\\PhysicalDrive([1-9][0-9]*)$' -or
        $disk.Number -ne [uint32]$Matches[1] -or [uint16]$disk.CimInstanceProperties['BusType'].Value -ne 15 -or
        $disk.IsBoot -or $disk.IsSystem -or $disk.IsOffline -or $disk.IsReadOnly -or
        [uint64]$image.Size -ne 64MB -or [uint64]$disk.Size -ne 64MB) { throw 'Original image disk identity changed' }
    return $disk
  }

  $disk = Get-OriginalImageDisk
  $image = Get-DiskImage -ImagePath $ready.image_path -ErrorAction Stop
  $partitions = @(Get-Partition -Disk $disk -ErrorAction Stop)
  $volumes = @(Get-Volume -DiskImage $image -ErrorAction Stop)
  Assert-OwnedRawVhdDisk $image $disk $ready $partitions.Count $volumes.Count
  [IO.File]::WriteAllText((Join-Path $root 'cross-volume-before.json'), (@{
    imagePath=$image.ImagePath; physicalDisk=$ready.physical_disk; diskNumber=$disk.Number
    busType=[uint16]$disk.CimInstanceProperties['BusType'].Value; busTypeDisplay=[string]$disk.BusType
    size=$disk.Size; partitionStyle=[string]$disk.PartitionStyle
    partitions=$partitions.Count; volumes=$volumes.Count; isBoot=$disk.IsBoot; isSystem=$disk.IsSystem
  } | ConvertTo-Json -Compress))

  # All mutations use only the disk just resolved from the original held image.
  $null = Initialize-Disk -InputObject $disk -PartitionStyle GPT -PassThru -Confirm:$false -ErrorAction Stop
  $disk = Get-OriginalImageDisk
  if ([string]$disk.PartitionStyle -cne 'GPT') { throw 'Original disk did not initialize as GPT' }
  $partition = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter -ErrorAction Stop
  $disk = Get-OriginalImageDisk
  if ($partition.DiskNumber -ne $disk.Number -or $partition.IsBoot -or $partition.IsSystem -or
      [string]$partition.DriveLetter -notmatch '^[D-Z]$') { throw 'Expected only the newly created partition with an OS-assigned free drive letter' }
  $volume = Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel 'KCoderOwnedQA' -Confirm:$false -ErrorAction Stop
  $null = Get-OriginalImageDisk
  if ([string]$volume.FileSystem -cne 'NTFS' -or $volume.DriveLetter -ne $partition.DriveLetter) { throw 'New owned partition did not become its own NTFS volume' }
  $result = @{ imagePath=$ready.image_path; diskNumber=$disk.Number; partitionNumber=$partition.PartitionNumber
    driveLetter=[string]$partition.DriveLetter; parent=([string]$partition.DriveLetter + ':\')
    fileSystem=$volume.FileSystem; volumeUniqueId=$volume.UniqueId; size=$volume.Size }
  $json = $result | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $root 'cross-volume-prepared.json'), $json)
  $json
} finally {
  $helper.Dispose()
  $target.Dispose()
}
