// Generic Duplex EOF contracts over owned TCP sockets and public Stream APIs.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { bridgeRaw, RELAY_EOF_DRAIN_TIMEOUT_MS } from '../src/transport.mjs';

async function bounded(promise, ms = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('owned raw drain deadline')), ms);
  })]); } finally { clearTimeout(timer); }
}
function watchDeadline(t) {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const timers = new Set(), counts = { started: 0, fired: 0, cleared: 0 };
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay !== RELAY_EOF_DRAIN_TIMEOUT_MS) return originalSet(callback, delay, ...args);
    counts.started++;
    const timer = originalSet(() => { counts.fired++; callback(...args); }, delay);
    timers.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => {
    if (timers.delete(timer)) counts.cleared++;
    return originalClear(timer);
  });
  return counts;
}
async function fixture(t, onBytes = () => true) {
  const source = new PassThrough(); source.on('error', () => {});
  let sink, client, cleanup, closeCount = 0, ready, completed;
  const attached = new Promise(resolve => { ready = resolve; });
  const bridgeClosed = new Promise(resolve => { completed = resolve; });
  const server = createServer({ allowHalfOpen: true }, socket => {
    sink = socket; socket.on('error', () => {}); socket.cork();
    cleanup = bridgeRaw(socket, source, () => { closeCount++; completed(); }, onBytes);
    ready();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  client = connect({ host: '127.0.0.1', port: server.address().port });
  client.on('error', () => {}); client.pause();
  await bounded(attached);
  t.after(async () => {
    cleanup(); client.destroy(); sink.destroy(); source.destroy();
    await bounded(new Promise(resolve => server.close(resolve)));
  });
  return { source, sink, client, cleanup, bridgeClosed, closeCount: () => closeCount };
}

test('generic natural EOF drains an owned queued TCP tail and clears its only deadline once', async t => {
  const timers = watchDeadline(t), measured = [];
  const f = await fixture(t, bytes => { measured.push(bytes); return true; });
  const body = Buffer.alloc(8 * 1024 * 1024, 0xa5), chunks = [];
  f.client.on('data', chunk => chunks.push(chunk));
  const end = once(f.client, 'end'), sourceClosed = once(f.source, 'close');
  f.source.end(body); await bounded(sourceClosed);
  assert.ok(f.sink.writableLength > 0);
  assert.equal(f.closeCount(), 0); assert.equal(f.sink.destroyed, false);
  f.client.resume(); f.sink.uncork();
  await bounded(Promise.all([end, f.bridgeClosed]));
  assert.deepEqual(Buffer.concat(chunks), body);
  assert.equal(measured.reduce((sum, bytes) => sum + bytes, 0), body.length);
  f.cleanup(); f.cleanup();
  assert.equal(f.closeCount(), 1);
  assert.deepEqual(timers, { started: 1, fired: 0, cleared: 1 });
});

test('returned raw cleanup immediately aborts a naturally ended source with a queued sink', async t => {
  const timers = watchDeadline(t), f = await fixture(t);
  const sourceClosed = once(f.source, 'close');
  f.source.end(Buffer.alloc(8 * 1024 * 1024, 0x5a)); await bounded(sourceClosed);
  assert.ok(f.sink.writableLength > 0);
  const began = performance.now(); f.cleanup(); f.cleanup();
  await bounded(f.bridgeClosed);
  assert.ok(performance.now() - began < 1000);
  assert.equal(f.sink.destroyed, true); assert.equal(f.closeCount(), 1);
  assert.deepEqual(timers, { started: 1, fired: 0, cleared: 1 });
});

test('a second EOF does not restart the one total raw drain deadline', async t => {
  const timers = watchDeadline(t), f = await fixture(t);
  const sourceClosed = once(f.source, 'close'), began = performance.now();
  f.source.end(Buffer.alloc(8 * 1024 * 1024, 0x3c)); await bounded(sourceClosed);
  assert.ok(f.sink.writableLength > 0); assert.equal(f.closeCount(), 0);
  await new Promise(resolve => setTimeout(resolve, 150));
  const inputEnded = once(f.sink, 'end'); f.client.end(); await bounded(inputEnded);
  assert.equal(timers.started, 1, 'the opposite EOF cannot renew the first deadline');
  await bounded(f.bridgeClosed, RELAY_EOF_DRAIN_TIMEOUT_MS + 1500);
  const elapsed = performance.now() - began;
  assert.ok(elapsed >= RELAY_EOF_DRAIN_TIMEOUT_MS - 50);
  assert.ok(elapsed < RELAY_EOF_DRAIN_TIMEOUT_MS + 1500);
  f.cleanup(); f.cleanup();
  assert.equal(f.closeCount(), 1); assert.equal(f.sink.destroyed, true);
  assert.deepEqual(timers, { started: 1, fired: 1, cleared: 1 });
});

test('a traffic gate error remains an immediate abort instead of an EOF grace', async t => {
  const timers = watchDeadline(t), f = await fixture(t, () => false);
  const began = performance.now(); f.source.write('owned-gate-rejection');
  await bounded(f.bridgeClosed);
  assert.ok(performance.now() - began < 1000);
  assert.equal(f.sink.destroyed, true); assert.equal(f.closeCount(), 1);
  assert.deepEqual(timers, { started: 0, fired: 0, cleared: 0 });
});
