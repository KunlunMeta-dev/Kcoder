param(
    [string]$InstallDir,
    [ValidateSet('Install', 'Uninstall')][string]$Mode = 'Install',
    [ValidateSet('User', 'Machine')][string]$Scope = 'User'
)
$ErrorActionPreference = 'Stop'

function Get-KCoderPathIdentity([string]$Value) {
    $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
    try { return [IO.Path]::GetFullPath($expanded).TrimEnd('\').ToUpperInvariant() }
    catch { return $expanded.TrimEnd('\').ToUpperInvariant() }
}

function Update-KCoderCliPath {
    param(
        [Parameter(Mandatory=$true)][string]$Directory,
        [Parameter(Mandatory=$true)][ValidateSet('Install', 'Uninstall')][string]$Action,
        [Parameter(Mandatory=$true)][Microsoft.Win32.RegistryKey]$EnvironmentKey,
        [Parameter(Mandatory=$true)][Microsoft.Win32.RegistryKey]$OwnershipKey
    )
    $bin = [IO.Path]::GetFullPath((Join-Path $Directory 'resources\bin'))
    if ($Action -eq 'Install' -and !(Test-Path -LiteralPath (Join-Path $bin 'kcoder.exe') -PathType Leaf)) {
        throw 'The bundled KCoder CLI executable is missing'
    }
    $identity = Get-KCoderPathIdentity $bin
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $ownerName = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '') }
    finally { $sha.Dispose() }
    $raw = $EnvironmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($raw -isnot [string]) { throw 'PATH is not a string; leaving it unchanged' }
    $kind = if ($EnvironmentKey.GetValueNames() -contains 'Path') { $EnvironmentKey.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $entries = @($raw.Split([char]';'))
    $present = @($entries | Where-Object { $_ -and (Get-KCoderPathIdentity $_) -eq $identity }).Count -gt 0
    $owned = $OwnershipKey.GetValue($ownerName, '') -eq $identity
    $changed = $false
    if ($Action -eq 'Install' -and !$present) {
        # Prepend only in the selected installation scope; preserve other CLI entries.
        $updated = if ($raw) { "$bin;$raw" } else { $bin }
        if ($updated.Length -gt 32760) { throw 'PATH is too long; CLI registration was not changed' }
        $EnvironmentKey.SetValue('Path', $updated, $kind)
        $OwnershipKey.SetValue($ownerName, $identity, [Microsoft.Win32.RegistryValueKind]::String)
        $changed = $true
    } elseif ($Action -eq 'Uninstall' -and $owned) {
        if ($present) {
            $remaining = @($entries | Where-Object { !$_ -or (Get-KCoderPathIdentity $_) -ne $identity })
            $EnvironmentKey.SetValue('Path', ($remaining -join ';'), $kind)
            $changed = $true
        }
        $OwnershipKey.DeleteValue($ownerName, $false)
    }
    # A pre-existing entry is deliberately not claimed by the installer.
    [pscustomobject]@{ Changed = $changed; PathEntry = $bin; Action = $Action }
}

if ($MyInvocation.InvocationName -ne '.') {
    if (!$InstallDir) { throw 'InstallDir is required' }
    $registry = if ($Scope -eq 'Machine') { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
    $environmentPath = if ($Scope -eq 'Machine') { 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' } else { 'Environment' }
    $environmentKey = $registry.CreateSubKey($environmentPath)
    $ownershipKey = $registry.CreateSubKey('Software\KunlunMeta\KCoder Studio\CliPathOwners')
    try { $result = Update-KCoderCliPath -Directory $InstallDir -Action $Mode -EnvironmentKey $environmentKey -OwnershipKey $ownershipKey }
    finally { $environmentKey.Dispose(); $ownershipKey.Dispose() }
    if ($result.Changed) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KCoderCliPathNotify {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr parameter,
        string text, uint flags, uint timeout, out UIntPtr result);
}
'@
        $notification = [UIntPtr]::Zero
        [KCoderCliPathNotify]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero,
            'Environment', 2, 5000, [ref]$notification) | Out-Null
    }
    Write-Output "KCoder CLI $Mode complete. Restart your terminal to refresh PATH."
}
