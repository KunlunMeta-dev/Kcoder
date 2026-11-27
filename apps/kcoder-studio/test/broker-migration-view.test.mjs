import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture() {
  const child = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true, adapter: { rawPassthrough: true }, serverId: 'owned', maxMessageBytes: 1024 * 1024 });
  const upstream = [];
  child.stdin.on('data', data => { for (const line of String(data).trim().split('\n')) upstream.push(JSON.parse(line)); });
  const client = () => { const value = { channel: 'runtime', messages: [], send(message) { this.messages.push(message); }, pause() {}, resume() {}, close() {} }; broker.attach(value); value.initialized = true; return value; };
  const a = client(), b = client();
  let sequence = 1;
  const request = (owner, method, params) => { broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id: sequence++, method: `migration/history/view/${method}`, params })); return upstream.at(-1); };
  const respond = (request, result) => broker.routeServerMessage({ jsonrpc: '2.0', id: request.id, result });
  const params = { requestId: randomUUID(), jobId: randomUUID(), expectedArchiveId: `archive-${'a'.repeat(64)}`, viewId: null };
  const lease = { requestId: params.requestId, leaseId: randomUUID(), jobId: params.jobId, archiveId: params.expectedArchiveId, viewId: null, state: 'active' };
  return { broker, child, upstream, a, b, request, respond, params, lease };
}

test('actual shared broker refuses peer lease operations before forwarding any bytes', () => {
  const f = fixture();
  const opened = f.request(f.a, 'open', f.params);
  f.respond(opened, { lease: f.lease });
  for (const method of ['read', 'renew', 'release']) {
    const before = f.upstream.length;
    f.request(f.b, method, { requestId: f.params.requestId, leaseId: f.lease.leaseId, expectedSequence: 1 });
    assert.equal(f.upstream.length, before);
    assert.equal(f.b.messages.at(-1).error.code, -32020);
  }
  f.child.emit('close', 0, null);
});

test('detached pending open retains cleanup authority on the original broker after param compaction', async () => {
  const f = fixture();
  const opened = f.request(f.a, 'open', f.params);
  f.broker.detach(f.a);
  assert.ok(f.broker.pending.has(opened.id));
  assert.deepEqual(f.broker.pending.get(opened.id).params, {});
  const before = f.upstream.length;
  await Promise.resolve();
  f.respond(opened, { lease: f.lease });
  assert.equal(f.upstream.length, before + 1);
  const cleanup = f.upstream.at(-1);
  assert.equal(cleanup.method, 'migration/history/view/release');
  assert.deepEqual(cleanup.params, { requestId: f.params.requestId, leaseId: f.lease.leaseId });
  assert.equal(f.b.messages.length, 0);
  f.respond(cleanup, { lease: { ...f.lease, state: 'released' } });
  f.child.emit('close', 0, null);
});

test('expiring a pending renewal cleans only its original lease and does not close a peer', () => {
  const f = fixture();
  const opened = f.request(f.a, 'open', f.params);
  f.respond(opened, { lease: f.lease });
  const renewal = f.request(f.a, 'renew', { requestId: f.params.requestId, leaseId: f.lease.leaseId, expectedSequence: 1 });
  f.broker.expireRequest(renewal.id);
  f.respond(renewal, { lease: { ...f.lease, sequence: 2 } });
  const cleanup = f.upstream.at(-1);
  assert.equal(cleanup.method, 'migration/history/view/release');
  assert.deepEqual(cleanup.params, { requestId: f.params.requestId, leaseId: f.lease.leaseId });
  assert.ok(f.broker.clients.has(f.b));
  f.respond(cleanup, { lease: { ...f.lease, state: 'released' } });
  f.child.emit('close', 0, null);
});

test('a read racing a timed-out open never advertises an active hold already scheduled for cleanup', () => {
  const f = fixture();
  const opened = f.request(f.a, 'open', f.params);
  f.broker.expireRequest(opened.id);
  const read = f.request(f.a, 'read', { requestId: f.params.requestId });
  f.respond(read, { lease: f.lease });
  assert.equal(f.a.messages.at(-1).error.code, -32020);
  const cleanup = f.upstream.at(-1);
  assert.equal(cleanup.method, 'migration/history/view/release');
  f.respond(opened, { lease: f.lease });
  assert.equal(f.upstream.filter(frame => frame.method === 'migration/history/view/release').length, 1);
  f.respond(cleanup, { lease: { ...f.lease, state: 'released' } });
  f.child.emit('close', 0, null);
});
