import test from 'node:test';
import assert from 'node:assert/strict';
import { endpointFeatureCapabilities } from './agent-message-router-capabilities.js';
import { AGENT_MESSAGE_RECEIPTS_CAPABILITY, AGENT_MESSAGE_REPLIES_CAPABILITY } from '../shared/agentMessageMethods.mjs';
import { privateRouterFrame, ROUTER_METHODS, AgentMessageRouterError } from './agent-message-router-private.js';
const both = [AGENT_MESSAGE_RECEIPTS_CAPABILITY, AGENT_MESSAGE_REPLIES_CAPABILITY];
function endpoint(paired = true) {
  let allowed = true;
  return { broker: { initializeResponse: { result: { capabilities: { experimental: Object.fromEntries(both.map(value => [value, true])) } } } },
    ...(paired ? { requestPrivate() {} } : {}), verify() { if (!allowed) throw Error('OWNED_SCOPE_REVOKED'); }, revoke() { allowed = false; } };
}
test('paired feature discovery uses the actual private TUI with no route proof, never catalog capabilities', async () => {
  const e = endpoint(); let calls = 0;
  const result = await endpointFeatureCapabilities(e, async (actual, method, params, proof) => {
    calls++; assert.equal(actual, e); assert.equal(method, ROUTER_METHODS.capabilities); assert.deepEqual(params, {}); assert.equal(proof, undefined);
    return { capabilities: [AGENT_MESSAGE_RECEIPTS_CAPABILITY] };
  });
  assert.equal(calls, 1); assert.equal(result.has(AGENT_MESSAGE_RECEIPTS_CAPABILITY), true); assert.equal(result.has(AGENT_MESSAGE_REPLIES_CAPABILITY), false);
  assert.deepEqual(privateRouterFrame({ method: ROUTER_METHODS.capabilities, params: {} }), { method: ROUTER_METHODS.capabilities, params: {} });
  assert.throws(() => privateRouterFrame({ method: ROUTER_METHODS.capabilities, params: {} }, {}), /UNEXPECTED_PRIVATE_PROOF/);
});
test('an old paired Native is explicitly unsupported and current revocation cannot become a capability result', async () => {
  const old = endpoint();
  assert.equal((await endpointFeatureCapabilities(old, async () => { throw new AgentMessageRouterError('AGENT_MESSAGES_ROUTER_UNSUPPORTED', -32601); })).size, 0);
  const revoked = endpoint();
  await assert.rejects(endpointFeatureCapabilities(revoked, async () => { revoked.revoke(); return { capabilities: both }; }), /SCOPE_REVOKED/);
});
test('ordinary Native uses its own negotiated facts and malformed peer capability payloads fail closed', async () => {
  const direct = endpoint(false);
  assert.deepEqual([...await endpointFeatureCapabilities(direct, () => assert.fail('ordinary broker must not probe a different peer'))], both);
  for (const capabilities of [{ capabilities: both, authorization: true }, { capabilities: [both[0], both[0]] }, { capabilities: [42] }])
    await assert.rejects(endpointFeatureCapabilities(endpoint(), async () => capabilities));
});
