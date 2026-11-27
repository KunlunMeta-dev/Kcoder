import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';

const question = {
  threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'cancelled',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
};

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
  const client = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
  let sequence = 0;
  const send = (method, params = {}) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread', ...params } }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  reply(send('thread/resume'), { thread: { id: 'thread' } });
  return { broker, client, upstream, send, reply };
}

for (const sparse of [false, true]) {
  for (const [name, questionId] of [
    ['missing', undefined], ['empty', ''], ['Rust whitespace', '\u0085'],
    ['invalid Unicode', '\ud800'], ['UTF-8 overflow', '问'.repeat(86)],
  ]) {
    for (const method of ['asyncQuestion/list', 'asyncQuestion/cancel']) {
      // Missing IDs cannot match cancellation; invalid Unicode requests are
      // already rejected before reaching the shared app-server stream.
      if (method === 'asyncQuestion/cancel' &&
          (questionId === undefined || !questionId.isWellFormed())) continue;
      test(`${method} rejects ${name} question identity (${sparse ? 'legacy sparse' : 'full'} snapshot)`, t => {
        const f = fixture(t);
        const saved = sparse ? { threadId: 'thread', questionId } : { ...question, questionId };
        assert.equal(hasValidAsyncQuestionNotificationBinding({ threadId: 'thread', question: {
          ...saved, revision: 2,
        } }), false, 'notifications already reject this unusable question identity');
        const request = f.send(method, method === 'asyncQuestion/cancel'
          ? { questionId, expectedRevision: 1 } : { includeTerminal: true });
        f.reply(request, { threadId: 'thread', ...(method === 'asyncQuestion/list'
          ? { questions: [{ ...question, questionId: 'peer' }, saved] } : { question: saved }) });
        assert.equal(f.client.messages.at(-1).error?.code, -32001,
          'an unusable question identity cannot confirm refresh or withdrawal');
        assert.equal(f.client.messages.at(-1).result, undefined, 'no partial card list is exposed');
        f.reply(f.send('asyncQuestion/list', { includeTerminal: true }), { threadId: 'thread', questions: [question] });
        assert.deepEqual(f.client.messages.at(-1).result.questions, [question]);
        assert.equal(f.broker.threadOwners.get('thread'), f.client);
        assert.equal(f.broker.activeTurns.size, 0);
        assert.equal(f.broker.threadDrains.size, 0);
        assert.equal(f.upstream.filter(message => message.method === method).length,
          method === 'asyncQuestion/list' ? 2 : 1);
        assert.equal(f.upstream.some(message => ['asyncQuestion/answer', 'turn/start', 'turn/interrupt'].includes(message.method)), false);
      });
    }
  }
}

for (const questionId of ['问'.repeat(85) + 'x', '\ufeff', ' question ']) {
  test(`valid exact question identity remains readable: ${JSON.stringify(questionId)}`, t => {
    const f = fixture(t);
    for (const saved of [{ ...question, questionId }, { threadId: 'thread', questionId }]) {
      for (const method of ['asyncQuestion/list', 'asyncQuestion/cancel']) {
        const result = { threadId: 'thread', ...(method === 'asyncQuestion/list'
          ? { questions: [saved] } : { question: saved }) };
        f.reply(f.send(method, method === 'asyncQuestion/list'
          ? { includeTerminal: true } : { questionId, expectedRevision: 1 }), result);
        assert.deepEqual(f.client.messages.at(-1).result, result, 'preserve exact identity and legacy omissions');
      }
    }
  });
}
