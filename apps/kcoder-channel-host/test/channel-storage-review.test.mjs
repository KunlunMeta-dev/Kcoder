import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, truncateSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ChannelStore } from '../src/channels/store.mjs';
import { ChannelRuntime } from '../src/channels/runtime.mjs';
import { ChannelSettingsFile } from '../src/channels/settings.mjs';
import { importChannels } from '../src/channels/migration.mjs';
import { channelMessagePreview, publicChannelChat } from '../src/channels/presentation.mjs';

const event = (id = 'message') => ({ platform: 'qq', tenantId: 'tenant', chatKind: 'private', conversationId: 'chat',
  botId: 'fixture-app', senderId: 'sender', eventId: id, text: 'input', occurredAtMs: 100, receivedAtMs: 100 });
const connection = { id: 'bot', platform: 'qq', label: 'Fixture', configuration: { appId: 'fixture-app' } };
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'channel-storage-review-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function storage(t) {
  const root = directory(t), store = new ChannelStore(root);
  t.after(() => store.close());
  store.saveConnection(connection, { appSecret: 'inert-private-fixture' });
  return { root, store };
}
function runtimeFixture(t) {
  const root = directory(t), calls = [];
  const worker = { state: 'connected', async start() {}, async stop() {}, connectionState() { return this.state; },
    async send() { calls.push('send'); return { state: 'accepted' }; } };
  const runtime = new ChannelRuntime({ directory: root, tasks: { run: async () => ({}), recover: async () => ({ state: 'unknown' }) },
    workerFactory: () => worker });
  t.after(() => runtime.close());
  runtime.store.saveConnection(connection, { appSecret: 'inert-private-fixture' });
  const input = runtime.store.receive('bot', event(), { historical: true });
  return { root, runtime, worker, calls, input };
}

test('a stopped worker cannot claim an unsent output and a later ready worker sends it once', async t => {
  const { runtime, worker, calls, input } = runtimeFixture(t);
  await runtime.connect('bot'); worker.state = 'stopped';
  const output = runtime.prepareOutput('reply', input.chatId, { text: 'kept result' });
  assert.equal((await runtime.dispatchOutput(output)).state, 'pending');
  assert.deepEqual(calls, []);
  worker.state = 'connected';
  assert.equal((await runtime.dispatchOutput(runtime.store.output(output.id))).state, 'accepted');
  assert.deepEqual(calls, ['send']);
});

test('an aborted manager retains a prepared reply and missing receipts remain unknown', async t => {
  const { runtime, worker, calls, input } = runtimeFixture(t);
  await runtime.connect('bot');
  worker.send = async () => { calls.push('send'); return undefined; };
  assert.equal((await runtime.send('uncertain', input.chatId, { text: 'receipt unknown' })).state, 'unknown');
  await runtime.dispatchOutput(runtime.store.output('uncertain'));
  assert.deepEqual(calls, ['send']);
  const pending = runtime.prepareOutput('shutdown-reply', input.chatId, { text: 'kept' });
  runtime.controller.abort();
  assert.equal((await runtime.dispatchOutput(pending)).state, 'pending');
  assert.deepEqual(calls, ['send']);
});

test('a task mirror may await its result but whitespace is never dispatched as a platform message', async t => {
  const { runtime, calls, input } = runtimeFixture(t);
  await runtime.connect('bot');
  runtime.store.setSettings({ mirrorClientTurns: true });
  runtime.prepareOutput('mirror', input.chatId, { text: '' });
  runtime.store.deferTaskOutput('mirror', { role: 'assistant', mirrorGeneration: runtime.store.mirrorPublication().generation });
  assert.equal(runtime.store.output('mirror').state, 'awaiting_task');
  runtime.store.resolveTaskOutput('mirror', ' \n ');
  const output = await runtime.dispatchOutput(runtime.store.output('mirror'));
  assert.equal(output.state, 'failed');
  assert.equal(output.receipt.code, 'CHANNEL_TASK_MESSAGE_EMPTY');
  assert.deepEqual(calls, []);
});

