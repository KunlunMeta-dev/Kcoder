import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerInventoryRoutes } from './server-inventory-routes.js';

function fixture() {
  const state = { servers: [{ id: 'local' }], calls: [], sameOrigin: true, body: '{}' };
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  const session = { allowedServerIds: new Set(['local']) };
  const route = createServerInventoryRoutes({
    getServers: () => state.servers,
    sshConnections: { list: async () => [], upsert: async profile => { state.calls.push(profile); return profile; } },
    jsonResponse: (res, status, body) => { res.status = status; res.body = body; },
    requireSameOriginMutation: () => state.sameOrigin,
    requestBody: async (_request, limit) => { assert.equal(limit, 32 * 1024); return state.body; },
    requestLoginOwner: () => 'owner',
    publicServerInventory: (scope, owner) => ({ servers: state.servers.filter(target => scope.allowedServerIds.has(target.id)), owner }),
    serverHealthScopeKey: (target, owner) => `${target.id}:${owner}`,
    probeServerHealthBounded: async (targets, owner) => { state.calls.push({ targets, owner }); return []; },
    respondWithServerStatusSnapshot: async options => { state.snapshot = options; },
    loginContexts: { identity: (owner, id) => ({ owner, id }) },
    gatewayRuntimeVersion: 'fixture',
  });
  return { state, response, session, route };
}

test('SSH catalog management checks current full access and same-origin authority before mutation', async () => {
  const { state, response, session, route } = fixture();
  state.servers.push({ id: 'peer' });
  assert.equal(await route({ method: 'GET' }, response, '/api/ssh-connections', session), true);
  assert.equal(response.status, 403);
  session.allowedServerIds.add('peer');
  state.sameOrigin = false;
  await route({ method: 'PUT' }, response, '/api/ssh-connections/remote', session);
  assert.equal(response.status, 403);
  assert.deepEqual(state.calls, []);
  state.sameOrigin = true;
  state.body = JSON.stringify({ id: 'other' });
  await route({ method: 'PUT' }, response, '/api/ssh-connections/remote', session);
  assert.equal(response.status, 400);
  assert.deepEqual(state.calls, []);
  state.body = JSON.stringify({ id: 'remote' });
  await route({ method: 'PUT' }, response, '/api/ssh-connections/remote', session);
  assert.equal(response.status, 200);
  assert.deepEqual(state.calls, [{ id: 'remote' }]);
});

test('public catalog retains request scope, no-store headers and unrelated-route fallthrough', async () => {
  const { state, response, session, route } = fixture();
  state.servers.push({ id: 'peer' });
  assert.equal(await route({ method: 'GET' }, response, '/api/servers', session), true);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body), { servers: [{ id: 'local' }], owner: 'owner' });
  assert.equal(await route({ method: 'POST' }, response, '/api/servers', session), false);
  assert.equal(await route({ method: 'GET' }, response, '/api/other', session), false);
});

test('status captures the authorized targets and scope before probing and retains live identity callbacks', async () => {
  const { state, response, session, route } = fixture();
  state.servers = [{ id: 'local', security: {} }, { id: 'peer' }];
  await route({ method: 'GET' }, response, '/api/servers/status', session);
  assert.deepEqual(state.calls, [{ targets: [state.servers[0]], owner: 'owner' }]);
  assert.equal(state.snapshot.statusScopes.get('local'), 'local:owner');
  assert.equal(state.snapshot.currentScopeFor(state.servers[0]), 'local:owner');
  assert.deepEqual(state.snapshot.accountIdentityFor('local'), { owner: 'owner', id: 'local' });
  assert.equal(state.snapshot.gatewayRuntimeVersion, 'fixture');
});
