param(
    [Parameter(Mandatory = $true)][string]$Helper,
    [Parameter(Mandatory = $true)][string]$FixtureExe
)
$ErrorActionPreference = 'Stop'
$base = [IO.Path]::GetFullPath((Split-Path -Parent $Helper))
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (!$base.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($base) -notmatch '^kcoder-preflight-probe-[a-f0-9]{32}$') {
    throw 'An isolated owned fixture directory is required'
}
. $Helper
$root = Join-Path $base 'installation'
$bin = Join-Path $root 'resources\bin'
[IO.Directory]::CreateDirectory($bin) | Out-Null
$exe = Join-Path $bin 'kcoder.exe'
Copy-Item -LiteralPath $FixtureExe -Destination $exe
$children = @()
function Start-FixtureLocker([int]$Number) {
    $payload = Join-Path $base ("payload-$Number")
    $ready = Join-Path $base ("ready-$Number")
    $stop = Join-Path $base ("stop-$Number")
    [IO.File]::WriteAllText($payload, 'owned fixture')
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $exe
    $start.Arguments = 'lock "' + $payload + '" "' + $ready + '" "' + $stop + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    if (!$process) { throw 'Could not start owned fixture process' }
    $script:children += $process
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (!(Test-Path -LiteralPath $ready)) {
        if ($process.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'Owned fixture did not lock its file' }
        Start-Sleep -Milliseconds 25
    }
    return $process
}
try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $excluded = Get-KCoderExcludedProcesses $PID
    $first = Start-FixtureLocker 1
    $captured = @(Get-KCoderOwnedProcessSnapshot @($root) $sid $excluded)
    if (!@($captured | Where-Object { $_.pid -eq $first.Id }).Count) { throw 'Initial fixture ownership was not identified' }
    $second = Start-FixtureLocker 2
    $closed = Close-KCoderInstallationProcesses $captured @($root) $sid $excluded 1
    if ($closed -lt 2 -or !$first.WaitForExit(5000) -or !$second.WaitForExit(5000)) {
        throw 'A late owned process was not closed'
    }
    foreach ($number in 1,2) {
        $stream = [IO.File]::Open((Join-Path $base ("payload-$number")), 'Open', 'ReadWrite', 'None')
        $stream.Dispose()
    }
    Write-Output 'KCODER_PREFLIGHT_NATIVE_RESTART_OK'
} finally {
    foreach ($process in $children) {
        if (!$process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
        $process.Dispose()
    }
}
