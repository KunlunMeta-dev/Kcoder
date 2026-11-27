import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bridgeSshTerminal } from './ssh-channel.js';
import { createWebSocketFrameCodec } from './websocket-frame-codec.js';

const { frame, decodeFrames } = createWebSocketFrameCodec({ maxMessageBytes: 2 * 1024 * 1024 });
function masked(text) {
  const payload = Buffer.from(text), encoded = frame(payload);
  const header = Buffer.from(encoded.subarray(0, encoded.length - payload.length));
  header[1] |= 0x80;
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([header, mask, payload.map((byte, index) => byte ^ mask[index % 4])]);
}
function fixture(t, initialData = Buffer.alloc(0)) {
  const socket = new EventEmitter(), replies = [];
  let lookups = 0;
  Object.assign(socket, { writable: true, writableLength: 0, destroyed: false,
    write(wire) { const length = wire[1] & 0x7f; replies.push(JSON.parse(wire.subarray(length < 126 ? 2 : length === 126 ? 4 : 10))); return true; },
    destroy() { this.destroyed = true; this.writable = false; this.emit('close'); },
    end() { this.writable = false; this.emit('close'); },
  });
  bridgeSshTerminal(socket, initialData, { frame, decodeFrames, store: { list() { lookups++; return []; } } });
  t.after(() => socket.destroy());
  return { socket, replies, lookups: () => lookups };
}

test('SSH initial upgrade bytes and later split frames preserve each reply once', async t => {
  const first = masked(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ssh/close' }));
  const second = masked(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ssh/close' }));
  const f = fixture(t, first.subarray(0, 3));
  f.socket.emit('data', first.subarray(3));
  for (const byte of second) f.socket.emit('data', Buffer.from([byte]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.replies.map(reply => reply.id), [1, 2]);
  assert.ok(f.replies.every(reply => !reply.error));
  assert.equal(f.lookups(), 0);
});

test('SSH retains its stricter input batch limit before any connection lookup', async t => {
  const f = fixture(t);
  const text = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ssh/connect', params: { profileId: 'owned' } })
    + ' '.repeat(100 * 1024);
  f.socket.emit('data', masked(text));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.socket.destroyed, true);
  assert.equal(f.lookups(), 0);
  assert.deepEqual(f.replies, []);
});
