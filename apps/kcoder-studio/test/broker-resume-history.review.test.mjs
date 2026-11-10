import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function brokerFixture({ onIdleStateChange } = {}) {
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
    onIdleStateChange,
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

test('resume stream context remains an explicit per-client opt-in, including Mobile compatibility', async t => {
  for (const enabled of [false, true]) await t.test(String(enabled), async () => {
    const f = brokerFixture();
    const owner = f.client('family-a');
    owner.threadStreamContextV1 = enabled;
    const pending = await f.request(owner, { id: 81, method: 'thread/resume', params: { threadId: 'thread' } });
    const streamContext = { serverId: 'instance', throughSequence: 7, activeTurn: null };
    await f.fromAppServer({ id: pending.id, result: { thread: { id: 'thread' }, streamContext } });
    assert.deepEqual(owner.messages.at(-1).result, { thread: { id: 'thread' }, ...(enabled ? { streamContext } : {}) });
    assert.equal(f.broker.threadOwners.get('thread'), owner);
    f.broker.clearTransientState();
  });
});

test('notifications arriving before a fresh resume response wait for that owner commit', async () => {
  const f = brokerFixture();
  const owner = f.client('family-a');
  const peer = f.client('family-b');
  const threadId = 'resume-with-inflight-notification';
  const clientRequestId = 'resume-inflight-request';
  const upstreamRequest = await f.request(owner, {
    jsonrpc: '2.0', id: clientRequestId, method: 'thread/resume',
    params: { threadId, history: { limit: 50, indexed: true } },
  });
  assert.equal(upstreamRequest.method, 'thread/resume');
  assert.equal(f.broker.threadOwners.has(threadId), false, 'pending claims are not committed ownership');

  const notification = {
    jsonrpc: '2.0', method: 'turn/completed',
    params: { threadId, turnId: 'turn-during-resume' },
  };
  await f.fromAppServer(notification);
  assert.equal(owner.messages.some(message => message.method === notification.method), false,
    'a pending resume claim must not authorize sending before its response');
  assert.equal(peer.messages.some(message => message.params?.threadId === threadId), false,
    'a pending candidate notification must never be broadcast to a peer');

  const result = { thread: { id: threadId, cwd: '/workspace/example' }, history: { status: 'ready', page: {
    messages: [{ id: 'old-message', role: 'assistant', content: 'history page' }],
    rangeStart: 0, rangeEnd: 1, hasMoreBefore: false,
  } } };
  await f.fromAppServer({ jsonrpc: '2.0', id: upstreamRequest.id, result });

  assert.deepEqual(owner.messages, [
    { jsonrpc: '2.0', id: clientRequestId, result },
    notification,
  ], 'after successful ownership commit, the resume response precedes the buffered event');
  assert.equal(f.broker.threadOwners.get(threadId), owner);
  assert.equal(peer.messages.some(message => message.params?.threadId === threadId), false);
  f.broker.clearTransientState();
});

test('a second same-client resume cannot share a pending notification claim', async () => {
  const f = brokerFixture();
  const owner = f.client('family-a');
  const first = await f.request(owner, {
    jsonrpc: '2.0', id: 'resume-first', method: 'thread/resume', params: { threadId: 'thread-one-pending-resume' },
  });
  const forwardedCount = f.upstream.length;

  f.broker.receive(owner, JSON.stringify({
    jsonrpc: '2.0', id: 'resume-second', method: 'thread/resume', params: { threadId: 'thread-one-pending-resume' },
  }));

  assert.equal(owner.messages.at(-1)?.error?.code, -32023);
  assert.equal(f.upstream.length, forwardedCount, 'only one in-flight request may own this notification candidate');
  await f.fromAppServer({ jsonrpc: '2.0', id: first.id, result: { thread: { id: 'thread-one-pending-resume' } } });
  f.broker.clearTransientState();
});

test('failed resume discards held notifications and never assigns ownership', async () => {
  const f = brokerFixture();
  const owner = f.client('family-a');
  const peer = f.client('family-b');
  const threadId = 'failed-resume-with-event';
  const upstreamRequest = await f.request(owner, {
    jsonrpc: '2.0', id: 'resume-failure', method: 'thread/resume', params: { threadId },
  });
  await f.fromAppServer({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId: 'failed-turn' } });
  await f.fromAppServer({ jsonrpc: '2.0', id: upstreamRequest.id, error: { code: -32021, message: 'resume unavailable' } });

  assert.equal(owner.messages.at(-1)?.error?.message, 'resume unavailable');
  assert.equal(f.broker.threadOwners.has(threadId), false);
  assert.equal(owner.messages.some(message => message.method === 'turn/completed'), false);
  assert.equal(peer.messages.some(message => message.params?.threadId === threadId), false);
  f.broker.clearTransientState();
});

