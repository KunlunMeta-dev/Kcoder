import assert from 'node:assert/strict';
import test from 'node:test';
import { HeaderWebSocket } from './header-websocket.mjs';

test('fragmented writes use text then masked continuations and preserve split UTF-8 bytes', () => {
  const socket = Object.create(HeaderWebSocket.prototype), frames = [];
  socket.readyState = HeaderWebSocket.OPEN;
  socket.socket = { write: bytes => frames.push(bytes) };
  socket.sendFragmented('a😀b', 2);
  assert.deepEqual(frames.map(frame => frame[0]), [1, 0, 0x80]);
  const payloads = frames.map(frame => {
    assert.equal(frame[1], 0x80 | 2);
    const mask = frame.subarray(2, 6);
    return frame.subarray(6).map((byte, index) => byte ^ mask[index % 4]);
  });
  assert.equal(Buffer.concat(payloads).toString('utf8'), 'a😀b');
  socket.sendFragmented('', 2);
  assert.equal(frames.at(-1)[0], 0x81);
  assert.equal(frames.at(-1)[1], 0x80);
  for (const size of [0, -1, 1.5, Infinity, NaN])
    assert.throws(() => socket.sendFragmented('text', size), /positive safe integer/);
  socket.readyState = HeaderWebSocket.CLOSED;
  assert.throws(() => socket.sendFragmented('text', 2), /not open/);
});

test('diagnostic listeners can be removed without affecting RPC subscribers', () => {
  // Exercise the event boundary without opening a network connection.
  const socket = Object.create(HeaderWebSocket.prototype);
  socket.listeners = new Map();
  let diagnostic = 0, rpc = 0, close = 0;
  const listener = () => diagnostic++;
  socket.addEventListener('message', listener);
  socket.addEventListener('message', () => rpc++);
  socket.addEventListener('close', () => close++);
  socket.emit('message', {});
  socket.removeEventListener('message', listener);
  socket.removeEventListener('message', listener);
  socket.removeEventListener('missing', listener);
  socket.emit('message', {});
  socket.emit('close', {});
  assert.deepEqual({ diagnostic, rpc, close }, { diagnostic: 1, rpc: 2, close: 1 });
});
