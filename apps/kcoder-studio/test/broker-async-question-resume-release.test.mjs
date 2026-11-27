import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true, threadRuntimeHandoffV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const client = () => {
    const value = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value);
    Object.assign(value, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true, threadRuntimeHandoffV1: true });
    return value;
  };
  const send = (peer, method, threadId = 'thread', extra = {}) => {
    const before = upstream.length;
    broker.receive(peer, JSON.stringify({ id: ++sequence, method, params: { threadId, ...extra } }));
    return upstream.slice(before).find(message => message.method === method);
  };
  const reply = (request, result, error, envelope) => child.stdout.write(`${JSON.stringify({ id: request.id,
    ...(error ? { error } : { result }), ...envelope })}\n`);
  const owner = client();
  reply(send(owner, 'thread/resume'), { thread: { id: 'thread' } });
  return { broker, upstream, client, send, reply, owner };
}

for (const release of ['thread/delete', 'thread/dispose']) {
  for (const shared of [false, true]) {
    test(`${release} fences a late ${shared ? 'shared' : 'owner'} resume before question access`, t => {
      const f = fixture(t), recovering = shared ? f.client() : f.owner;
      const resume = f.send(recovering, 'thread/resume');
      assert.ok(resume);
      const deletion = f.send(f.owner, release);
      assert.ok(deletion);
      f.reply(deletion, { threadId: 'thread' });
      f.reply(resume, { thread: { id: 'thread' } });
      assert.equal(recovering.messages.at(-1).error?.code, -32023,
        'the old resume receipt cannot certify a binding released in the meantime');
      assert.equal(f.broker.threadOwners.has('thread'), false);
      assert.equal(f.broker.sharedThreads.has('thread', recovering), false);
      assert.equal(f.send(recovering, 'asyncQuestion/list'), undefined,
        'a stale resume cannot regain access to original question content');
      assert.equal(recovering.messages.at(-1).error?.code, -32023);
      // Recovery is an explicit fresh read, never an automatic answer replay.
      f.reply(f.send(recovering, 'thread/resume'), { thread: { id: 'thread' } });
      assert.equal(f.send(recovering, 'asyncQuestion/list')?.method, 'asyncQuestion/list');
      assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false);
    });
  }
}

for (const outcome of ['released', 'rejected', 'unknown', 'fresh runtime', 'other task']) {
  test(`only a confirmed original runtime release invalidates shared question recovery (${outcome})`, t => {
    const f = fixture(t), recovering = f.client();
    const resume = f.send(recovering, 'thread/resume');
    const threadId = outcome === 'other task' ? 'other' : 'thread';
    const release = f.send(f.owner, 'thread/runtime/handoff/release', threadId, {
      operationId: 'release-once', expectedServerId: 'native-server',
      expectedOwnerRef: 'original-owner', expectedClientTurnCount: 0,
    });
    assert.ok(release);
    f.reply(release, {
      snapshot: { serverId: 'native-server', threadId,
        ownerRef: outcome === 'fresh runtime' ? 'new-owner' : null,
        clientTurnCount: outcome === 'fresh runtime' ? 0 : null, releasable: outcome === 'fresh runtime' },
      receipt: { serverId: 'native-server', threadId, operationId: 'release-once',
        ownerRef: 'original-owner', status: outcome === 'unknown' ? 'unknown' : 'released' },
    }, outcome === 'rejected' ? { code: -32036, message: 'runtime is busy' } : undefined);
    f.reply(resume, { thread: { id: 'thread' } });
    const invalidated = outcome === 'released';
    assert.equal(recovering.messages.at(-1).error?.code, invalidated ? -32023 : undefined);
    assert.equal(f.broker.sharedThreads.has('thread', recovering), !invalidated);
    assert.equal(f.send(recovering, 'asyncQuestion/list')?.method, invalidated ? undefined : 'asyncQuestion/list');
    assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false);
  });
}