test('a held terminal event settles automation lifecycle before a failed resume without leaking the event', async () => {
  const idleStates = [];
  const f = brokerFixture({ onIdleStateChange: broker => idleStates.push(broker.hasProjectAutomations) });
  const candidate = f.client('family-a');
  const peer = f.client('family-b');
  const threadId = 'failed-resume-automation-lifecycle';
  f.broker.automationThreads.add(threadId);
  f.broker.activeAutomationThreads.add(threadId);

  const resume = await f.request(candidate, {
    jsonrpc: '2.0', id: 'resume-with-automation-event', method: 'thread/resume', params: { threadId },
  });
  f.broker.activeTurns.set(threadId, { owner: null, turnId: 'automation-turn' });
  f.broker.beginThreadDrain(threadId, 'automation-turn');
  const beforeEvent = idleStates.length;
  const completed = { jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId: 'automation-turn' } };
  await f.fromAppServer(completed);

  assert.equal(f.broker.activeAutomationThreads.has(threadId), false,
    'the backend terminal event must settle local automation activity immediately');
  assert.equal(f.broker.activeTurns.has(threadId), false,
    'the backend terminal event must settle the active turn immediately');
  assert.equal(f.broker.threadDrains.has(threadId), false,
    'the backend terminal event must finish a waiting thread drain immediately');
  assert.equal(idleStates.length, beforeEvent + 1,
    'automation idle state must be recalculated once when the terminal event arrives');
  assert.equal(idleStates.at(-1), false);
  assert.equal(candidate.messages.some(message => message.method === 'turn/completed'), false,
    'a pending claim cannot receive a thread event before successful ownership commit');
  assert.equal(peer.messages.some(message => message.method === 'turn/completed'), false,
    'the event is not broadcast to a peer while the resume has no owner');

  await f.fromAppServer({ jsonrpc: '2.0', id: resume.id, error: { code: -32021, message: 'resume unavailable' } });
  assert.equal(candidate.messages.some(message => message.method === 'turn/completed'), false);
  assert.equal(peer.messages.some(message => message.method === 'turn/completed'), false);
  assert.equal(f.broker.threadOwners.has(threadId), false);
  assert.equal(f.broker.activeAutomationThreads.has(threadId), false);
  assert.equal(idleStates.length, beforeEvent + 1, 'the discarded handoff must not replay bookkeeping');
});

test('a held automation start updates local activity once and is delivered only to the committed resume owner', async () => {
  const idleStates = [];
  const f = brokerFixture({ onIdleStateChange: broker => idleStates.push(broker.hasProjectAutomations) });
  const candidate = f.client('family-a');
  const peer = f.client('family-b');
  const threadId = 'successful-resume-automation-lifecycle';
  const resume = await f.request(candidate, {
    jsonrpc: '2.0', id: 'resume-with-automation-start', method: 'thread/resume', params: { threadId },
  });
  const beforeEvent = idleStates.length;
  const started = { jsonrpc: '2.0', method: 'automation/runStarted', params: {
    threadId, jobId: 'job-during-resume', requestId: 'request-during-resume',
  } };
  await f.fromAppServer(started);

  assert.equal(f.broker.activeAutomationThreads.has(threadId), true,
    'the backend start event must update broker lifecycle state while delivery is held');
  assert.equal(idleStates.length, beforeEvent + 1);
  assert.equal(idleStates.at(-1), true);
  assert.equal(candidate.messages.some(message => message.method === started.method), false);
  assert.equal(peer.messages.some(message => message.method === started.method), false,
    'the pending resume claim cannot broadcast an automation event to a peer');

  const result = { thread: { id: threadId }, history: { status: 'ready' } };
  await f.fromAppServer({ jsonrpc: '2.0', id: resume.id, result });
  assert.deepEqual(candidate.messages, [
    { jsonrpc: '2.0', id: 'resume-with-automation-start', result },
    started,
  ]);
  assert.equal(peer.messages.some(message => message.method === started.method), false,
    'a buffered thread-scoped automation event is delivered only after the exact owner commits');
  assert.equal(idleStates.length, beforeEvent + 1,
    'successful replay must not run automation lifecycle bookkeeping a second time');
});

