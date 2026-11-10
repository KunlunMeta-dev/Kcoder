import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelRuntime } from '../../kcoder-channel-host/src/channels/runtime.mjs';
import { ChannelTaskMirrors } from '../src/channel-task-mirrors.mjs';
import { createChannelsController } from '../src/channels-controller.mjs';

const target = { serverId: 'local', workspacePath: '/fixture', threadId: 'original' };
const started = { method: 'turn/started', params: { threadId: 'original', turn: { id: 'turn', attemptId: 'attempt' } } };
async function fixture(t, enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-mirror-')), sends = []; let observe, reads = 0;
  const runtime = new ChannelRuntime({ directory, tasks: { run: async () => {}, recover: async () => {} }, workerFactory: () => ({
    start: async () => {}, stop: async () => {}, connectionState: () => 'connected',
    send: async payload => { sends.push(payload.content.text); return { state: 'accepted' }; },
  }) });
  runtime.store.saveConnection({ id: 'bot', platform: 'feishu', label: 'Fixture' }, { appSecret: 'fixture' });
  if (enabled) runtime.store.setSettings({ mirrorClientTurns: true });
  const chat = runtime.store.observeChat('bot', { platform: 'feishu', conversationId: 'private', eventId: 'old' });
  runtime.bind(chat.id, target); await runtime.connect('bot');
  const client = { watch: async (_thread, callback) => { observe = callback; },
    readTurn: async () => { reads++; return { state: 'completed', user: 'canonical user', assistant: 'canonical response' }; } };
  const create = () => new ChannelTaskMirrors({ runtime, retain: async () => client,
    release: async () => {}, useClient: (_target, operation) => operation(client) });
  const mirror = create(); await mirror.sync(); await mirror.pumping;
  t.after(async () => { await mirror.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  return { runtime, mirror, create, chat, sends, client, reads: () => reads,
    emit: (event, facts = { channelInput: false }) => observe?.(event, facts) };
}

test('client mirroring is off by default and enabling it watches only future turns', async t => {
  const f = await fixture(t, false);
  assert.equal(f.mirror.watches.size, 0);
  f.mirror.observe(target, started.params); await f.mirror.pump();
  assert.equal(f.runtime.store.waitingTaskOutputs().length, 0);
  assert.equal(f.reads(), 0); assert.deepEqual(f.sends, []);
  f.runtime.store.setSettings({ mirrorClientTurns: true }); await f.mirror.sync();
  assert.equal(f.mirror.watches.size, 1);
  assert.equal(f.runtime.store.waitingTaskOutputs().length, 0);
  f.emit(started); f.emit({ method: 'turn/completed', params: { threadId: 'original' } });
  await f.mirror.pumping;
  assert.deepEqual(f.sends, ['canonical user', 'canonical response']);
});

test('disabling during a history read suppresses unsent mirrors and does not replay them when reenabled', async t => {
  const f = await fixture(t);
  let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  f.client.readTurn = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  f.emit(started); f.mirror.kick(); await reading;
  f.runtime.store.setSettings({ mirrorClientTurns: false });
  release({ state: 'completed', user: 'canonical user', assistant: 'canonical response' });
  await f.mirror.pumping; await f.mirror.sync();
  assert.deepEqual(f.sends, []); assert.equal(f.mirror.watches.size, 0);
  f.runtime.store.setSettings({ mirrorClientTurns: true }); await f.mirror.sync(); await f.mirror.pumping;
  assert.deepEqual(f.sends, []);
  assert.ok(f.runtime.store.deliverySummaries(f.chat.id, 1).every(row => row.code === 'CHANNEL_CLIENT_SYNC_DISABLED'));
});

test('default-off dispatch suppresses a preexisting pending mirror while ordinary channel replies still send', async t => {
  const f = await fixture(t, false), store = f.runtime.store;
  f.runtime.prepareOutput('old-mirror', f.chat.id, { text: '' }, { bindingRevision: 1 });
  store.deferTaskOutput('old-mirror', { target, turnId: 'old-turn', role: 'user' });
  store.resolveTaskOutput('old-mirror', 'old client input');
  const queued = store.output('old-mirror');
  assert.equal((await f.runtime.dispatchOutput(queued)).receipt.code, 'CHANNEL_CLIENT_SYNC_DISABLED');
  assert.deepEqual(f.sends, []);
  await f.runtime.send('ordinary-channel-reply', f.chat.id, { text: 'ordinary reply' });
  assert.deepEqual(f.sends, ['ordinary reply']);
  store.setSettings({ mirrorClientTurns: true });
  await f.runtime.dispatchOutput(queued);
  assert.deepEqual(f.sends, ['ordinary reply'], 'a stale queued object cannot resend the suppressed output');
});

test('future web turns freeze two durable intents; duplicate events and channel turns do not echo', async t => {
  const f = await fixture(t);
  assert.equal(f.runtime.store.waitingTaskOutputs().length, 0, 'binding never scans old history');
  f.emit(started); f.emit(started);
  assert.equal(f.runtime.store.waitingTaskOutputs().length, 2);
  assert.equal(f.reads(), 0, 'ordinary turn admission does not wait for channel publication');
  f.emit({ method: 'turn/completed', params: { threadId: 'original' } }); await f.mirror.pumping;
  assert.deepEqual(f.sends, ['canonical user', 'canonical response']); assert.equal(f.reads(), 1);
  f.emit(started, { channelInput: true }); f.emit({ method: 'turn/completed', params: { threadId: 'original' } });
  await f.mirror.pumping; assert.equal(f.sends.length, 2);
});

test('an unbind/rebind cannot redirect an already observed turn, including rebinding the same target', async t => {
  const f = await fixture(t); f.emit(started);
  f.runtime.unbind(f.chat.id); f.runtime.bind(f.chat.id, target);
  f.mirror.kick(); await f.mirror.pumping;
  assert.deepEqual(f.sends, []); assert.equal(f.reads(), 0);
  assert.equal(f.runtime.store.waitingTaskOutputs().length, 0);
});

test('matching workspace and thread names on two target accounts never merge their mirrors', async t => {
  const f = await fixture(t);
  const peer = f.runtime.store.observeChat('bot', { platform: 'feishu', conversationId: 'peer', eventId: 'old-peer' });
  f.runtime.bind(peer.id, { ...target, loginOwner: 'different-target-account' });
  f.emit(started);
  assert.ok(f.runtime.store.waitingTaskOutputs().every(row => row.chatId === f.chat.id));
  f.mirror.kick(); await f.mirror.pumping;
  assert.deepEqual(f.sends, ['canonical user', 'canonical response']);
});

test('restart resolves original intents only and never retries a send whose receipt was lost', async t => {
  const f = await fixture(t); f.emit(started); await f.mirror.close();
  let attempts = 0;
  f.runtime.workers.get('bot').send = async () => { attempts++; throw new Error('lost response'); };
  const recovered = f.create(); t.after(() => recovered.close());
  await recovered.sync(); await recovered.pumping;
  assert.equal(attempts, 2); assert.equal(f.runtime.store.waitingTaskOutputs().length, 0);
  recovered.kick(); await recovered.pumping; assert.equal(attempts, 2);
  const rows = f.runtime.store.deliverySummaries(f.chat.id, 1);
  assert.ok(rows.every(row => row.deliveryState === 'unknown'));
});

test('a replaced backend reacquires only its bound task watcher; unbinding releases the replacement', async t => {
  function broker() {
    const clients = new Set();
    return { clients, attach: client => clients.add(client), detach: client => clients.delete(client),
      receive(client, raw) {
        const request = JSON.parse(raw);
        assert.ok(['initialize', 'thread/resume', 'gateway/thread/attach'].includes(request.method));
        client.send({ id: request.id, result: request.method === 'initialize'
          ? { capabilities: { experimental: { unattendedTurnsV1: true, channelToolRestrictionsV1: true } } } : {} });
      } };
  }
  const directory = mkdtempSync(join(tmpdir(), 'channel-watcher-owner-'));
  const original = broker(), replacement = broker(); let current = original;
  const controller = createChannelsController({ directory, selectBroker: async () => ({ broker: current }) });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  const { store } = controller.runtime;
  store.setSettings({ mirrorClientTurns: true });
  store.saveConnection({ id: 'bot', platform: 'feishu', label: 'Fixture', enabled: true }, { appSecret: 'fixture' });
  const chat = store.observeChat('bot', { platform: 'feishu', conversationId: 'private', eventId: 'old' });
  store.bind(chat.id, target); await controller.bindingChanged(); assert.equal(original.clients.size, 1);
  for (const client of original.clients) client.close();
  current = replacement;
  await controller.bindingChanged();
  assert.equal(original.clients.size, 0); assert.equal(replacement.clients.size, 1);
  store.unbind(chat.id); await controller.bindingChanged(); assert.equal(replacement.clients.size, 0);
});
