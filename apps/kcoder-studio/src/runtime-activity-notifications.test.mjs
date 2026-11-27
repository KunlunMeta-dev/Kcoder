import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeActivityNotifications, createRuntimeActivityAuthorization } from './runtime-activity-notifications.mjs';

const scope = { serverId: 'target', loginOwner: 'owner', generation: 3, signature: 'original' };
function socket() {
  const value = new EventEmitter(); value.writable = true; value.messages = [];
  value.write = raw => { value.messages.push(JSON.parse(raw)); return true; };
  return value;
}

function authorizationFixture() {
  const session = { allowedServerIds: new Set(['target']) };
  const state = { session, target: { security: true }, signature: 'original', identity: {}, generation: 3, reads: 0 };
  const canRead = createRuntimeActivityAuthorization({
    getSession: async () => { state.reads++; return state.session; }, session,
    getTarget: id => id === 'target' ? state.target : null,
    targetSignature: () => state.signature, loginOwner: 'owner',
    loginContexts: { identity: () => state.identity, generation: () => state.generation },
  });
  return { state, session, canRead };
}

test('stale scopes in one broadcast skip session reads while an eligible scope still authenticates', async t => {
  const { state, canRead } = authorizationFixture();
  const notifications = createRuntimeActivityNotifications({ frame: value => value });
  t.after(() => notifications.close());
  const target = socket();
  notifications.attach(target, canRead);
  notifications.changed({ ...scope, serverId: 'removed' });
  notifications.changed({ ...scope, signature: 'retired' });
  notifications.changed({ ...scope, loginOwner: 'foreign' });
  notifications.changed({ ...scope, generation: 2 });
  notifications.changed(scope);
  await delay(100);
  assert.equal(target.messages.length, 1);
  assert.equal(state.reads, 1);
});

test('current scopes always reread session authority, including target grants and revocation', async () => {
  const { state, session, canRead } = authorizationFixture();
  assert.equal(await canRead(scope), true);
  assert.equal(await canRead(scope), true);
  session.allowedServerIds.clear();
  assert.equal(await canRead(scope), false);
  state.session = null;
  assert.equal(await canRead(scope), false);
  assert.equal(state.reads, 4);
});

test('a retired login identity rejects before session lookup', async () => {
  const { state, canRead } = authorizationFixture();
  state.identity = null;
  assert.equal(await canRead(scope), false);
  assert.equal(state.reads, 0);
});

for (const field of ['target', 'signature', 'identity', 'generation']) test(`${field} changes during authentication still reject the notification`, async () => {
  const { state, session } = authorizationFixture();
  let finish;
  const canRead = createRuntimeActivityAuthorization({
    getSession: () => new Promise(resolve => { finish = resolve; }), session,
    getTarget: () => state.target, targetSignature: () => state.signature, loginOwner: 'owner',
    loginContexts: { identity: () => state.identity, generation: () => state.generation },
  });
  const pending = canRead(scope);
  state[field] = null;
  finish(session);
  assert.equal(await pending, false);
});

test('peer turn activity refreshes one authorized socket per page without sharing conversation content', async t => {
  const notifications = createRuntimeActivityNotifications({ frame: value => value });
  t.after(() => notifications.close());
  const first = socket(), second = socket(), other = socket(), forbidden = socket();
  const page = 'owned-page-0123456789';
  let allowed = true;
  const canRead = candidate => allowed && candidate.serverId === 'target' && candidate.generation === 3;
  notifications.attach(first, canRead, 'login', page);
  notifications.attach(second, canRead, 'login', page);
  notifications.attach(other, () => true, 'other-login', page);
  notifications.attach(forbidden, () => false, 'forbidden', page);
  notifications.changed(scope); notifications.changed(scope);
  await delay(100);
  assert.deepEqual(first.messages, [{ jsonrpc: '2.0', method: 'gateway/runtimeActivity/changed', params: {} }]);
  assert.equal(second.messages.length, 0);
  assert.equal(other.messages.length, 1);
  assert.equal(forbidden.messages.length, 0);
  allowed = false;
  notifications.changed(scope);
  await delay(100);
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 0);
  assert.equal(other.messages.length, 2);
  first.emit('close'); second.emit('close'); other.emit('close'); forbidden.emit('close');
  assert.equal(first.listenerCount('drain'), 0);
});

test('backpressure and revocation never deliver a stale refresh', async t => {
  const notifications = createRuntimeActivityNotifications({ frame: value => value });
  t.after(() => notifications.close());
  const target = socket();
  target.write = raw => { target.messages.push(JSON.parse(raw)); return false; };
  let allowed = true;
  notifications.attach(target, () => allowed);
  notifications.changed(scope); await delay(100);
  notifications.changed(scope); await delay(100);
  assert.equal(target.messages.length, 1);
  allowed = false; target.emit('drain'); await delay(100);
  assert.equal(target.messages.length, 1);
  notifications.close();
  assert.equal(target.listenerCount('drain'), 0);
});

test('an authorization check that finishes after socket close cannot publish', async t => {
  const notifications = createRuntimeActivityNotifications({ frame: value => value });
  t.after(() => notifications.close());
  const target = socket();
  let resolve;
  notifications.attach(target, () => new Promise(done => { resolve = done; }));
  notifications.changed(scope); await delay(80);
  assert.equal(typeof resolve, 'function');
  target.emit('close'); resolve(true); await delay(20);
  assert.deepEqual(target.messages, []);
});

test('a reconnect or selected socket handoff resynchronizes the page with fresh authorization', async t => {
  const notifications = createRuntimeActivityNotifications({ frame: value => value });
  t.after(() => notifications.close());
  const page = 'owned-page-0123456789', first = socket(), spare = socket();
  notifications.attach(first, () => true, 'login', page, scope);
  notifications.attach(spare, () => true, 'login', page, scope);
  await delay(100);
  assert.equal(first.messages.length, 1);
  assert.equal(spare.messages.length, 0);
  first.emit('close'); await delay(100);
  assert.equal(spare.messages.length, 1);
  spare.emit('close');
  const reconnected = socket();
  notifications.attach(reconnected, () => true, 'login', page, scope);
  await delay(100);
  assert.equal(reconnected.messages.length, 1);
});