for (const release of ['thread/delete', 'thread/dispose']) {
  test(`a rejected ${release} preserves the pending shared question reader`, t => {
    const f = fixture(t), recovering = f.client();
    const resume = f.send(recovering, 'thread/resume');
    f.reply(f.send(f.owner, release), undefined, { code: -32036, message: 'task is busy' });
    f.reply(resume, { thread: { id: 'thread' } });
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.equal(f.broker.sharedThreads.has('thread', recovering), true);
    assert.equal(f.send(recovering, 'asyncQuestion/list')?.method, 'asyncQuestion/list');
  });
}

test('late released resume cannot replace a fresh owner or replay its buffered question', t => {
  const f = fixture(t), oldViewer = f.client();
  const oldResume = f.send(oldViewer, 'thread/resume');
  const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
    question: { threadId: 'thread', questionId: 'question', revision: 1 } } };
  f.broker.routeServerMessage(changed);
  f.reply(f.send(f.owner, 'thread/delete'), { threadId: 'thread' });
  const fresh = f.client();
  f.reply(f.send(fresh, 'thread/resume'), { thread: { id: 'thread' } });
  f.reply(oldResume, { thread: { id: 'thread' } });
  assert.equal(oldViewer.messages.at(-1).error?.code, -32023);
  assert.equal(oldViewer.messages.some(message => message.method === 'asyncQuestion/changed'), false);
  assert.equal(f.broker.threadOwners.get('thread'), fresh);
  assert.equal(f.broker.sharedThreads.has('thread', fresh), true);
  assert.equal(f.broker.sharedThreads.has('thread', oldViewer), false);
  const mutation = { questionId: 'question', expectedRevision: 1 };
  for (const [method, params] of [
    ['asyncQuestion/list', {}],
    ['asyncQuestion/answer', { ...mutation, submissionId: 'submission', answers: { item: { text: 'Answer' } } }],
    ['asyncQuestion/cancel', mutation],
  ]) {
    assert.equal(f.send(oldViewer, method, 'thread', params), undefined);
    assert.equal(oldViewer.messages.at(-1).error?.code, -32023);
  }
  assert.equal(f.send(fresh, 'asyncQuestion/list')?.method, 'asyncQuestion/list');
  assert.equal(f.broker.activeTurns.size, 0);
  assert.equal(f.broker.threadDrains.size, 0);
});

for (const release of ['thread/delete', 'thread/dispose']) {
  test(`${release} also fences a shared resume using a legacy task alias`, t => {
    const f = fixture(t), recovering = f.client();
    const resume = f.send(recovering, 'thread/resume', 'thread', { threadId: undefined, thread_id: 'thread' });
    assert.ok(resume);
    f.reply(f.send(f.owner, release), { threadId: 'thread' });
    f.reply(resume, { thread: { id: 'thread' } });
    assert.equal(recovering.messages.at(-1).error?.code, -32023);
    assert.equal(f.broker.sharedThreads.has('thread', recovering), false);
    assert.equal(f.send(recovering, 'asyncQuestion/list'), undefined);
  });
}

for (const release of ['thread/delete', 'thread/dispose', 'thread/runtime/handoff/release']) {
  test(`${release} fences a pending question list even after the same client resumes again`, t => {
    const f = fixture(t);
    const oldList = f.send(f.owner, 'asyncQuestion/list');
    assert.ok(oldList);
    const operation = f.send(f.owner, release, 'thread', {
      operationId: 'release-once', expectedServerId: 'native-server',
      expectedOwnerRef: 'original-owner', expectedClientTurnCount: 0,
    });
    assert.ok(operation);
    f.reply(operation, release === 'thread/runtime/handoff/release' ? {
      snapshot: { serverId: 'native-server', threadId: 'thread',
        ownerRef: null, clientTurnCount: null, releasable: false },
      receipt: { serverId: 'native-server', threadId: 'thread', operationId: 'release-once',
        ownerRef: 'original-owner', status: 'released' },
    } : { threadId: 'thread' });

    f.reply(f.send(f.owner, 'thread/resume'), { thread: { id: 'thread' } });
    const freshList = f.send(f.owner, 'asyncQuestion/list');
    assert.ok(freshList);
    f.reply(freshList, { threadId: 'thread', questions: [] });
    assert.deepEqual(f.owner.messages.at(-1).result?.questions, []);

    f.reply(oldList, { threadId: 'thread', questions: [
      { threadId: 'thread', questionId: 'old-question', revision: 1 },
    ] });
    assert.equal(f.owner.messages.at(-1).error?.code, -32023);
    assert.equal(f.owner.messages.at(-1).result, undefined);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/list').length, 2);
  });
}

