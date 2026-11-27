import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSessionPersistence, createGatewayAuthSessionRegistry } from './browser-session-recovery.js';
import { createGatewayMigrationSourceSessions } from './migration-source-session-gateway.js';

async function fixture(t) {
  const data = { identityHash: 'a'.repeat(64), browserSessions: [] };
  let inspections = 0, launches = 0, reply;
  const persistence = await createBrowserSessionPersistence({ maximumSessions: 4, now: Date.now,
    transaction: async operation => operation(data),
    inspect: async operation => { inspections++; return operation(data); },
  });
  const registry = createGatewayAuthSessionRegistry({ authRequired: true, getServerIds: () => ['local'],
    maximumSessions: 4, ttlMs: 60_000, persistence, sessionSockets: new Map(),
    invalidateOwner() {}, expireDevice() {} });
  const { id, session } = await registry.create({ browserAdmin: true });
  t.after(() => { for (const value of registry.sessions.values()) clearTimeout(value.expiryTimer); });
  const gateway = createGatewayMigrationSourceSessions({ maxMessageBytes: 1024 * 1024,
    trackAppServerChild: value => value, loginContexts: {}, closeContextSockets() {},
    requireSameOriginMutation: () => true,
    requestBody: async () => JSON.stringify({ sessionId: '22222222-2222-4222-8222-222222222222', purpose: 'source', targetId: 'local' }),
    jsonResponse: (_response, status, body) => { reply = { status, body }; },
    requestLoginOwner: (_request, current) => current ? id : null,
    authenticatedSessionId: () => id, authSessionById: credential => registry.get(credential),
    getSessionState: credential => registry.sessions.get(credential),
    getTarget: () => ({ id: 'local', runtime: 'kcoder', transport: 'local' }),
    serverHealthSignature: () => 'owned-target', isMock: () => false,
    makeLaunchSpec: () => { launches++; throw new Error('Observation must not launch'); },
  });
  t.after(() => gateway.close());
  return { registry, persistence,
    revokeInSibling: () => { data.browserSessions = []; },
    read: async () => {
      await gateway.handle({ pathname: '/api/migration/source-session/read', request: { method: 'POST' }, response: {}, authSession: session });
      return reply;
    }, id, inspections: () => inspections, launches: () => launches };
}

test('migration state observation awaits actual asynchronous session authority without launching Native', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.read(), { status: 200, body: { status: 'released', launching: false, ownedChildren: 0 } });
  assert.equal(f.inspections(), 1);
  assert.equal(f.launches(), 0);
});

test('revocation after the HTTP gate is rejected by migration selection authority', async t => {
  const f = await fixture(t);
  f.revokeInSibling();
  assert.deepEqual(await f.read(), { status: 409, body: { error: 'source_transfer_authority_unavailable' } });
  assert.equal(f.inspections(), 1);
  assert.equal(f.launches(), 0);
});
