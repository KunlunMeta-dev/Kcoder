import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from './workspace-app-server-broker.js';
import { projectPeerMessageHistory, allowsPeerMessageNotification } from './broker-peer-message-compat.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const digest = 'a'.repeat(64);
const peer = Object.freeze({ id: 'peer-history', role: 'peer_agent', origin: 'peer_agent', content: 'A peer input', timestampMs: 1 });
const user = Object.freeze({ id: 'user-history', role: 'user', content: 'A user request', timestampMs: 1 });
const assistant = Object.freeze({ id: 'assistant-history', role: 'assistant',
  content: 'Assistant reply to a peer_agent; text can also mention peerAgentMessage.', timestampMs: 2 });
const page = () => ({ messages: [user, peer, assistant], rangeStart: 7, rangeEnd: 10, hasMoreBefore: true,
  beforeCursor: `tp1:ob1-${digest}:7`, transcriptSnapshotV1: { status: 'available', snapshotId: digest, viewKey: digest },
  transcriptObservationV1: { observationId: digest, viewKey: digest } });

function fixture(t, backendPeer = true) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true, serverId: 'peer-wire-compat', maxMessageBytes: 1024 * 1024,
    adapter: { rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => { broker.clearTransientState(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const requests = [];
  child.stdin.on('data', bytes => requests.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const emit = async message => { child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); await tick(); };
  const client = () => {
    const value = { channel: 'runtime', messages: [], send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value); return value;
  };
  const request = async (owner, id, method, params) => {
    const count = requests.length;
    broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    await tick(); return requests.length > count ? requests.at(-1) : null;
  };
  const initialize = (owner, id, choice) => request(owner, id, 'initialize', {
    protocolVersion: '2026-07-27', clientInfo: { name: 'owned-peer-compat-client', version: '1' },
    capabilities: { experimental: { gatewaySharedThreadsV1: true, threadTranscriptSnapshotV1: true, threadTranscriptObservationV1: true,
      ...(choice === undefined ? {} : { peerAgentMessagesV1: choice }), crossSessionDiscoveryV1: true, crossSessionMessagesV1: true } },
  });
  const ready = request => emit({ id: request.id, result: { protocolVersion: '2026-07-27', capabilities: { experimental: {
    residentThreads: true, peerAgentMessagesV1: backendPeer, crossSessionDiscoveryV1: true, crossSessionMessagesV1: true,
    threadTranscriptSnapshotV1: true, threadTranscriptObservationV1: true,
  } } } });
  const resume = async (owner, id, threadId, historyPage = page()) => {
    const pending = await request(owner, id, 'thread/resume', { threadId });
    await emit({ id: pending.id, result: { thread: { id: threadId }, history: { status: 'ready', page: historyPage } } });
    return owner.messages.find(message => message.id === id);
  };
  return { broker, child, requests, emit, client, request, initialize, ready, resume };
}

test('typed peer projection never interprets body text or mutates a modern shared response', () => {
  const input = Object.freeze({ result: Object.freeze({ ...page(), messages: Object.freeze([user, peer, assistant]) }) });
  assert.equal(projectPeerMessageHistory(input, 'thread/read', true), input);
  const old = projectPeerMessageHistory(input, 'thread/read', false);
  assert.deepEqual(old.result.messages, [user, assistant]);
  assert.equal(input.result.messages.length, 3);
  assert.equal(old.result.rangeStart, 7); assert.equal(old.result.rangeEnd, 10);
  assert.equal(old.result.beforeCursor, '7');
  assert.equal(old.result.transcriptSnapshotV1, undefined); assert.equal(old.result.transcriptObservationV1, undefined);
  const ordinary = { result: { messages: [user, assistant] } };
  assert.equal(projectPeerMessageHistory(ordinary, 'thread/read', false), ordinary);
  assert.equal(allowsPeerMessageNotification({ method: 'item/completed', params: { item: { type: 'assistantMessage', text: 'peer_agent' } } }, false), true);
  for (const marker of [{ role: 'peer_agent' }, { origin: 'peer_agent' }, { type: 'peerAgentMessage' }]) {
    assert.equal(allowsPeerMessageNotification({ method: 'item/completed', params: { item: marker } }, false), false);
    assert.equal(allowsPeerMessageNotification({ method: 'item/completed', params: { item: marker } }, true), true);
  }
});

for (const first of ['legacy', 'modern']) test(`mixed clients use their own initialize agreement when ${first} initializes the backend first`, async t => {
  const f = fixture(t), legacy = f.client(), modern = f.client();
  const initial = first === 'legacy' ? await f.initialize(legacy, 'init-old', undefined) : await f.initialize(modern, 'init-new', true);
  assert.equal(initial.params.capabilities.experimental.peerAgentMessagesV1, true);
  await f.ready(initial);
  if (first === 'legacy') await f.initialize(modern, 'init-new', true); else await f.initialize(legacy, 'init-old', undefined);
  assert.equal(legacy.messages.find(message => message.id === 'init-old').result.capabilities.experimental.peerAgentMessagesV1, false);
  assert.equal(modern.messages.find(message => message.id === 'init-new').result.capabilities.experimental.peerAgentMessagesV1, true);
  await f.resume(legacy, 'resume-old', 'shared-thread');
  const currentResume = await f.resume(modern, 'resume-new', 'shared-thread');
  assert.deepEqual(currentResume.result.history.page.messages, [user, peer, assistant]);
  assert.deepEqual(legacy.messages.find(message => message.id === 'resume-old').result.history.page.messages, [user, assistant]);
  for (const method of ['thread/read', 'thread/read/indexed']) {
    for (const [owner, suffix, expected] of [[legacy, 'old', [user, assistant]], [modern, 'new', [user, peer, assistant]]]) {
      const id = method + suffix;
      const pending = await f.request(owner, id, method, { threadId: 'shared-thread', limit: 10 });
      await f.emit({ id: pending.id, result: { thread: { id: 'shared-thread' }, ...page() } });
      const result = owner.messages.find(message => message.id === id).result;
      assert.deepEqual(result.messages, expected);
      assert.equal(result.rangeStart, 7); assert.equal(result.rangeEnd, 10); assert.equal(result.hasMoreBefore, true);
      assert.equal(result.beforeCursor, owner === legacy ? '7' : page().beforeCursor);
      assert.equal(Boolean(result.transcriptSnapshotV1), owner === modern);
      assert.equal(Boolean(result.transcriptObservationV1), owner === modern);
    }
  }
  const peerEvent = { method: 'item/completed', params: { threadId: 'shared-thread',
    item: { id: 'peer-live', type: 'peerAgentMessage', role: 'peer_agent', origin: 'peer_agent', text: 'peer live body' } } };
  await f.emit(peerEvent);
  assert.equal(legacy.messages.some(message => message.params?.item?.id === 'peer-live'), false);
  assert.equal(modern.messages.filter(message => message.params?.item?.id === 'peer-live').length, 1);
  await f.emit({ method: 'item/completed', params: { threadId: 'shared-thread',
    item: { id: 'assistant-live', type: 'assistantMessage', text: 'A normal assistant reply caused by a peer.' } } });
  for (const owner of [legacy, modern]) assert.equal(owner.messages.filter(message => message.params?.item?.id === 'assistant-live').length, 1);
  // This is the old renderer's unsafe non-user fallback. No peer row reaches it.
  const oldRows = legacy.messages.find(message => message.id === 'resume-old').result.history.page.messages;
  assert.deepEqual(oldRows.map(row => ({ id: row.id, displayRole: row.role === 'user' ? 'user' : 'assistant' })),
    [{ id: user.id, displayRole: 'user' }, { id: assistant.id, displayRole: 'assistant' }]);
});

test('resume notification handoff applies the same peer filter after ownership commits', async t => {
  const f = fixture(t), legacy = f.client();
  await f.ready(await f.initialize(legacy, 'init-old', false));
  const request = await f.request(legacy, 'pending-resume', 'thread/resume', { threadId: 'handoff-thread' });
  await f.emit({ method: 'item/completed', params: { threadId: 'handoff-thread', item: { id: 'held-peer', type: 'peerAgentMessage', text: 'input' } } });
  await f.emit({ method: 'item/completed', params: { threadId: 'handoff-thread', item: { id: 'held-assistant', type: 'assistantMessage', text: 'reply' } } });
  assert.equal(legacy.messages.some(message => message.params?.item), false);
  await f.emit({ id: request.id, result: { thread: { id: 'handoff-thread' }, history: { status: 'ready', page: page() } } });
  assert.equal(legacy.messages.some(message => message.params?.item?.id === 'held-peer'), false);
  assert.equal(legacy.messages.filter(message => message.params?.item?.id === 'held-assistant').length, 1);
});

test('requested peer support without Native agreement cannot enable receiving, and reattachment resets the agreement', async t => {
  const f = fixture(t, false), client = f.client();
  await f.ready(await f.initialize(client, 'init-unsupported', true));
  assert.equal(client.messages.find(message => message.id === 'init-unsupported').result.capabilities.experimental.peerAgentMessagesV1, false);
  await f.resume(client, 'resume', 'thread');
  assert.deepEqual(client.messages.find(message => message.id === 'resume').result.history.page.messages, [user, assistant]);
  f.broker.sendServerNotification(client, { method: 'item/completed', params: { item: { id: 'unsupported', role: 'peer_agent' } } });
  assert.equal(client.messages.some(message => message.params?.item?.id === 'unsupported'), false);
  client.peerAgentMessagesNegotiatedV1 = true;
  f.broker.detach(client); f.broker.attach(client);
  assert.equal(client.peerAgentMessagesNegotiatedV1, false);
});