test('setEnabled changes only its own column and preserves a concurrent connection rename', t => {
  const { root, store } = storage(t), peer = new ChannelStore(root);
  t.after(() => peer.close());
  const transaction = store.transaction.bind(store);
  let raced = false;
  store.transaction = operation => {
    if (!raced) { raced = true; peer.renameConnection('bot', 'Concurrent label', peer.connection('bot').revision); }
    return transaction(operation);
  };
  store.setEnabled('bot', true);
  assert.equal(peer.connection('bot').label, 'Concurrent label');
  assert.equal(peer.connection('bot').enabled, true);
  assert.equal(peer.connection('bot').revision, 3);
});

test('retirement cancels only work that has not started and preserves unknown receipts and history', t => {
  const { store } = storage(t), historical = store.receive('bot', event(), { historical: true });
  store.bind(historical.chatId, { serverId: 'local', threadId: 'original-task' });
  const pending = store.receive('bot', event('queued'));
  store.enqueueOutput('queued', historical.chatId, { content: { text: 'pending' } });
  store.enqueueOutput('uncertain', historical.chatId, { content: { text: 'unknown' } });
  store.claimOutput('uncertain'); store.settleOutput('uncertain', 'unknown', { code: 'LOST_RECEIPT' });
  store.removeConnection('bot', store.connection('bot').revision);
  assert.equal(store.inbox(pending.id).state, 'cancelled');
  assert.equal(store.inbox(historical.id).state, 'historical');
  assert.equal(store.output('queued').state, 'failed');
  assert.equal(store.output('uncertain').state, 'unknown');
  assert.deepEqual(store.pendingOutputs('bot'), []);
});

test('missing deferred output and missing recovered input are bounded no-ops', async t => {
  const { runtime } = runtimeFixture(t);
  assert.doesNotThrow(() => runtime.store.deferTaskOutput('absent', { role: 'assistant' }));
  await runtime.recover('absent');
});

