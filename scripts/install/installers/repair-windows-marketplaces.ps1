[CmdletBinding()]
param(
    [string]$SettingsFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$marketplacePathHelpers = Join-Path $repoDir "scripts\install\lib\windows-marketplace-paths.ps1"
. $marketplacePathHelpers

if (-not $SettingsFile) {
    $SettingsFile = Join-Path $env:USERPROFILE ".config\kcoder\settings.json"
}
$SettingsFile = [IO.Path]::GetFullPath($SettingsFile)
if (-not (Test-Path -LiteralPath $SettingsFile -PathType Leaf)) {
    throw "KCoder settings file not found: $SettingsFile"
}

$settings = Get-Content -Raw -LiteralPath $SettingsFile | ConvertFrom-Json
if ($null -eq $settings -or $settings -isnot [PSCustomObject]) {
    throw "Settings root must be a JSON object: $SettingsFile"
}
$removedMarketplaces = @(Remove-NonPortableWindowsMarketplaces $settings)

$backupPath = $null
if ($removedMarketplaces.Count -gt 0) {
    $backupPath = "$SettingsFile.bak-$(Get-Date -Format yyyyMMddHHmmss)"
    if (Test-Path -LiteralPath $backupPath) {
        $backupPath = "$backupPath-$([guid]::NewGuid().ToString('N'))"
    }
    $utf8 = New-Object Text.UTF8Encoding($false)
    $temporaryPath = "$SettingsFile.tmp-$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText(
            $temporaryPath,
            (($settings | ConvertTo-Json -Depth 100) + [Environment]::NewLine),
            $utf8
        )
        [IO.File]::Replace($temporaryPath, $SettingsFile, $backupPath, $true)
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "Removed non-portable local marketplaces: $($removedMarketplaces -join ', ')"
    Write-Host "Backup: $backupPath"
} else {
    Write-Host "No non-portable local marketplace paths were found."
}

$kcoderInfo = Get-Command kcoder.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $kcoderInfo) {
    $kcoderInfo = Get-Command kcoder -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $kcoderInfo) {
    throw "kcoder command was not found; settings were inspected but post-repair checks could not run."
}

& $kcoderInfo.Source config validate
if ($LASTEXITCODE -ne 0) {
    throw "kcoder config validate failed after marketplace repair. Backup: $backupPath"
}
& $kcoderInfo.Source marketplace list
if ($LASTEXITCODE -ne 0) {
    throw "kcoder marketplace list failed after marketplace repair. Backup: $backupPath"
}

$verifiedSettings = Get-Content -Raw -LiteralPath $SettingsFile | ConvertFrom-Json
$remaining = @(Get-NonPortableWindowsMarketplaceNames $verifiedSettings)
if ($remaining.Count -gt 0) {
    throw "Non-portable local marketplaces reappeared after KCoder startup: $($remaining -join ', '). Replace the installed executable with a package built from sanitized settings. Backup: $backupPath"
}
Write-Host "KCoder settings and marketplace checks passed."
