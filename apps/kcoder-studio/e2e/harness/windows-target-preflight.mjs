import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { waitForStdioChildClose } from './app-server-stdio.mjs';
import { runE2E } from './run-context.mjs';

const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
assert.ok(typeof target === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/.test(target),
  'UNMET_PREREQUISITE: provide an authorized SSH target alias');
const source = await readFile(new URL('./fixtures/windows-target-preflight.ps1', import.meta.url), 'utf8');
const command = Buffer.from(source, 'utf16le').toString('base64');

await runE2E(import.meta.url, { testId: 'windows-read-only-target-preflight', tier: 'host-preflight',
  modelPolicy: 'User-authorized read-only SSH inventory; no settings, account, task, desktop, installation or model changes.' }, async context => {
  const label = 'windows-read-only-preflight';
  const child = context.spawnOwned(label, 'ssh', ['-T', '-S', 'none',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
    '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', target,
    'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command],
  { env: context.isolatedEnvironment() });
  let stdout = '', bytes = 0, overflow = false;
  child.stdout.on('data', value => {
    bytes += value.length;
    if (bytes <= 32 * 1024) stdout += value.toString('utf8');
    else overflow = true;
  });
  const close = await waitForStdioChildClose(child, 20000, label);
  await context.stopOwned(label);
  assert.equal(overflow, false, 'Read-only preflight output exceeded its budget');
  assert.equal(close.code, 0, 'SSH preflight did not complete successfully; inspect the owned log');
  assert.equal(close.signal, null);
  const result = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
  assert.equal(result.version, 1);
  assert.equal(result.readOnly, true);
  assert.ok(typeof result.identity === 'string' && result.identity.length < 256);
  await context.writeArtifactJson('target-preflight.json', { target, ...result,
    userDesktopAccessed: false, globalConfigurationChanged: false });
  return { target, computer: result.computer, powerShellVersion: result.powerShellVersion,
    nodeAvailable: Boolean(result.nodePath), studioAvailable: result.studioDirectories.length > 0,
    readOnly: true };
});