test('rejected and unrelated releases preserve the pending question list', t => {
  const f = fixture(t);
  const list = f.send(f.owner, 'asyncQuestion/list');
  assert.ok(list);

  f.reply(f.send(f.owner, 'thread/delete'), undefined, { code: -32036, message: 'task is busy' });
  f.reply(f.send(f.owner, 'thread/resume', 'other'), { thread: { id: 'other' } });
  f.reply(f.send(f.owner, 'thread/delete', 'other'), { threadId: 'other' });

  const questions = [{ threadId: 'thread', questionId: 'current-question', revision: 2 }];
  f.reply(list, { threadId: 'thread', questions });
  assert.deepEqual(f.owner.messages.at(-1).result?.questions, questions);
});

for (const release of ['thread/delete', 'thread/dispose']) {
  for (const [name, envelope] of Object.entries({
    'wrong version': { jsonrpc: '1.0' },
    'result and null error': { error: null },
    'result and request params': { params: {} },
    'result and null method': { method: null },
    'result with null thread ID': {},
  })) {
    test(`${release} with ${name} preserves pending question reads and resumes`, t => {
      const f = fixture(t), recovering = f.client();
      const list = f.send(f.owner, 'asyncQuestion/list');
      const resume = f.send(recovering, 'thread/resume');
      const result = name === 'result with null thread ID' ? { threadId: null } : { threadId: 'thread' };
      f.reply(f.send(f.owner, release), result, undefined, envelope);
      const releaseResponse = f.owner.messages.at(-1);

      const questions = [{ threadId: 'thread', questionId: 'original-question', revision: 1 }];
      f.reply(list, { threadId: 'thread', questions });
      assert.deepEqual(f.owner.messages.at(-1).result?.questions, questions);
      f.reply(resume, { thread: { id: 'thread' } });
      assert.equal(recovering.messages.at(-1).result?.thread.id, 'thread');
      assert.equal(f.broker.threadOwners.get('thread'), f.owner);
      assert.equal(f.send(recovering, 'asyncQuestion/list')?.method, 'asyncQuestion/list');
      assert.equal(releaseResponse.error?.code, -32001);
      assert.equal(releaseResponse.result, undefined);
      assert.deepEqual(f.upstream.map(request => request.method),
        ['thread/resume', 'asyncQuestion/list', 'thread/resume', release, 'asyncQuestion/list']);
    });
  }
}

for (const firstOutcome of ['success', 'rejection']) {
  test(`overlapping resumes deliver each question update once after the first ${firstOutcome}`, t => {
    const f = fixture(t), viewer = f.client();
    const first = f.send(viewer, 'thread/resume');
    const second = f.send(viewer, 'thread/resume');
    assert.ok(first);
    assert.ok(second);

    const change = revision => ({ method: 'asyncQuestion/changed', params: { threadId: 'thread',
      question: { threadId: 'thread', questionId: 'original-question', revision } } });
    const readThread = { thread: { id: 'thread' } };
    f.broker.routeServerMessage(change(1));
    if (firstOutcome === 'success') f.reply(first, readThread);
    else f.reply(first, undefined, { code: -32036, message: 'task is busy' });
    f.broker.routeServerMessage(change(2));
    f.reply(second, readThread);

    const questionsReceived = client => client.messages.filter(message => message.method === 'asyncQuestion/changed');
    // Without membership, both hints coalesce to the newest revision in the
    // still-pending handoff. Once joined, the second update arrives live.
    assert.deepEqual(questionsReceived(viewer), firstOutcome === 'success' ? [change(1), change(2)] : [change(2)]);
    assert.deepEqual(questionsReceived(f.owner), [change(1), change(2)]);
    assert.equal(f.broker.sharedThreads.has('thread', viewer), true);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    const read = f.send(viewer, 'asyncQuestion/list');
    assert.ok(read);
    const questions = [change(2).params.question];
    f.reply(read, { threadId: 'thread', questions });
    assert.deepEqual(viewer.messages.at(-1).result?.questions, questions);
    assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false);
  });
}

