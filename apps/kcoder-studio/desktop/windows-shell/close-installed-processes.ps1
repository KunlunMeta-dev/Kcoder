param(
    [string]$InstallDir,
    [ValidateSet('Inspect', 'Close')][string]$Mode = 'Inspect',
    [ValidateSet('User', 'Machine')][string]$Scope = 'User',
    [string]$AppGuid = 'dde41fb5-2370-5338-807d-3f5c37c73fa3',
    [int]$InstallerPid = 0,
    [ValidateRange(1, 20)][int]$WaitSeconds = 5
)
$ErrorActionPreference = 'Stop'

function Get-KCoderNormalizedPath([string]$Value) {
    if (!$Value -or ![IO.Path]::IsPathRooted($Value)) { return $null }
    $path = [IO.Path]::GetFullPath($Value.Trim('"'))
    # Native services may report the same image with a verbatim DOS/UNC prefix.
    if ($path.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
        $path = '\\' + $path.Substring(8)
    } elseif ($path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase) -and $path.Length -gt 6 -and $path[5] -eq ':') {
        $path = $path.Substring(4)
    }
    return $path.TrimEnd('\')
}
function Test-KCoderImageRoot([string]$Image, [string[]]$Roots) {
    $path = Get-KCoderNormalizedPath $Image
    if (!$path) { return $false }
    foreach ($directory in $Roots) {
        if ([String]::Equals($path, (Join-Path $directory 'kcoder-studio.exe'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
        if ($path.StartsWith(($directory + '\resources\'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}
function Get-KCoderCreationIdentity($Process) {
    if (!$Process.CreationDate) { throw 'Process creation identity unavailable' }
    return $Process.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
}
function Get-KCoderProcessOwner($Process) {
    try {
        $owner = Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid -ErrorAction Stop
        if ($owner.ReturnValue -eq 0) { return [string]$owner.Sid }
    } catch {}
    return $null
}
function Get-KCoderInstallRoots([string]$Requested, [string]$Guid, [string]$InstallScope) {
    if ($Guid -notmatch '^[a-fA-F0-9-]{36}$') { throw 'Invalid application registration identity' }
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if ($Requested) { [void]$paths.Add((Get-KCoderNormalizedPath $Requested)) }
    $hives = if ($InstallScope -eq 'Machine') { @('HKLM:', 'HKCU:') } else { @('HKCU:') }
    foreach ($hive in $hives) {
        $registryHive = if ($hive -eq 'HKLM:') { [Microsoft.Win32.RegistryHive]::LocalMachine } else { [Microsoft.Win32.RegistryHive]::CurrentUser }
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($registryHive, [Microsoft.Win32.RegistryView]::Registry64)
        $registered = $null
        try {
            $registered = $base.OpenSubKey('Software\' + $Guid)
            if ($registered) {
                $location = [string]$registered.GetValue('InstallLocation', '')
                if ($location) { [void]$paths.Add((Get-KCoderNormalizedPath $location)) }
            }
        } finally { if ($registered) { $registered.Dispose() }; $base.Dispose() }
    }
    $roots = @()
    foreach ($directory in $paths) {
        if (!$directory) { continue }
        if ([String]::Equals($directory, [IO.Path]::GetPathRoot($directory).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'An installation volume root is unsafe' }
        if (!(Test-Path -LiteralPath (Join-Path $directory 'kcoder-studio.exe') -PathType Leaf) -and !(Test-Path -LiteralPath (Join-Path $directory 'resources\bin\kcoder.exe') -PathType Leaf)) { continue }
        # Executable roots establish ownership; a raw shared directory prefix does not.
        $roots += $directory
    }
    return $roots
}
function Get-KCoderExcludedProcesses([int]$CallerPid) {
    $excluded = [Collections.Generic.HashSet[int]]::new()
    foreach ($start in @($PID, $CallerPid)) {
        $cursor = $start
        for ($depth = 0; $depth -lt 32 -and $cursor -gt 0; $depth++) {
            if (!$excluded.Add($cursor)) { break }
            $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $cursor) -ErrorAction SilentlyContinue
            if (!$parent) { break }
            $cursor = [int]$parent.ParentProcessId
        }
    }
    return ,$excluded
}
function Get-KCoderOwnedProcessSnapshot([string[]]$Roots, [string]$CurrentSid, $Excluded) {
    $all = @(Get-CimInstance Win32_Process)
    $selected = @{}
    foreach ($process in $all) {
        $processId = [int]$process.ProcessId
        if ($Excluded.Contains($processId) -or !(Test-KCoderImageRoot $process.ExecutablePath $Roots)) { continue }
        if ((Get-KCoderProcessOwner $process) -ne $CurrentSid) { continue }
        $selected[$processId] = @{ pid=$processId; parent=[int]$process.ParentProcessId; path=[string]$process.ExecutablePath; created=(Get-KCoderCreationIdentity $process); depth=0 }
    }
    # System-path terminal shells belong only through a currently captured native
    # installation parent, the same SID and non-older process creation identity.
    for ($depth = 1; $depth -le 32; $depth++) {
        $added = $false
        foreach ($process in $all) {
            $processId = [int]$process.ProcessId
            if ($selected.ContainsKey($processId) -or $Excluded.Contains($processId)) { continue }
            $parent = $selected[[int]$process.ParentProcessId]
            if (!$parent -or (Get-KCoderProcessOwner $process) -ne $CurrentSid) { continue }
            $created = Get-KCoderCreationIdentity $process
            if ([long]$created -lt [long]$parent.created) { continue }
            $selected[$processId] = @{ pid=$processId; parent=[int]$process.ParentProcessId; path=[string]$process.ExecutablePath; created=$created; depth=($parent.depth+1) }
            $added = $true
        }
        if (!$added) { break }
    }
    return @($selected.Values)
}
function Test-KCoderSameProcess($Captured, [string]$CurrentSid) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Captured.pid) -ErrorAction SilentlyContinue
    if (!$current) { return $false }
    return (Get-KCoderProcessOwner $current) -eq $CurrentSid -and (Get-KCoderCreationIdentity $current) -eq $Captured.created -and [String]::Equals([string]$current.ExecutablePath, $Captured.path, [StringComparison]::OrdinalIgnoreCase)
}
function Close-KCoderOwnedProcesses($Captured, [string]$CurrentSid, [int]$GraceSeconds) {
    foreach ($entry in $Captured) {
        if (!(Test-KCoderSameProcess $entry $CurrentSid)) { continue }
        try { $process = [Diagnostics.Process]::GetProcessById($entry.pid); [void]$process.CloseMainWindow(); $process.Dispose() } catch {}
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($GraceSeconds)
    do {
        $remaining = @($Captured | Where-Object { Test-KCoderSameProcess $_ $CurrentSid })
        if (!$remaining.Count) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    foreach ($entry in @($remaining | Sort-Object depth -Descending)) {
        if (Test-KCoderSameProcess $entry $CurrentSid) { Stop-Process -Id $entry.pid -Force -ErrorAction SilentlyContinue }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $remaining = @($Captured | Where-Object { Test-KCoderSameProcess $_ $CurrentSid })
        if (!$remaining.Count) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($remaining.Count) { throw 'Owned installation processes remain active; close them before retrying' }
}
function Get-KCoderScheduledTaskFolder {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    return $service.GetFolder('\')
}
function Test-KCoderOwnedScheduledTask($Task, [string[]]$Roots, [string]$CurrentSid) {
    if ($Task.Name -notmatch '^KCoder-Channel-[a-f0-9]{64}$') { return $false }
    $definition = $Task.Definition
    if ($definition.RegistrationInfo.Description -cnotmatch '^kcoder-native-user-service-v1:[a-f0-9]{64}$') { return $false }
    $sid = [string]$definition.Principal.UserId
    if ($sid -notmatch '^S-1-') {
        try { $sid = ([Security.Principal.NTAccount]::new($sid)).Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { return $false }
    }
    if ($sid -cne $CurrentSid -or $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0) { return $false }
    if ($definition.Actions.Count -ne 1) { return $false }
    $action = $definition.Actions.Item(1)
    return $action.Type -eq 0 -and (Test-KCoderImageRoot $action.Path $Roots)
}
function Get-KCoderInstallationTasks([string[]]$Roots, [string]$CurrentSid, $Folder) {
    if (!$Roots.Count) { return @() }
    if (!$Folder) { $Folder = Get-KCoderScheduledTaskFolder }
    return @($Folder.GetTasks(1) | Where-Object { Test-KCoderOwnedScheduledTask $_ $Roots $CurrentSid })
}
function Stop-KCoderInstallationTasks([string[]]$Roots, [string]$CurrentSid, $Folder) {
    if (!$Roots.Count) { return }
    if (!$Folder) { $Folder = Get-KCoderScheduledTaskFolder }
    foreach ($task in @(Get-KCoderInstallationTasks $Roots $CurrentSid $Folder)) {
        $originalXml = [string]$task.Xml
        $current = $Folder.GetTask($task.Name)
        if (!(Test-KCoderOwnedScheduledTask $current $Roots $CurrentSid) -or [string]$current.Xml -cne $originalXml) {
            throw 'Owned installation task definition changed during upgrade'
        }
        # Stop through the scheduler before terminating processes. Killing only
        # its child image can activate the task's RestartOnFailure policy.
        # The registration, triggers, enabled state and private data are retained.
        try { [void]$current.Stop(0) } catch {
            $failure = $_.Exception
            while ($failure.InnerException) { $failure = $failure.InnerException }
            # SCHED_E_TASK_NOT_RUNNING is already the requested terminal state.
            if ($failure.HResult -ne -2147216629) { throw }
        }
    }
}
function Close-KCoderInstallationProcesses([object[]]$Captured, [string[]]$Roots, [string]$CurrentSid, $Excluded, [int]$GraceSeconds) {
    Stop-KCoderInstallationTasks $Roots $CurrentSid
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        if ($Captured.Count) {
            foreach ($entry in $Captured) { [void]$seen.Add(([string]$entry.pid + ':' + [string]$entry.created)) }
            Close-KCoderOwnedProcesses $Captured $CurrentSid $GraceSeconds
        }
        Start-Sleep -Milliseconds 250
        $Captured = @(Get-KCoderOwnedProcessSnapshot $Roots $CurrentSid $Excluded)
        if (!$Captured.Count) {
            Start-Sleep -Milliseconds 250
            $Captured = @(Get-KCoderOwnedProcessSnapshot $Roots $CurrentSid $Excluded)
            if (!$Captured.Count) { return $seen.Count }
        }
    }
    throw 'Installation processes continued restarting during upgrade'
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $roots = @(Get-KCoderInstallRoots $InstallDir $AppGuid $Scope)
        $excluded = Get-KCoderExcludedProcesses $InstallerPid
        $captured = @(Get-KCoderOwnedProcessSnapshot $roots $currentSid $excluded)
        if ($Mode -eq 'Inspect') {
            $activeTasks = @(Get-KCoderInstallationTasks $roots $currentSid | Where-Object { $_.State -in @(2, 4) })
            Write-Output ('KCODER_OWNED_PROCESS_COUNT=' + $captured.Count)
            Write-Output ('KCODER_OWNED_TASK_COUNT=' + $activeTasks.Count)
            if ($captured.Count -or $activeTasks.Count) { exit 10 }
            exit 0
        }
        $closed = Close-KCoderInstallationProcesses $captured $roots $currentSid $excluded $WaitSeconds
        Write-Output ('KCODER_OWNED_PROCESSES_CLOSED=' + $closed)
        exit 0
    } catch {
        Write-Output 'KCODER_PROCESS_PREFLIGHT_UNAVAILABLE'
        exit 20
    }
}
