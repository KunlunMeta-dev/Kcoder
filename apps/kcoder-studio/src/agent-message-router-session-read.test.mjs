import test from 'node:test';
import assert from 'node:assert/strict';
import { endpointFeatureCapabilities } from './agent-message-router-capabilities.js';
import { ROUTER_METHODS, requireRouter } from './agent-message-router-private.js';
import { SESSION_READ_CAPABILITY, routeSessionRead, sessionReadUnsupported, validSessionReadRequest } from './agent-message-router-session-read.js';

const targetAddress = { targetId: 'host-b', workspaceId: 'space-b', threadId: 'peer-thread' };
const read = { threadId: 'peer-thread', targetAddress, turns: 2 };
function harness({ features = [SESSION_READ_CAPABILITY], reply }) {
  const calls = [];
  let released = 0;
  const destination = {
    verify() { assert.equal(released, 0, 'a released route lease cannot be verified'); },
    acquire: () => () => { released++; },
    request: async (method, params) => { calls.push({ method, params }); return reply; },
  };
  const deps = {
    source: { sourceThreadId: 'source-thread', address: { targetId: 'host-a', workspaceId: 'space-a', threadId: 'source-thread' },
      endpoint: {}, verify() {}, async checkCurrentAuthority() {} },
    read, refreshEndpoint: async () => {}, destinationFor: async () => destination,
    requireEndpointFeature: async (_endpoint, capability) => { if (!features.includes(capability)) throw sessionReadUnsupported(); },
  };
  return { deps, calls, released: () => released };
}

test('a routed read reaches only a target that advertises sessionReadV1 and returns its owner decision', async () => {
  const window = { result: { threadId: 'peer-thread', address: targetAddress, archived: false, resident: false, otherWorkspace: false,
    turns: [{ turnId: 'turn-1', status: 'completed', items: [{ kind: 'user_message', text: '进度？' }], omittedItems: 0 }], hasEarlierTurns: false } };
  const allowed = harness({ reply: window });
  assert.deepEqual(await routeSessionRead(allowed.deps), window);
  assert.deepEqual(allowed.calls, [{ method: ROUTER_METHODS.read, params: { sourceThreadId: 'source-thread', read } }]);
  assert.equal(allowed.released(), 1);

  const denied = harness({ reply: { refused: 'session_read_not_permitted' } });
  assert.deepEqual(await routeSessionRead(denied.deps), { refused: 'session_read_not_permitted' });

  // An older Native target lacks the feature: unsupported, and nothing is sent.
  const old = harness({ features: [], reply: window });
  await assert.rejects(routeSessionRead(old.deps), error => error.message === 'AGENT_MESSAGES_SESSION_READ_UNSUPPORTED' && error.code === -32601);
  assert.equal(old.calls.length, 0);

  for (const reply of [{ refused: 'session_read_maybe' }, { result: { ...window.result, threadId: 'other' } },
    { result: { ...window.result, turns: [...window.result.turns, ...window.result.turns, ...window.result.turns] } }]) {
    const invalid = harness({ reply });
    await assert.rejects(routeSessionRead(invalid.deps), /AGENT_MESSAGES_INVALID_READ_RESPONSE/);
    assert.equal(invalid.released(), 1);
  }
});

test('read requests need a matching target address and ordinary Native echoes the feature in initialize', async () => {
  assert.equal(validSessionReadRequest('source-thread', read), true);
  assert.equal(validSessionReadRequest('source-thread', { threadId: 'peer-thread' }), false);
  assert.equal(validSessionReadRequest('source-thread', { ...read, targetAddress: { ...targetAddress, threadId: 'x' } }), false);
  assert.equal(validSessionReadRequest('source-thread', { ...read, accountId: 'forged' }), false);
  const direct = experimental => ({ broker: { initializeResponse: { result: { capabilities: { experimental } } } }, verify() {} });
  const fail = () => requireRouter(false);
  assert.equal((await endpointFeatureCapabilities(direct({ [SESSION_READ_CAPABILITY]: true }), fail)).has(SESSION_READ_CAPABILITY), true);
  assert.equal((await endpointFeatureCapabilities(direct({}), fail)).has(SESSION_READ_CAPABILITY), false);
});
