import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, readFile, writeFile, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { repoRoot, waitFor } from './run-context.mjs';

export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function physicalSshArgs({ target, key, knownHosts }, command) {
  assert.match(target, /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/);
  assert.ok(key.startsWith('/') && knownHosts.startsWith('/'));
  return ['-T', '-F', '/dev/null', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', ...(command === undefined ? [] : [target, command])];
}
async function waitExit(child, timeout = 30000) {
  if (child.exitCode !== null) { assert.equal(child.exitCode, 0); return; }
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('owned SSH subprocess did not exit')), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error(`owned SSH subprocess exited ${code}`)); });
  });
}
export async function startPhysicalWidgetSsh(context, { target, key, knownHosts, binary, localProviderPort }) {
  const root = `/tmp/kcoder-widget-e2e-${randomBytes(12).toString('hex')}`; const nonce = randomBytes(16).toString('hex'); context.registerSecret(nonce);
  const hostsCopy = context.pathInState('physical-known-hosts'); await copyFile(knownHosts, hostsCopy); await chmod(hostsCopy, 0o600);
  const connection = { target, key, knownHosts: hostsCopy }; const args = physicalSshArgs(connection);
  const source = await readFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/fixtures/owned-widget-ssh.py'), 'utf8');
  const command = `python3 -u -c ${shellQuote(source)} ${shellQuote(root)} ${shellQuote(nonce)}`;
  const child = context.spawnOwned('physical-widget-controller', '/usr/bin/ssh', [...args, target, command], { stdin: 'pipe' });
  const frames = []; const waiters = new Map(); let failure = null; let next = 0;
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', line => { try { const frame = JSON.parse(line); frames.push(frame); const waiter = waiters.get(frame.id); if (waiter) { waiters.delete(frame.id); clearTimeout(waiter.timer); waiter.resolve(frame.result); } } catch { failure = new Error('remote controller returned invalid JSON'); } });
  const request = (action, extra = {}) => new Promise((resolveReply, reject) => {
    const id = ++next; const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`remote fixture ${action} timed out`)); }, action === 'verify_binary' ? 30000 : 9000);
    waiters.set(id, { resolve: resolveReply, timer }); child.stdin.write(`${JSON.stringify({ id, action, ...extra })}\n`);
  });
  let cleaned = false;
  context.addCleanup('release verified physical widget root', async () => { if (!cleaned) { assert.deepEqual(await request('cleanup'), { cleaned: true }); cleaned = true; await waitExit(child); } });
  await waitFor(() => { if (failure) throw failure; if (child.exitCode !== null) throw new Error('remote fixture controller exited before ownership acknowledgement'); return frames.find(frame => frame.ready === true); }, 15000, 'physical fixture ownership');
  const frozen = context.pathInState('physical-kcoder'); await copyFile(binary, frozen); await chmod(frozen, 0o700);
  const hash = createHash('sha256'); await pipeline(createReadStream(frozen), hash); const sha256 = hash.digest('hex');
  const upload = context.spawnOwned('physical-widget-binary-upload', '/usr/bin/scp', ['-F', '/dev/null', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${hostsCopy}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', frozen, `${target}:${root}/kcoder`]);
  await waitExit(upload, 120000); const verified = await request('verify_binary', { sha256 }); assert.equal(verified.sha256, sha256);
  const forwarding = context.spawnOwned('physical-widget-provider-forward', '/usr/bin/ssh', [...args, '-o', 'ExitOnForwardFailure=yes', '-N', '-R', `127.0.0.1:0:127.0.0.1:${localProviderPort}`, target]);
  let forwardLog = ''; forwarding.stderr.on('data', chunk => { forwardLog = (forwardLog + chunk).slice(-8192); });
  const remotePort = await waitFor(() => { if (forwarding.exitCode !== null) throw new Error('owned remote forwarding exited'); return Number(forwardLog.match(/Allocated port (\d+) for remote forward/)?.[1]) || null; }, 15000, 'owned remote Provider forwarding');
  const wrapperDir = context.pathInState('physical-ssh-bin'); const { mkdir } = await import('node:fs/promises'); await mkdir(wrapperDir);
  await writeFile(resolve(wrapperDir, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh ${args.map(shellQuote).join(' ')} "$@"\n`, { mode: 0o700 });
  await context.writeArtifactJson('physical-owner-evidence.json', { target, root, sourceBinarySha256: sha256, sourceBytes: verified.bytes, remoteProviderPort: remotePort, installed: false, personalConfigTouched: false });
  return { root, sha256, remoteProviderPort: remotePort, providerEndpoint: `http://127.0.0.1:${remotePort}/v1`, wrapperDir,
    configure: settings => request('configure', { settings }),
    verifyCleaned: () => cleaned };
}
