import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RequestLoadTracker } from '../src/request-load.js';

function fixture(budget = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const written = [];
  child.stdin.on('data', chunk => written.push(JSON.parse(chunk.toString())));
  const broker = new WorkspaceAppServerBroker({ child, adapter: { rawPassthrough: true, fromUpstream: m => ({ upstream: [], client: [m] }) }, maxMessageBytes: 1024 * 1024,
    serverId: 'owned-fixture', residentThreads: true, pendingBudget: { total: 4, perOwner: 2, bytes: 8192, ownerBytes: 4096, ttlMs: 20, ...budget } });
  const owner = () => { const c = { channel: 'runtime', messages: [], send(m) { this.messages.push(m); return true; }, pause() {}, resume() {}, close() {} }; broker.attach(c); return c; };
  return { broker, child, written, owner, request(c, id, method = 'server/info', params = {}) { broker.receive(c, JSON.stringify({ jsonrpc: '2.0', id, method, params })); },
    reply(id, result = {}) { child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); } };
}

test('unanswered work accounting never drops the oldest request', () => {
  const tracker = new RequestLoadTracker({ capacityPerChannel: 8 });
  for (let id = 0; id < 40; id++) tracker.begin('runtime', id);
  assert.equal(tracker.snapshot().total.inFlight, 40);
  tracker.settle('runtime', 0);
  assert.equal(tracker.snapshot().total.inFlight, 39);
});

test('count and byte admission occurs before forwarding and isolates owners', t => {
  const f = fixture(); t.after(() => f.child.emit('close', 0)); const a = f.owner(), b = f.owner();
  f.request(a, 1); f.request(a, 2); f.request(a, 3);
  assert.equal(f.written.length, 2);
  assert.match(a.messages.at(-1).error.message, /capacity/);
  f.request(b, 4); f.request(b, 5); f.request(b, 6);
  assert.equal(f.written.length, 4);
  assert.equal(f.broker.requestLoad.total.inFlight, 4);
  f.reply(f.written[0].id);
  f.request(a, 7, 'server/info', { value: 'x'.repeat(5000) });
  assert.equal(f.written.length, 4, 'owner byte budget precedes stdin');
  assert.equal(f.broker.requestLoad.total.inFlight, 3);
});

test('expiration drops full params but retains bounded unknown work and late resources', async t => {
  const f = fixture(); t.after(() => f.child.emit('close', 0)); const a = f.owner(), b = f.owner();
  f.request(a, 1, 'attachment/save', { filename: 'owned.txt', bytes: 'x'.repeat(2000) });
  const id = f.written[0].id;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(a.messages.at(-1).error.message, /unknown/);
  assert.ok(!JSON.stringify([...f.broker.pending.values()]).includes('xxx'));
  assert.equal(f.broker.requestLoad.total.inFlight, 1);
  assert.equal(f.broker.hasPendingWork, true);
  f.request(a, 2); f.request(a, 3);
  assert.equal(f.written.length, 2, 'expired unknown work still reserves the owner slot');
  f.request(b, 4);
  f.broker.detach(a);
  assert.equal(f.broker.requestLoad.total.inFlight, 3, 'disconnect cannot conceal unanswered work');
  f.reply(id, { path: '/owned/late.txt' });
  const cleanup = f.written.at(-1);
  assert.ok(Number.isInteger(cleanup.id), 'stateful cleanup must have a real request ID');
  assert.notEqual(cleanup.id, id, 'cleanup cannot reuse the expired operation ID');
  assert.deepEqual(cleanup, { jsonrpc: '2.0', id: cleanup.id, method: 'attachment/delete', params: { path: '/owned/late.txt' } });
  assert.equal(f.broker.resourceOwners.size, 0);
  assert.equal(f.broker.requestLoad.total.inFlight, 3, 'cleanup remains pending until acknowledgement');
  f.reply(cleanup.id);
  assert.equal(f.broker.requestLoad.total.inFlight, 2);
});

test('stdin failure rolls back admission and claims', t => {
  const f = fixture(); t.after(() => f.child.emit('close', 0)); const a = f.owner();
  f.child.stdin.destroy();
  assert.throws(() => f.request(a, 1, 'thread/resume', { threadId: 'owned' }), /closed/);
  assert.equal(f.broker.pending.size, 0);
  assert.equal(f.broker.threadClaims.size, 0);
  assert.equal(f.broker.requestLoad.total.inFlight, 0);
});

test('unwritten initialize does not leave an orphan handshake gate', t => {
  const f = fixture(); t.after(() => f.child.emit('close', 0)); const client = f.owner();
  f.child.stdin.cork(); f.child.stdin.write(Buffer.alloc(2 * 1024 * 1024));
  assert.throws(() => f.request(client, 1, 'initialize', {}), /queue is full/);
  assert.equal(f.broker.initializePending, null);
  assert.equal(f.broker.pending.size, 0);
  assert.equal(f.broker.requestLoad.total.inFlight, 0);
});

test('expiry of an attached owner does not interrupt an accepted late turn', async t => {
  const f = fixture(); t.after(() => f.child.emit('close', 0)); const owner = f.owner();
  f.broker.threadOwners.set('owned-thread', owner);
  f.request(owner, 1, 'turn/start', { threadId: 'owned-thread', prompt: 'x'.repeat(1024), clientMessageId: 'once' });
  const id = f.written[0].id;
  await new Promise(resolve => setTimeout(resolve, 40));
  f.reply(id, { threadId: 'owned-thread', turn: { id: 'accepted-once' } });
  assert.equal(f.written.filter(m => m.method === 'turn/interrupt').length, 0);
  assert.equal(f.broker.activeTurns.get('owned-thread')?.owner, owner);
  assert.equal(owner.messages.filter(m => m.id === 1).length, 1, 'the unknown outcome is reported exactly once');
});

test('internal cleanup RPCs remain counted until their actual reply', t => {
  const f = fixture(); t.after(() => f.child.emit('close', 0));
  f.broker.cancelArchiveTransfer('owned-transfer');
  assert.equal(f.broker.pending.size, 1);
  assert.equal(f.broker.requestLoad.total.inFlight, 1);
  f.reply(f.written[0].id, { cancelled: true });
  assert.equal(f.broker.requestLoad.total.inFlight, 0);
});

test('late archive cleanup uses bounded shared admission without evicting healthy owners', async t => {
  const f = fixture({ total: 256, perOwner: 128, ownerBytes: 1024 * 1024, bytes: 2 * 1024 * 1024 });
  t.after(() => f.child.emit('close', 0)); const a = f.owner(), b = f.owner();
  for (let id = 1; id <= 128; id++) f.request(a, id, 'knowledge/archiveTransfer/exportStart', {});
  const ids = f.written.map(m => m.id);
  await new Promise(resolve => setTimeout(resolve, 40));
  for (const id of ids) f.reply(id, { transferId: `owned-${id}` });
  assert.equal(f.broker.closed, false, 'cleanup of an admitted owner cannot evict another owner');
  assert.equal(f.broker.requestLoad.total.inFlight, 128);
  assert.equal(f.broker.pending.size, 128);
  f.request(b, 500, 'server/info', {});
  assert.equal(f.written.at(-1).method, 'server/info');
});

test('cleanup after transport close cannot reserve an unwritten request', () => {
  const f = fixture(); f.child.emit('close', 0);
  f.broker.cancelArchiveTransfer('owned-transfer');
  assert.equal(f.broker.pending.size, 0);
  assert.equal(f.broker.pendingLoad.admitted, 0);
  assert.equal(f.broker.requestLoad.total.inFlight, 0);
});