test('published settings are verified against the complete intended merge before any write', t => {
  const root = directory(t), settings = new ChannelSettingsFile(root), path = join(root, 'settings.json');
  const original = '{"meta":{"config_version":2},"channels":{"tool_restrictions":{"enabled":true,"disabled_tools":["Old"]},"tool_restrictions":{"enabled":true,"disabled_tools":["Actual"]}},"other":{"kept":true}}';
  writeFileSync(path, original);
  assert.throws(() => settings.write({ toolRestrictions: { enabled: false, disabledTools: ['New'] } }), /CHANNEL_SETTINGS_MIGRATION_CONFLICT/);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('settings write returns its verified document without a post-publication read failure window', t => {
  const root = directory(t), settings = new ChannelSettingsFile(root);
  settings.read = () => { throw new Error('post-publish read must not run'); };
  assert.equal(settings.write({ mirrorClientTurns: true }).mirrorClientTurns, true);
});

test('preview text honors 1000-character requests, bounds legacy labels and never splits an emoji', t => {
  assert.equal(channelMessagePreview({ text: 'x'.repeat(800) }, 1000).text.length, 800);
  assert.equal(channelMessagePreview({ text: 'a'.repeat(159) + '😀' }, 160).text, 'a'.repeat(159));
  assert.throws(() => channelMessagePreview({ text: 'kept' }, -1), /CHANNEL_PREVIEW_LIMIT_INVALID/);
  const { store } = storage(t), input = store.receive('bot', event(), { historical: true });
  store.db.prepare('UPDATE chats SET label=? WHERE id=?').run('legacy'.repeat(10000), input.chatId);
  assert.ok(publicChannelChat(store, store.chat(input.chatId)).label.length <= 256);
});

test('one binding projection cannot mix two connection revisions', t => {
  const { root, store } = storage(t), peer = new ChannelStore(root);
  t.after(() => peer.close());
  const input = store.receive('bot', event(), { historical: true });
  store.bind(input.chatId, { serverId: 'local', threadId: 'first' });
  const binding = store.binding.bind(store);
  store.binding = id => {
    const previous = binding(id);
    peer.bind(id, { serverId: 'local', threadId: 'second' });
    return previous;
  };
  const projected = publicChannelChat(store, store.chat(input.chatId));
  assert.equal(projected.binding.revision, projected.bindingRevision);
});

test('import shape failures are coded, future historical time cannot pin live chat or refresh a reply window', t => {
  const { store } = storage(t);
  const base = { id: 'new', platform: 'qq', label: 'Imported', configuration: { appId: 'new-app' }, credentials: { appSecret: 'inert' } };
  assert.throws(() => importChannels(store, { version: 1, connections: [{ ...base, contexts: [null] }] }), /CHANNEL_IMPORT_CONTEXT_INVALID/);
  const future = Date.now() + 86400000;
  importChannels(store, { version: 1, connections: [{ ...base, chats: [{ event: { ...event('future'), occurredAtMs: future, receivedAtMs: future } }] }] });
  store.receive('new', { ...event('live'), receivedAtMs: Date.now(), text: 'current live input' });
  const chat = store.chats('new')[0];
  assert.equal(chat.lastEvent.text, 'current live input');
  assert.equal(store.inbox(store.db.prepare("SELECT id FROM inbox WHERE state='historical' AND chat_id=?").get(chat.id).id).event.receivedAtMs, null);
});

test('private import parsing cannot echo credentials or create a target on malformed JSON', t => {
  const root = directory(t), file = join(root, 'private.json'), target = join(root, 'not-created');
  writeFileSync(file, 'PRIVATE_CANARY_NOT_JSON', { mode: 0o600 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/channels/cli.mjs', import.meta.url)), 'import', '--root', target, '--file', file],
    { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /PRIVATE_CANARY/);
  assert.match(result.stderr, /CHANNEL_IMPORT_FILE_INVALID/);
  assert.equal(existsSync(target), false);
});

test('input identities isolate chats while old unknown input IDs retain their authoritative original receipt', t => {
  const { store } = storage(t);
  const first = store.receive('bot', { ...event('shared'), conversationId: 'first' });
  const second = store.receive('bot', { ...event('shared'), conversationId: 'second' });
  assert.equal(second.duplicate, false);
  assert.notEqual(first.id, second.id);
  const original = event('old-receipt');
  const chat = store.observeChat('bot', original), target = { serverId: 'local', threadId: 'original-task' };
  const binding = store.bind(chat.id, target);
  const legacyId = createHash('sha256').update(JSON.stringify(['bot', original.eventId])).digest('hex');
  store.db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?,?)')
    .run(legacyId, chat.id, JSON.stringify(original), 'unknown', JSON.stringify({ turnId: 'original-turn' }), JSON.stringify(target), binding.revision);
  store.unbind(chat.id); store.bind(chat.id, { serverId: 'local', threadId: 'replacement-task' });
  const repeated = store.receive('bot', { ...original, topicId: 'newly-observed-topic' });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.id, legacyId);
  assert.equal(repeated.state, 'unknown');
  assert.equal(repeated.target.threadId, 'original-task');
});

for (const change of ['configuration', 'credentials', 'rename-and-locale']) test(`startup pins SDK identity through its awaited authentication: ${change}`, async t => {
  const root = directory(t); let release, captured, stopped = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const worker = { state: 'starting', async start() { await gate; this.state = 'connected'; },
    async stop() { stopped++; this.state = 'stopped'; }, connectionState() { return this.state; }, async send() { assert.fail('no external send'); } };
  const runtime = new ChannelRuntime({ directory: root, tasks: { run: async () => ({}), recover: async () => ({ state: 'unknown' }) },
    workerFactory: (connection, credentials) => { captured = { connection, credentials }; return worker; } });
  t.after(() => runtime.close());
  runtime.store.saveConnection({ id: 'bot', platform: 'feishu', label: 'Original', configuration: { appId: 'original-app', locale: 'zh-CN' } }, { appSecret: 'original-private-fixture' });
  const peer = new ChannelStore(root); t.after(() => peer.close());
  const starting = runtime.connect('bot');
  assert.equal(captured.connection.configuration.appId, 'original-app');
  const current = peer.connection('bot');
  if (change === 'configuration') peer.saveConnection({ ...current, configuration: { ...current.configuration, appId: 'replacement-app' } }, undefined, current.revision);
  if (change === 'credentials') peer.saveConnection(current, { appSecret: 'replacement-private-fixture' }, current.revision);
  if (change === 'rename-and-locale') peer.saveConnection({ ...current, label: 'Renamed', configuration: { ...current.configuration, locale: 'en-US' } }, undefined, current.revision);
  release();
  if (change === 'rename-and-locale') {
    await starting;
    assert.equal(runtime.store.connection('bot').enabled, true);
    assert.equal(runtime.store.connection('bot').label, 'Renamed');
    assert.equal(runtime.store.connection('bot').configuration.locale, 'en-US');
    assert.equal(stopped, 0);
  } else {
    await assert.rejects(starting, /CHANNEL_CONNECTION_STATE_CHANGED/);
    assert.equal(stopped, 1);
    assert.equal(runtime.workers.has('bot'), false);
    assert.equal(runtime.store.connection('bot').enabled, false);
    if (change === 'configuration') assert.equal(runtime.store.connection('bot').configuration.appId, 'replacement-app');
    if (change === 'credentials') assert.equal(runtime.store.credentials('bot').appSecret, 'replacement-private-fixture');
  }
});

for (const platform of ['dingtalk', 'github']) for (const change of ['identity', 'credentials']) test(`${platform}: a frozen pending intent retains its original actor across ${change} replacement`, async t => {
  const root = directory(t), sentBy = [];
  const identity = platform === 'github' ? 'botLogin' : 'clientId', credential = platform === 'github' ? 'token' : 'clientSecret';
  const runtime = new ChannelRuntime({ directory: root, tasks: { run: async () => ({}), recover: async () => ({ state: 'unknown' }) },
    workerFactory: snapshot => ({ state: 'connected', async start() {}, async stop() { this.state = 'stopped'; },
      connectionState() { return this.state; }, async send(payload) {
        assert.equal(payload.destination.conversationId, platform === 'github' ? 'owner/repo' : 'shared-group');
        sentBy.push(snapshot.configuration[identity]); return { state: 'accepted' };
      } }),
  });
  t.after(() => runtime.close());
  runtime.store.saveConnection({ id: 'bot', platform, label: 'Original', configuration: { [identity]: 'actor-a',
    ...(platform === 'github' ? { repositories: ['owner/repo'] } : {}) } }, { [credential]: 'original-private-fixture' });
  await runtime.connect('bot');
  const input = runtime.store.receive('bot', { ...event(), platform, botId: 'actor-a', chatKind: 'group',
    conversationId: platform === 'github' ? 'owner/repo' : 'shared-group', ...(platform === 'github' ? { topicId: '1' } : {}) }, { historical: true });
  const binding = runtime.bind(input.chatId, { serverId: 'local', threadId: 'original-task' });
  const pending = runtime.prepareOutput('pending-a', input.chatId, { text: 'original result' }, { bindingRevision: binding.revision });
  for (const state of ['unknown', 'sending']) {
    runtime.store.enqueueOutput(state, input.chatId, pending.payload); runtime.store.claimOutput(state);
    if (state === 'unknown') runtime.store.settleOutput(state, 'unknown', { code: 'ORIGINAL_RECEIPT_UNKNOWN' });
  }
  await runtime.disconnect('bot');
  const current = runtime.store.connection('bot');
  runtime.store.saveConnection({ ...current, configuration: { ...current.configuration, [identity]: change === 'identity' ? 'actor-b' : 'actor-a' } },
    { [credential]: 'replacement-private-fixture' }, current.revision);
  await runtime.connect('bot');
  assert.equal(runtime.store.output('pending-a').payload.destination.botId, 'actor-a');
  assert.equal(runtime.store.output('unknown').state, 'unknown');
  assert.equal(runtime.store.output('sending').state, 'sending');
  if (change === 'identity') {
    assert.deepEqual(sentBy, []);
    assert.equal(runtime.store.output('pending-a').state, 'failed');
    assert.equal(runtime.store.output('pending-a').receipt.code, 'CHANNEL_OUTPUT_ACTOR_CHANGED');
  } else {
    assert.deepEqual(sentBy, ['actor-a']);
    assert.equal(runtime.store.output('pending-a').state, 'accepted');
  }
});

test('failed startup cleanup retains its owned worker and cannot create a replacement before termination confirms', async t => {
  const root = directory(t); let stopFails = true, factories = 0;
  const original = new Error('PLATFORM_AUTHORIZATION_FAILED');
  const failed = { async start() { throw original; }, async stop() { if (stopFails) throw new Error('CHANNEL_WORKER_EXIT_UNCONFIRMED'); }, connectionState: () => 'starting' };
  const ready = { async start() {}, async stop() {}, connectionState: () => 'connected', async send() {} };
  const runtime = new ChannelRuntime({ directory: root, tasks: { run: async () => ({}), recover: async () => ({ state: 'unknown' }) },
    workerFactory: () => ++factories === 1 ? failed : ready });
  t.after(() => runtime.close());
  runtime.store.saveConnection(connection, { appSecret: 'private-fixture' });
  await assert.rejects(runtime.connect('bot'), error => error === original);
  assert.equal(runtime.workers.has('bot'), false);
  assert.equal(runtime.failedWorkers.get('bot'), failed);
  await assert.rejects(runtime.connect('bot'), /CHANNEL_WORKER_EXIT_UNCONFIRMED/);
  assert.equal(factories, 1);
  stopFails = false;
  await runtime.connect('bot');
  assert.equal(runtime.failedWorkers.size, 0);
  assert.equal(factories, 2);
});

test('CLI bounds regular files before parsing and rejects FIFO input without blocking', { skip: process.platform !== 'linux' }, t => {
  const root = directory(t), source = join(root, 'oversized.json'), cli = fileURLToPath(new URL('../src/channels/cli.mjs', import.meta.url));
  writeFileSync(source, '', { mode: 0o600 }); truncateSync(source, 9 * 1024 * 1024);
  let result = spawnSync(process.execPath, [cli, 'import', '--root', join(root, 'unused'), '--file', source], { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /CHANNEL_IMPORT_TOO_LARGE/);
  const fifo = join(root, 'input.fifo');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 1000 }); assert.equal(made.status, 0, made.stderr);
  result = spawnSync(process.execPath, [cli, 'import', '--root', join(root, 'unused'), '--file', fifo], { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /CHANNEL_IMPORT_FILE_INVALID/);
  assert.equal(existsSync(join(root, 'unused')), false);
});

test('CLI accepts UTF-8 BOM input and reports its actual target without starting a listener', t => {
  const root = directory(t), source = join(root, 'private.json'), target = join(root, 'new-channel-store');
  const bundle = { version: 1, connections: [{ ...connection, credentials: { appSecret: 'private-fixture' } }] };
  writeFileSync(source, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(bundle))]), { mode: 0o600 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/channels/cli.mjs', import.meta.url)), 'import', '--root', target, '--file', source],
    { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.root, target); assert.equal(summary.listenersStarted, false); assert.equal(summary.imported[0].id, 'bot');
  assert.doesNotMatch(result.stdout, /private-fixture/);
});

test('two independent SQLite writers reserve reply sequences together with their output insertion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'channel-sequence-review-')), workers = [];
  let store;
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); store?.close(); rmSync(root, { recursive: true, force: true }); });
  store = new ChannelStore(root); store.saveConnection(connection, { appSecret: 'private-fixture' });
  const input = store.receive('bot', event(), { historical: true });
  const barrier = new SharedArrayBuffer(8), synchronization = new Int32Array(barrier);
  const script = `const { parentPort, workerData } = require('node:worker_threads');
  (async () => {
    const { ChannelRuntime } = await import(workerData.module);
    const runtime = new ChannelRuntime({ directory: workerData.root, tasks: { run: async () => ({}), recover: async () => ({state:'unknown'}) } });
    try {
      const synchronization = new Int32Array(workerData.barrier), count = runtime.store.replySequence.bind(runtime.store);
      runtime.store.replySequence = (...args) => {
        const result = count(...args); Atomics.add(synchronization, 1, 1); Atomics.notify(synchronization, 1);
        if (Atomics.load(synchronization, 1) === 1) Atomics.wait(synchronization, 1, 1, 150);
        return result;
      };
      parentPort.postMessage({ready:true}); Atomics.wait(synchronization, 0, 0, 5000);
      const result = runtime.prepareOutput('parallel-' + workerData.side, workerData.chatId, {text:'result'}, {event:workerData.event});
      parentPort.postMessage({sequence:result.payload.destination.replySequence});
    } finally { await runtime.close(); }
  })().catch(error => parentPort.postMessage({error:error.message}));`;
  const ready = [], results = [], exits = [];
  for (const side of [1, 2]) {
    const worker = new Worker(script, { eval: true, workerData: { module: new URL('../src/channels/runtime.mjs', import.meta.url).href,
      root, barrier, side, chatId: input.chatId, event: event() } });
    workers.push(worker);
    exits.push(new Promise((resolve, reject) => worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`owned sequence worker exited ${code}`)))));
    ready.push(new Promise((resolve, reject) => { worker.on('message', message => { if (message.ready) resolve(); if (message.error) reject(new Error(message.error)); }); worker.once('error', reject); }));
    results.push(new Promise((resolve, reject) => { worker.on('message', message => { if (message.sequence) resolve(message.sequence); if (message.error) reject(new Error(message.error)); }); worker.once('error', reject); }));
  }
  await Promise.all(ready); Atomics.store(synchronization, 0, 1); Atomics.notify(synchronization, 0, 2);
  assert.deepEqual((await Promise.all(results)).sort(), [1, 2]);
  await Promise.all(exits);
  store.enqueueOutput('root-reply', input.chatId, { destination: { replyMessageId: null }, content: { text: 'root' } });
  assert.equal(store.replySequence(input.chatId, null), 2);
});

