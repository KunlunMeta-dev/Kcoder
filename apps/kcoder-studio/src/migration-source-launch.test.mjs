import test from 'node:test';
import assert from 'node:assert/strict';
import { launchSpec, normalizeServer, workspaceReceiptParentAttempt } from './server-config.js';

const defaults = { repoRoot: '/repo', appServerBin: '/repo/kcoder', workspace: '/repo' };
const negotiated = { migrationSourceParentV1: true, migrationSourceTransferParentLaunchV1: true };

test('only a negotiated dedicated Windows migration launch adds the source-only flag', () => {
  const target = normalizeServer({ id: 'owned', label: 'Owned', transport: 'local' }, {
    ...defaults, platform: 'win32', appServerBin: String.raw`D:\Owned Fixture\kcoder.exe`, workspace: String.raw`D:\Owned Fixture\workspace`,
  });
  assert.deepEqual(launchSpec(target, { platform: 'win32' }).args, ['app-server']);
  assert.equal(workspaceReceiptParentAttempt(target, 'win32'), false);
  const spec = launchSpec(target, { platform: 'win32', ...negotiated });
  assert.deepEqual(spec.args, ['app-server', '--migration-source-parent-local-v1']);
  assert.equal(spec.env, undefined);
  assert.throws(() => launchSpec(target, { platform: 'win32', migrationSourceParentV1: true }), /not negotiated/);
  assert.throws(() => launchSpec(target, { platform: 'win32', ...negotiated, retentionParentV1: true }), /not valid/);
});

test('plain SSH source-only launch retains safe argv and never downgrades managed account identity', () => {
  const target = normalizeServer({ id: 'owned', label: 'Owned', transport: 'ssh', host: 'owned.example', command: '/owned/kcoder' }, defaults);
  assert.equal(workspaceReceiptParentAttempt(target), false);
  assert.deepEqual(launchSpec(target).args.slice(-2), ['/owned/kcoder', 'app-server']);
  assert.deepEqual(launchSpec(target, negotiated).args.slice(-3), ['/owned/kcoder', 'app-server', '--migration-source-parent-local-v1']);
  const account = normalizeServer({ id: 'account', label: 'Account', transport: 'ssh', host: 'owned.example', security: { identity: { mode: 'kcoder-account' } } }, defaults);
  assert.throws(() => launchSpec(account, negotiated), /not valid/);
  assert.equal(launchSpec(account).args.at(-1), 'kcoder-account');
});

test('stored target properties and a support declaration alone cannot enable the private launch', () => {
  const target = normalizeServer({ id: 'owned', label: 'Owned', transport: 'local', migrationSourceParentV1: true,
    migrationSourceTransferParentLaunchV1: true }, defaults);
  assert.deepEqual(launchSpec(target).args, ['app-server']);
  assert.deepEqual(launchSpec(target, { migrationSourceTransferParentLaunchV1: true }).args, ['app-server']);
  assert.throws(() => launchSpec(target, { ...negotiated, migrationSourceParentV1: 'true' }), /invalid/);
});