test('a resource-owned thread-tagged terminal notification keeps its existing owner during pending resume', async () => {
  const f = brokerFixture();
  const candidate = f.client('family-a');
  const terminalOwner = f.client('family-b');
  const threadId = 'resume-with-resource-owned-terminal';
  const sessionId = 'terminal-owned-by-peer';
  f.broker.resourceOwners.set(`terminal\0${sessionId}`, terminalOwner);

  const resume = await f.request(candidate, {
    jsonrpc: '2.0', id: 'resume-terminal-resource', method: 'thread/resume', params: { threadId },
  });
  const exit = { jsonrpc: '2.0', method: 'terminal/exit', params: {
    threadId, session_id: sessionId, sequence: 3, exit_code: 0,
  } };
  await f.fromAppServer(exit);

  assert.deepEqual(terminalOwner.messages, [exit],
    'a pending thread claim must not intercept a notification with an established resource owner');
  assert.equal(candidate.messages.some(message => message.method === exit.method), false);
  await f.fromAppServer({ jsonrpc: '2.0', id: resume.id, error: { code: -32021, message: 'resume unavailable' } });
  assert.equal(candidate.messages.some(message => message.method === exit.method), false);
  assert.equal(f.broker.threadOwners.has(threadId), false);
});

test('an expired pending resume cannot commit ownership when its late success arrives', async () => {
  const f = brokerFixture();
  const owner = f.client('family-a');
  const peer = f.client('family-b');
  const threadId = 'expired-resume-with-event';
  const upstreamRequest = await f.request(owner, {
    jsonrpc: '2.0', id: 'resume-expired', method: 'thread/resume', params: { threadId },
  });
  await f.fromAppServer({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId: 'expired-turn' } });
  f.broker.expireRequest(upstreamRequest.id);
  await f.fromAppServer({ jsonrpc: '2.0', id: upstreamRequest.id, result: { thread: { id: threadId } } });

  assert.equal(owner.messages.some(message => message.id === 'resume-expired' && message.error), true);
  assert.equal(f.broker.threadOwners.has(threadId), false, 'a timeout releases ownership even if the upstream response is late');
  assert.equal(owner.messages.some(message => message.method === 'turn/completed'), false);
  assert.equal(peer.messages.some(message => message.params?.threadId === threadId), false);
  f.broker.clearTransientState();
});

test('expiring pending resumes releases their shared notification byte budget', async () => {
  const f = brokerFixture();
  const owner = f.client('family-a');
  const payload = 'x'.repeat(240 * 1024);
  const expired = [];
  for (let index = 0; index < 8; index += 1) {
    const threadId = `expired-buffer-${index}`;
    const request = await f.request(owner, {
      jsonrpc: '2.0', id: `expired-buffer-request-${index}`, method: 'thread/resume', params: { threadId },
    });
    expired.push({ request, threadId });
    await f.fromAppServer({ jsonrpc: '2.0', method: 'item/event', params: {
      threadId, event: { type: 'message_delta', text: payload },
    } });
    f.broker.expireRequest(request.id);
  }
  for (const entry of expired) {
    await f.fromAppServer({ jsonrpc: '2.0', id: entry.request.id, result: { thread: { id: entry.threadId } } });
  }

  const freshThreadId = 'after-expiry-release';
  const freshRequest = await f.request(owner, {
    jsonrpc: '2.0', id: 'after-expiry-release-request', method: 'thread/resume', params: { threadId: freshThreadId },
  });
  const freshEvent = { jsonrpc: '2.0', method: 'item/event', params: {
    threadId: freshThreadId, event: { type: 'message_delta', text: payload },
  } };
  await f.fromAppServer(freshEvent);
  await f.fromAppServer({ jsonrpc: '2.0', id: freshRequest.id, result: { thread: { id: freshThreadId } } });

  assert.equal(f.broker.threadOwners.get(freshThreadId), owner);
  assert.deepEqual(owner.messages.filter(message => message.method === 'item/event'), [freshEvent]);
  f.broker.clearTransientState();
});

