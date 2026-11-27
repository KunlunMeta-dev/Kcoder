import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayDeviceAuth, requireOriginalOperationDeviceAuthorization } from './gateway-device-auth.js';
import { createGatewayDeviceLifecycle, requireOriginalOperationDeviceOwner } from './gateway-device-lifecycle.js';
import { createAccountLoginContexts } from './account-login-context.js';
import { createGatewayAuthSessionRegistry } from './browser-session-recovery.js';

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-original-device-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = 1_000_000, enabled = true;
  const auth = createGatewayDeviceAuth({ directory, identity: 'owned-original-device',
    accessTtlMs: 1_000, socketGraceMs: 500, now: () => time, ...extra });
  const families = new Map(), sessions = new Map(), sessionSockets = new Map(), timers = new Set();
  const loginContexts = createAccountLoginContexts();
  const lifecycle = createGatewayDeviceLifecycle({ families, authSessions: sessions, sessionSockets, loginContexts,
    gatewayDeviceAuth: auth, getServerIds: () => ['a', 'b'], allowsSurface: () => enabled, now: () => time,
    setTimer(callback) { const handle = { callback, unref() {} }; timers.add(handle); return handle; },
    clearTimer(handle) { timers.delete(handle); } });
  const grant = await auth.pair();
  const { session, family } = lifecycle.registerGrant(grant);
  t.after(() => { for (const item of [...timers]) timers.delete(item); });
  return { directory, auth, families, sessions, sessionSockets, loginContexts, lifecycle, grant, session, family,
    advance(value) { time = value; }, expireTimers() { for (const item of [...timers]) item.callback(); },
    disable() { enabled = false; } };
}

test('opaque durable device authority survives access rotation/expiry without writing or accepting device JSON', async t => {
  const f = await fixture(t);
  const authority = await f.auth.captureOriginalOperationDeviceAuthorization(f.grant.accessToken);
  assert.equal(requireOriginalOperationDeviceAuthorization(authority), authority);
  assert.throws(() => requireOriginalOperationDeviceAuthorization({ ...authority }));
  const rotated = await f.auth.refresh(f.grant.refreshToken, randomUUID());
  await assert.rejects(f.auth.captureOriginalOperationDeviceAuthorization(f.grant.accessToken));
  await authority.checkCurrent();
  f.advance(rotated.wsLeaseExpiresAt + 1);
  const ledger = join(f.directory, 'mobile-device-auth', 'devices.json');
  const before = await stat(ledger, { bigint: true }), bytes = await readFile(ledger);
  assert.equal(await f.auth.inspectAccessAuthorization(rotated.accessToken), undefined);
  await authority.checkCurrent(); await authority.checkCurrent();
  const after = await stat(ledger, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(await readFile(ledger), bytes);
  await f.auth.revoke(f.grant.deviceId);
  await assert.rejects(authority.checkCurrent());
});

test('durable device expiry, epoch replacement, and installation key replacement reject the original authority', async t => {
  const expiring = await fixture(t, { idleTtlMs: 2_000, absoluteTtlMs: 3_000 });
  const expiredOwner = await expiring.auth.captureOriginalOperationDeviceAuthorization(expiring.grant.accessToken);
  expiring.advance(expiring.grant.refreshExpiresAt);
  await assert.rejects(expiredOwner.checkCurrent());
  for (const kind of ['epoch', 'key']) {
    const f = await fixture(t);
    const owner = await f.auth.captureOriginalOperationDeviceAuthorization(f.grant.accessToken);
    if (kind === 'epoch') {
      const file = join(f.directory, 'mobile-device-auth', 'devices.json');
      const data = JSON.parse(await readFile(file, 'utf8'));
      data.devices[0].authEpoch = randomUUID();
      await writeFile(file, JSON.stringify(data));
    } else await writeFile(join(f.directory, 'mobile-device-auth', '.key'), 'b'.repeat(64));
    await assert.rejects(owner.checkCurrent());
  }
});

test('family expiry only closes transport; fixed owners use current ACL after old sessions leave the registry', async t => {
  const f = await fixture(t);
  let destroyed = 0;
  f.family.sockets.add({ destroy() { destroyed++; } });
  const owner = await f.lifecycle.captureOriginalOperationOwner(f.grant.accessToken, f.session);
  assert.equal(requireOriginalOperationDeviceOwner(owner), owner);
  assert.throws(() => requireOriginalOperationDeviceOwner({ ...owner }));
  const stableLogin = f.grant.stableLoginOwner;
  const generation = f.loginContexts.generation(stableLogin, 'a');
  f.advance(f.grant.wsLeaseExpiresAt + 1); f.expireTimers();
  assert.equal(destroyed, 1); assert.equal(f.families.size, 0); assert.equal(f.sessions.size, 0);
  assert.equal(f.loginContexts.generation(stableLogin, 'a'), generation);
  await owner.checkCurrent();
  await assert.rejects(f.lifecycle.captureOriginalOperationOwner(f.grant.accessToken, f.session));
  f.lifecycle.reconcileAccess(['a', 'b'], ['a'], () => new Set(['a']));
  assert.equal(f.session.allowedServerIds.has('b'), true, 'the removed session deliberately retains its old projection');
  assert.equal(owner.isTargetAllowed('b'), false, 'the fixed owner reads actual current ACL, not that stale projection');
  f.lifecycle.invalidateOwner(f.grant.deviceId);
  assert.equal(f.loginContexts.generation(stableLogin, 'a'), generation + 1);
  assert.throws(() => owner.verifyScopeFacts());
  await assert.rejects(owner.checkCurrent());
});

test('a source-owner check rejected around an await cannot publish a revoked or disabled device scope', async t => {
  for (const mutate of [f => f.lifecycle.invalidateOwner(f.grant.deviceId), f => f.disable()]) {
    const f = await fixture(t);
    const owner = await f.lifecycle.captureOriginalOperationOwner(f.grant.accessToken, f.session);
    const pending = owner.checkCurrent();
    mutate(f);
    await assert.rejects(pending);
  }
});

test('auth registry automatic device expiry preserves stable ownership, explicit logout revokes it, browsers retain old semantics', async () => {
  let time = 10;
  const invalidated = [], transport = [], revoked = [];
  const registry = createGatewayAuthSessionRegistry({ authRequired: true, getServerIds: () => ['a'], maximumSessions: 8,
    ttlMs: 1000, sessionSockets: new Map(), now: () => time,
    invalidateOwner: id => invalidated.push(id), expireDevice: id => revoked.push(id),
    expireDeviceTransport: id => { transport.push(id); registry.sessions.delete('device-access'); } });
  registry.sessions.set('device-access', { deviceId: 'actual-device', stableLoginOwner: 'actual-owner', expiresAt: 20,
    accessExpiresAt: 15, allowedServerIds: new Set(['a']) });
  time = 21;
  assert.equal(await registry.get('device-access'), null);
  await registry.get('drain-queued-expiry');
  assert.deepEqual(transport, ['actual-device']); assert.deepEqual(invalidated, []); assert.deepEqual(revoked, []);
  registry.sessions.set('device-access', { deviceId: 'actual-device', stableLoginOwner: 'actual-owner', expiresAt: 50 });
  await registry.delete('device-access');
  assert.deepEqual(revoked, ['actual-device']); assert.deepEqual(invalidated, ['actual-owner']);
  registry.sessions.set('browser', { expiresAt: 20, allowedServerIds: new Set(['a']) });
  await registry.get('browser'); await registry.get('drain-browser');
  assert.ok(invalidated.includes('browser'));
});