test('an earlier pending resume still delivers a question absent from the successful later resume', t => {
  const f = fixture(t), viewer = f.client();
  const first = f.send(viewer, 'thread/resume');
  const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
    question: { threadId: 'thread', questionId: 'original-question', revision: 1 } } };
  f.broker.routeServerMessage(changed);
  const second = f.send(viewer, 'thread/resume');
  const result = { thread: { id: 'thread' } };
  f.reply(second, result);
  assert.equal(f.broker.sharedThreads.has('thread', viewer), true);
  assert.equal(viewer.messages.some(message => message.method === changed.method), false);
  f.reply(first, result);
  assert.deepEqual(viewer.messages.filter(message => message.method === changed.method), [changed]);
});

for (const firstReply of ['earlier', 'later']) {
  test(`overlapping resumes share an unchanged question snapshot (${firstReply} replies first)`, t => {
    const f = fixture(t), viewer = f.client();
    const earlier = f.send(viewer, 'thread/resume');
    const question = { threadId: 'thread', questionId: 'original-question', requestId: 'request',
      sourceTurnId: 'source', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
      questions: [{ id: 'item', header: 'Format', question: 'Which format?', options: [], multiSelect: false }] };
    const change = (sequence, snapshot) => ({ method: 'asyncQuestion/changed', traceId: String(sequence),
      params: { threadId: 'thread', sequence, question: snapshot } });
    const original = change(1, question);
    f.broker.routeServerMessage(original);
    const later = f.send(viewer, 'thread/resume');
    const replay = change(2, question);
    const updated = change(3, { ...question, revision: 2, status: 'cancelled' });
    f.broker.routeServerMessage(replay);
    f.broker.routeServerMessage(updated);

    const result = { thread: { id: 'thread' } };
    for (const request of firstReply === 'earlier' ? [earlier, later] : [later, earlier]) {
      f.reply(request, result);
    }
    assert.deepEqual(viewer.messages.filter(message => message.method === 'asyncQuestion/changed'),
      [firstReply === 'earlier' ? original : replay, updated]);
    assert.deepEqual(f.owner.messages.filter(message => message.method === 'asyncQuestion/changed'),
      [original, replay, updated]);
    assert.equal(f.send(viewer, 'asyncQuestion/list')?.method, 'asyncQuestion/list');
  });
}

