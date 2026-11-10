import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelTaskClient } from '../src/channel-task-client.mjs';

test('only explicit read-only workspace ownership errors become a binding mismatch diagnostic', async t => {
  for (const [method, message, expected] of [
    ['thread/read', 'persisted thread belongs to another workspace', 'CHANNEL_TASK_WORKSPACE_MISMATCH'],
    ['thread/read', 'thread metadata belongs to another workspace', 'CHANNEL_TASK_WORKSPACE_MISMATCH'],
    ['thread/read', 'persisted thread not found: private-thread', 'CHANNEL_TASK_REJECTED'],
    ['turn/start', 'persisted thread belongs to another workspace', 'CHANNEL_TASK_REJECTED'],
  ]) {
    const client = new ChannelTaskClient({ attach() {}, detach() {}, receive(peer, raw) {
      peer.send({ id: JSON.parse(raw).id, error: { code: -32021, message } });
    } });
    t.after(() => client.close());
    await assert.rejects(client.request(method, {}), error => error.code === expected && error.message === expected);
  }
});

function fixture(t, { supported = true, lostReply = false } = {}) {
  const requests = [], clients = new Set(); let starts = 0;
  const broker = { attach: client => clients.add(client), detach: client => clients.delete(client),
    receive(client, raw) {
      const request = JSON.parse(raw); requests.push(request);
      const respond = result => client.send({ id: request.id, result });
      if (request.method === 'initialize') respond({ capabilities: { experimental: { unattendedTurnsV1: supported, channelToolRestrictionsV1: supported } } });
      else if (request.method === 'thread/resume') respond({ thread: { id: 'original' } });
      else if (request.method === 'gateway/thread/attach') respond({ changed: true });
      else if (request.method === 'turn/start') {
        starts++;
        if (lostReply) { queueMicrotask(() => client.close()); return; }
        client.send({ method: 'item/completed', params: { threadId: 'original', turnId: 'one',
          item: { type: 'agentMessage', content: { text: 'not authoritative notification' } } } });
        client.send({ method: 'turn/completed', params: { threadId: 'original', turnId: 'one',
          turn: { id: 'one', status: 'completed', attemptId: 'attempt' } } });
        respond({ turn: { id: 'one', threadId: 'original' } });
      } else if (request.method === 'turn/receipt/read') respond({ receipt: { threadId: 'original', turnId: 'one', attemptId: 'attempt', status: 'completed' } });
      else if (request.method === 'thread/read') respond({ hasMoreBefore: false, messages: [
        { role: 'assistant', turnId: 'older', attemptId: 'attempt', content: 'unrelated' },
        { role: 'assistant', turnId: 'one', attemptId: 'earlier-attempt', content: 'failed output' },
        { role: 'assistant', turnId: 'one', attemptId: 'attempt', content: 'canonical result' },
      ] });
      else throw new Error(`Unexpected method ${request.method}`);
    } };
  const client = new ChannelTaskClient(broker); t.after(() => client.close());
  return { client, broker, requests, starts: () => starts, clients };
}
const input = () => ({ toolRestrictions: { enabled: true, disabledTools: ['AskUserQuestion', 'AskUserQuestionAsync'] }, id: 'durable-input', target: { serverId: 'local', threadId: 'original' },
  event: { text: 'new platform message' }, signal: new AbortController().signal });

test('channel input uses ordinary task RPC with turn-local unattended policy and canonical result', async t => {
  const { client, requests, starts } = fixture(t);
  const accepted = [];
  const result = await client.run({ ...input(), onAccepted: receipt => accepted.push(receipt) });
  assert.equal(result.text, 'canonical result');
  assert.equal(result.turnId, 'one'); assert.equal(accepted.length, 1); assert.equal(starts(), 1);
  const turn = requests.find(request => request.method === 'turn/start').params;
  assert.equal(turn.threadId, 'original'); assert.equal(turn.unattended, true);
  assert.equal(turn.asyncUserQuestions, undefined);
  assert.equal(turn.channelToolRestrictions.enabled, true);
  assert.ok(turn.channelToolRestrictions.disabledTools.includes('AskUserQuestion'));
  assert.equal(turn.permissionMode, undefined, 'the task permission configuration must not be overwritten');
  assert.equal(requests.some(request => request.method.startsWith('integrations/')), false);
});

