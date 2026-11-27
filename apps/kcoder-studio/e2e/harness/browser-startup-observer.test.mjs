import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { observeFrontendInitialize } from './browser-startup-observer.mjs';

test('startup observer separates socket wait from initialize and retains only timing facts', t => {
  let clock = 100, phase = 'startup';
  t.mock.method(performance, 'now', () => clock);
  const page = new EventEmitter(), socket = new EventEmitter();
  const samples = observeFrontendInitialize(page, () => phase);
  page.emit('websocket', socket);
  clock = 5100;
  socket.emit('framesent', { payload: JSON.stringify({ id: 1, method: 'initialize', params: { secret: 'must-not-persist' } }) });
  phase = 'next'; clock = 5107;
  socket.emit('framereceived', { payload: JSON.stringify({ id: 1, result: { secret: 'must-not-persist' } }) });
  socket.emit('framereceived', { payload: JSON.stringify({ id: 1, result: {} }) });
  assert.deepEqual(samples, [{ phase: 'startup', socketToRequestMs: 5000, durationMs: 7, succeeded: true }]);
});

test('startup observer isolates identical ids per socket and ignores malformed or unrelated frames', t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const page = new EventEmitter(), first = new EventEmitter(), second = new EventEmitter();
  const samples = observeFrontendInitialize(page);
  page.emit('websocket', first);
  clock = 10; page.emit('websocket', second);
  for (const payload of ['null', 'invalid-json', '[]', '{"method":"initialized"}', '{"id":1,"method":"thread/list"}']) {
    first.emit('framesent', { payload }); first.emit('framereceived', { payload });
  }
  clock = 20;
  first.emit('framesent', { payload: '{"id":1,"method":"initialize"}' });
  second.emit('framesent', { payload: '{"id":1,"method":"initialize"}' });
  first.emit('framereceived', { payload: '{"id":2,"result":{}}' });
  clock = 30; first.emit('framereceived', { payload: '{"id":1,"error":{"message":"must-not-persist"}}' });
  clock = 40; second.emit('framereceived', { payload: '{"id":1,"result":{}}' });
  assert.deepEqual(samples, [
    { phase: 'startup', socketToRequestMs: 20, durationMs: 10, succeeded: false },
    { phase: 'startup', socketToRequestMs: 10, durationMs: 20, succeeded: true },
  ]);
});
