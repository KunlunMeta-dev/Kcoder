import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { gatewayRequestOutcome } from '../shared/gatewayRequestDeadline.js';
import {
  SELF_EVOLUTION_CAPABILITY, SELF_EVOLUTION_METHODS, allowsSelfEvolutionNotification, selfEvolutionAdmissionError,
} from '../src/broker-self-evolution.js';

function fixture(t, advertised = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { [SELF_EVOLUTION_CAPABILITY]: advertised } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    client.initialized = true;
    return client;
  };
  return { broker, upstream, emit, join };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('target-scoped evolution requests are forwarded only after the backend advertised the capability', async t => {
  const f = fixture(t);
  const client = f.join();
  f.broker.receive(client, JSON.stringify({ id: 3, method: 'evolution/status', params: {} }));
  f.broker.receive(client, JSON.stringify({ id: 4, method: 'settings/evolution/read', params: {} }));
  assert.deepEqual(f.upstream.map(request => request.method), ['evolution/status', 'settings/evolution/read']);
  assert.equal(client.messages.length, 0);

  const old = fixture(t, false);
  const legacy = old.join();
  old.broker.receive(legacy, JSON.stringify({ id: 5, method: 'evolution/data/clear', params: { scope: 'all', confirm: true } }));
  assert.equal(old.upstream.length, 0, 'an older target never receives the request');
  assert.equal(legacy.messages[0].error.code, -32601);
  assert.equal(legacy.messages[0].error.data.kind, 'evolution_unsupported');
});

test('ratings require a thread owned by the requesting client', async t => {
  const f = fixture(t);
  const owner = f.join();
  const other = f.join();
  f.broker.receive(owner, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
  const resume = f.upstream.at(-1);
  f.emit({ id: resume.id, result: { thread: { id: 'thread' } } });
  await settle();
  const rate = { method: 'evolution/rate', params: { threadId: 'thread', turnId: 'turn', rating: 'up' } };
  f.broker.receive(other, JSON.stringify({ id: 9, ...rate }));
  assert.equal(other.messages.at(-1).error.code, -32023);
  assert.equal(other.messages.at(-1).error.data.kind, 'evolution_target_not_found');
  assert.equal(f.upstream.filter(request => request.method === 'evolution/rate').length, 0);
  f.broker.receive(owner, JSON.stringify({ id: 10, ...rate }));
  assert.equal(f.upstream.filter(request => request.method === 'evolution/rate').length, 1);
  f.broker.receive(owner, JSON.stringify({ id: 11, method: 'evolution/rate', params: { turnId: 'turn', rating: 'up' } }));
  assert.equal(owner.messages.at(-1).error.data.kind, 'evolution_invalid_params');

  // The ratable-turn projection is thread-scoped the same way.
  const list = { method: 'evolution/ratings/list', params: { threadId: 'thread', subagentId: 'agent-1' } };
  f.broker.receive(other, JSON.stringify({ id: 12, ...list }));
  assert.equal(other.messages.at(-1).error.data.kind, 'evolution_target_not_found');
  assert.equal(f.upstream.filter(request => request.method === 'evolution/ratings/list').length, 0);
  f.broker.receive(owner, JSON.stringify({ id: 13, ...list }));
  assert.equal(f.upstream.filter(request => request.method === 'evolution/ratings/list').length, 1);
  f.broker.receive(owner, JSON.stringify({ id: 14, method: 'evolution/ratings/list', params: {} }));
  assert.equal(owner.messages.at(-1).error.data.kind, 'evolution_invalid_params');
});

test('evolution/changed reaches initialized clients of a supporting backend only', async t => {
  const f = fixture(t);
  const ready = f.join();
  const pending = f.join();
  pending.initialized = false;
  f.emit({ jsonrpc: '2.0', method: 'evolution/changed', params: { reason: 'settings' } });
  await settle();
  assert.deepEqual(ready.messages.map(message => message.method), ['evolution/changed']);
  assert.equal(pending.messages.length, 0);
  assert.equal(allowsSelfEvolutionNotification({ method: 'evolution/changed' }, ready, {}), false);
  assert.equal(allowsSelfEvolutionNotification({ method: 'item/delta' }, pending, {}), true);
});

test('admission covers every evolution method and rejects uninitialized or management clients', () => {
  assert.equal(SELF_EVOLUTION_METHODS.size, 13);
  const experimental = { [SELF_EVOLUTION_CAPABILITY]: true };
  for (const method of SELF_EVOLUTION_METHODS) {
    assert.equal(selfEvolutionAdmissionError({ method, params: {} }, { initialized: false }, experimental, () => true).code, -32600);
    assert.equal(selfEvolutionAdmissionError({ method, params: {} }, { initialized: true, nativeManagementOnly: true }, experimental, () => true).code, -32600);
  }
  assert.equal(selfEvolutionAdmissionError({ method: 'thread/read' }, {}, {}, () => false), null);
  assert.equal(selfEvolutionAdmissionError({ method: 'evolution/status', params: [] }, { initialized: true }, experimental, () => true).code, -32602);
});

test('only evolution reads are classified read-only for retry decisions', () => {
  for (const method of ['evolution/status', 'evolution/targets/list', 'evolution/target/read', 'evolution/preference/list', 'evolution/ratings/list', 'settings/evolution/read'])
    assert.equal(gatewayRequestOutcome(method), 'readOnly', method);
  for (const method of ['evolution/proposal/decide', 'evolution/overlay/update', 'evolution/preference/update', 'evolution/rate', 'evolution/data/clear', 'evolution/target/distill', 'settings/evolution/save'])
    assert.equal(gatewayRequestOutcome(method), 'unknown', method);
});
