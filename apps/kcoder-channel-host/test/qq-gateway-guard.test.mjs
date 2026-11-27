import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { QQGateway } from '../src/adapters/qq-sdk.mjs';
import { BoundedPlatformEvents } from '../src/adapters/sdk-guards.mjs';

function options(controller, events) {
  return { account: { accountId: 'owned', appId: 'fixture', clientSecret: 'fixture' },
    events, abortSignal: controller.signal, getAccessToken: async () => 'fixture',
    getGatewayUrl: async () => 'wss://api.sgroup.qq.com/fixture', onMessage: async () => {} };
}

test('a missing SDK receiver rejects the owned loop without throwing from the open listener', async () => {
  const controller = new AbortController(), events = new BoundedPlatformEvents(); let socket;
  class MissingReceiverGateway extends QQGateway {
    openSocket() {
      socket = Object.assign(new EventEmitter(), { readyState: 0, send() {}, terminate() { this.readyState = 3; } });
      this.currentWs = socket; this.guardSocket(socket);
    }
  }
  const gateway = new MissingReceiverGateway(options(controller, events)), loop = gateway.start();
  loop.catch(() => {});
  try {
    await new Promise(setImmediate);
    assert.doesNotThrow(() => socket.emit('open'));
    await assert.rejects(loop, { code: 'QQ_SDK_GUARD_UNAVAILABLE' });
    assert.equal(socket.readyState, 3); assert.equal(gateway.currentWs, null);
  } finally { controller.abort(); events.close(); await loop.catch(() => {}); }
});

test('a late open on a retired socket cannot terminate the replacement loop', () => {
  const controller = new AbortController(), events = new BoundedPlatformEvents();
  const gateway = new QQGateway(options(controller, events)); let terminated = 0, finished = 0;
  const retired = Object.assign(new EventEmitter(), { send() {}, terminate() { terminated++; } });
  const current = {}; gateway.currentWs = current; gateway.finish = () => { finished++; };
  gateway.guardSocket(retired);
  assert.doesNotThrow(() => retired.emit('open'));
  assert.equal(gateway.currentWs, current); assert.equal(finished, 0); assert.equal(terminated, 1);
  events.close();
});

test('a retired READY dispatch cannot report the replacement socket connected', async () => {
  const controller = new AbortController(), events = new BoundedPlatformEvents(); let ready = 0;
  const gateway = new QQGateway({ ...options(controller, events), onReady: () => { ready++; } });
  const old = { terminate() {} }, current = { terminate() {} }; gateway.currentWs = old;
  gateway.handlePayload(old, { op: 0, t: 'READY', s: 1, d: { session_id: 'retired-session' } }, 'fixture');
  gateway.currentWs = current; await new Promise(setImmediate);
  gateway.handlePayload(current, { op: 0, t: 'FIXTURE_EVENT', s: 2, d: {} }, 'fixture');
  await new Promise(setImmediate); assert.equal(ready, 0);
  gateway.handlePayload(current, { op: 0, t: 'READY', s: 1, d: { session_id: 'current-session' } }, 'fixture');
  await new Promise(setImmediate); assert.equal(ready, 1); events.close();
});

test('the RESUME sequence is monotonic within a session and resets for a new READY identity', async () => {
  const controller = new AbortController(), events = new BoundedPlatformEvents();
  const gateway = new QQGateway(options(controller, events)), socket = { terminate() {} }; gateway.currentWs = socket;
  for (const [type, sequence, data] of [['READY', 1, { session_id: 'first' }], ['FIXTURE_EVENT', 5, {}], ['FIXTURE_EVENT', 3, {}]]) {
    gateway.handlePayload(socket, { op: 0, t: type, s: sequence, d: data }, 'fixture');
    await new Promise(setImmediate);
  }
  assert.equal(gateway.lastSeq, 5);
  gateway.handlePayload(socket, { op: 0, t: 'READY', s: 1, d: { session_id: 'second' } }, 'fixture');
  await new Promise(setImmediate); assert.equal(gateway.lastSeq, 1); events.close();
});
