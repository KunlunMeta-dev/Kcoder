import { isAbsolute, win32 } from 'node:path';

export function assertWindowsInputCleanupReady(state) {
  if (!['not_started', 'confirmed'].includes(state)) throw new Error('OWNED_NATIVE_INPUT_RECOVERY_UNCONFIRMED');
}

export function observeWindowsInputCleanup(value) {
  return value && value.cleaned === true && value.fixtureStateRetained !== true && !value.result?.nativeInputRecovery
    ? 'confirmed' : 'unknown';
}

/** The original owner alone may remove its run directory; recovery hints only veto removal. */
export function windowsProbeCleanupScript(directory) {
  if (typeof directory !== 'string' || !(win32.isAbsolute(directory) || isAbsolute(directory)) || /['\r\n\0]/.test(directory)
      || !/^kcoder-windows-e2e-[a-f0-9-]{36}$/.test(win32.basename(directory))) throw new Error('OWNED_WINDOWS_PROBE_DIRECTORY_INVALID');
  return `$ErrorActionPreference='Stop';$owned='${directory}';
$directory=Get-Item -LiteralPath $owned -Force -ErrorAction Stop;
if(-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'OWNED_WINDOWS_PROBE_DIRECTORY_CHANGED'}
if(Test-Path -LiteralPath (Join-Path $owned 'native-input-recovery-required.json') -ErrorAction Stop){throw 'OWNED_NATIVE_INPUT_RECOVERY_UNCONFIRMED'}
foreach($child in @(Get-ChildItem -LiteralPath $owned -Directory -Force -ErrorAction Stop)){
  if($child.Name.StartsWith('studio-ui-') -or $child.Name -in @('installed-ui-profile','office-ui-profile')){
    if(($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Test-Path -LiteralPath (Join-Path $child.FullName 'native-input-foreground.json') -ErrorAction Stop)){throw 'OWNED_NATIVE_INPUT_RECOVERY_UNCONFIRMED'}
  }
}
[IO.Directory]::Delete($owned,$true);if([IO.Directory]::Exists($owned)){throw 'Remote cleanup failed'}`;
}
