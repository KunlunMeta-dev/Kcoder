import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerFixture, fakeClient } from './workspace-app-server-broker.test-support.js';
import { captureNativeRemoteSourceClient } from '../src/remotes/source-client-owner.mjs';
import { ROUTER_METHODS } from '../src/agent-message-router-private.js';

const address = { targetId: 'native-original', workspaceId: 'workspace-original', threadId: 'same-thread' };
const identity = { targetId: address.targetId, workspaceId: address.workspaceId,
  principal: { kind: 'localOs' }, publicKey: Array(32).fill(7), identityEpoch: 'epoch-original' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const f = brokerFixture();
  t.after(() => f.broker.fail(new Error('owned fixture complete')));
  const client = fakeClient();
  client.authorizationOwner = 'actual-test-login';
  f.broker.attach(client);
  client.initialized = true;
  f.broker.shareability = 'resident';
  f.broker.initializeResponse = { result: { capabilities: { experimental: { residentThreads: true } } } };
  const target = { id: 'local', runtime: 'kcoder', transport: 'local' };
  const targets = new Map([['local', target]]);
  let valid = true, generation = 1;
  client.nativeRemoteSourceOwner = captureNativeRemoteSourceClient({ client, broker: f.broker, sourceTarget: target,
    authorizationOwner: client.authorizationOwner, session: { allowedServerIds: new Set(['local']) },
    verifySession: () => valid, getTarget: id => targets.get(id), targetSignature: value => JSON.stringify(value),
    accountIdentity: () => null, accountGeneration: () => generation });
  const identityCalls = [];
  f.broker.sendAgentMessageRouterRequest = async (method, params) => {
    identityCalls.push({ method, params });
    return { result: identity };
  };
  const send = (id = 10, expected = address, method = 'thread/read') => f.broker.receive(client, JSON.stringify({
    jsonrpc: '2.0', id, method, params: { threadId: address.threadId, expectedSessionAddress: expected, limit: 1 },
  }));
  return { ...f, client, targets, identityCalls, send, revoke() { valid = false; }, changeAccount() { generation++; } };
}

test('a matching canonical selector is removed before the ordinary read reaches Native', async t => {
  const f = fixture(t); f.send(); await tick();
  assert.deepEqual(f.identityCalls, [{ method: ROUTER_METHODS.identity, params: {} }]);
  const read = f.upstream.find(row => row.method === 'thread/read');
  assert.deepEqual(read?.params, { threadId: address.threadId, limit: 1 });
});

test('reusing a catalog alias and thread ID for another Native target never reads it', async t => {
  const f = fixture(t);
  f.broker.sendAgentMessageRouterRequest = async () => ({ result: { ...identity, targetId: 'native-replacement' } });
  f.send(); await tick();
  assert.equal(f.upstream.some(row => row.method === 'thread/read'), false);
  assert.equal(f.client.messages.at(-1)?.error?.message, 'SESSION_ADDRESS_EXPECTATION_UNAVAILABLE');
});

test('workspace mismatch and malformed or mismatched thread selectors fail closed', async t => {
  for (const expected of [{ ...address, workspaceId: 'different' }, { ...address, threadId: 'other' },
    { ...address, authorization: true }, null]) {
    const f = fixture(t); f.send(11, expected); await tick();
    assert.equal(f.upstream.some(row => row.method === 'thread/read'), false);
    assert.ok(f.client.messages.at(-1)?.error);
  }
});

test('account, catalog, transport and authentication changes during the identity read block forwarding', async t => {
  for (const invalidate of [f => f.revoke(), f => f.changeAccount(),
    f => f.targets.set('local', { ...f.targets.get('local'), command: 'replacement' }),
    f => f.child.stdout.destroy()]) {
    const f = fixture(t);
    f.broker.sendAgentMessageRouterRequest = async () => { invalidate(f); return { result: identity }; };
    f.send(); await tick();
    assert.equal(f.upstream.some(row => row.method === 'thread/read'), false);
    assert.ok(f.client.messages.at(-1)?.error);
  }
});

test('a public JSON owner claim and an unsupported private lane cannot satisfy the comparison', async t => {
  for (const change of [f => { f.client.nativeRemoteSourceOwner = { verify() {}, checkCurrentAuthority() {} }; },
    f => { f.broker.sendAgentMessageRouterRequest = async () => ({ error: { code: -32601 } }); }]) {
    const f = fixture(t); change(f); f.send(); await tick();
    assert.equal(f.upstream.some(row => row.method === 'thread/read'), false);
    assert.ok(f.client.messages.at(-1)?.error);
  }
});

test('bounded pending comparison requests do not admit duplicate IDs or detached clients', async t => {
  const f = fixture(t);
  let finish;
  f.broker.sendAgentMessageRouterRequest = () => new Promise(resolve => { finish = resolve; });
  f.send(); await tick(); f.send();
  assert.equal(f.client.messages.at(-1)?.error?.message, 'SESSION_ADDRESS_EXPECTATION_INVALID');
  f.broker.clients.delete(f.client);
  finish({ result: identity }); await tick();
  assert.equal(f.upstream.some(row => row.method === 'thread/read'), false);
});

test('canonical async answers validate the original JSON before address lookup', async t => {
  const f = fixture(t);
  f.client.asyncUserQuestionsV1 = true;
  f.broker.initializeResponse.result.capabilities.experimental.asyncUserQuestionsV1 = true;
  f.broker.receive(f.client, JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'thread/resume', params: { threadId: address.threadId },
  }));
  f.respond({ id: f.upstream.at(-1).id, result: { thread: { id: address.threadId } } });
  const answer = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'asyncQuestion/answer',
    params: { threadId: address.threadId, expectedSessionAddress: address, questionId: 'question',
      expectedRevision: 1, submissionId: 'submission', answers: { item: { text: 'original' } } } });
  for (const [raw, id, field] of [
    [answer.replace('"id":2', '"id":99,"id":2'), null, 'request ID'],
    [answer.replace('"expectedRevision":1', '"expectedRevision":1.0'), 2, 'expectedRevision'],
    [answer.replace('"text":"original"', '"text":"other","text":"original"'), 2, 'answers'],
  ]) {
    const before = f.client.messages.length;
    f.broker.receive(f.client, raw);
    await tick();
    assert.deepEqual(f.upstream.map(row => row.method), ['thread/resume']);
    assert.deepEqual(f.identityCalls, []);
    assert.deepEqual(f.client.messages.slice(before), [{
      jsonrpc: '2.0', id, error: { code: -32602, message: `Invalid async question ${field}` },
    }]);
  }

  f.broker.receive(f.client, answer);
  await tick();
  assert.equal(f.identityCalls.length, 1);
  const forwarded = f.upstream.filter(row => row.method === 'asyncQuestion/answer');
  assert.equal(forwarded.length, 1);
  const { expectedSessionAddress: _selector, ...params } = JSON.parse(answer).params;
  assert.deepEqual(forwarded[0].params, { ...params, asyncUserQuestions: true });
});
