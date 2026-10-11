[CmdletBinding()]
param(
    [string] $InstallDir = $(
        if ($env:KCODER_DEV_INSTALL_DIR) {
            $env:KCODER_DEV_INSTALL_DIR
        } elseif ($env:CARGO_HOME) {
            Join-Path $env:CARGO_HOME 'bin'
        } else {
            Join-Path $HOME '.cargo\bin'
        }
    ),
    [string] $SourceBinary,
    [string] $SourceSupervisor,
    [switch] $NoDoctor,
    [switch] $NoPathUpdate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\..\..'))
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$defaultDevHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config\kcoder-dev'
$devConfigDir = if ($env:KCODER_CONFIG_DIR) {
    [IO.Path]::GetFullPath($env:KCODER_CONFIG_DIR)
} else {
    $defaultDevHome
}
# Source debug builds are installed under a distinct command and state root.
# Keep an explicit config-dir override available for test sandboxes.
$env:KCODER_HOME = $devConfigDir
if (-not $env:KCODER_CONFIG_DIR) {
    $env:KCODER_CONFIG_DIR = $devConfigDir
}
$installedBinary = Join-Path $InstallDir 'kcoder-dev.exe'
$installedSupervisor = Join-Path $InstallDir 'kcoder-process-supervisor.exe'

function Install-SourceDotenvIfMissing {
    $sourceDotenv = Join-Path $repoDir '.env'
    if (-not (Test-Path -LiteralPath $sourceDotenv -PathType Leaf)) {
        return
    }
    $configDir = if ($env:KCODER_CONFIG_DIR) {
        [IO.Path]::GetFullPath($env:KCODER_CONFIG_DIR)
    } else {
        $defaultDevHome
    }
    $destination = Join-Path $configDir '.env'
    if (Test-Path -LiteralPath $destination) {
        return
    }
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    Copy-Item -LiteralPath $sourceDotenv -Destination $destination
    Write-Host "Installed repository .env to $destination"
}

function Test-KCoderBinary([string] $Candidate) {
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
        return $false
    }
    $helpText = (& $Candidate --help 2>$null | Out-String)
    return $LASTEXITCODE -eq 0 -and $helpText.Contains('--profile')
}

function Sync-DevelopmentConfig([string] $Binary) {
    # Replace only the isolated dev settings layer; release settings and
    # credentials live in the formal profile and are never touched here.
    $settingsPath = Join-Path $devConfigDir 'settings.json'
    Remove-Item -LiteralPath $settingsPath -Force -ErrorAction SilentlyContinue
    & $Binary config migrate *> $null
    if ($LASTEXITCODE -ne 0) { throw "Development config migrate exited $LASTEXITCODE" }
    & $Binary config import --scope user --file (Join-Path $repoDir 'crates/kcoder_config/setting_dev_user.jsonc') *> $null
    if ($LASTEXITCODE -ne 0) { throw "Development settings import exited $LASTEXITCODE" }
    $sourceDotenv = Join-Path $repoDir '.env'
    if ((Test-Path -LiteralPath $sourceDotenv -PathType Leaf) -and
        ((Get-Content -Raw -LiteralPath $sourceDotenv) -match '(?m)^\s*(export\s+)?KUNLUNMETA_BASE_API_KEY\s*=')) {
        & $Binary auth login --provider kunlunmeta --env-file $sourceDotenv *> $null
        if ($LASTEXITCODE -ne 0) { throw "Development KunlunMeta credential import exited $LASTEXITCODE" }
    }
}

if ($SourceBinary) {
    if (-not [IO.Path]::IsPathRooted($SourceBinary)) {
        $SourceBinary = Join-Path (Get-Location).Path $SourceBinary
    }
    $SourceBinary = [IO.Path]::GetFullPath($SourceBinary)
    Write-Host "Using prebuilt development binary: $SourceBinary"
} else {
    Write-Host "Building KCoder from current source: $repoDir"
    Push-Location $repoDir
    try {
        & cargo build -p kcoder_cli --bin kcoder --locked --all-features | Out-Host
        if ($LASTEXITCODE -eq 0) {
            & cargo build -p kcoder_process_supervisor --bin kcoder-process-supervisor --locked | Out-Host
        }
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
    $SourceBinary = Join-Path $repoDir 'target\debug\kcoder.exe'
    $SourceSupervisor = Join-Path $repoDir 'target\debug\kcoder-process-supervisor.exe'
}

if (-not $SourceSupervisor) {
    $SourceSupervisor = Join-Path (Split-Path -Parent $SourceBinary) 'kcoder-process-supervisor.exe'
}
if (-not [IO.Path]::IsPathRooted($SourceSupervisor)) {
    $SourceSupervisor = Join-Path (Get-Location).Path $SourceSupervisor
}
$SourceSupervisor = [IO.Path]::GetFullPath($SourceSupervisor)

Install-SourceDotenvIfMissing

if (-not (Test-KCoderBinary $SourceBinary)) {
    throw "Development build is not a usable KCoder binary: $SourceBinary"
}
if (-not (Test-Path -LiteralPath $SourceSupervisor -PathType Leaf)) {
    throw "Development process supervisor is missing: $SourceSupervisor"
}

Sync-DevelopmentConfig $SourceBinary

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$stagedBinary = Join-Path $InstallDir "kcoder-dev.installing.$PID.exe"
$stagedSupervisor = Join-Path $InstallDir "kcoder-process-supervisor.installing.$PID.exe"
try {
    Copy-Item -LiteralPath $SourceBinary -Destination $stagedBinary -Force
    Copy-Item -LiteralPath $SourceSupervisor -Destination $stagedSupervisor -Force
} catch {
    Remove-Item -LiteralPath $stagedBinary, $stagedSupervisor -Force -ErrorAction SilentlyContinue
    throw
}
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SourceBinary).Hash
$stagedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedBinary).Hash
if ($sourceHash -ne $stagedHash) {
    Remove-Item -LiteralPath $stagedBinary, $stagedSupervisor -Force -ErrorAction SilentlyContinue
    throw 'Staged binary checksum does not match the development build'
}
$sourceSupervisorHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SourceSupervisor).Hash
$stagedSupervisorHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedSupervisor).Hash
if ($sourceSupervisorHash -ne $stagedSupervisorHash) {
    Remove-Item -LiteralPath $stagedBinary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stagedSupervisor -Force -ErrorAction SilentlyContinue
    throw 'Staged process supervisor checksum does not match the development build'
}

