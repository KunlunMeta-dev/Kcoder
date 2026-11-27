[CmdletBinding()]
param(
    [string]$InstallDir = $(if ($env:KCODER_INSTALL_DIR) { $env:KCODER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\KCoder\bin" })
)

$ErrorActionPreference = "Stop"
$binary = Join-Path $InstallDir "kcoder.exe"
$retiredStem = 'kunlun' + 'code'
$legacyBinary = Join-Path $InstallDir ($retiredStem + '.exe')
$legacyFamilyBinary = Join-Path $InstallDir ('kunlun' + '.exe')
$supervisor = Join-Path $InstallDir "kcoder-process-supervisor.exe"
$ripgrep = Join-Path $InstallDir "lib\kcoder\rg.exe"
if (-not (Test-Path -LiteralPath $binary) -and -not (Test-Path -LiteralPath $legacyBinary) -and -not (Test-Path -LiteralPath $legacyFamilyBinary) -and -not (Test-Path -LiteralPath $supervisor) -and -not (Test-Path -LiteralPath $ripgrep)) {
    Write-Output "KCoder is not installed at $binary"
    exit 0
}
if (Test-Path -LiteralPath $legacyBinary -PathType Leaf) {
    Remove-Item -LiteralPath $legacyBinary -Force
    Write-Output "Removed a retired command entry"
}
if (Test-Path -LiteralPath $legacyFamilyBinary -PathType Leaf) {
    Remove-Item -LiteralPath $legacyFamilyBinary -Force
    Write-Output "Removed a retired command entry"
}
if (Test-Path -LiteralPath $binary -PathType Leaf) {
    Remove-Item -LiteralPath $binary -Force
    Write-Output "Removed $binary"
}
if (Test-Path -LiteralPath $supervisor -PathType Leaf) {
    Remove-Item -LiteralPath $supervisor -Force
    Write-Output "Removed $supervisor"
}
if (Test-Path -LiteralPath $ripgrep -PathType Leaf) {
    Remove-Item -LiteralPath $ripgrep -Force
    Write-Output "Removed $ripgrep"
}
Write-Output "User settings and history were kept. Remove them separately if no longer needed."
