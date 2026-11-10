import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createMobilePeerOwnership } from './mobile-peer-ownership.js';

const token = 'a'.repeat(48);

function ownerFixture(overrides = {}) {
  const session = {
    deviceId: 'device-owner',
    authorizationGeneration: 'generation-1',
    expiresAt: Date.now() + 60_000,
    accessExpiresAt: Date.now() + 60_000,
    wsLeaseExpiresAt: Date.now() + 60_000,
    allowedServerIds: new Set(['server-a']),
    ...overrides.session,
  };
  const family = {
    expiresAt: Date.now() + 60_000,
    authorizationGeneration: 'generation-1',
    sockets: new Set(),
    ...overrides.family,
  };
  const authSessions = new Map([[token, session]]);
  const mobileDeviceFamilies = new Map([[session.deviceId, family]]);
  const sessionSockets = new Map();
  const contextRows = new Map();
  const ownership = createMobilePeerOwnership({
    authSessionById: overrides.authSessionById ?? (async () => session),
    authSessions,
    mobileDeviceFamilies,
    sessionSockets,
    registerTargetContext: overrides.registerTargetContext ?? ((handle, boundSession, targetId) => {
      const key = `${boundSession.deviceId}:${targetId}`;
      let sockets = contextRows.get(key);
      if (!sockets) contextRows.set(key, sockets = new Set());
      sockets.add(handle);
      return () => {
        sockets.delete(handle);
        if (!sockets.size) contextRows.delete(key);
      };
    }),
  });
  return { session, family, authSessions, mobileDeviceFamilies, sessionSockets, contextRows, ownership };
}

test('peer handle is registered with token, device family, and target context owners and fully released', async () => {
  const fixture = ownerFixture();
  const handle = new EventEmitter();
  const session = await fixture.ownership.bind(handle, token, 'server-a');
  assert.equal(session, fixture.session);
  assert.ok(fixture.sessionSockets.get(token)?.has(handle));
  assert.ok(fixture.family.sockets.has(handle));
  assert.ok(fixture.contextRows.get('device-owner:server-a')?.has(handle));

  handle.emit('close');
  assert.equal(fixture.sessionSockets.has(token), false);
  assert.equal(fixture.family.sockets.has(handle), false);
  assert.equal(fixture.contextRows.size, 0);
  fixture.ownership.closeAll();
  assert.equal(fixture.sessionSockets.size, 0);
});

test('late auth completion after peer close cannot recreate owner registrations', async () => {
  let resolveSession;
  const pendingSession = new Promise(resolve => { resolveSession = resolve; });
  const fixture = ownerFixture({ authSessionById: () => pendingSession });
  const handle = new EventEmitter();
  const pendingBind = fixture.ownership.bind(handle, token, 'server-a');
  fixture.ownership.close(handle);
  resolveSession(fixture.session);
  assert.equal(await pendingBind, null);
  assert.equal(fixture.sessionSockets.size, 0);
  assert.equal(fixture.family.sockets.has(handle), false);
  assert.equal(fixture.contextRows.size, 0);
});

test('bind rejects expired family, expired websocket lease, changed generation, and disallowed target', async () => {
  for (const overrides of [
    { family: { expiresAt: Date.now() - 1 } },
    { session: { wsLeaseExpiresAt: Date.now() - 1 } },
    { session: { authorizationGeneration: 'generation-2' } },
    { session: { allowedServerIds: new Set() } },
  ]) {
    const fixture = ownerFixture(overrides);
    const handle = new EventEmitter();
    assert.equal(await fixture.ownership.bind(handle, token, 'server-a'), null);
    assert.equal(fixture.sessionSockets.size, 0);
    assert.equal(fixture.family.sockets.has(handle), false);
    assert.equal(fixture.contextRows.size, 0);
  }
});
