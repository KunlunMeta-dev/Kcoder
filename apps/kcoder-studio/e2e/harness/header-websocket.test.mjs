import assert from 'node:assert/strict';
import test from 'node:test';
import { HeaderWebSocket } from './header-websocket.mjs';

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