for (const [delivery, liveStatus] of [['queued', 'cancelled'], ['queued', 'stale'], ['unqueued', 'cancelled']]) {
  test(`live delivery between overlapping resumes handles question queue status (${delivery}, ${liveStatus})`, t => {
    const f = fixture(t), viewer = f.client(), otherViewer = f.client();
    const earlier = f.send(viewer, 'thread/resume');
    const other = f.send(otherViewer, 'thread/resume');
    const question = { threadId: 'thread', questionId: 'original-question', requestId: 'request',
      sourceTurnId: 'source', toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'cancelled',
      questions: [{ id: 'item', header: 'Format', question: 'Which format?', options: [], multiSelect: false }] };
    const change = (sequence, snapshot) => ({ method: 'asyncQuestion/changed', traceId: String(sequence),
      params: { threadId: 'thread', sequence, question: snapshot } });
    const original = change(1, question);
    f.broker.routeServerMessage(original);
    const later = f.send(viewer, 'thread/resume');
    const result = { thread: { id: 'thread' } };
    f.reply(later, result);
    assert.equal(f.broker.sharedThreads.has('thread', viewer), true);

    const live = change(2, { ...question, status: liveStatus });
    viewer.sendWithQueueStatus = message => {
      const queued = delivery === 'queued';
      if (queued) viewer.send(message);
      return { queued, writable: false };
    };
    f.broker.routeServerMessage(live);
    delete viewer.sendWithQueueStatus;
    const received = client => client.messages.filter(message => message.method === 'asyncQuestion/changed');
    assert.deepEqual(received(viewer), delivery === 'queued' ? [live] : []);
    f.reply(earlier, result);
    const expected = delivery === 'unqueued' ? [] : liveStatus === question.status ? [live] : [live, original];
    assert.deepEqual(received(viewer), expected);
    assert.equal(f.broker.clients.has(viewer), delivery === 'queued');
    assert.equal(f.broker.sharedThreads.has('thread', viewer), delivery === 'queued');

    f.reply(other, result);
    assert.deepEqual(received(otherViewer), liveStatus === question.status ? [original] : [original, live]);
    assert.deepEqual(received(f.owner), [original, live]);
    assert.equal(f.send(otherViewer, 'asyncQuestion/list')?.method, 'asyncQuestion/list');
  });
}

test('a live full question resolves only the matching locator in an older pending resume', t => {
  const f = fixture(t), viewer = f.client();
  const earlier = f.send(viewer, 'thread/resume');
  const locator = { threadId: 'thread', questionId: 'original-question', requestId: 'request',
    sourceTurnId: 'source', toolCallId: 'tool', revision: 2 };
  const change = question => ({ method: 'asyncQuestion/changed', params: { threadId: 'thread', question } });
  const otherSource = change({ ...locator, toolCallId: 'other-tool' });
  f.broker.routeServerMessage(change(locator));
  f.broker.routeServerMessage(otherSource);

  const result = { thread: { id: 'thread' } };
  f.reply(f.send(viewer, 'thread/resume'), result);
  const live = change({ ...locator, createdAtMs: 1, status: 'cancelled',
    questions: [{ id: 'item', header: 'Format', question: 'Which format?', options: [], multiSelect: false }] });
  f.broker.routeServerMessage(live);
  f.reply(earlier, result);

  assert.deepEqual(viewer.messages.filter(message => message.method === live.method), [live, otherSource]);
  assert.equal(f.broker.threadOwners.get('thread'), f.owner);
  assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
});

for (const sameSnapshot of [true, false]) {
  test(`live delivery reconciles a compacted snapshot in an earlier pending resume (same=${sameSnapshot})`, t => {
    const f = fixture(t), viewer = f.client();
    const earlier = f.send(viewer, 'thread/resume');
    const locator = { threadId: 'thread', questionId: 'original-question', requestId: 'request',
      sourceTurnId: 'source', toolCallId: 'tool', revision: 1 };
    const change = (sequence, prompt) => ({ method: 'asyncQuestion/changed', params: {
      threadId: 'thread', sequence, question: { ...locator, createdAtMs: 1, status: 'pending',
        questions: [{ id: 'item', header: 'Format', question: prompt, options: [], multiSelect: false }] },
    } });
    const prompt = 'Which format? '.repeat(1000);
    f.broker.routeServerMessage({ method: 'item/delta', params: { threadId: 'thread',
      delta: { text: 'x'.repeat(250 * 1024) } } });
    f.broker.routeServerMessage(change(1, prompt));

    const result = { thread: { id: 'thread' } };
    f.reply(f.send(viewer, 'thread/resume'), result);
    const live = change(2, sameSnapshot ? prompt : 'Which format should be used?');
    f.broker.routeServerMessage(live);
    f.reply(earlier, result);

    const received = viewer.messages.filter(message => message.method === live.method);
    const readback = { ...live, params: { ...live.params, sequence: 1, question: locator } };
    assert.deepEqual(received, sameSnapshot ? [live] : [live, readback],
      'only a matching snapshot can suppress the earlier task readback');
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });
}

