import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import { probeStun } from '../deploy/stun-lifecycle.mjs';

for (const synchronous of [false, true]) test('a failed STUN socket settles once and cannot send again: ' + synchronous, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sends = 0, closes = 0;
  const socket = Object.assign(new EventEmitter(), {
    send() { sends++; if (synchronous) throw new Error('owned closed socket'); },
    close() { closes++; },
  });
  t.mock.method(dgram, 'createSocket', () => socket);
  const pending = probeStun({}, 18452);
  if (!synchronous) socket.emit('error', new Error('owned UDP failure'));
  await assert.rejects(pending, /STUN Binding probe (socket|send) failed/);
  t.mock.timers.tick(10000);
  assert.equal(sends, 1);
  assert.equal(closes, 1);
});
