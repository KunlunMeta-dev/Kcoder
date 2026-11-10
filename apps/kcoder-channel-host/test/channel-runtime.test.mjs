import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelRuntime } from '../src/channels/runtime.mjs';
import { ChannelStore } from '../src/channels/store.mjs';
import definitions from '../src/channel-platforms.json' with { type: 'json' };

const event = (id, chat = 'chat') => ({ platform: 'feishu', tenantId: 'tenant', botId: 'bot',
  chatKind: 'private', senderId: 'sender', conversationId: chat, eventId: id, text: id });
const target = { serverId: 'target', threadId: 'task' };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, runTask, { platform = 'feishu' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-runtime-'));
  const sends = [], workers = [];
  const runtime = new ChannelRuntime({ directory, tasks: { run: runTask, recover: async () => ({ state: 'unknown' }) }, workerFactory: () => {
    const worker = { async start(ingest) { worker.ingest = ingest; }, async stop() {},
      connectionState() { return 'connected'; },
      async send(payload, options) { sends.push({ payload, options }); return { state: 'accepted', messageId: 'platform-receipt' }; } };
    workers.push(worker); return worker;
  } });
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  runtime.store.saveConnection({ id: 'connection', platform, label: 'Fixture', configuration: platform === 'qq' ? { appId: 'fixture-bot' } : {} },
    { [definitions[platform].credentialField]: 'fixture' });
  return { runtime, sends, workers };
}
async function idle(runtime) { while (runtime.jobs.size) await Promise.all(runtime.jobs); }

for (const platform of Object.keys(definitions)) test(`${platform}: shared text routing deduplicates input, replies once and stops its worker (controlled SDK)`, async t => {
  const calls = [];
  const { runtime, workers, sends } = fixture(t, async input => { calls.push(input.id); return { text: 'one result' }; }, { platform });
  const known = runtime.store.receive('connection', { ...event('historical'), platform }, { historical: true });
  runtime.bind(known.chatId, target);
  await runtime.connect('connection');
  const input = { ...event('fresh'), platform };
  const first = workers[0].ingest(input);
  assert.equal(workers[0].ingest(input).duplicate, true);
  await idle(runtime);
  assert.deepEqual(calls, [first.inputId]);
  assert.equal(runtime.store.inbox(first.inputId).state, 'completed');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].payload.content.text, 'one result');
  assert.equal(sends[0].payload.destination.platform, platform);
  const media = workers[0].ingest({ ...input, eventId: 'unsupported-media', attachments: [{ kind: 'image', mediaId: 'fixture' }] });
  await idle(runtime);
  assert.equal(runtime.store.inbox(media.inputId).result.code, 'CHANNEL_ATTACHMENT_TRANSFER_UNAVAILABLE');
  assert.deepEqual(calls, [first.inputId], 'unsupported media never enters a task or a model request');
  assert.equal(sends.length, 1);
  await runtime.disconnect('connection');
  assert.equal(runtime.workers.size, 0);
  assert.equal(runtime.store.connection('connection').enabled, false);
  assert.throws(() => workers[0].ingest({ ...input, eventId: 'late' }), /CHANNEL_CONNECTION_STOPPED/);
});