test('an older backend is rejected before any channel input is submitted', async t => {
  const { client, starts } = fixture(t, { supported: false });
  await assert.rejects(client.run(input()), /CHANNEL_TASK_BACKEND_UPDATE_REQUIRED/);
  assert.equal(starts(), 0);
});

test('lost acceptance is reconciled by the original receipt without another turn/start', async t => {
  const { client, broker, starts, clients } = fixture(t, { lostReply: true });
  await assert.rejects(client.run(input()), /CHANNEL_TASK_DISCONNECTED/);
  assert.equal(clients.size, 0);
  const recovered = new ChannelTaskClient(broker); t.after(() => recovered.close());
  const before = broker.receive;
  broker.receive = (owner, raw) => {
    if (owner === recovered.client) assert.notEqual(JSON.parse(raw).method, 'thread/resume', 'receipt recovery must not resume a stopped task');
    return before(owner, raw);
  };
  const result = await recovered.recover(input());
  assert.equal(result.state, 'completed'); assert.equal(result.text, 'canonical result');
  assert.equal(starts(), 1);
});

test('reply lookup stops at the original turn input without scanning older task history', async t => {
  const { client, broker, requests } = fixture(t);
  const receive = broker.receive;
  broker.receive = (owner, raw) => {
    const request = JSON.parse(raw);
    if (request.method !== 'thread/read') return receive(owner, raw);
    requests.push(request);
    owner.send({ id: request.id, result: { hasMoreBefore: true, beforeCursor: 'unrelated-older-history', messages: [
      { role: 'user', turnId: 'one', content: 'original input' },
      { role: 'assistant', turnId: 'one', attemptId: 'attempt', content: 'bounded reply' },
    ] } });
  };
  assert.equal((await client.run(input())).text, 'bounded reply');
  assert.equal(requests.filter(request => request.method === 'thread/read').length, 1);
});

test('web mirroring reads the original user and completed attempt through the ordinary receipt', async t => {
  const { client, broker, requests } = fixture(t);
  const receive = broker.receive;
  broker.receive = (owner, raw) => {
    const request = JSON.parse(raw);
    if (request.method !== 'thread/read') return receive(owner, raw);
    requests.push(request);
    owner.send({ id: request.id, result: { hasMoreBefore: true, beforeCursor: 'older', messages: [
      { role: 'user', turnId: 'one', clientMessageId: 'original-browser-input', content: 'canonical input' },
      { role: 'assistant', turnId: 'one', attemptId: 'earlier-attempt', content: 'failed attempt text' },
      { role: 'assistant', turnId: 'one', attemptId: 'attempt', content: 'canonical answer' },
    ] } });
  };
  const result = await client.readTurn({ target: { threadId: 'original' }, turnId: 'one', attemptId: 'attempt' });
  assert.deepEqual(result, { state: 'completed', user: 'canonical input', assistant: 'canonical answer' });
  assert.equal(requests.find(row => row.method === 'turn/receipt/read').params.clientMessageId, 'original-browser-input');
  assert.equal(requests.filter(row => row.method === 'thread/read').length, 1);
});

test('visible assistant text alone cannot complete a pending mirror without its original input identity', async t => {
  const { client, requests } = fixture(t);
  assert.deepEqual(await client.readTurn({ target: { threadId: 'original' }, turnId: 'one' }), { state: 'unknown' });
  assert.equal(requests.some(row => row.method === 'turn/start'), false);
});


test('configured channel restrictions travel with the turn without overriding task permissions', async t => {
  const { client, requests } = fixture(t);
  await client.run({ ...input(), toolRestrictions: { enabled: false, disabledTools: ['AskUserQuestion'] } });
  const turn = requests.find(request => request.method === 'turn/start').params;
  assert.deepEqual(turn.channelToolRestrictions, { enabled: false, disabledTools: ['AskUserQuestion'] });
  assert.equal(turn.permissionMode, undefined);
});

test('unattended support alone cannot silently ignore configured restrictions', async t => {
  const { client, broker, starts } = fixture(t);
  const receive = broker.receive;
  broker.receive = (peer, raw) => {
    const request = JSON.parse(raw);
    if (request.method === 'initialize') peer.send({ id: request.id, result: { capabilities: { experimental: { unattendedTurnsV1: true } } } });
    else receive(peer, raw);
  };
  await assert.rejects(client.run(input()), /CHANNEL_TASK_BACKEND_UPDATE_REQUIRED/);
  assert.equal(starts(), 0);
});