test('portable facts project away nested authority envelopes and invalid public config never upgrades into a new row', t => {
  const { store } = storage(t), before = store.connections();
  const base = { id: 'new', platform: 'qq', label: 'Imported', configuration: { appId: 'new-app' }, credentials: { appSecret: 'private-fixture' } };
  for (const configuration of [{ appId: 'new-app', features: { apiToken: 'private' } }, { appId: 'new-app', intents: { authorization: 'private' } }]) {
    assert.throws(() => importChannels(store, { version: 1, connections: [{ ...base, configuration }] }));
    assert.deepEqual(store.connections(), before);
  }
  assert.throws(() => store.saveConnection({ id: 'bad-github', platform: 'github', label: 'Bad', configuration: { botLogin: 'bot', repositories: 'owner/repo', pollIntervalSeconds: 5 } }), /GITHUB_REPOSITORIES_INVALID/);
  const input = store.receive('bot', { ...event('projected'), raw: { accessToken: 'private' }, metadata: { grantRef: 'authority' },
    attachments: [{ kind: 'file', mediaId: 'opaque', filename: 'kept.txt', nested: { privateKey: 'private' } }] }, { historical: true });
  assert.equal(input.event.raw, undefined); assert.equal(input.event.metadata, undefined);
  assert.deepEqual(input.event.attachments, [{ kind: 'file', mediaId: 'opaque', filename: 'kept.txt' }]);
  assert.equal(input.event.text, 'input');
});

