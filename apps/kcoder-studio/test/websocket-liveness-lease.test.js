import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketLivenessLease } from '../src/websocket-liveness-lease.js';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0, expired = 0, paused = false;
  const pings = [];
  const lease = new WebSocketLivenessLease({ sendPing: payload => pings.push(payload),
    onExpired: () => expired++, canProbe: () => !paused, now: () => clock });
  return { lease, pings, expired: () => expired, pause: value => { paused = value; },
    tick: (milliseconds, jump = milliseconds) => { clock += jump; t.mock.timers.tick(milliseconds); } };
}

test('matching pong renews the lease; wrong pong cannot prevent expiration', t => {
  const f = fixture(t);
  f.lease.start();
  f.tick(30_000);
  assert.equal(f.pings.length, 1);
  f.lease.pong(f.pings[0]);
  f.tick(30_000);
  assert.equal(f.pings.length, 2);
  f.lease.pong(Buffer.from('wrong'));
  f.tick(30_000);
  assert.equal(f.expired(), 1);
  f.tick(60_000);
  assert.equal(f.expired(), 1);
});

test('local input backpressure and event-loop suspension do not cause false expiry', t => {
  const f = fixture(t);
  f.pause(true);
  f.lease.start();
  f.tick(30_000);
  assert.equal(f.pings.length, 0);
  f.pause(false);
  f.tick(30_000);
  assert.equal(f.pings.length, 1);
  f.tick(30_000, 300_000);
  assert.equal(f.expired(), 0);
  f.tick(30_000);
  assert.equal(f.pings.length, 2);
  f.lease.stop();
  f.tick(30_000);
  assert.equal(f.expired(), 0);
});

test('synchronous pong and paused pending probes do not accidentally expire', t => {
  const f = fixture(t);
  f.lease.sendPing = payload => f.lease.pong(payload);
  f.lease.start();
  f.tick(30_000);
  f.tick(30_000);
  assert.equal(f.expired(), 0);
  f.lease.sendPing = () => {};
  f.tick(30_000);
  f.pause(true);
  f.tick(30_000);
  assert.equal(f.expired(), 0);
  f.lease.stop();
});
