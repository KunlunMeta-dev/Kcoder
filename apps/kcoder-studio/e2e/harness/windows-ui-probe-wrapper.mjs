import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { spawnWindowsSupervised } from './owned-process.mjs';

export function validateWindowsUiProbe(input) {
  assert.match(input.owner, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  for (const key of ['directory', 'node', 'installation']) {
    assert.ok(typeof input[key] === 'string' && win32.isAbsolute(input[key]) && !/[\0\r\n]/.test(input[key]), 'Explicit Windows path required');
  }
  assert.ok(['migration', 'remote-oauth', 'remote-models'].includes(input.mode), 'Unsupported owned UI mode');
}

async function main(file) {
  assert.equal(process.platform, 'win32');
  const input = JSON.parse(await readFile(file, 'utf8'));
  validateWindowsUiProbe(input);
  const root = input.directory;
  assert.equal(JSON.parse(await readFile(join(root, '.owner.json'), 'utf8')).owner, input.owner);
  const creationTicks = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`],
  { windowsHide: true, encoding: 'utf8', timeout: 10000 }).trim();
  assert.match(creationTicks, /^\d+$/);
  await writeFile(join(root, 'probe-owner.json'), JSON.stringify({ owner: input.owner, pid: process.pid,
    creationTicks, creationKind: 'process-start-time' }));
  let child, finished = false;
  const authority = createInterface({ input: process.stdin });
  authority.on('close', () => { if (!finished) { child?.stdin.destroy(); process.exitCode = 2; } });
  const lease = await new Promise((resolve, reject) => {
    authority.once('line', line => { try { resolve(JSON.parse(line)); } catch { reject(Error('Invalid UI owner lease')); } });
    authority.once('close', () => { if (!finished) reject(Error('UI owner disconnected')); });
  });
  assert.equal(lease.owner, input.owner);
  process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = join(input.installation, 'resources/bin/kcoder-process-supervisor.exe');
  const supervised = spawnWindowsSupervised(input.node,
    [join(root, 'probe.cjs'), join(root, 'kcoder.exe'), input.installation, join(root, 'overlay'), root, '--' + input.mode],
    { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }, join(root, 'process-status'));
  child = supervised.child;
  let bytes = 0;
  const timer = setTimeout(() => child.stdin.destroy(), 220000);
  for (const channel of ['stdout', 'stderr']) child[channel].on('data', data => {
    bytes += data.length;
    if (bytes > 2 * 1024 * 1024) child.stdin.destroy();
    else process[channel].write(data);
  });
  try {
    const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await supervised.identity.readyPromise;
    process.exitCode = (await completion) ?? 1;
  } finally {
    clearTimeout(timer); finished = true; authority.close(); child.stdin.destroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv[2]);
