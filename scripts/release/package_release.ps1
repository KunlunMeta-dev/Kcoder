[CmdletBinding()]
param(
    [string]$Version,
    [string]$Target = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$installer = Join-Path $PSScriptRoot "install-kcoder.ps1"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Windows installer script not found: $installer" }

if (-not $Version) {
    $manifest = Get-Content -Raw (Join-Path $repoDir "Cargo.toml")
    $match = [regex]::Match($manifest, '(?m)^version\s*=\s*"([^"]+)"')
    if (-not $match.Success) { throw "Could not determine the workspace version" }
    $Version = $match.Groups[1].Value
}

$binary = $env:KCODER_RELEASE_BIN
if (-not $binary) { $binary = Join-Path $repoDir "target\$Target\release\kcoder.exe" }
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    $fallback = Join-Path $repoDir "target\release\kcoder.exe"
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { $binary = $fallback }
}
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Release binary not found: $binary" }

$supervisorBinary = $env:KCODER_RELEASE_PROCESS_SUPERVISOR_BIN
if (-not $supervisorBinary) { $supervisorBinary = Join-Path $repoDir "target\$Target\release\kcoder-process-supervisor.exe" }
if (-not (Test-Path -LiteralPath $supervisorBinary -PathType Leaf)) {
    $fallbackSupervisor = Join-Path $repoDir "target\release\kcoder-process-supervisor.exe"
    if (Test-Path -LiteralPath $fallbackSupervisor -PathType Leaf) { $supervisorBinary = $fallbackSupervisor }
}
if (-not (Test-Path -LiteralPath $supervisorBinary -PathType Leaf)) {
    throw "Release process supervisor not found: $supervisorBinary"
}

$ripgrepBinary = $env:KCODER_RIPGREP_BIN
if (-not $ripgrepBinary) {
    $rgCommand = Get-Command rg.exe -ErrorAction SilentlyContinue
    if ($rgCommand) { $ripgrepBinary = $rgCommand.Source }
}
if ($ripgrepBinary -and -not (Test-Path -LiteralPath $ripgrepBinary -PathType Leaf)) {
    throw "Configured ripgrep binary not found: $ripgrepBinary"
}

$downloadRoot = $null
if (-not $ripgrepBinary -and $env:KCODER_SKIP_RIPGREP_DOWNLOAD -ne '1') {
    $ripgrepVersion = if ($env:KCODER_RIPGREP_VERSION) { $env:KCODER_RIPGREP_VERSION } else { '15.1.0' }
    $ripgrepTarget = switch ($Target) {
        'x86_64-pc-windows-msvc' { 'x86_64-pc-windows-msvc' }
        'x86_64-pc-windows-gnu' { 'x86_64-pc-windows-msvc' }
        'i686-pc-windows-msvc' { 'i686-pc-windows-msvc' }
        'aarch64-pc-windows-msvc' { 'aarch64-pc-windows-msvc' }
        default { $null }
    }
    if ($ripgrepTarget) {
        $downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ("kcoder-ripgrep-" + [guid]::NewGuid().ToString('N'))
        try {
            New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
            $archive = Join-Path $downloadRoot "ripgrep-$ripgrepVersion-$ripgrepTarget.zip"
            $url = "https://github.com/BurntSushi/ripgrep/releases/download/$ripgrepVersion/ripgrep-$ripgrepTarget.zip"
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
            $extractRoot = Join-Path $downloadRoot 'extract'
            Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
            $found = Get-ChildItem -LiteralPath $extractRoot -Filter 'rg.exe' -File -Recurse | Select-Object -First 1
            if ($found) { $ripgrepBinary = $found.FullName }
        } catch {
            Write-Warning "Could not bundle ripgrep ($url): $($_.Exception.Message)"
        }
    }
}

$outDir = $env:KCODER_RELEASE_OUT
if (-not $outDir) { $outDir = Join-Path $repoDir "target\dist" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stage = Join-Path ([IO.Path]::GetTempPath()) ("kcoder-release-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

try {
    Copy-Item -LiteralPath $binary -Destination (Join-Path $stage "kcoder.exe") -Force
    Copy-Item -LiteralPath $supervisorBinary -Destination (Join-Path $stage "kcoder-process-supervisor.exe") -Force
    Copy-Item -LiteralPath $installer -Destination (Join-Path $stage "install-kcoder.ps1") -Force
    $archiveItems = @(
        (Join-Path $stage "kcoder.exe"),
        (Join-Path $stage "kcoder-process-supervisor.exe"),
        (Join-Path $stage "install-kcoder.ps1")
    )
    if ($ripgrepBinary) {
        $rgDir = Join-Path $stage "lib\kcoder"
        New-Item -ItemType Directory -Force -Path $rgDir | Out-Null
        Copy-Item -LiteralPath $ripgrepBinary -Destination (Join-Path $rgDir "rg.exe") -Force
        $archiveItems += $rgDir
    }
    $archive = Join-Path $outDir "kcoder-$Version-$Target.zip"
    $latestArchive = Join-Path $outDir "kcoder-$Target.zip"
    Compress-Archive -LiteralPath $archiveItems -DestinationPath $archive -CompressionLevel Optimal -Force
    Copy-Item -LiteralPath $archive -Destination $latestArchive -Force

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    foreach ($path in @($archive, $latestArchive)) {
        $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText("$path.sha256", "$digest  $([IO.Path]::GetFileName($path))`n", $utf8)
    }
    Write-Output $archive
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    if ($downloadRoot) {
        Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