test('a disconnected resume candidate cannot hand its held event to a peer or a late client', async () => {
  const f = brokerFixture();
  const owner = f.client('family-a');
  const peer = f.client('family-b');
  const threadId = 'detached-resume-with-event';
  const upstreamRequest = await f.request(owner, {
    jsonrpc: '2.0', id: 'resume-detached', method: 'thread/resume', params: { threadId },
  });
  await f.fromAppServer({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId: 'detached-turn' } });
  f.broker.detach(owner);
  await f.fromAppServer({ jsonrpc: '2.0', id: upstreamRequest.id, result: { thread: { id: threadId } } });

  assert.equal(f.broker.threadOwners.has(threadId), false);
  assert.equal(owner.messages.some(message => message.method === 'turn/completed'), false);
  assert.equal(peer.messages.some(message => message.params?.threadId === threadId), false);
  f.broker.clearTransientState();
});

test('detaching pending resumes releases their shared notification byte budget', async () => {
  const f = brokerFixture();
  const owner = f.client('family-a');
  const peer = f.client('family-b');
  const payload = 'x'.repeat(240 * 1024);
  const pending = [];
  for (let index = 0; index < 8; index += 1) {
    const threadId = `detached-buffer-${index}`;
    const request = await f.request(owner, {
      jsonrpc: '2.0', id: `detached-buffer-request-${index}`, method: 'thread/resume', params: { threadId },
    });
    pending.push(request);
    await f.fromAppServer({ jsonrpc: '2.0', method: 'item/event', params: {
      threadId, event: { type: 'message_delta', text: payload },
    } });
  }
  f.broker.detach(owner);
  for (const request of pending) {
    await f.fromAppServer({ jsonrpc: '2.0', id: request.id, result: { thread: { id: `detached-buffer-${pending.indexOf(request)}` } } });
  }

  const freshThreadId = 'after-detach-release';
  const freshRequest = await f.request(peer, {
    jsonrpc: '2.0', id: 'after-detach-release-request', method: 'thread/resume', params: { threadId: freshThreadId },
  });
  const freshEvent = { jsonrpc: '2.0', method: 'item/event', params: {
    threadId: freshThreadId, event: { type: 'message_delta', text: payload },
  } };
  await f.fromAppServer(freshEvent);
  await f.fromAppServer({ jsonrpc: '2.0', id: freshRequest.id, result: { thread: { id: freshThreadId } } });

  assert.equal(f.broker.threadOwners.get(freshThreadId), peer);
  assert.deepEqual(peer.messages.filter(message => message.method === 'item/event'), [freshEvent]);
  assert.equal(owner.messages.some(message => message.method === 'item/event'), false);
  f.broker.clearTransientState();
});

test('a peer owner that appears before resume completion is never overwritten', async () => {
  const f = brokerFixture();
  const candidate = f.client('family-a');
  const peer = f.client('family-b');
  const threadId = 'peer-owns-before-resume-completion';
  const resume = await f.request(candidate, {
    jsonrpc: '2.0', id: 'resume-candidate', method: 'thread/resume', params: { threadId },
  });
  const held = { jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId: 'held-for-candidate' } };
  await f.fromAppServer(held);

  const start = await f.request(peer, { jsonrpc: '2.0', id: 'peer-start', method: 'thread/start', params: {} });
  await f.fromAppServer({ jsonrpc: '2.0', id: start.id, result: { thread: { id: threadId } } });
  const peerEvent = { jsonrpc: '2.0', method: 'item/event', params: { threadId, event: { type: 'peer-owned' } } };
  await f.fromAppServer(peerEvent);
  await f.fromAppServer({ jsonrpc: '2.0', id: resume.id, result: { thread: { id: threadId } } });

  assert.equal(f.broker.threadOwners.get(threadId), peer, 'the later candidate response cannot overwrite the committed peer owner');
  assert.equal(candidate.messages.some(message => message.id === 'resume-candidate' && message.result), false,
    'a candidate whose claim lost must not receive a successful ownership response');
  assert.equal(candidate.messages.at(-1)?.error?.code, -32023);
  assert.equal(candidate.messages.includes(held), false);
  assert.deepEqual(peer.messages.find(message => message.method === 'item/event'), peerEvent);
  assert.equal(peer.messages.includes(held), false, 'the previously held candidate event is not re-routed to the peer');
  f.broker.clearTransientState();
});

