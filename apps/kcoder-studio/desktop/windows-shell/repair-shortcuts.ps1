param(
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [string]$DesktopLink = '',
    [string]$StartMenuLink = '',
    [string]$PinnedRoot = (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned')
)
$ErrorActionPreference = 'Stop'
$exe = [IO.Path]::GetFullPath((Join-Path $InstallDir 'kcoder-studio.exe'))
$resource = Join-Path $InstallDir 'resources\shell'
$source = Join-Path $resource 'icon.ico'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Installed KCoder executable is missing' }
$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$icon = Join-Path $resource "kcoder-$hash.ico"
if (!(Test-Path -LiteralPath $icon)) { Copy-Item -LiteralPath $source -Destination $icon }
if ((Get-FileHash -LiteralPath $icon -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) {
    throw 'Installed Shell icon content does not match the package'
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KCoderShortcutNotification {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    public static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);
}
'@
$paths = @(@($DesktopLink, $StartMenuLink) | Where-Object { $_ })
function Test-OrdinaryPath([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    while ($item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        $item = if ($item.PSIsContainer) { $item.Parent } else { $item.Directory }
    }
    return $true
}
# Only inspect the user's existing pinned links; never create or remove pinned entries.
if ((Test-Path -LiteralPath $PinnedRoot -PathType Container) -and (Test-OrdinaryPath $PinnedRoot)) {
    $directories = New-Object 'System.Collections.Generic.Queue[string]'
    $directories.Enqueue($PinnedRoot)
    $visited = 0
    while ($directories.Count -gt 0 -and $visited -lt 1024) {
        $directory = $directories.Dequeue()
        foreach ($entry in (Get-ChildItem -LiteralPath $directory -Force | Select-Object -First (1025 - $visited))) {
            $visited++
            if ($visited -gt 1024) { break }
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
            if ($entry.PSIsContainer) { $directories.Enqueue($entry.FullName) }
            elseif ($entry.Extension -eq '.lnk') { $paths += $entry.FullName }
        }
    }
}
$shell = New-Object -ComObject WScript.Shell
$updated = 0
try {
    foreach ($path in ($paths | Select-Object -Unique)) {
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        if (!(Test-OrdinaryPath $path)) { continue }
        $link = $shell.CreateShortcut($path)
        try {
            # Names alone never establish ownership. Preserve arguments and all other link fields.
            if (!$link.TargetPath -or ![String]::Equals([IO.Path]::GetFullPath($link.TargetPath), $exe,
                    [StringComparison]::OrdinalIgnoreCase)) { continue }
            $link.IconLocation = "$icon,0"
            if (!(Test-OrdinaryPath $path)) { continue }
            $link.Save()
            [KCoderShortcutNotification]::SHChangeNotify(0x2000, 0x5, $path, [IntPtr]::Zero)
            $updated++
        } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null }
    }
} finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
Write-Output "Updated $updated KCoder shortcut icons"
