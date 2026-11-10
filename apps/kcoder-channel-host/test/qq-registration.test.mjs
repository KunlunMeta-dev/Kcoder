import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QQRegistration } from '../src/adapters/qq-registration.mjs';
import { ChannelAuthorizations } from '../src/channels/authorizations.mjs';

function fixture() {
  const child = new EventEmitter(); let killed = 0;
  child.kill = () => { killed++; };
  const adapter = new QQRegistration({ forkImpl: (file, args, options) => {
    assert.ok(file.href.endsWith('qq-registration-worker.mjs'));
    assert.deepEqual(args, []); assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
    assert.equal(options.env.KCODER_HOME, undefined); assert.equal(options.windowsHide, true);
    return child;
  } });
  return { adapter, child, killed: () => killed };
}

test('QQ SDK callbacks remain private, save once through the common commit and never start a listener', async () => {
  const f = fixture(); let saved = null, writes = 0;
  const authorization = new ChannelAuthorizations({ connection: () => saved,
    saveConnection: (value, credentials) => { writes++; assert.deepEqual(credentials, { appSecret: 'PRIVATE_SECRET' }); return saved = { ...value, revision: 1 }; },
  }, { qq: () => f.adapter });
  const begin = { action: 'authorization_begin', platform: 'qq', flowId: 'qq-original', connectionId: 'qq-bot', expectedRevision: 0 };
  const pending = authorization.request(begin, 'owner'); await new Promise(setImmediate);
  f.child.emit('message', { state: 'waiting', verificationUrl: 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=fixture' });
  assert.equal((await pending).state, 'waiting'); assert.equal(writes, 0);
  await assert.rejects(authorization.request({ action: 'authorization_read', flowId: begin.flowId }, 'peer'), /FLOW_MISSING/);
  f.child.emit('message', { state: 'ready', credentials: [{ appId: 'fixture-app', appSecret: 'PRIVATE_SECRET', userOpenid: 'private-user' }] });
  const ready = await authorization.request({ action: 'authorization_poll', flowId: begin.flowId }, 'owner');
  assert.equal(ready.state, 'ready'); assert.equal(JSON.stringify(ready).includes('PRIVATE_SECRET'), false);
  assert.equal(JSON.stringify(ready).includes('private-user'), false);
  const commit = { action: 'authorization_commit', flowId: begin.flowId, label: 'QQ', features: { messageFormat: 'plain' } };
  await authorization.request(commit, 'owner'); await authorization.request(commit, 'owner');
  assert.equal(writes, 1); assert.equal(saved.configuration.features.messageFormat, 'plain');
  assert.equal(saved.enabled, undefined); assert.equal(f.adapter.credentials, undefined); assert.equal(f.killed(), 1);
  authorization.close();
});

for (const state of ['cancelled', 'expired', 'unavailable']) test(`QQ ${state} ends only the owned worker and ignores late success`, async () => {
  const f = fixture(), creating = f.adapter.create();
  f.child.emit('message', { state: 'waiting', verificationUrl: 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=fixture' });
  await creating;
  if (state === 'cancelled') f.adapter.cancel(); else f.child.emit('message', { state });
  f.child.emit('message', { state: 'ready', credentials: [{ appId: 'other', appSecret: 'late' }] });
  assert.equal(f.adapter.poll().state, state); assert.equal(f.adapter.credentials, undefined); assert.equal(f.killed(), 1);
});

test('QQ rejects foreign QR URLs and does not pick an arbitrary bot from multiple credentials', async () => {
  const first = fixture(), waiting = first.adapter.create();
  first.child.emit('message', { state: 'waiting', verificationUrl: 'https://evil.example/qqbot/openclaw/connect.html' });
  assert.equal((await waiting).state, 'unavailable'); assert.equal(first.killed(), 1);
  const second = fixture(), pending = second.adapter.create();
  second.child.emit('message', { state: 'ready', credentials: [{ appId: 'a', appSecret: 'x' }, { appId: 'b', appSecret: 'y' }] });
  assert.equal((await pending).state, 'unavailable'); assert.equal(second.adapter.credentials, undefined);
});

test('QQ cancellation settles an in-flight create without waiting for SDK network timeouts', async () => {
  const f = fixture(), pending = f.adapter.create(); f.adapter.cancel();
  await assert.rejects(pending, /QQ_QR_CANCELLED/); assert.equal(f.killed(), 1);
});