test('a replay of a compacted question corrects the sparse hint for its sequence before resume drains', t => {
  const f = fixture(t), viewer = f.client();
  const resume = f.send(viewer, 'thread/resume');
  const locator = { threadId: 'thread', questionId: 'original-question', requestId: 'request',
    sourceTurnId: 'source', toolCallId: 'tool', revision: 1 };
  const change = (sequence, question) => ({ method: 'asyncQuestion/changed', params: {
    threadId: 'thread', sequence, question,
  } });
  const full = { ...locator, createdAtMs: 1, status: 'pending',
    questions: [{ id: 'item', header: 'Format', question: 'Which format? '.repeat(1000),
      options: [], multiSelect: false }] };
  const delta = text => ({ method: 'item/delta', params: { threadId: 'thread', delta: { text } } });

  // The first complete snapshot can only fit as a readback locator.
  f.broker.routeServerMessage(delta('x'.repeat(250 * 1024)));
  f.broker.routeServerMessage(change(1, full));
  f.broker.routeServerMessage(change(2, { ...locator, revision: 99 }));
  f.broker.routeServerMessage(change(2, full));
  for (let index = 0; index < 62; index++) f.broker.routeServerMessage(delta('a'));

  f.reply(resume, { thread: { id: 'thread' } });
  assert.equal(viewer.messages.find(message => message.id === 2)?.result?.thread.id, 'thread');
  assert.deepEqual(viewer.messages.filter(message => message.method === 'asyncQuestion/changed'),
    [change(1, locator)]);
  assert.equal(viewer.messages.filter(message => message.method === 'item/delta').length, 63);
  assert.equal(f.broker.threadOwners.get('thread'), f.owner);
  assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
});

test('a compacted exclusive resume replay does not enter a later shared resume', t => {
  const f = fixture(t);
  const exclusive = f.client(), viewer = f.client();
  exclusive.gatewaySharedThreadsV1 = false;
  const threadId = 'recovering-thread';
  const originalResume = f.send(exclusive, 'thread/resume', threadId);
  assert.ok(originalResume);
  const notify = (method, params) => f.broker.routeServerMessage({ method, params: { threadId, ...params } });
  const locator = { threadId, questionId: 'original-question', requestId: 'request',
    sourceTurnId: 'source', toolCallId: 'tool', revision: 1 };
  notify('item/delta', { sequence: 1, delta: { text: 'x'.repeat(250 * 1024) } });
  notify('asyncQuestion/changed', { sequence: 2, question: { ...locator, createdAtMs: 1, status: 'pending',
    questions: [{ id: 'item', header: 'Format', question: 'Which format? '.repeat(1000), options: [], multiSelect: false }],
  } });

  const sharedResume = f.send(viewer, 'thread/resume', threadId);
  assert.ok(sharedResume);
  const result = { thread: { id: threadId } };
  f.reply(originalResume, result);
  f.reply(sharedResume, result);

  const updates = client => client.messages.filter(message => message.method === 'asyncQuestion/changed');
  assert.deepEqual(updates(exclusive).map(message => message.params.question), [locator],
    'the original owner must receive the compacted handoff');
  assert.equal(viewer.messages.at(0)?.result?.thread?.id, threadId);
  assert.deepEqual(updates(viewer), [], 'the earlier replay must not be a new event in the later handoff');

  notify('asyncQuestion/changed', { sequence: 3, question: { ...locator, revision: 2, status: 'cancelled' } });
  assert.deepEqual(updates(viewer).map(message => message.params.question.revision), [2]);
  assert.ok(f.send(viewer, 'asyncQuestion/list', threadId));
});
