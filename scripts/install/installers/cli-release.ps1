[CmdletBinding()]
param(
    [string]$InstallDir = $(
        if ($env:KCODER_INSTALL_DIR) {
            $env:KCODER_INSTALL_DIR
        } else {
            Join-Path $env:LOCALAPPDATA 'Programs\KCoder\bin'
        }
    ),
    [string]$SourceBinary = $(if ($env:KCODER_RELEASE_BIN) { $env:KCODER_RELEASE_BIN } else { '' }),
    [string]$SourceSupervisor = $(if ($env:KCODER_RELEASE_PROCESS_SUPERVISOR_BIN) { $env:KCODER_RELEASE_PROCESS_SUPERVISOR_BIN } else { '' })
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\..\..'))
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$targetDir = if ($env:KCODER_TARGET_DIR) {
    $env:KCODER_TARGET_DIR
} elseif ($env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR
} else {
    Join-Path $repoDir 'target'
}
if (-not [IO.Path]::IsPathRooted($targetDir)) {
    $targetDir = Join-Path $repoDir $targetDir
}
$targetDir = [IO.Path]::GetFullPath($targetDir)
$formalHome = if ($env:KCODER_CONFIG_DIR) {
    [IO.Path]::GetFullPath($env:KCODER_CONFIG_DIR)
} else {
    Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config\kcoder'
}
# Release installation always uses the production profile and imports no repository development settings or credentials.
$env:KCODER_HOME = $formalHome
if (-not $env:KCODER_CONFIG_DIR) {
    $env:KCODER_CONFIG_DIR = $formalHome
}

function Resolve-InputPath([string]$Path) {
    if ([IO.Path]::IsPathRooted($Path)) {
        return [IO.Path]::GetFullPath($Path)
    }
    return [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

if (-not $SourceBinary) {
    Write-Host "Building KCoder release from current source: $repoDir"
    Push-Location $repoDir
    $previousCargoTarget = $env:CARGO_TARGET_DIR
    try {
        $env:CARGO_TARGET_DIR = $targetDir
        & cargo build -p kcoder_cli --bin kcoder --release --locked | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build failed with exit code $LASTEXITCODE"
        }
        & cargo build -p kcoder_process_supervisor --bin kcoder-process-supervisor --release --locked | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build failed with exit code $LASTEXITCODE"
        }
    } finally {
        if ($null -eq $previousCargoTarget) {
            Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
        } else {
            $env:CARGO_TARGET_DIR = $previousCargoTarget
        }
        Pop-Location
    }
    $SourceBinary = Join-Path $targetDir 'release\kcoder.exe'
    $SourceSupervisor = Join-Path $targetDir 'release\kcoder-process-supervisor.exe'
} else {
    $SourceBinary = Resolve-InputPath $SourceBinary
    if (-not $SourceSupervisor) {
        $SourceSupervisor = Join-Path (Split-Path -Parent $SourceBinary) 'kcoder-process-supervisor.exe'
    } else {
        $SourceSupervisor = Resolve-InputPath $SourceSupervisor
    }
}

if (-not (Test-Path -LiteralPath $SourceBinary -PathType Leaf)) {
    throw "Local release binary not found: $SourceBinary"
}
if (-not (Test-Path -LiteralPath $SourceSupervisor -PathType Leaf)) {
    throw "Local release process supervisor not found: $SourceSupervisor"
}
$helpText = (& $SourceBinary --help 2>$null | Out-String)
if ($LASTEXITCODE -ne 0 -or -not $helpText.Contains('--profile')) {
    throw "Local release binary is not usable: $SourceBinary"
}

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("kcoder-install-" + [guid]::NewGuid().ToString('N'))
$stagedBinary = Join-Path $InstallDir "kcoder.installing.$PID.exe"
$stagedSupervisor = Join-Path $InstallDir "kcoder-process-supervisor.installing.$PID.exe"
New-Item -ItemType Directory -Force -Path $tempDir, $InstallDir | Out-Null
$installed = Join-Path $InstallDir 'kcoder.exe'
$installedSupervisor = Join-Path $InstallDir 'kcoder-process-supervisor.exe'

try {
    if (Test-Path -LiteralPath $installed -PathType Leaf) {
        $running = Get-CimInstance Win32_Process -Filter "Name='kcoder.exe'" |
            Where-Object {
                $_.ExecutablePath -and
                [string]::Equals($_.ExecutablePath, $installed, [StringComparison]::OrdinalIgnoreCase)
            }
        foreach ($process in $running) {
            Write-Host "Stopping installed KCoder process PID $($process.ProcessId)..."
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        }
        if ($running) {
            for ($attempt = 0; $attempt -lt 50; $attempt++) {
                $stillRunning = Get-CimInstance Win32_Process -Filter "Name='kcoder.exe'" |
                    Where-Object {
                        $_.ExecutablePath -and
                        [string]::Equals($_.ExecutablePath, $installed, [StringComparison]::OrdinalIgnoreCase)
                    } |
                    Select-Object -First 1
                if (-not $stillRunning) { break }
                Start-Sleep -Milliseconds 100
            }
            if ($stillRunning) {
                throw "Installed KCoder process PID $($stillRunning.ProcessId) did not exit"
            }
        }
    }

    & $SourceBinary config path --scope user *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Local release binary failed user configuration migration with exit code $LASTEXITCODE"
    }
    Copy-Item -LiteralPath $SourceBinary -Destination $stagedBinary -Force
    Copy-Item -LiteralPath $SourceSupervisor -Destination $stagedSupervisor -Force
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SourceBinary).Hash
    $sourceSupervisorHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SourceSupervisor).Hash
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $stagedBinary).Hash -ne $sourceHash) {
        throw 'Staged release binary checksum mismatch'
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $stagedSupervisor).Hash -ne $sourceSupervisorHash) {
        throw 'Staged release process supervisor checksum mismatch'
    }

    $hadInstalled = Test-Path -LiteralPath $installed -PathType Leaf
    $hadInstalledSupervisor = Test-Path -LiteralPath $installedSupervisor -PathType Leaf
    $backupBinary = Join-Path $tempDir 'previous-kcoder.exe'
    $backupSupervisor = Join-Path $tempDir 'previous-kcoder-process-supervisor.exe'
    if ($hadInstalled) { Copy-Item -LiteralPath $installed -Destination $backupBinary -Force }
    if ($hadInstalledSupervisor) { Copy-Item -LiteralPath $installedSupervisor -Destination $backupSupervisor -Force }
    try {
        if ($hadInstalledSupervisor) { Remove-Item -LiteralPath $installedSupervisor -Force }
        Move-Item -LiteralPath $stagedSupervisor -Destination $installedSupervisor -Force
        if ($hadInstalled) { Remove-Item -LiteralPath $installed -Force }
        Move-Item -LiteralPath $stagedBinary -Destination $installed -Force
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installed).Hash -ne $sourceHash) {
            throw 'Installed release binary checksum mismatch'
        }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installedSupervisor).Hash -ne $sourceSupervisorHash) {
            throw 'Installed release process supervisor checksum mismatch'
        }
        & $installed --version
        if ($LASTEXITCODE -ne 0) { throw "Installed kcoder.exe --version exited $LASTEXITCODE" }
        $settingsPath = (& $installed config path --scope user | Out-String).Trim()
        if (-not (Test-Path -LiteralPath $settingsPath)) {
            & $installed config init --scope user
            if ($LASTEXITCODE -ne 0) { throw "Installed kcoder.exe config init exited $LASTEXITCODE" }
        } else {
            Write-Host "Keeping existing user settings: $settingsPath"
        }
    } catch {
        Remove-Item -LiteralPath $installed, $installedSupervisor -Force -ErrorAction SilentlyContinue
        if ($hadInstalled) { Copy-Item -LiteralPath $backupBinary -Destination $installed -Force }
        if ($hadInstalledSupervisor) { Copy-Item -LiteralPath $backupSupervisor -Destination $installedSupervisor -Force }
        throw
    } finally {
        Remove-Item -LiteralPath $stagedBinary, $stagedSupervisor -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Installed local KCoder release to $installed"
    Write-Host 'No credentials were imported from the repository.'
    if (-not (($env:PATH -split ';') -contains $InstallDir)) {
        Write-Host 'Add the install directory to PATH, then open a new terminal.'
    }
    Write-Output $installed
} finally {
    Remove-Item -LiteralPath $stagedBinary, $stagedSupervisor -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
