import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { captureOwnedNativeSshAcpTransport } from './owned-ssh-acp-transport.mjs';

function fixture({ write, clean = true } = {}) {
  const child = new EventEmitter(); const sent = [];
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, callback) { sent.push(Buffer.from(chunk)); write ? write(chunk, callback) : callback(); } });
  let allowed = true; let stops = 0;
  const transport = captureOwnedNativeSshAcpTransport({ child, operationId: 'original-operation', endpointInstanceId: 'held-endpoint',
    deadlineAtMs: Date.now() + 5000, assertEndpointOwner: binding => { assert.equal(binding.child, child); if (!allowed) throw new Error('revoked'); },
    stopOwned: async binding => { assert.equal(binding.child, child); stops += 1; return clean; } });
  return { child, sent, transport, revoke() { allowed = false; }, stops: () => stops };
}
const rpc = id => ({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: 'original-session' } });

test('write receipts mean pipe transport only and the same request cannot replay a prompt', async () => {
  const f = fixture();
  const receipt = await f.transport.writeOnce('original-write', rpc(1));
  assert.equal(receipt.state, 'transport_written'); assert.equal(f.sent.length, 1);
  await assert.rejects(f.transport.writeOnce('original-write', rpc(1)), /RECONCILE_ORIGINAL/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.transport.observeWrite('missing').state, 'not_observed');
  await f.transport.close(); assert.equal(f.stops(), 1);
});

test('read receipt loss redelivers original frames until an explicit acknowledged cursor', async () => {
  const f = fixture();
  const reply = { jsonrpc: '2.0', id: 1, result: { sessionId: 'original-session' } };
  const bytes = Buffer.from(`${JSON.stringify(reply)}\n`);
  f.child.stdout.write(bytes.subarray(0, 7)); f.child.stdout.write(bytes.subarray(7));
  const first = await f.transport.read(); const repeated = await f.transport.read();
  assert.deepEqual(first.frames, repeated.frames); assert.equal(first.frames.length, 1);
  assert.deepEqual((await f.transport.read({ acknowledgeThrough: 1 })).frames, []);
  await assert.rejects(f.transport.read({ acknowledgeThrough: 2 }), /CURSOR_INVALID/);
  await f.transport.close();
});

test('revoked actual endpoint cannot write and closes only its original child', async () => {
  const f = fixture(); f.revoke();
  await assert.rejects(f.transport.writeOnce('after-revocation', rpc(1)), /OWNER_CHANGED/);
  assert.equal(f.sent.length, 0); await f.transport.close(); assert.equal(f.stops(), 1);
});

test('a pipe write with lost callback settles as unknown on child close and is never repeated', async () => {
  const f = fixture({ write() {} });
  const write = f.transport.writeOnce('write-with-lost-ack', rpc(1));
  f.child.emit('close');
  await assert.rejects(write, /RECONCILE_ORIGINAL/);
  assert.equal(f.transport.observeWrite('write-with-lost-ack').state, 'outcome_unknown');
  assert.equal(f.sent.length, 1); await f.transport.close(); assert.equal(f.stops(), 1);
});

test('invalid UTF-8 and oversized ACP frames fail closed without decoding replacement text', async () => {
  for (const data of [Buffer.from([0xff, 0x0a]), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)]) {
    const f = fixture(); f.child.stdout.write(data);
    await assert.rejects(f.transport.read(), /INVALID_ACP_FRAME|FRAME_TOO_LARGE/);
    await f.transport.close(); assert.equal(f.stops(), 1);
  }
});

test('source cancellation aborts a pending frame read and retains unconfirmed actual cleanup', async () => {
  const f = fixture({ clean: false }); const pending = f.transport.read({ waitMs: 1000 });
  f.child.emit('close'); await assert.rejects(pending, /TRANSPORT_CLOSED/);
  assert.equal(await f.transport.close(), false); assert.equal(f.stops(), 1);
});