for (const platform of ['feishu', 'qq', 'weixin']) test(`${platform}: unbound input gets one durable, rate-limited binding notice without task execution`, async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { runtime, workers, sends } = fixture(t, async () => assert.fail('Unbound input cannot execute a task'), { platform });
  await runtime.connect('connection');
  const input = { ...event('unbound-first'), platform, occurredAtMs: now, replyRef: 'original-reply-context' };
  const receipt = workers[0].ingest(input);
  assert.equal(receipt.state, 'unbound');
  assert.equal(runtime.store.output(`unbound-${receipt.inputId}`).state, 'pending', 'intent exists before SDK acknowledgement');
  assert.equal(workers[0].ingest(input).duplicate, true);
  workers[0].ingest({ ...input, eventId: 'unbound-burst' });
  await idle(runtime); assert.equal(sends.length, 1);
  const { destination, content } = sends[0].payload;
  assert.equal(destination.replyMessageId, input.eventId);
  assert.equal(destination.replyRef, input.replyRef);
  assert.equal(destination.conversationId, input.conversationId);
  if (platform === 'qq') assert.equal(destination.sendMode, 'reply');
  assert.match(content.text, /尚未绑定/); assert.match(content.text, /绑定通道/); assert.match(content.text, /重新发送/);
  assert.match(content.text, /Fixture/);
  workers[0].ingest({ ...input, eventId: 'another-chat', conversationId: 'another-chat' });
  await idle(runtime); assert.equal(sends.length, 2, 'another chat has an independent notice limit');
  now += 60001;
  workers[0].ingest({ ...input, eventId: 'after-limit', occurredAtMs: now });
  await idle(runtime); assert.equal(sends.length, 3);
  assert.equal(runtime.store.inbox(receipt.inputId).state, 'unbound');
});

test('binding before dispatch suppresses an old notice and never replays the unbound input', async t => {
  const calls = [];
  const { runtime, workers, sends } = fixture(t, async input => { calls.push(input.event.text); return { text: 'bound answer' }; });
  await runtime.connect('connection');
  const receipt = workers[0].ingest(event('before-binding'));
  runtime.bind(runtime.store.inbox(receipt.inputId).chatId, target);
  await idle(runtime);
  assert.equal(sends.length, 0); assert.deepEqual(calls, []);
  assert.equal(runtime.store.output(`unbound-${receipt.inputId}`).receipt.code, 'CHANNEL_BINDING_CHANGED');
  workers[0].ingest(event('after-binding')); await idle(runtime);
  assert.deepEqual(calls, ['after-binding']); assert.equal(sends[0].payload.content.text, 'bound answer');
  assert.equal(runtime.store.inbox(receipt.inputId).state, 'unbound');
});

test('a lost unbound notice receipt is not retried and notice failures never become task input', async t => {
  const { runtime, workers } = fixture(t, async () => assert.fail('No model task is allowed'));
  await runtime.connect('connection'); let attempts = 0;
  workers[0].send = async () => { attempts++; throw new Error('lost external receipt'); };
  const input = event('unbound-unknown'), receipt = workers[0].ingest(input);
  await idle(runtime);
  assert.equal(runtime.store.output(`unbound-${receipt.inputId}`).state, 'unknown');
  workers[0].ingest(input); workers[0].ingest(event('unbound-next'));
  await idle(runtime); assert.equal(attempts, 1);
  await runtime.disconnect('connection'); await runtime.connect('connection');
  assert.equal(attempts, 1);
});

test('unbound input and its notice roll back together if intent preparation fails', async t => {
  const { runtime, workers } = fixture(t, async () => assert.fail('No task execution'));
  await runtime.connect('connection'); const prepare = runtime.prepareOutput;
  runtime.prepareOutput = () => { throw new Error('controlled storage failure'); };
  assert.throws(() => workers[0].ingest(event('unbound-atomic')), /controlled storage failure/);
  assert.equal(runtime.store.db.prepare('SELECT count(*) AS n FROM inbox').get().n, 0);
  runtime.prepareOutput = prepare;
  const receipt = workers[0].ingest(event('unbound-atomic')); await idle(runtime);
  assert.equal(receipt.state, 'unbound'); assert.equal(receipt.duplicate, false);
});

test('unbound notices do not block SDK acknowledgement and expired pending notices are not sent on reconnect', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { runtime, workers, sends } = fixture(t, async () => assert.fail('No task execution'));
  await runtime.connect('connection');
  const sendGate = deferred(), sending = deferred();
  workers[0].send = async () => { sending.resolve(); await sendGate.promise; return {state: 'accepted'}; };
  const first = workers[0].ingest(event('unbound-slow'));
  assert.equal(first.state, 'unbound'); await sending.promise;
  assert.equal(runtime.store.output(`unbound-${first.inputId}`).state, 'sending');
  sendGate.resolve(); await idle(runtime);
  // A committed but not yet dispatched notice may be recovered only while still relevant.
  const second = runtime.store.transaction(() => {
    const input = runtime.store.receive('connection', {...event('offline-notice', 'other-chat'), receivedAtMs: now});
    runtime.prepareUnboundNotice(input); return input;
  });
  await runtime.disconnect('connection'); now += 60001; await runtime.connect('connection');
  assert.equal(sends.length, 0);
  assert.equal(runtime.store.output(`unbound-${second.id}`).receipt.code, 'CHANNEL_BINDING_NOTICE_EXPIRED');
});

