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
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const serverMessage = message => {
    const line = `${JSON.stringify(message)}\n`, middle = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, middle)); child.stdout.write(line.slice(middle));
  };
  const client = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  Object.assign(client, { initialized: true, asyncUserQuestionsV1: true });
  let sequence = 0;
  const send = (method, params = {}) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread', ...params } }));
    assert.ok(upstream.length > before, `${method} must reach the backend`);
    return upstream.at(-1);
  };
  serverMessage({ id: send('thread/resume').id, result: { thread: { id: 'thread' } } });
  const answer = send('asyncQuestion/answer', { questionId: 'question', submissionId: 'submission',
    expectedRevision: 1, answers: { item: { text: 'original answer' } } });
  const answerReceipt = () => serverMessage({ id: answer.id, result: {
    threadId: 'thread', accepted: true, duplicate: false,
    question: {
      requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
      questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }], threadId: 'thread', questionId: 'question',
      answer: { acceptedAtMs: 2, submissionId: 'submission', answers: answer.params.answers } },
    startedTurn: { id: 'answer-turn', status: 'running' },
  } });
  return { broker, client, send, serverMessage, upstream, answer, answerReceipt };
}

for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
  for (const deleted of [true, false]) {
    test(`${lifecycle}: ${deleted ? 'confirmed' : 'rejected'} deletion fences a delayed answer admission`, t => {
      const f = fixture(t);
      const deletion = f.send('thread/delete');
      if (lifecycle.startsWith('expired')) f.broker.expireRequest(f.answer.id);
      f.serverMessage({ id: deletion.id, ...(deleted
        ? { result: { threadId: 'thread', deleted: true } }
        : { error: { code: -32036, message: 'cannot delete active runtime' } }) });
      if (lifecycle.endsWith('disconnected')) f.broker.detach(f.client);
      const delivered = f.client.messages.length;
      f.answerReceipt();
      const disconnected = lifecycle.endsWith('disconnected');
      assert.equal(f.broker.activeTurns.has('thread'), !deleted && !disconnected,
        'a receipt from before confirmed deletion cannot recreate an active turn');
      assert.equal(f.broker.threadOwners.has('thread'), !deleted && !disconnected,
        'the released task binding must not be restored by a delayed receipt');
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), !deleted && disconnected,
        'deleted task admissions must not generate stale interruption or drain work');
      assert.equal(f.broker.threadDrains.has('thread'), !deleted && disconnected);
      if (deleted) assert.equal(f.broker.hasPendingWork, false,
        'settled deleted-task receipts must not keep the Gateway busy');
      if (lifecycle === 'connected') assert.equal(f.client.messages.at(-1).result?.accepted, true,
        'preserve the authoritative answer receipt without restoring the deleted binding');
      else assert.equal(f.client.messages.length, delivered, 'do not redeliver an expired or detached answer');
    });
  }
}

test('deleting a different task does not invalidate this answer admission', t => {
  const f = fixture(t);
  const deletion = f.send('thread/delete', { threadId: 'other-thread' });
  f.serverMessage({ id: deletion.id, result: { threadId: 'other-thread', deleted: true } });
  f.answerReceipt();
  assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'answer-turn', owner: f.client });
});

for (const [method, flag] of [['thread/delete', 'deleted'], ['thread/dispose', 'disposed']]) {
  test(`${method} cannot drop question access on a task named only by the receipt`, t => {
    const f = fixture(t);
    const release = f.send(method, { threadId: 'other-thread' });
    f.serverMessage({ id: release.id, result: { threadId: 'thread', [flag]: true } });

    assert.equal(f.broker.threadOwners.has('thread'), true, 'the unrelated task must retain question access');
    assert.equal(f.client.messages.at(-1).error?.code, -32001);
    const list = f.send('asyncQuestion/list', { includeTerminal: true });
    f.serverMessage({ id: list.id, result: { threadId: 'thread', questions: [] } });
    assert.deepEqual(f.client.messages.at(-1).result.questions, []);
    f.answerReceipt();
    assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'answer-turn', owner: f.client });
    assert.deepEqual(f.upstream.map(message => message.method),
      ['thread/resume', 'asyncQuestion/answer', method, 'asyncQuestion/list']);
  });
}

test('an unconfirmed deletion does not invalidate the original answer admission', t => {
  const f = fixture(t);
  const deletion = f.send('thread/delete');
  f.broker.expireRequest(deletion.id);
  assert.match(f.client.messages.at(-1).error?.message, /unknown/);
  f.answerReceipt();
  assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'answer-turn', owner: f.client });
  assert.equal(f.broker.threadOwners.get('thread'), f.client);
});

for (const method of ['thread/delete', 'thread/dispose']) {
  for (const result of [undefined, null, false, []]) {
    test(`${method} with result ${JSON.stringify(result)} cannot release pending question access`, t => {
      const f = fixture(t);
      const list = f.send('asyncQuestion/list', { includeTerminal: true });
      const release = f.send(method);
      f.serverMessage({ id: release.id, result });

      assert.equal(f.client.messages.at(-1).error?.code, -32001);
      assert.equal(f.broker.threadOwners.get('thread'), f.client);
      const questions = [{ threadId: 'thread', questionId: 'question', revision: 1 }];
      f.serverMessage({ id: list.id, result: { threadId: 'thread', questions } });
      assert.deepEqual(f.client.messages.at(-1).result?.questions, questions);
      f.answerReceipt();
      assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'answer-turn');
      assert.deepEqual(f.upstream.map(message => message.method),
        ['thread/resume', 'asyncQuestion/answer', 'asyncQuestion/list', method]);
    });
  }
}
