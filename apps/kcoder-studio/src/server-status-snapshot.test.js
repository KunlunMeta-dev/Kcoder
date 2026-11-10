import assert from 'node:assert/strict';
import test from 'node:test';
import { respondWithServerStatusSnapshot } from './server-status-snapshot.js';

test('rechecks account generation after Gateway version lookup and before sending statuses', async () => {
  let resolveVersion;
  let versionReadStarted;
  const started = new Promise(resolve => { versionReadStarted = resolve; });
  const version = new Promise(resolve => { resolveVersion = resolve; });
  let generation = 'alice-generation';
  let identity = { principalId: 'alice-id', username: 'alice', role: 'user' };
  let sent;

  const responsePromise = respondWithServerStatusSnapshot({
    response: {},
    sendJson(_response, statusCode, body) {
      sent = { statusCode, body, generationAtSend: generation, identityAtSend: identity.username };
    },
    targets: [{ id: 'isolated', security: { identity: { mode: 'kcoder-account' } } }],
    statuses: [{ id: 'isolated', status: 'online', checkedAt: 123, appServerVersion: '1.2.3',
      protocolVersion: '2026-07-27', capabilities: { privateAccountFeature: true } }],
    statusScopes: new Map([['isolated', 'alice-generation-scope']]),
    currentScopeFor: () => `${generation}-scope`,
    accountIdentityFor: () => identity,
    gatewayRuntimeVersion: () => { versionReadStarted(); return version; },
  });

  await started;
  generation = 'bob-generation';
  identity = { principalId: 'bob-id', username: 'bob', role: 'user' };
  resolveVersion('0.4.0');
  await responsePromise;

  assert.equal(sent.statusCode, 200);
  assert.equal(sent.generationAtSend, 'bob-generation');
  assert.equal(sent.identityAtSend, 'bob');
  assert.equal(sent.body.gatewayRuntimeVersion, '0.4.0');
  assert.deepEqual(sent.body.statuses[0], {
    id: 'isolated', status: 'offline', latencyMs: 0,
    appServerVersion: null, protocolVersion: null,
    error: '账号状态在检查期间已变更，请重新检查',
    accountIdentity: identity,
  });
});