test('import has one aggregate record budget and platform reply context keeps its actual TTL policy', t => {
  const { store } = storage(t), context = { id: 'context', value: { text: 'private fixture' }, expiresAtMs: null };
  const entry = { id: 'one', platform: 'qq', label: 'One', configuration: { appId: 'one' }, credentials: { appSecret: 'private' }, contexts: Array(6000).fill(context) };
  assert.throws(() => importChannels(store, { version: 1, connections: [entry, { ...entry, id: 'two' }] }), /CHANNEL_IMPORT_CAPACITY/);
  assert.equal(store.connection('one'), null);
  importChannels(store, { version: 1, connections: [{ id: 'weixin', platform: 'weixin', label: 'Weixin', configuration: { accountId: 'fixture-account' },
    credentials: { botToken: 'private-fixture' }, contexts: [{ id: 'reply', value: { contextToken: 'private-reply', toUserId: 'recipient' }, expiresAtMs: 1 }] }] });
  assert.equal(store.context('weixin', 'reply').toUserId, 'recipient');
});

test('optional persistence details become SQL null without inventing a send receipt', t => {
  const { store } = storage(t), historical = store.receive('bot', event('historical'), { historical: true });
  store.bind(historical.chatId, { serverId: 'local', threadId: 'original-task' });
  const input = store.receive('bot', event('pending'));
  store.claimInput(input.id); store.recordAcceptance(input.id);
  store.settleInput(input.id, 'unknown'); assert.equal(store.inbox(input.id).result, null);
  store.recoverInput(input.id, 'completed'); assert.equal(store.inbox(input.id).state, 'completed');
  store.enqueueOutput('output', historical.chatId, { content: { text: 'kept' } });
  store.claimOutput('output'); store.settleOutput('output', 'unknown');
  assert.equal(store.output('output').receipt, null); assert.equal(store.output('output').state, 'unknown');
});

