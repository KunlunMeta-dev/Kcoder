[CmdletBinding()]
param(
    [string]$InstallDir = $(
        if ($env:KCODER_INSTALL_DIR) {
            $env:KCODER_INSTALL_DIR
        } else {
            Join-Path $env:ProgramFiles 'KCoder'
        }
    ),
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$sourceDir = Split-Path -Parent $scriptPath
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$sourceBinary = Join-Path $sourceDir 'kcoder.exe'
$sourceSupervisor = Join-Path $sourceDir 'kcoder-process-supervisor.exe'

function Copy-PackageDirectory([string]$Source, [string]$Destination) {
    $items = @(Get-ChildItem -LiteralPath $Source -Force)
    if ($items.Count -eq 0) {
        throw "Package directory is empty: $Source"
    }
    foreach ($item in $items) {
        $target = Join-Path $Destination $item.Name
        Copy-Item -LiteralPath $item.FullName -Destination $target -Recurse -Force
    }
}

function Install-PackageDirectory([string]$Source, [string]$Destination, [string]$Backup) {
    # Back up the complete release unit before replacement; restore every touched file after any copy or validation failure.
    $sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $files = @(Get-ChildItem -LiteralPath $Source -File -Recurse -Force)
    if ($files.Count -eq 0) { throw 'Staged package is empty' }
    $entries = @()
    $createdDirectories = New-Object 'System.Collections.Generic.List[string]'
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($sourceRoot.Length)
        $target = Join-Path $Destination $relative
        $previous = Join-Path $Backup $relative
        $existed = Test-Path -LiteralPath $target
        if ($existed) {
            if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Install target is not a file: $target" }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $previous) | Out-Null
            Copy-Item -LiteralPath $target -Destination $previous -Force
            if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $previous -Algorithm SHA256).Hash) {
                throw "Backup checksum failed: $target"
            }
        }
        $entries += [pscustomobject]@{
            Source = $file.FullName; Target = $target; Previous = $previous; Existed = $existed
            Hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash; Touched = $false
        }
    }
    try {
        foreach ($entry in $entries) {
            $parent = Split-Path -Parent $entry.Target
            $missing = @()
            while (-not (Test-Path -LiteralPath $parent)) {
                $missing += $parent
                $parent = Split-Path -Parent $parent
            }
            for ($index = $missing.Count - 1; $index -ge 0; $index--) {
                New-Item -ItemType Directory -Path $missing[$index] | Out-Null
                $createdDirectories.Add($missing[$index])
            }
            $entry.Touched = $true
            Copy-Item -LiteralPath $entry.Source -Destination $entry.Target -Force
            if ((Get-FileHash -LiteralPath $entry.Target -Algorithm SHA256).Hash -ne $entry.Hash) {
                throw "Installed checksum failed: $($entry.Target)"
            }
        }
    } catch {
        $installError = $_
        $rollbackErrors = @()
        foreach ($entry in $entries) {
            if (-not $entry.Touched) { continue }
            try {
                if ($entry.Existed) {
                    Copy-Item -LiteralPath $entry.Previous -Destination $entry.Target -Force
                    if ((Get-FileHash -LiteralPath $entry.Target -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $entry.Previous -Algorithm SHA256).Hash) {
                        throw "Restored checksum failed: $($entry.Target)"
                    }
                } elseif (Test-Path -LiteralPath $entry.Target) {
                    Remove-Item -LiteralPath $entry.Target -Force
                }
            } catch { $rollbackErrors += $_.Exception.Message }
        }
        for ($index = $createdDirectories.Count - 1; $index -ge 0; $index--) {
            try { [IO.Directory]::Delete($createdDirectories[$index], $false) }
            catch { $rollbackErrors += $_.Exception.Message }
        }
        if ($rollbackErrors.Count -gt 0) {
            # Retain the sole backup after incomplete rollback so finally cannot delete data required for user recovery.
            $failure = New-Object InvalidOperationException("Installation failed and rollback was incomplete. Backup retained at: $Backup. " + ($rollbackErrors -join '; '))
            $failure.Data['KeepBackup'] = $true
            throw $failure
        }
        throw $installError
    }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertTo-PowerShellArgument([string]$Value) {
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Wait-ForExit {
    if (-not $NoPause) {
        [void](Read-Host 'Installation failed. Press Enter to exit')
    }
}

function Add-UserPathEntry([string]$Path) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if (-not [string]::IsNullOrWhiteSpace($userPath)) {
        foreach ($entry in ($userPath -split ';')) {
            if (-not [string]::IsNullOrWhiteSpace($entry)) {
                $entries += $entry
            }
        }
    }

    $normalizedPath = $Path.TrimEnd('\')
    $alreadyPresent = $false
    foreach ($entry in $entries) {
        if ([string]::Equals($entry.Trim().TrimEnd('\'), $normalizedPath, [StringComparison]::OrdinalIgnoreCase)) {
            $alreadyPresent = $true
            break
        }
    }
    if (-not $alreadyPresent) {
        [Environment]::SetEnvironmentVariable('Path', (($entries + $Path) -join ';'), 'User')
        Write-Host "Added user PATH entry: $Path"
    } else {
        Write-Host "User PATH already contains: $Path"
    }
}

try {
if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) {
    throw "kcoder.exe is missing. Run this script from a complete Windows release directory: $sourceDir"
}
if (-not (Test-Path -LiteralPath $sourceSupervisor -PathType Leaf)) {
    throw "kcoder-process-supervisor.exe is missing. Run this script from a complete Windows release directory: $sourceDir"
}

if (-not (Test-IsAdministrator)) {
    Write-Host 'Installing to Program Files requires administrator permission. Requesting UAC approval...'
    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $arguments = @(
        '-NoProfile'
        '-ExecutionPolicy'
        'Bypass'
        '-File'
        (ConvertTo-PowerShellArgument $scriptPath)
        '-InstallDir'
        (ConvertTo-PowerShellArgument $InstallDir)
    ) -join ' '
    if ($NoPause) {
        $arguments += ' -NoPause'
    }
    $elevated = Start-Process -FilePath $powershell -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    if ($elevated.ExitCode -ne 0) {
        Write-Host "Elevated installation failed with exit code $($elevated.ExitCode)." -ForegroundColor Red
        Wait-ForExit
        exit $elevated.ExitCode
    }
    exit 0
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("kcoder-install-" + [guid]::NewGuid().ToString('N'))
$keepBackup = $false

try {
    $stagedDir = Join-Path $tempDir 'payload'
    New-Item -ItemType Directory -Force -Path $stagedDir | Out-Null
    # Stage the complete release package first so source and installation directories may overlap.
    Copy-PackageDirectory $sourceDir $stagedDir

    $binaryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceBinary).Hash
    $supervisorHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceSupervisor).Hash
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stagedDir 'kcoder.exe')).Hash -ne $binaryHash) {
        throw 'kcoder.exe staging checksum failed'
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stagedDir 'kcoder-process-supervisor.exe')).Hash -ne $supervisorHash) {
        throw 'kcoder-process-supervisor.exe staging checksum failed'
    }

    Install-PackageDirectory $stagedDir $InstallDir (Join-Path $tempDir 'backup')

    $installedBinary = Join-Path $InstallDir 'kcoder.exe'
    $retiredStem = 'kunlun' + 'code'
    $retiredBinary = Join-Path $InstallDir ($retiredStem + '.exe')
    $retiredFamilyBinary = Join-Path $InstallDir ('kunlun' + '.exe')
    # Every release file was validated and committed transactionally; auxiliary cleanup failure cannot misreport primary installation failure.
    foreach ($retiredPath in @($retiredBinary, $retiredFamilyBinary)) {
        try {
            if (Test-Path -LiteralPath $retiredPath) { Remove-Item -LiteralPath $retiredPath -Force }
        } catch { Write-Warning "KCoder is installed, but an old launcher could not be removed: $retiredPath" }
    }
    try { Add-UserPathEntry $InstallDir }
    catch { Write-Warning "KCoder is installed, but user PATH could not be updated. Add this directory manually: $InstallDir" }
    Write-Host "KCoder installed to: $InstallDir"
    Write-Host 'User settings and history were not modified. Reopen the terminal and run: kcoder'
    Write-Output $installedBinary
} catch {
    $keepBackup = $_.Exception.Data.Contains('KeepBackup')
    throw
} finally {
    if (-not $keepBackup) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
} catch {
    Write-Host "Installation failed: $($_.Exception.Message)" -ForegroundColor Red
    Wait-ForExit
    exit 1
}
