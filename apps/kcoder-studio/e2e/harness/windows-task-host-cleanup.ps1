param([Parameter(Mandatory=$true)][string]$OwnedRoot)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=[IO.Path]::GetFullPath($OwnedRoot).TrimEnd('\')
if (-not [IO.Path]::GetFileName($root).StartsWith('studio-ui-')) { throw 'Owned Studio root required' }
$marker=Get-Content -Raw -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($root)) '.owner.json') | ConvertFrom-Json
if ($marker.owner -notmatch '^[a-f0-9-]{36}$') { throw 'Original probe owner required' }
$prefix=$root+'\'
$managers=@(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'kcoder.exe' -and $_.ExecutablePath -and
  $_.ExecutablePath.TrimStart([char[]]'\?').StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -and
  $_.CommandLine.Contains('--internal-native-user-service-manager-v1')
})
foreach ($manager in $managers) { & taskkill /PID $manager.ProcessId /T /F | Out-Null }
Get-ScheduledTask | Where-Object {
  $_.TaskName.StartsWith('KCoder-Channel-') -and
  @($_.Actions | Where-Object { $_.WorkingDirectory.TrimStart([char[]]'\?').StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) }).Count -eq 1
} | ForEach-Object {
  Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false
}
$left=@(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.TrimStart([char[]]'\?').StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)
})
if ($left.Count) { throw 'Owned Studio process cleanup unconfirmed' }