test('SDK acknowledgement is durable and nonblocking; the bound original task produces one reply', async t => {
  const gate = deferred(), started = deferred(), calls = [];
  const { runtime, workers, sends } = fixture(t, async input => { calls.push(input); started.resolve(); await gate.promise; return { text: 'answer' }; });
  await runtime.connect('connection');
  const chat = runtime.store.observeChat('connection', event('authenticated-message'));
  runtime.bind(chat.id, target);
  const accepted = workers[0].ingest(event('new-message'));
  assert.equal(accepted.state, 'pending');
  assert.equal(runtime.store.inbox(accepted.inputId).event.text, 'new-message');
  await started.promise;
  assert.equal(sends.length, 0);
  assert.equal(workers[0].ingest(event('new-message')).duplicate, true);
  gate.resolve(); await idle(runtime);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target, target);
  assert.equal(sends.length, 1);
  assert.equal(runtime.store.output(`reply-${accepted.inputId}`).receipt.messageId, 'platform-receipt');
});

test('queued inputs retain the original binding and cannot follow an unbind/rebind', async t => {
  const gate = deferred(), started = deferred(), executed = [];
  const { runtime, workers, sends } = fixture(t, async input => { executed.push(input.event.text); started.resolve(); await gate.promise; return { text: 'old result' }; });
  await runtime.connect('connection');
  const chat = runtime.store.observeChat('connection', event('known'));
  const original = runtime.bind(chat.id, target);
  const first = workers[0].ingest(event('first'));
  await started.promise;
  const queued = workers[0].ingest(event('second'));
  runtime.unbind(chat.id);
  const replacement = runtime.bind(chat.id, target);
  assert.ok(replacement.revision > original.revision);
  gate.resolve(); await idle(runtime);
  assert.deepEqual(executed, ['first']);
  assert.equal(sends.length, 0);
  assert.equal(runtime.store.inbox(first.inputId).state, 'completed');
  assert.equal(runtime.store.inbox(queued.inputId).state, 'cancelled');
});

test('two chats bound to the same task share its input ordering', async t => {
  const gate = deferred(), started = deferred(), calls = [];
  const { runtime, workers } = fixture(t, async input => {
    calls.push(input.event.text);
    if (input.event.text === 'first') { started.resolve(); await gate.promise; }
    return { text: 'result' };
  });
  await runtime.connect('connection');
  for (const id of ['one', 'two']) runtime.bind(runtime.store.observeChat('connection', event('known', id)).id, target);
  workers[0].ingest(event('first', 'one')); await started.promise;
  workers[0].ingest(event('second', 'two'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['first']); gate.resolve(); await idle(runtime);
  assert.deepEqual(calls, ['first', 'second']);
});

test('a lost platform response remains unknown and the original delivery is never resent', async t => {
  const { runtime, workers } = fixture(t, async () => ({ text: 'unused' }));
  await runtime.connect('connection');
  let attempts = 0;
  workers[0].send = async () => { attempts++; throw new Error('response lost'); };
  const chat = runtime.store.observeChat('connection', event('known'));
  assert.equal((await runtime.send('delivery', chat.id, { text: 'test' })).state, 'unknown');
  assert.equal((await runtime.send('delivery', chat.id, { text: 'test' })).state, 'unknown');
  assert.equal(attempts, 1);
});

test('a running original receipt is revisited after startup without another task submission', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let submissions = 0, recoveries = 0;
  const { runtime, workers, sends } = fixture(t, async () => { submissions++; throw new Error('lost task response'); });
  runtime.tasks.recover = async () => ++recoveries === 1 ? { state: 'unknown' } : { state: 'completed', text: 'original result' };
  await runtime.connect('connection');
  const chat = runtime.store.observeChat('connection', event('known')); runtime.bind(chat.id, target);
  const accepted = workers[0].ingest(event('new'));
  await idle(runtime); assert.equal(runtime.store.inbox(accepted.inputId).state, 'unknown');
  await runtime.start(); await idle(runtime);
  assert.equal(runtime.store.inbox(accepted.inputId).state, 'unknown'); assert.equal(sends.length, 0);
  t.mock.timers.tick(5000); await idle(runtime);
  assert.equal(runtime.store.inbox(accepted.inputId).state, 'completed');
  assert.equal(submissions, 1); assert.equal(recoveries, 2); assert.equal(sends.length, 1);
});

