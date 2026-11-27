import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerFixture, fakeClient } from './workspace-app-server-broker.test-support.js';

function fixture(t) {
  const observed = [];
  const value = brokerFixture({ residentThreads: true, onThreadActivity: () => observed.push(true) });
  t.after(() => value.broker.clearTransientState());
  const client = fakeClient(); value.broker.attach(client); client.initialized = true;
  let id = 0;
  const request = (method, params) => {
    value.broker.receive(client, JSON.stringify({ id: ++id, method, params }));
    return value.upstream.at(-1);
  };
  return { ...value, client, observed, request };
}

test('ordinary, channel and internal turn lifecycles invalidate other pages without broadcasting body deltas', t => {
  const { broker, observed } = fixture(t);
  for (const internal of [undefined, false, true]) {
    for (const [method, status] of [['turn/started', 'running'], ['turn/completed', 'completed'],
      ['turn/failed', 'failed'], ['turn/interrupted', 'interrupted']]) {
      const count = observed.length;
      broker.routeServerMessage({ jsonrpc: '2.0', method, params: {
        threadId: 'unopened', turnId: `${method}-${internal}`, turn: { id: `${method}-${internal}`, status, internal },
      } });
      assert.equal(observed.length, count + 1, `${method}, internal=${internal}`);
    }
  }
  const count = observed.length;
  for (let i = 0; i < 100; i++) broker.routeServerMessage({ method: 'item/delta', params: {
    threadId: 'unopened', turnId: 'turn', delta: { text: 'private output' },
  } });
  assert.equal(observed.length, count);
});

for (const ending of ['disconnect', 'expire']) {
  test(`late archive result still invalidates other pages after ${ending}`, t => {
    const { broker, client, observed, request } = fixture(t);
    const created = request('thread/start', {});
    broker.routeServerMessage({ id: created.id, result: { thread: { id: 'thread' } } });
    const archive = request('thread/metadata/update', { threadId: 'thread', archivedAt: '2026-11-19T00:00:00Z' });
    if (ending === 'disconnect') broker.detach(client);
    else broker.expireRequest(archive.id);
    assert.equal(broker.pending.has(archive.id), true);
    assert.equal(broker.pending.get(archive.id).client, null);
    const before = observed.length;
    broker.routeServerMessage({ id: archive.id, result: { thread: { id: 'thread', archivedAt: '2026-11-19T00:00:00Z' } } });
    assert.equal(observed.length, before + 1);
    assert.equal(broker.pending.has(archive.id), false);
  });
}

test('invalid lifecycle envelopes and stale producer identities cannot invalidate lists', t => {
  const { broker, observed } = fixture(t);
  broker.initializeResponse = { result: { sessionId: 'current' } };
  const event = { jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread', turnId: 'turn' } };
  for (const frame of [
    { ...event, id: 41 }, { ...event, jsonrpc: '1.0' },
    { ...event, params: { ...event.params, sequence: -1 } },
    { ...event, params: { ...event.params, serverId: 'server-old' } },
    { ...event, params: { ...event.params, turn: { status: 'completed' } } },
  ]) broker.routeServerMessage(frame);
  assert.equal(observed.length, 0);
  broker.routeServerMessage(event);
  assert.equal(observed.length, 1);
});

test('confirmed creation and metadata changes invalidate lists, while reads and rejected mutations do not', t => {
  const { broker, observed, request } = fixture(t);
  const respond = (command, result, error) => broker.routeServerMessage({ id: command.id,
    ...(error ? { error } : { result }) });
  respond(request('thread/start', {}), { thread: { id: 'thread' } });
  assert.equal(observed.length, 1);
  respond(request('thread/metadata/update', { threadId: 'thread', title: 'Renamed' }), { thread: { id: 'thread', title: 'Renamed' } });
  assert.equal(observed.length, 2);
  respond(request('thread/list', {}), { threads: [] });
  respond(request('thread/read', { threadId: 'thread' }), { thread: { id: 'thread' } });
  respond(request('thread/metadata/update', { threadId: 'thread', title: 'Rejected' }), null,
    { code: -1, message: 'rejected' });
  assert.equal(observed.length, 2);
  respond(request('thread/delete', { threadId: 'thread' }), { threadId: 'thread', deleted: true });
  assert.equal(observed.length, 3);
});
