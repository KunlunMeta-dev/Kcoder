import assert from 'node:assert/strict'
import { join } from 'node:path'
import { waitFor } from './run-context.mjs'

// Keep the opaque fixture up while the owned host and recovery worker retire.
// This is a read-only process-identity check; it never kills by process name.
export async function waitOwnedDesktopControllersStopped({ context, packageRoot, powershell, env }) {
  const component = (join(packageRoot, 'resources/computer-use') + '\\').replace(/'/g, "''")
  const cli = join(packageRoot, 'resources/bin/kcoder.exe').replace(/'/g, "''")
  const script = `$ErrorActionPreference='Stop';$deadline=[DateTime]::UtcNow.AddSeconds(20);$verbatim=[string]([char]92)+[char]92+'?'+[char]92;do{$remaining=@(Get-CimInstance Win32_Process|Where-Object {$path=[string]$_.ExecutablePath;if($path.StartsWith($verbatim,[StringComparison]::Ordinal)){$path=$path.Substring(4)};$path -and ($path.StartsWith('${component}',[StringComparison]::OrdinalIgnoreCase) -or $path.Equals('${cli}',[StringComparison]::OrdinalIgnoreCase))});if($remaining.Count -eq 0){exit 0};Start-Sleep -Milliseconds 100}while([DateTime]::UtcNow -lt $deadline);throw 'Owned desktop controllers survived host cleanup'`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const probe = context.spawnOwned('desktop-controller-cleanup-check', powershell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env })
  await waitFor(() => probe.exitCode !== null, 25000, 'owned desktop controller process retirement')
  assert.equal(probe.exitCode, 0, 'opaque fixture cannot close before owned controllers retire')
  return true
}