test('an empty display locale remains valid metadata without weakening platform identity validation', t => {
  const { store } = storage(t);
  const value = store.saveConnection({ id: 'localized', platform: 'feishu', label: 'Locale', configuration: { appId: 'identity', locale: '' } }, { appSecret: 'private-fixture' });
  assert.equal(value.configuration.locale, '');
  assert.throws(() => store.saveConnection({ id: 'invalid-identity', platform: 'feishu', label: 'Bad', configuration: { appId: ' ' } }), /CHANNEL_CONFIGURATION_INVALID/);
});

test('importing a bounded context never refreshes its absolute deadline while the clock advances', t => {
  const { store } = storage(t); let now = 1000;
  t.mock.method(Date, 'now', () => ++now);
  importChannels(store, { version: 1, connections: [{ id: 'deadline', platform: 'qq', label: 'Deadline', configuration: { appId: 'deadline' },
    credentials: { appSecret: 'private-fixture' }, contexts: [{ id: 'bounded', value: { text: 'private fixture' }, expiresAtMs: 1010 }] }] });
  assert.equal(store.db.prepare('SELECT expires_at FROM contexts WHERE connection_id=? AND id=?').get('deadline', 'bounded').expires_at, 1010);
});

test('settings directory replacement cannot redirect a settings save to a peer profile', { skip: process.platform === 'win32' }, t => {
  const root = directory(t), owned = join(root, 'owned'), peer = join(root, 'peer');
  mkdirSync(owned, { mode: 0o700 }); mkdirSync(peer, { mode: 0o700 });
  const original = '{"meta":{"config_version":2},"channels":{"mirror_client_turns":true}}';
  writeFileSync(join(peer, 'settings.json'), original, { mode: 0o600 });
  const settings = new ChannelSettingsFile(owned);
  renameSync(owned, owned + '.original'); symlinkSync(peer, owned, 'dir');
  assert.throws(() => settings.write({ mirrorClientTurns: false }), /CHANNEL_SETTINGS_DIRECTORY_INVALID/);
  assert.throws(() => new ChannelSettingsFile(join(root, 'missing')), /CHANNEL_SETTINGS_DIRECTORY_MISSING/);
  assert.equal(readFileSync(join(peer, 'settings.json'), 'utf8'), original);
});

test('settings read diagnostics distinguish concurrent change, oversized data and invalid files', t => {
  const root = directory(t), settings = new ChannelSettingsFile(root), lstat = fs.lstatSync;
  let currentCode = 'CONFIG_FILE_CHANGED';
  const mocked = t.mock.method(fs, 'lstatSync', (path, ...args) => {
    if (path === settings.path) throw Object.assign(new Error('controlled file diagnostic'), { code: currentCode });
    return lstat(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  for (const [source, expected] of [['CONFIG_FILE_CHANGED', 'CHANNEL_SETTINGS_CHANGED'], ['CONFIG_FILE_TOO_LARGE', 'CHANNEL_SETTINGS_FILE_TOO_LARGE'], ['CONFIG_FILE_INVALID', 'CHANNEL_SETTINGS_FILE_INVALID']]) {
    currentCode = source;
    assert.throws(() => settings.read(), error => error.message === expected);
  }
});