test('a replaced resume claim cannot commit or release the new claim owner', async () => {
  const f = brokerFixture();
  const candidate = f.client('family-a');
  const peer = f.client('family-b');
  const threadId = 'resume-claim-replaced';
  const resume = await f.request(candidate, {
    jsonrpc: '2.0', id: 'resume-replaced-claim', method: 'thread/resume', params: { threadId },
  });
  const held = { jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId: 'held-before-replacement' } };
  await f.fromAppServer(held);
  f.broker.threadClaims.set(threadId, peer);
  await f.fromAppServer({ jsonrpc: '2.0', id: resume.id, result: { thread: { id: threadId } } });

  assert.equal(f.broker.threadOwners.has(threadId), false);
  assert.equal(f.broker.threadClaims.get(threadId), peer, 'the expired candidate cannot release a replacement claim');
  assert.equal(candidate.messages.at(-1)?.error?.code, -32023);
  assert.equal(candidate.messages.includes(held), false);
  assert.equal(peer.messages.includes(held), false);
  f.broker.clearTransientState();
});

test('a resume response for a different thread cannot commit either thread to its candidate', async () => {
  const f = brokerFixture();
  const candidate = f.client('family-a');
  const peer = f.client('family-b');
  const requestedThreadId = 'resume-requested-thread';
  const unrelatedThreadId = 'resume-response-unrelated-thread';
  f.broker.threadOwners.set(unrelatedThreadId, peer);
  const resume = await f.request(candidate, {
    jsonrpc: '2.0', id: 'resume-wrong-thread', method: 'thread/resume', params: { threadId: requestedThreadId },
  });
  const held = { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: requestedThreadId, turnId: 'held-for-exact-result' } };
  await f.fromAppServer(held);
  await f.fromAppServer({ jsonrpc: '2.0', id: resume.id, result: { thread: { id: unrelatedThreadId } } });

  assert.equal(candidate.messages.at(-1)?.error?.code, -32023);
  assert.equal(f.broker.threadOwners.has(requestedThreadId), false);
  assert.equal(f.broker.threadOwners.get(unrelatedThreadId), peer);
  assert.equal(candidate.messages.includes(held), false);
  assert.equal(peer.messages.includes(held), false);
  f.broker.clearTransientState();
});

test('a same-owner resume keeps its existing live notification route', async () => {
  const f = brokerFixture();
  const owner = f.client('family-a');
  const threadId = 'already-owned-resume';
  const first = await f.request(owner, {
    jsonrpc: '2.0', id: 'already-owned-first', method: 'thread/resume', params: { threadId },
  });
  await f.fromAppServer({ jsonrpc: '2.0', id: first.id, result: { thread: { id: threadId } } });

  const second = await f.request(owner, {
    jsonrpc: '2.0', id: 'already-owned-second', method: 'thread/resume', params: { threadId },
  });
  const live = { jsonrpc: '2.0', method: 'item/event', params: { threadId, event: { type: 'live-during-owned-resume' } } };
  await f.fromAppServer(live);
  assert.deepEqual(owner.messages.find(message => message.method === live.method), live,
    'an already committed owner receives live events immediately');

  await f.fromAppServer({ jsonrpc: '2.0', id: second.id, result: { thread: { id: threadId } } });
  assert.equal(owner.messages.findIndex(message => message.method === live.method) < owner.messages.findIndex(message => message.id === 'already-owned-second'), true);
  assert.equal(f.broker.threadOwners.get(threadId), owner);
  f.broker.clearTransientState();
});

