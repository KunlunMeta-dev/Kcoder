import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const thread = 'original-thread';
const policy = Object.freeze({ enabled: true, wakeIdle: false, revision: 'original-policy-revision' });
const policyRead = 'thread/agentMessage/policy/read';
const policySave = 'thread/agentMessage/policy/save';

// Drive the actual broker wire/ownership transitions. Native replies are a
// protocol fixture; no test directly inserts a thread owner or shared member.
function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned-policy-target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = []; let nextId = 0;
  child.stdin.on('data', bytes => upstream.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }));
    return upstream.length > before ? upstream.at(-1) : null;
  };
  const reply = (request, result, error) => broker.routeServerMessage({ jsonrpc: '2.0', id: request.id,
    ...(error ? { error } : { result }) });
  const client = () => {
    const value = { channel: 'runtime', messages: [], send(message) { this.messages.push(message); return true; },
      pause() {}, resume() {}, close() {} };
    broker.attach(value);
    const experimental = { gatewaySharedThreadsV1: true, crossSessionDiscoveryV1: true,
      crossSessionMessagesV1: true, peerAgentMessagesV1: true };
    const request = send(value, 'initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'owned-shared-policy-test', version: '1' },
      capabilities: { experimental } });
    if (request) reply(request, { serverInfo: { name: 'owned-native-protocol-fixture', version: '1' },
      capabilities: { experimental: { ...experimental, residentThreads: true } } });
    assert.equal(value.initialized, true);
    return value;
  };
  const resume = (client, id = thread, error) => {
    const request = send(client, 'thread/resume', { threadId: id }); assert.ok(request);
    reply(request, { thread: { id } }, error);
  };
  const denied = (client, method, params, code = -32023) => {
    const before = upstream.length;
    assert.equal(send(client, method, params), null, 'Rejected requests never reach Native');
    assert.equal(upstream.length, before);
    assert.equal(client.messages.at(-1).error.code, code);
  };
  return { broker, upstream, send, reply, client, resume, denied };
}

test('shared policy read: joined client reads while original controller remains active', t => {
  const f = fixture(t), owner = f.client(), shared = f.client();
  f.resume(owner); f.resume(shared);
  assert.equal(f.broker.threadOwners.get(thread), owner);
  const turn = f.send(owner, 'turn/start', { threadId: thread, clientMessageId: 'original-owner-turn',
    input: [{ type: 'text', text: 'Original owner still responding' }] }); assert.ok(turn);
  f.reply(turn, { turn: { id: 'original-active-turn' } });
  const request = f.send(shared, policyRead, { sourceThreadId: thread });
  assert.ok(request, `Actual shared policy/read was rejected: ${JSON.stringify(shared.messages.at(-1)?.error)}`);
  f.reply(request, policy);
  assert.deepEqual(shared.messages.at(-1).result, policy);
  assert.equal(f.broker.threadOwners.get(thread), owner, 'A policy read cannot take control');
  assert.equal(f.broker.activeTurns.get(thread).owner, owner);
});

test('shared policy read: nonmembers, pending joins and other threads remain denied', t => {
  const f = fixture(t), owner = f.client(), shared = f.client(), stranger = f.client();
  f.resume(owner); f.resume(owner, 'other-original-thread');
  f.denied(stranger, policyRead, { sourceThreadId: thread });
  const pending = f.send(shared, 'thread/resume', { threadId: thread }); assert.ok(pending);
  f.denied(shared, policyRead, { sourceThreadId: thread });
  f.reply(pending, { thread: { id: thread } });
  f.denied(shared, policyRead, { sourceThreadId: 'other-original-thread' });
  assert.equal(f.broker.threadOwners.get(thread), owner);
});

test('shared policy read: policy save and unrelated mutations stay controller-only', t => {
  const f = fixture(t), owner = f.client(), shared = f.client(); f.resume(owner); f.resume(shared);
  f.denied(shared, policySave, { sourceThreadId: thread, expectedRevision: policy.revision, enabled: false, wakeIdle: false });
  f.denied(shared, 'thread/name/set', { threadId: thread, name: 'Must not be written' });
  const request = f.send(owner, policySave, { sourceThreadId: thread, expectedRevision: policy.revision, enabled: true, wakeIdle: false });
  assert.ok(request); f.reply(request, policy);
  assert.deepEqual(owner.messages.at(-1).result, policy);
});

test('shared policy read: failed join does not create membership', t => {
  const f = fixture(t), owner = f.client(), rejected = f.client(); f.resume(owner);
  f.resume(rejected, thread, { code: -32022, message: 'owned fixture join refused' });
  f.denied(rejected, policyRead, { sourceThreadId: thread });
});

test('shared policy read: disconnect revokes pending read and fresh connection cannot reuse membership', t => {
  const f = fixture(t), owner = f.client(), shared = f.client(); f.resume(owner); f.resume(shared);
  const request = f.send(shared, policyRead, { sourceThreadId: thread }); assert.ok(request);
  const before = shared.messages.length; f.broker.detach(shared); f.reply(request, policy);
  assert.equal(shared.messages.slice(before).some(message => message.result?.revision === policy.revision), false);
  const fresh = f.client(); f.denied(fresh, policyRead, { sourceThreadId: thread });
  f.resume(fresh);
  const current = f.send(fresh, policyRead, { sourceThreadId: thread }); assert.ok(current); f.reply(current, policy);
  assert.deepEqual(fresh.messages.at(-1).result, policy);
  assert.equal(f.broker.threadOwners.get(thread), owner);
});
