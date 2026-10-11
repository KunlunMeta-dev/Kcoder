import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function brokerFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({
    child,
    adapter: {
      rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }),
    },
    maxMessageBytes: 1024 * 1024,
    serverId: 'resume-review',
    residentThreads: true,
  });
  const upstream = [];
  let pending = '';
  child.stdin.on('data', chunk => {
    pending += chunk.toString('utf8');
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      upstream.push(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
    }
  });
  const client = authorizationOwner => {
    const value = {
      channel: 'runtime', authorizationOwner, initialized: true, messages: [],
      send(message) { this.messages.push(message); return true; },
      pause() {}, resume() {}, close() {},
    };
    broker.attach(value);
    value.initialized = true;
    return value;
  };
  const request = async (owner, message) => {
    broker.receive(owner, JSON.stringify(message));
    await new Promise(resolve => setImmediate(resolve));
    return upstream.at(-1);
  };
  const fromAppServer = async message => {
    child.stdout.write(`${JSON.stringify(message)}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  return { broker, child, upstream, client, request, fromAppServer };
}

test('resume history variants pass through with the original request id and one private thread owner', async t => {
  const cases = [
    ['ready', { status: 'ready', page: {
      messages: [{ id: 'm-1', role: 'assistant', content: 'ready' }],
      rangeStart: 3, rangeEnd: 4, hasMoreBefore: true, beforeCursor: 'tp1:opaque',
    } }],
    ['unavailable', { status: 'unavailable', code: 'responseBudgetExceeded' }],
    ['omitted', undefined],
  ];

  for (const [label, history] of cases) await t.test(label, async () => {
    const f = brokerFixture();
    const owner = f.client('family-a');
    const other = f.client('family-b');
    const threadId = `resume-${label}`;
    const clientRequestId = `mobile-${label}-request`;
    const upstreamRequest = await f.request(owner, {
      jsonrpc: '2.0', id: clientRequestId, method: 'thread/resume',
      params: { threadId, history: { limit: 50, indexed: true } },
    });
    assert.equal(upstreamRequest.method, 'thread/resume');
    assert.notEqual(upstreamRequest.id, clientRequestId, 'the broker assigns its own upstream correlation id');

    const thread = { id: threadId, cwd: '/workspace/example' };
    const result = { thread, ...(history === undefined ? {} : { history }) };
    await f.fromAppServer({ jsonrpc: '2.0', id: upstreamRequest.id, result });
    assert.deepEqual(owner.messages.at(-1), {
      jsonrpc: '2.0', id: clientRequestId, result,
    }, 'the client id and optional history outcome are restored without projection loss');
    const responseIndex = owner.messages.findIndex(message => message.id === clientRequestId);
    assert.notEqual(responseIndex, -1);
    assert.equal(f.broker.threadOwners.get(threadId), owner, 'ownership commits only after successful resume');

    const beforeRejectedResume = f.upstream.length;
    f.broker.receive(other, JSON.stringify({ jsonrpc: '2.0', id: `${label}-other`,
      method: 'thread/resume', params: { threadId } }));
    assert.equal(other.messages.at(-1)?.error?.code, -32023);
    assert.equal(f.upstream.length, beforeRejectedResume, 'another Gateway owner cannot resume the bound thread');

    const orderedNotifications = [
      { jsonrpc: '2.0', method: 'turn/started', params: { threadId, turnId: 'turn-1' } },
      { jsonrpc: '2.0', method: 'item/event', params: { threadId, turnId: 'turn-1', event: { type: 'message_delta', text: 'answer' } } },
      { jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId: 'turn-1' } },
    ];
    for (const notification of orderedNotifications) await f.fromAppServer(notification);
    const ownerMessages = owner.messages.filter(message =>
      message.method && message.params?.threadId === threadId);
    assert.deepEqual(ownerMessages.map(message => message.method), orderedNotifications.map(message => message.method));
    assert.equal(other.messages.some(message => message.params?.threadId === threadId), false,
      'thread notifications remain with the successful resume owner');
    assert.equal(responseIndex < owner.messages.indexOf(ownerMessages[0]), true,
      'resume response arrives before later thread notifications');
    f.broker.clearTransientState();
  });
});

test('an old backend does not gain the new resume-history capability through Broker initialization', async () => {
  const f = brokerFixture();
  const client = f.client('family-a');
  client.initialized = false;
  const initialize = await f.request(client, {
    jsonrpc: '2.0', id: 'init-old-backend', method: 'initialize', params: {
      capabilities: { experimental: {} },
    },
  });
  assert.equal(initialize.method, 'initialize');
  assert.notEqual(initialize.params?.capabilities?.experimental?.threadResumeHistoryPageV1, true,
    'Broker must not turn a client request into a server capability');

  const oldCapabilities = { residentThreads: true, threadIndexedPagesV1: true };
  await f.fromAppServer({ jsonrpc: '2.0', id: initialize.id, result: {
    protocolVersion: '1', capabilities: { experimental: oldCapabilities },
  } });
  const response = client.messages.at(-1);
  assert.equal(response.id, 'init-old-backend');
  assert.deepEqual(response.result.capabilities.experimental, oldCapabilities,
    'the backend response remains authoritative; Broker does not fabricate inline history support');
  f.broker.clearTransientState();
});
