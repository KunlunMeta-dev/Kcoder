import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPeerSshAdminRunner, peerSshAdminLaunch } from './remotes/peer-ssh-admin.mjs';
import { peerSshFactsFixture } from './remotes/__fixtures__/peer-ssh-facts.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-peer-ssh-admin-'));
  const command = join(root, 'native');
  const worker = fileURLToPath(new URL('./remotes/__fixtures__/peer-ssh-admin-worker.mjs', import.meta.url));
  await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${worker}' "$@"\n`, { mode: 0o700 });
  const target = { id: 'owned-ssh', runtime: 'kcoder', transport: 'ssh', host: 'owned.invalid', user: 'owned', command,
    remoteCwd: root, settingsFile: '/owned/overlay.json', profile: 'owned-profile' };
  const tracked = new Set(), children = [];
  const state = { current: true, authFailure: false, loginCurrent: true };
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  };
  const runner = createPeerSshAdminRunner({ timeoutMs: 3000,
    baseEnv: { ...process.env, OWNED_PEER_CAPTURE: join(root, 'captured.json') },
    trackChild: child => { tracked.add(child); child.once('close', () => tracked.delete(child)); }, isTrackedChild: child => tracked.has(child), terminateChild: stop,
    spawnChild(_command, args, options) {
      const at = args.indexOf('owned@owned.invalid'); assert.ok(at >= 0);
      const child = spawn('/bin/sh', ['-c', args.slice(at + 1).join(' ')], options); children.push(child); return child;
    },
    // This unit tests the fixed management wrapper and cleanup, not actual SSH
    // authentication. Real OpenSSH/Native enrollment belongs to the UID suite.
    observeAuthentication({ child }) {
      if (state.authFailure) throw new Error('OWNED_AUTH_CAPTURE_FAILED');
      const verify = () => { if (!state.current || !tracked.has(child)) throw new Error('OWNED_TRANSPORT_CHANGED'); };
      const facts = { key: 'ssh-ed25519 SHA256:fixture', username: 'owned', verifyPolicy() { if (!state.current) throw new Error('OWNED_TRANSPORT_CHANGED'); },
        requireExited() { assert.ok(child.exitCode !== null || child.signalCode !== null); } };
      return { ready: Promise.resolve(facts), verify, close() {} };
    } });
  const verifyCurrent = () => { if (!state.current) throw new Error('OWNED_SCOPE_CHANGED'); };
  const authorizeCurrent = async () => { if (!state.loginCurrent) throw new Error('OWNED_LOGIN_REVOKED'); };
  t.after(async () => { await runner.close(); await Promise.all(children.map(stop)); await rm(root, { recursive: true, force: true }); });
  return { root, target, runner, state, children, verifyCurrent, authorizeCurrent };
}
test('fixed SSH administration preserves target selectors and waits for the original exit', async t => {
  const f = await fixture(t);
  const launch = peerSshAdminLaunch(f.target, f.root, 'prepare', undefined, '1'.repeat(64));
  assert.ok(launch.args.at(-1).includes('--settings-file'));
  assert.ok(launch.args.at(-1).includes('owned-profile'));
  assert.ok(!launch.args.at(-1).includes('app-server'));
  const result = await f.runner.run({ target: f.target, workspacePath: f.root, action: 'prepare', verifyCurrent: f.verifyCurrent, authorizeCurrent: f.authorizeCurrent });
  assert.equal(result.value.native.profileIdentity, 'owned-profile');
  assert.equal(f.children[0].exitCode, 0);
});
test('one compact pin command reaches stdin intact, with no command bytes in argv', async t => {
  const f = await fixture(t); const enrollment = peerSshFactsFixture().enrollment;
  const command = { version: 1, purpose: 'kcoder.peer-message.ssh-pin-change.v1', operationId: 'owned-operation', expectedRevision: 0,
    action: { kind: 'authorize', enrollment } };
  const result = await f.runner.run({ target: f.target, workspacePath: f.root, action: 'apply', command,
    verifyCurrent: f.verifyCurrent, authorizeCurrent: f.authorizeCurrent, expectedSsh: { sshHostKey: 'ssh-ed25519 SHA256:fixture', sshUser: 'owned' } });
  assert.equal(result.value.operationId, command.operationId);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'captured.json'), 'utf8')), command);
  assert.ok(!f.children[0].spawnargs.join(' ').includes('owned-operation'));
  assert.equal(f.children[0].exitCode, 0);
});
test('failure to capture authentication still closes the exact owned child', async t => {
  const f = await fixture(t); f.state.authFailure = true;
  await assert.rejects(f.runner.run({ target: f.target, workspacePath: f.root, action: 'prepare', verifyCurrent: f.verifyCurrent,
    authorizeCurrent: f.authorizeCurrent }), /AUTH_CAPTURE_FAILED/);
  assert.ok(f.children[0].exitCode !== null || f.children[0].signalCode !== null);
});
