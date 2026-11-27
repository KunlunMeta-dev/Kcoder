import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, shared, session = { sessionId: 'current' }) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'gateway-target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { ...session,
    capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emitRaw = line => child.stdout.write(`${line}\n`);
  const emit = message => emitRaw(JSON.stringify(message));
  let sequence = 0;
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  return { broker, upstream, emit, emitRaw, resume };
}

const changed = (serverId, revision = 1) => ({ method: 'asyncQuestion/changed', params: {
  ...(serverId === undefined ? {} : { serverId }), threadId: 'thread',
  question: { threadId: 'thread', questionId: 'question', revision },
} });

for (const shared of [false, true]) {
  const mode = shared ? 'shared' : 'exclusive';
  for (const order of ['legacy-first', 'identified-first', 'compacted-legacy-first', 'compacted-conflicting-replay']) {
    test(`${mode}: the initialized producer shares resume capacity across question aliases (${order})`, t => {
      const f = fixture(t, shared), owner = shared ? f.resume() : null;
      owner?.finish();
      const recovering = f.resume();
      const legacy = changed(undefined);
      legacy.params.sequence = RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames;
      Object.assign(legacy.params.question, {
        requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', status: 'pending',
        createdAtMs: 1,
        questions: [{ id: 'item', header: 'Details', question: 'Continue?', options: [], multiSelect: false }],
      });
      const identified = { ...legacy, params: { ...legacy.params, serverId: 'server-current' } };
      const conflict = order === 'compacted-conflicting-replay';
      if (conflict) identified.params.question = { ...legacy.params.question, toolCallId: 'another-tool' };
      const compacted = order.startsWith('compacted-');
      const [first, replay] = order === 'identified-first' ? [identified, legacy] : [legacy, identified];
      const expected = compacted ? { ...legacy, params: { ...legacy.params, question: {
        threadId: 'thread', questionId: 'question', revision: 1,
        requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool',
      } } } : first;
      const progress = Array.from({ length: RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames - 1 },
        (_, index) => ({ method: 'item/delta', params: { threadId: 'thread', delta: { text: String(index) } } }));
      if (compacted) {
        const bytes = [...progress, expected].reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0);
        progress[0].params.delta.text += 'x'.repeat(RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes - bytes);
      }
      for (const frame of progress) f.emit(frame);
      f.emit(first);
      f.emit(replay);
      recovering.finish();

      const [response, ...replayed] = recovering.client.messages;
      if (conflict) {
        assert.equal(response?.error?.code, -32047, 'compaction must preserve conflicting source evidence');
        assert.deepEqual(replayed, []);
      } else {
        assert.equal(response?.result?.thread?.id, 'thread', JSON.stringify(response?.error));
        assert.deepEqual(replayed, [...progress, expected]);
      }
      assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
    });
  }

  for (const field of ['createdAtMs', 'acceptedAtMs']) {
    test(`${mode}: equivalent ${field} zero timestamps share a resume slot`, t => {
      const f = fixture(t, shared), owner = shared ? f.resume() : null;
      owner?.finish();
      const recovering = f.resume();
      const full = changed('server-current', 2);
      Object.assign(full.params.question, {
        requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', status: 'queued',
        createdAtMs: 0,
        questions: [{ id: 'item', header: 'Details', question: 'Continue?', options: [], multiSelect: false }],
        answer: { acceptedAtMs: 0, submissionId: 'submission', answers: { item: { text: 'Yes' } } },
      });
      f.emit(full);
      const progress = Array.from({ length: RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames - 1 },
        (_, index) => ({ method: 'item/delta', params: { threadId: 'thread', delta: { text: String(index) } } }));
      for (const frame of progress) f.emit(frame);
      f.emitRaw(JSON.stringify(full).replace(`"${field}":0`, `"${field}":-0`));
      recovering.finish();

      assert.equal(recovering.client.messages[0]?.error?.code, undefined,
        'the same durable snapshot must not exhaust the handoff');
      assert.equal(recovering.client.messages[0]?.result?.thread?.id, 'thread');
      assert.deepEqual(recovering.client.messages.slice(1), [full, ...progress]);
      assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
    });
  }

  for (const order of ['hint-first', 'snapshot-first', 'compacted-first', 'conflicting-source']) {
    test(`${mode}: resume preserves same-sequence question identity (${order})`, t => {
      const f = fixture(t, shared), owner = shared ? f.resume() : null;
      owner?.finish();
      const recovering = f.resume();
      const hint = changed('server-current', 3);
      const frameLimit = RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames;
      hint.params.sequence = frameLimit;
      const full = changed('server-current', 2);
      full.params.sequence = frameLimit;
      Object.assign(full.params.question, {
        requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', status: 'cancelled',
        createdAtMs: 1,
        questions: [{ id: 'item', header: 'Details', question: 'Continue?', options: [], multiSelect: false }],
      });
      const conflicting = order === 'conflicting-source';
      if (conflicting) hint.params.question.toolCallId = 'another-tool';
      const progress = Array.from({ length: frameLimit - (conflicting ? 2 : 1) },
        (_, index) => ({ method: 'item/delta', params: { threadId: 'thread', sequence: index + 1,
          delta: { text: String(index) } } }));
      const expected = order === 'compacted-first' ? { ...full, params: { ...full.params, question: {
        ...hint.params.question, revision: 2, requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool',
      } } } : full;
      if (order === 'compacted-first') {
        const retainedBytes = [...progress, expected].reduce((bytes, frame) =>
          bytes + Buffer.byteLength(JSON.stringify(frame)), 0);
        progress[0].params.delta.text += 'x'.repeat(RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes - retainedBytes);
      }
      for (const frame of progress) f.emit(frame);
      for (const frame of order === 'hint-first' ? [hint, full] : [full, hint]) f.emit(frame);
      recovering.finish();

      const [response, ...replayed] = recovering.client.messages;
      assert.equal(response?.result?.thread?.id, 'thread', JSON.stringify(response?.error));
      assert.deepEqual(replayed, conflicting ? [...progress, expected, hint] : [...progress, expected]);
      assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
    });
  }

  test(`${mode}: a foreign async question producer cannot break original-task recovery`, t => {
    const f = fixture(t, shared);
    const owner = shared ? f.resume() : null;
    owner?.finish();
    const recovering = f.resume();
    for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
      f.emit(changed('server-previous', index + 1));
    const current = changed('server-current', 2), legacy = changed(undefined, 3);
    legacy.params.question.questionId = 'another-question';
    f.emit(current);
    f.emit(legacy);
    recovering.finish();
    assert.ok(recovering.client.messages[0]?.result?.thread,
      'foreign producer frames must not exhaust the original resume handoff');
    assert.deepEqual(recovering.client.messages.slice(1), [current, legacy]);
    if (owner) assert.deepEqual(owner.client.messages.slice(1), [current, legacy],
      'live peers and recovering peers must enforce the same producer identity');
    assert.equal(f.broker.threadOwners.get('thread'), owner?.client ?? recovering.client);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
      'recovery must not answer, cancel or replay task input');
  });

  test(`${mode}: live async questions use the Native producer identity, preserving legacy omission`, t => {
    const f = fixture(t, shared), owner = f.resume();
    owner.finish();
    for (const serverId of ['server-previous', 'gateway-target', null]) f.emit(changed(serverId));
    assert.equal(owner.client.messages.length, 1, 'a foreign producer cannot refresh the original card');
    const current = changed('server-current'), legacy = changed(undefined, 2);
    f.emit(current);
    f.emit(legacy);
    assert.deepEqual(owner.client.messages.slice(1), [current, legacy]);
  });
}

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: malformed producer IDs cannot exhaust legacy resume handoff`, t => {
    const f = fixture(t, shared, {});
    const owner = shared ? f.resume() : null;
    owner?.finish();
    const recovering = f.resume();
    const invalidIds = [null, 7, '', '\u0085', '\ud800', 'x'.repeat(257)];
    for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++) {
      const frame = changed(invalidIds[index % invalidIds.length]);
      frame.params.question.questionId = `invalid-${index}`;
      f.emit(frame);
    }
    const legacy = changed(undefined), identified = changed('legacy-producer', 2);
    f.emit(legacy);
    f.emit(identified);
    recovering.finish();

    assert.equal(recovering.client.messages[0]?.result?.thread.id, 'thread');
    assert.deepEqual(recovering.client.messages.slice(1), [legacy, identified]);
    if (owner) assert.deepEqual(owner.client.messages.slice(1), [legacy, identified]);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });
}