test('a definitely rejected task is distinct from a lost task acceptance', async t => {
  const { runtime, workers } = fixture(t, async input => {
    throw Object.assign(new Error('TASK_REJECTED'), { accepted: input.event.text !== 'rejected' });
  });
  await runtime.connect('connection');
  const chat = runtime.store.observeChat('connection', event('known')); runtime.bind(chat.id, target);
  const rejected = workers[0].ingest(event('rejected')), unknown = workers[0].ingest(event('unknown'));
  await idle(runtime);
  assert.equal(runtime.store.inbox(rejected.inputId).state, 'failed');
  assert.equal(runtime.store.inbox(unknown.inputId).state, 'unknown');
});

test('a completed task and its reply intent survive interruption before platform dispatch', async t => {
  let calls = 0;
  const { runtime, workers, sends } = fixture(t, async () => { calls++; return { text: 'durable answer' }; });
  await runtime.connect('connection');
  const chat = runtime.store.observeChat('connection', event('known')); runtime.bind(chat.id, target);
  const dispatch = runtime.dispatchOutput;
  runtime.dispatchOutput = async () => { throw new Error('interrupted after commit'); };
  const receipt = workers[0].ingest(event('new'));
  await idle(runtime);
  assert.equal(runtime.store.inbox(receipt.inputId).state, 'completed');
  assert.equal(runtime.store.output(`reply-${receipt.inputId}`).state, 'pending');
  await runtime.disconnect('connection');
  runtime.dispatchOutput = dispatch;
  await runtime.connect('connection');
  assert.equal(calls, 1); assert.equal(sends.length, 1);
  assert.equal(sends[0].payload.content.text, 'durable answer');
});

test('an offline reply is retained but cannot follow a changed binding on reconnect', async t => {
  const { runtime, sends } = fixture(t, async () => ({ text: 'unused' }));
  const chat = runtime.store.observeChat('connection', event('known'));
  const original = runtime.bind(chat.id, target);
  const pending = await runtime.send('offline', chat.id, { text: 'old reply' }, { bindingRevision: original.revision });
  assert.equal(pending.state, 'pending');
  runtime.unbind(chat.id); runtime.bind(chat.id, target);
  await runtime.connect('connection');
  assert.equal(sends.length, 0);
  assert.equal(runtime.store.output('offline').receipt.code, 'CHANNEL_BINDING_CHANGED');
});

