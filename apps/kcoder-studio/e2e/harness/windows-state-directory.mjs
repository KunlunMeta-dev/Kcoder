import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export async function secureWindowsRunState(stateDirectory, runRoot, {
  execute = promisify(execFile), systemRoot = process.env.SystemRoot,
} = {}) {
  assert.match(runRoot, /^[A-Za-z]:\\/);
  assert.equal(win32.normalize(stateDirectory).toLowerCase(), win32.join(runRoot, 'state').toLowerCase(), 'Only the owned state directory may be secured');
  assert.match(systemRoot ?? '', /^[A-Za-z]:\\/);
  const powershell = win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('windows-state-directory.ps1', import.meta.url)),
    '-StateDirectory', stateDirectory, '-RunRoot', runRoot,
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const receipt = JSON.parse(stdout.trim());
  assert.equal(win32.normalize(receipt.path).toLowerCase(), win32.normalize(stateDirectory).toLowerCase());
  assert.match(receipt.currentSid, /^S-1-[0-9-]+$/);
  assert.equal(receipt.ownerSid, receipt.currentSid);
  assert.equal(receipt.protected, true);
  assert.equal(receipt.aceCount, 1);
  assert.equal(receipt.inheritableFullControl, true);
  return receipt;
}