test('overflowing a pending resume notification queue fails handoff explicitly', async () => {
  const f = brokerFixture();
  const owner = f.client('family-a');
  const threadId = 'resume-buffer-overflow';
  const upstreamRequest = await f.request(owner, {
    jsonrpc: '2.0', id: 'resume-overflow', method: 'thread/resume', params: { threadId },
  });
  for (let index = 0; index < 65; index += 1) {
    await f.fromAppServer({ jsonrpc: '2.0', method: 'item/event', params: {
      threadId, event: { type: 'message_delta', text: `event-${index}` },
    } });
  }
  await f.fromAppServer({ jsonrpc: '2.0', id: upstreamRequest.id, result: { thread: { id: threadId } } });

  const response = owner.messages.find(message => message.id === 'resume-overflow');
  assert.equal(response?.error?.code, -32047);
  assert.deepEqual(response?.error?.data, { gatewayRecoveryV1: {
    kind: 'resume_notification_handoff_incomplete',
    upstreamOutcome: 'succeeded',
    retryScope: 'thread/resume',
  } });
  assert.equal(f.broker.threadOwners.has(threadId), false);
  assert.equal(owner.messages.some(message => message.method === 'item/event'), false);
  f.broker.clearTransientState();
});

test('global pending resume buffer limit is shared across threads and released after failed requests', async () => {
  const f = brokerFixture();
  const owner = f.client('family-a');
  const pending = [];
  const payload = 'x'.repeat(240 * 1024);
  for (let index = 0; index < 9; index += 1) {
    const threadId = `global-buffer-${index}`;
    const request = await f.request(owner, {
      jsonrpc: '2.0', id: `global-resume-${index}`, method: 'thread/resume', params: { threadId },
    });
    pending.push({ request, threadId });
    await f.fromAppServer({ jsonrpc: '2.0', method: 'item/event', params: {
      threadId, event: { type: 'message_delta', text: payload },
    } });
  }
  for (let index = 0; index < 8; index += 1) {
    await f.fromAppServer({ jsonrpc: '2.0', id: pending[index].request.id,
      error: { code: -32021, message: 'resume unavailable' } });
  }
  const freshThreadId = 'global-buffer-after-release';
  const freshRequest = await f.request(owner, {
    jsonrpc: '2.0', id: 'global-resume-after-release', method: 'thread/resume', params: { threadId: freshThreadId },
  });
  const freshEvent = { jsonrpc: '2.0', method: 'item/event', params: {
    threadId: freshThreadId, event: { type: 'message_delta', text: payload },
  } };
  await f.fromAppServer(freshEvent);
  const final = pending.at(-1);
  await f.fromAppServer({ jsonrpc: '2.0', id: final.request.id,
    result: { thread: { id: final.threadId } } });
  await f.fromAppServer({ jsonrpc: '2.0', id: freshRequest.id,
    result: { thread: { id: freshThreadId } } });

  const response = owner.messages.find(message => message.id === 'global-resume-8');
  assert.equal(response?.error?.code, -32047, 'the broker-wide cap applies even when each queue is individually below its limit');
  assert.equal(f.broker.threadOwners.has(final.threadId), false);
  assert.deepEqual(owner.messages.filter(message => message.method === 'item/event'), [freshEvent],
    'failing earlier resumes frees global capacity for a later candidate');
  const freshEventIndex = owner.messages.findIndex(message => message.method === 'item/event' && message.params?.threadId === freshThreadId);
  assert.equal(owner.messages.findIndex(message => message.id === 'global-resume-after-release') < freshEventIndex, true);
  assert.equal(f.broker.threadOwners.get(freshThreadId), owner);
  f.broker.clearTransientState();
});

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
      protocolVersion: '2026-07-27',
      clientInfo: { name: 'resume-review', version: '1' },
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
  assert.deepEqual(response.result.capabilities.experimental, { ...oldCapabilities,
    workspaceOperationReceiptsV2: false, stagedAttachmentRetentionReceiptsV1: false },
    'the backend response remains authoritative; Broker does not fabricate inline history support');
  assert.equal(response.result.capabilities.experimental.threadStreamContextV1, undefined);
  f.broker.clearTransientState();
});