test('manager restart marks an interrupted external send unknown without replaying it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-runtime-restart-'));
  let runtime, sends = 0;
  const options = { directory, tasks: { run: async () => assert.fail('No task replay'), recover: async () => assert.fail('No input recovery') },
    workerFactory: () => ({ start: async () => {}, stop: async () => {}, connectionState: () => 'connected',
      send: async () => { sends++; assert.fail('An unknown send cannot be replayed'); } }) };
  t.after(async () => { await runtime?.close(); rmSync(directory, { recursive: true, force: true }); });
  runtime = new ChannelRuntime(options);
  runtime.store.saveConnection({ id: 'connection', platform: 'feishu', label: 'Fixture' }, { appSecret: 'fixture' });
  await runtime.connect('connection');
  const chat = runtime.store.observeChat('connection', event('known'));
  runtime.prepareOutput('interrupted', chat.id, { text: 'already attempted' });
  assert.equal(runtime.store.claimOutput('interrupted'), true);
  const reader = new ChannelStore(directory);
  assert.equal(reader.output('interrupted').state, 'sending', 'SDK store readers must not settle active sends');
  reader.close();
  await runtime.close();
  runtime = new ChannelRuntime(options);
  await runtime.start();
  assert.equal(runtime.store.output('interrupted').state, 'unknown');
  assert.equal(runtime.store.output('interrupted').receipt.code, 'CHANNEL_MANAGER_RESTARTED');
  assert.equal((await runtime.send('interrupted', chat.id, { text: 'already attempted' })).state, 'unknown');
  assert.equal(sends, 0);
});


test('QQ freezes proactive sends for old conversations and passive replies for fresh messages', async t => {
  const { runtime } = fixture(t, async () => ({ text: 'answer' }), { platform: 'qq' });
  const observed = { ...event('old-qq'), platform: 'qq', botId: 'fixture-bot',
    occurredAtMs: Date.now() - 2 * 60 * 60_000, receivedAtMs: Date.now() - 2 * 60 * 60_000 };
  const chat = runtime.store.observeChat('connection', observed);
  const push = runtime.prepareOutput('push', chat.id, { text: 'proactive' });
  assert.equal(push.payload.destination.sendMode, 'proactive');
  assert.equal(push.payload.destination.replyMessageId, 'old-qq');
  const fresh = { ...observed, eventId: 'fresh-qq', occurredAtMs: Date.now(), receivedAtMs: Date.now() };
  const reply = runtime.prepareOutput('reply', chat.id, { text: 'reply' }, { event: fresh });
  assert.equal(reply.payload.destination.sendMode, 'reply');
  assert.equal(reply.payload.destination.replyMessageId, 'fresh-qq');
  const reread = runtime.prepareOutput('reply', chat.id, { text: 'reply' }, { event: observed });
  assert.equal(reread.payload.destination.sendMode, 'reply');
  assert.equal(reread.payload.destination.replyMessageId, 'fresh-qq');
});

test('QQ platform rejection does not fall back from a reply to a second proactive send', async t => {
  const { runtime, workers, sends } = fixture(t, async () => ({ text: 'answer' }), { platform: 'qq' });
  await runtime.connect('connection');
  const chat = runtime.store.observeChat('connection', { ...event('fresh'), platform: 'qq', botId: 'fixture-bot', occurredAtMs: Date.now() });
  workers[0].send = async (payload) => { sends.push(payload); const error = new Error('PLATFORM_REJECTED'); error.externalOutcome = 'failed'; throw error; };
  const output = runtime.prepareOutput('single-attempt', chat.id, { text: 'one message' });
  await runtime.dispatchOutput(output); await runtime.dispatchOutput(runtime.store.output(output.id));
  assert.equal(sends.length, 1); assert.equal(runtime.store.output(output.id).state, 'failed');
});


test('each channel dispatch receives one effective restriction snapshot', async t => {
  const calls = [];
  const { runtime, workers } = fixture(t, async input => { calls.push(input.toolRestrictions); return { text: 'done' }; });
  const known = runtime.store.receive('connection', event('historical'), { historical: true });
  runtime.bind(known.chatId, target);
  await runtime.connect('connection');
  runtime.store.setSettings({ toolRestrictions: { enabled: true, disabledTools: ['AskUserQuestion'] } });
  workers[0].ingest(event('first-policy'));
  await idle(runtime);
  runtime.store.setSettings({ toolRestrictions: { enabled: false, disabledTools: ['WebSearch'] } });
  workers[0].ingest(event('second-policy'));
  await idle(runtime);
  assert.deepEqual(calls, [{ enabled: true, disabledTools: ['AskUserQuestion'] }, { enabled: false, disabledTools: ['WebSearch'] }]);
});