$backup = $null
$backupSupervisor = $null
$hadInstalledBinary = Test-Path -LiteralPath $installedBinary -PathType Leaf
$hadInstalledSupervisor = Test-Path -LiteralPath $installedSupervisor -PathType Leaf
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if ($hadInstalledBinary) {
    $backup = "$installedBinary.bak-$timestamp"
    Copy-Item -LiteralPath $installedBinary -Destination $backup -Force
    Write-Host "Backed up existing installation to $backup"
}
if ($hadInstalledSupervisor) {
    $backupSupervisor = "$installedSupervisor.bak-$timestamp"
    Copy-Item -LiteralPath $installedSupervisor -Destination $backupSupervisor -Force
    Write-Host "Backed up existing process supervisor to $backupSupervisor"
}

if ($hadInstalledBinary) {
    $running = Get-CimInstance Win32_Process -Filter "Name='kcoder-dev.exe'" |
        Where-Object {
            $_.ExecutablePath -and
            [string]::Equals($_.ExecutablePath, $installedBinary, [StringComparison]::OrdinalIgnoreCase)
        }
    foreach ($process in $running) {
        Write-Host "Stopping installed KCoder process PID $($process.ProcessId)..."
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    }
    if ($running) {
        for ($attempt = 0; $attempt -lt 50; $attempt++) {
            $stillRunning = Get-CimInstance Win32_Process -Filter "Name='kcoder-dev.exe'" |
                Where-Object {
                    $_.ExecutablePath -and
                    [string]::Equals($_.ExecutablePath, $installedBinary, [StringComparison]::OrdinalIgnoreCase)
                } |
                Select-Object -First 1
            if (-not $stillRunning) {
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if ($stillRunning) {
            Remove-Item -LiteralPath $stagedBinary -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $stagedSupervisor -Force -ErrorAction SilentlyContinue
            throw "Installed KCoder process PID $($stillRunning.ProcessId) did not exit"
        }
    }
}

& $SourceBinary config path --scope user *> $null
if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $stagedBinary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stagedSupervisor -Force -ErrorAction SilentlyContinue
    throw "Development build failed user configuration migration with exit code $LASTEXITCODE"
}
if (-not $NoDoctor) {
    & $SourceBinary doctor
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $stagedBinary -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stagedSupervisor -Force -ErrorAction SilentlyContinue
        throw "Development build doctor check failed before installation with exit code $LASTEXITCODE"
    }
}

try {
    if (Test-Path -LiteralPath $installedSupervisor) {
        Remove-Item -LiteralPath $installedSupervisor -Force
    }
    Move-Item -LiteralPath $stagedSupervisor -Destination $installedSupervisor -Force
    if (Test-Path -LiteralPath $installedBinary) {
        Remove-Item -LiteralPath $installedBinary -Force
    }
    Move-Item -LiteralPath $stagedBinary -Destination $installedBinary -Force
    $installedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedBinary).Hash
    if ($installedHash -ne $sourceHash) {
        throw 'Installed binary checksum does not match the development build'
    }
    if (-not (Test-KCoderBinary $installedBinary)) {
        throw 'Installed binary failed its startup validation'
    }
    $installedSupervisorHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedSupervisor).Hash
    if ($installedSupervisorHash -ne $sourceSupervisorHash) {
        throw 'Installed process supervisor checksum does not match the development build'
    }
} catch {
    Remove-Item -LiteralPath $stagedBinary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stagedSupervisor -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $installedBinary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $installedSupervisor -Force -ErrorAction SilentlyContinue
    if ($backup -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
        Copy-Item -LiteralPath $backup -Destination $installedBinary -Force
        Write-Warning "Installation failed; restored $backup"
    }
    if ($hadInstalledSupervisor -and $backupSupervisor -and (Test-Path -LiteralPath $backupSupervisor -PathType Leaf)) {
        Copy-Item -LiteralPath $backupSupervisor -Destination $installedSupervisor -Force
        Write-Warning "Installation failed; restored $backupSupervisor"
    }
    throw
}

if (-not $NoPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $userEntries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $alreadyOnUserPath = $userEntries | Where-Object {
        [string]::Equals($_.TrimEnd('\'), $InstallDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if (-not $alreadyOnUserPath) {
        $newUserPath = (@($userEntries) + $InstallDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
        Write-Host "Added $InstallDir to the user PATH"
    }
    $processEntries = @($env:PATH -split ';')
    $alreadyOnProcessPath = $processEntries | Where-Object {
        [string]::Equals($_.TrimEnd('\'), $InstallDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if (-not $alreadyOnProcessPath) {
        $env:PATH = "$InstallDir;$env:PATH"
    }
}

$version = (& $installedBinary --version | Out-String).Trim()
Write-Host "Installed $version to $installedBinary"
Write-Host "SHA256: $sourceHash"

Write-Output $installedBinary
