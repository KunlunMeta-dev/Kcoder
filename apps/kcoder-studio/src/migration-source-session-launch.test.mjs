import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMigrationSourceSessionLauncher, terminateMigrationSourceSessionChild } from './migration-source-session-launch.js';
import { normalizeServer } from './server-config.js';

const defaults = { repoRoot: '/owned', appServerBin: '/owned/kcoder', workspace: '/owned/workspace' };
function spawnFixture(t) {
  const spawned = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => false;
    spawned.push({ child, command, args, options });
    return child;
  };
  t.after(() => { for (const { child } of spawned) child.emit('close', 0, null); });
  return { spawnProcess, spawned };
}

test('the concrete launcher uses the negotiated argv and real broker without inherited private parent assertions', async t => {
  const f = spawnFixture(t), adopted = [];
  const launch = createMigrationSourceSessionLauncher({ spawnProcess: f.spawnProcess, platform: 'win32',
    baseEnv: { PATH: 'owned-path', KCODER_PRIVATE_RETENTION_PARENT_V1: 'must-be-removed', KCODER_STUDIO_TOKEN: 'must-be-removed' } });
  const target = normalizeServer({ id: 'owned', label: 'Owned', transport: 'local' }, {
    ...defaults, platform: 'win32', appServerBin: String.raw`D:\Owned\kcoder.exe`, workspace: String.raw`D:\Owned\workspace`,
  });
  const probe = await launch({ target, phase: 'probe', adopt: r => adopted.push(r) });
  const actual = await launch({ target, phase: 'migration', parentLaunchSupported: true, adopt: r => adopted.push(r) });
  assert.deepEqual(f.spawned.map(record => record.args), [['app-server'], ['app-server', '--migration-source-parent-local-v1']]);
  assert.equal(f.spawned[1].options.windowsHide, true);
  assert.deepEqual(f.spawned[1].options.env, { PATH: 'owned-path' });
  assert.equal(probe.broker.migrationSourceParentV1, false); assert.equal(actual.broker.migrationSourceParentV1, true);
  assert.equal(actual.broker.child, actual.child); assert.equal(adopted.length, 2);
  await assert.rejects(launch({ target, phase: 'migration', adopt() {} }), /not negotiated/);
  assert.equal(f.spawned.length, 2);
});

test('managed authentication preserves the original account command and adopts the raw child before await', async t => {
  const f = spawnFixture(t), order = [];
  const target = normalizeServer({ id: 'owned', label: 'Owned', transport: 'ssh', host: 'owned.invalid',
    security: { identity: { mode: 'kcoder-account' } } }, defaults);
  const launch = createMigrationSourceSessionLauncher({ spawnProcess: f.spawnProcess,
    authenticate: async child => { order.push('authenticate'); return child; } });
  const resource = await launch({ target, phase: 'probe', adopt() { order.push('adopt'); } });
  assert.deepEqual(order, ['adopt', 'authenticate']);
  assert.equal(f.spawned[0].args.at(-1), 'kcoder-account');
  assert.ok(!f.spawned[0].args.includes('--migration-source-parent-local-v1'));
  assert.equal(resource.broker.retentionParentV1, true); assert.equal(resource.broker.migrationSourceParentV1, false);
});

test('unknown transports and missing managed authentication never spawn a process', async t => {
  const f = spawnFixture(t), launch = createMigrationSourceSessionLauncher({ spawnProcess: f.spawnProcess });
  await assert.rejects(launch({ target: { runtime: 'kcoder', transport: 'http' }, phase: 'probe', adopt() {} }),
    { reason: 'source_transfer_transport_unsupported' });
  const target = normalizeServer({ id: 'owned', label: 'Owned', transport: 'ssh', host: 'owned.invalid',
    security: { identity: { mode: 'kcoder-account' } } }, defaults);
  await assert.rejects(launch({ target, phase: 'probe', adopt() {} }), { reason: 'source_transfer_authority_unavailable' });
  assert.equal(f.spawned.length, 0);
});

test('the cleanup helper requires actual close rather than an exit code or successful signal call', async () => {
  const child = new EventEmitter(), signals = [];
  child.stdin = new PassThrough(); child.exitCode = 0;
  child.kill = signal => { signals.push(signal); return true; };
  const resource = { child, closed: false };
  assert.equal((await terminateMigrationSourceSessionChild(resource, { eofMs: 2, graceMs: 2, killMs: 2 })).status, 'unknown');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  setImmediate(() => child.emit('close', 0, null));
  assert.equal((await terminateMigrationSourceSessionChild(resource, { graceMs: 50, killMs: 50 })).status, 'stopped');
});

test('a migration child that closes after stdin EOF is not terminated before its native cleanup', async () => {
  const child = new EventEmitter(), signals = [];
  child.stdin = new PassThrough();
  child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0, null)));
  child.kill = signal => { signals.push(signal); return true; };
  const resource = { child, closed: false };
  const result = await terminateMigrationSourceSessionChild(resource, { eofMs: 50, graceMs: 2, killMs: 2 });
  assert.deepEqual(result, { status: 'stopped' });
  assert.equal(resource.closed, true);
  assert.deepEqual(signals, []);
});
