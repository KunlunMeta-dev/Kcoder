import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, adapter: {
    rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }),
    fromUpstream: message => ({ upstream: [], client: [message] }),
  }, maxMessageBytes: 1024 * 1024, serverId: 'synthetic' });
  const frames = []; child.stdin.on('data', data => frames.push(JSON.parse(data.toString())));
  const client = owner => { const value = { channel: 'runtime', authorizationOwner: owner, messages: [], send(m) { this.messages.push(m); }, pause() {}, resume() {}, close() {} }; broker.attach(value); value.initialized = true; return value; };
  const respond = (request, value) => broker.routeServerMessage({ jsonrpc: '2.0', id: request.id, ...value });
  const absent = request => respond(request, { error: { code: -32021, message: 'persisted thread not found: deleted' } });
  const retain = (owner, path, threadId = 'deleted') => {
    broker.resourceOwners.set(`attachment\0${path}`, owner);
    broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gateway/attachments/retain', params: { paths: [path], threadId } }));
  };
  return { broker, child, frames, client, respond, absent, retain };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('scoped retention rejects rebinding and active foreign owners, then releases unowned paths via original stdio', async () => {
  const f = fixture(); const owner = f.client('family'); const other = f.client('family'); const foreign = f.client('other-family');
  f.retain(owner, '/staged/a');
  f.retain(owner, '/staged/a', 'other-thread'); assert.equal(owner.messages.at(-1).error.code, -32048);
  assert.deepEqual(await f.broker.discardRetainedAttachments(other, 'deleted', ['/staged/a']), { cleared: [], pending: ['/staged/a'] });
  f.broker.detach(owner);
  const beforeDirect = f.frames.length;
  f.broker.receive(foreign, JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'attachment/delete', params: { path: '/staged/a' } }));
  assert.equal(foreign.messages.at(-1).error.code, -32048); assert.equal(f.frames.length, beforeDirect);
  f.broker.receive(other, JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'attachment/delete', params: { path: '/staged/a' } }));
  assert.equal(other.messages.at(-1).error.code, -32048); assert.equal(f.frames.length, beforeDirect);
  assert.deepEqual(await f.broker.discardRetainedAttachments(foreign, 'deleted', ['/staged/a']), { cleared: [], pending: ['/staged/a'] });
  const pending = f.broker.discardRetainedAttachments(other, 'deleted', ['/staged/a']);
  f.absent(f.frames.at(-1)); await tick();
  assert.equal(f.frames.at(-1).method, 'attachment/delete'); f.respond(f.frames.at(-1), { result: { removed: true } });
  assert.deepEqual(await pending, { cleared: ['/staged/a'], pending: [] });
  assert.equal(f.broker.persistentResources.size, 0);
  const before = f.frames.length; assert.deepEqual(await f.broker.discardRetainedAttachments(other, 'deleted', ['/staged/a']), { cleared: ['/staged/a'], pending: [] }); assert.equal(f.frames.length, before);
  f.broker.clearTransientState();
});
test('partial failures retain only pending paths and materialized paths never dispatch delete', async () => {
  const f = fixture(); const owner = f.client('family');
  for (const path of ['/staged/a', '/staged/b', '/staged/c']) f.retain(owner, path);
  f.broker.materializedAttachments.set('attachment\0/staged/c', 'deleted');
  const cleanup = f.broker.discardRetainedAttachments(owner, 'deleted', ['/staged/a', '/staged/b', '/staged/c']);
  f.absent(f.frames.at(-1)); await tick(); f.respond(f.frames.at(-1), { result: { removed: true } }); await tick();
  f.absent(f.frames.at(-1)); await tick(); f.respond(f.frames.at(-1), { error: { code: -1, message: 'synthetic failure' } }); await tick();
  f.absent(f.frames.at(-1));
  assert.deepEqual(await cleanup, { cleared: ['/staged/a', '/staged/c'], pending: ['/staged/b'] });
  assert.deepEqual(f.frames.filter(frame => frame.method === 'attachment/delete').map(frame => frame.params.path), ['/staged/a', '/staged/b']);
  assert.equal(f.broker.persistentResources.has('attachment\0/staged/b'), true);
  f.broker.clearTransientState();
});
test('disconnect during absence read cannot release resources and broker close settles cleanup', async () => {
  const f = fixture(); const owner = f.client('family'); f.retain(owner, '/staged/a');
  const cleanup = f.broker.discardRetainedAttachments(owner, 'deleted', ['/staged/a']); f.broker.detach(owner); f.absent(f.frames.at(-1));
  assert.deepEqual(await cleanup, { cleared: [], pending: ['/staged/a'] });
  const next = f.client('family'); const waiting = f.broker.discardRetainedAttachments(next, 'deleted', ['/staged/a']);
  f.broker.clearTransientState(); assert.deepEqual(await waiting, { cleared: [], pending: ['/staged/a'] });
});
test('cleanup claim blocks concurrent cleanup and next-turn claim while same-binding retain stays idempotent', async () => {
  const f = fixture(); const owner = f.client('family'); const next = f.client('family');
  f.retain(owner, '/staged/a'); const binding = f.broker.retainedAttachmentBindings.get('attachment\0/staged/a');
  const cleanup = f.broker.discardRetainedAttachments(owner, 'deleted', ['/staged/a']); const read = f.frames.at(-1);
  f.retain(owner, '/staged/a'); assert.equal(f.broker.retainedAttachmentBindings.get('attachment\0/staged/a'), binding); assert.equal(binding.cleaning, true);
  f.broker.detach(owner);
  assert.deepEqual(await f.broker.discardRetainedAttachments(next, 'deleted', ['/staged/a']), { cleared: [], pending: ['/staged/a'] });
  f.broker.receive(next, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'turn/start', params: { threadId: 'deleted', input: [{ type: 'text', text: '<kcoder_attachments version="1">\n{"path":"/staged/a","filename":"a"}\n</kcoder_attachments>' }] } }));
  assert.equal(next.messages.at(-1).error.code, -32048);
  f.absent(read); assert.deepEqual(await cleanup, { cleared: [], pending: ['/staged/a'] }); assert.equal(binding.cleaning, false);
  assert.equal(f.frames.filter(frame => frame.method === 'attachment/delete').length, 0);
  const retry = f.broker.discardRetainedAttachments(next, 'deleted', ['/staged/a']); f.absent(f.frames.at(-1)); await tick(); f.respond(f.frames.at(-1), { result: { removed: true } });
  assert.deepEqual(await retry, { cleared: ['/staged/a'], pending: [] });
  f.broker.clearTransientState();
});
