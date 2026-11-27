import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { projectAsyncQuestionResponse } from '../src/broker-async-questions.js';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, lifetime) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: lifetime,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  let sequence = 0;
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result, jsonrpc, method, params) => child.stdout.write(`${JSON.stringify({ id: request.id, result, jsonrpc, method, params })}\n`);
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId: 'thread' }), { thread: { id: 'thread' } });
    return client;
  };
  return { broker, upstream, send, reply, join, stdout: child.stdout };
}

const question = {
  requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1,
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }], threadId: 'thread', questionId: 'question', revision: 2, status: 'queued',
  answer: { acceptedAtMs: 2, submissionId: 'submission', answers: { item: { text: 'original answer' } } } };

for (const corrupt of [true, false]) {
  test(`answer receipt preserves its UTF-8 bytes (corrupt=${corrupt})`, t => {
    const f = fixture(t, true), original = f.join(), answerer = f.join();
    const saved = structuredClone(question);
    saved.answer.answers.item.text = '原�答案';
    const answer = f.send(answerer, 'asyncQuestion/answer', {
      threadId: 'thread', questionId: 'question', expectedRevision: 1,
      submissionId: 'submission', answers: saved.answer.answers,
    });
    const read = f.send(original, 'asyncQuestion/list', { threadId: 'thread' });
    const result = { threadId: 'thread', question: saved, accepted: true, duplicate: false,
      startedTurn: { id: 'answer-turn', threadId: 'thread', status: 'running' } };
    const receipt = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: answer.id, result }) + '\n');
    const offset = receipt.indexOf(Buffer.from('�'));
    assert.ok(offset > 0);
    f.stdout.write(receipt.subarray(0, offset + (corrupt ? 0 : 1)));
    const tail = corrupt ? Buffer.concat([Buffer.from([0xff]), receipt.subarray(offset + 3)])
      : receipt.subarray(offset + 1);
    const readback = { threadId: 'thread', questions: [saved] };
    f.stdout.write(Buffer.concat([tail, Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: read.id, result: readback,
    }) + '\n')]));
    assert.equal(f.broker.threadOwners.get('thread') === answerer, !corrupt,
      'a receipt with corrupted answer bytes cannot transfer control');
    assert.equal(f.broker.activeTurns.has('thread'), !corrupt);
    assert.deepEqual(original.messages.at(-1).result, readback);
    assert.equal(f.broker.closed, false);
    if (corrupt) {
      assert.equal(answerer.messages.at(-1).error?.code, -32045);
      assert.match(answerer.messages.at(-1).error.message, /invalid UTF-8/);
    } else {
      assert.deepEqual(answerer.messages.at(-1).result, result);
    }
  });
}

for (const malformed of ['answer text', 'escaped answer key', 'result', 'id', 'fractional id',
  'rounded revision', 'fractional creation time', 'exponent acceptance time']) {
  test(`ambiguous wire receipt cannot transfer task control (${malformed})`, t => {
    const f = fixture(t, true), original = f.join(), answerer = f.join();
    const answer = f.send(answerer, 'asyncQuestion/answer', {
      threadId: 'thread', questionId: 'question', expectedRevision: 1,
      submissionId: 'submission', answers: question.answer.answers,
    });
    const result = { threadId: 'thread', question, accepted: true, duplicate: false,
      startedTurn: { id: 'answer-turn', threadId: 'thread', status: 'running' } };
    const valid = JSON.stringify({ jsonrpc: '2.0', id: answer.id, result });
    const replacements = {
      'answer text': ['"text":', '"text":"different answer","text":'],
      'escaped answer key': ['"item":', '"\\u0069tem":{"text":"different answer"},"item":'],
      result: ['"result":', '"result":null,"result":'],
      id: ['"id":', '"id":0,"id":'],
      'rounded revision': ['"revision":2', '"revision":2.0000000000000001'],
      'fractional creation time': ['"createdAtMs":1', '"createdAtMs":1.0'],
      'exponent acceptance time': ['"acceptedAtMs":2', '"acceptedAtMs":2e0'],
      'fractional id': [`"id":${answer.id},`, `"id":${answer.id}.0,`],
    };
    const corrupt = valid.replace(...replacements[malformed]);
    assert.notEqual(corrupt, valid);
    f.stdout.write(corrupt + '\n');
    assert.equal(f.broker.threadOwners.get('thread'), original);
    assert.equal(f.broker.activeTurns.size, 0);
    const ambiguousId = malformed === 'id' || malformed === 'fractional id';
    assert.equal(f.broker.pending.has(answer.id), ambiguousId);
    if (!ambiguousId) assert.equal(answerer.messages.at(-1).error?.code, -32001);
    const read = f.send(original, 'asyncQuestion/list', { threadId: 'thread' });
    f.reply(read, { threadId: 'thread', questions: [question] });
    assert.deepEqual(original.messages.at(-1).result.questions, [question]);
    if (ambiguousId) {
      f.stdout.write(valid + '\n');
      assert.deepEqual(answerer.messages.at(-1).result, result);
    }
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

test('a rounded revision cannot enter list readback or confirm withdrawal', t => {
  const f = fixture(t, true), client = f.join();
  const cancelled = { ...question, status: 'cancelled', revision: 3 };
  for (const [method, params, result] of [
    ['asyncQuestion/list', { threadId: 'thread', includeTerminal: true },
      { threadId: 'thread', questions: [question, { ...cancelled, questionId: 'other',
        requestId: 'other-request', toolCallId: 'other-tool' }] }],
    ['asyncQuestion/cancel', { threadId: 'thread', questionId: 'question', expectedRevision: 2 },
      { threadId: 'thread', question: cancelled }],
  ]) {
    const request = f.send(client, method, params);
    const frame = JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
      .replace('"revision":3', '"revision":3.0000000000000001');
    f.stdout.write(frame + '\n');
    assert.equal(client.messages.at(-1).error?.code, -32001);
    assert.equal(client.messages.at(-1).result, undefined);
  }
  const result = { threadId: 'thread', questions: [cancelled] };
  f.reply(f.send(client, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true }), result);
  assert.deepEqual(client.messages.at(-1).result, result);
  assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/cancel').length, 1);
});

for (const lifetime of [false, true]) {
  for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
    for (const [jsonrpc, method, params] of [
      ...['1.0', null, 2, {}].map(jsonrpc => [jsonrpc, undefined]),
      ...[null, '', false, 0].map(method => ['2.0', method]),
      ['2.0', undefined, { threadId: 'other-thread' }],
    ]) {
      test(`invalid answer receipt envelope ${JSON.stringify({ jsonrpc, method, params })} fences task control (${lifecycle}, lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime), original = f.join(), answerer = f.join();
        const answer = f.send(answerer, 'asyncQuestion/answer', {
          threadId: 'thread', questionId: 'question', expectedRevision: 1,
          submissionId: 'submission', answers: question.answer.answers,
        });
        if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
        if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
        const deliveries = answerer.messages.length;
        f.reply(answer, { threadId: 'thread', question, accepted: true, duplicate: false,
          startedTurn: { id: 'answer-turn', status: 'running' } }, jsonrpc, method, params);
        assert.equal(f.broker.threadOwners.get('thread'), original,
          'a correlation ID with an invalid response envelope cannot transfer task control');
        assert.equal(f.broker.activeTurns.size, 0, 'unconfirmed execution cannot become active');
        assert.equal(f.broker.threadDrains.size, 0, 'unconfirmed execution cannot block task recovery');
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
          'a late malformed receipt cannot authorize disconnect cleanup');
        if (lifecycle === 'connected') {
          assert.equal(answerer.messages.at(-1).error?.code, -32001);
          assert.match(answerer.messages.at(-1).error.message, /unknown/i);
        } else assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');
        // Read the original persisted answer rather than replaying its mutation.
        f.reply(f.send(original, 'asyncQuestion/list', { threadId: 'thread' }), {
          threadId: 'thread', questions: [question],
        }, '2.0');
        assert.deepEqual(original.messages.at(-1).result.questions, [question]);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
      });
    }
  }
  for (const jsonrpc of [undefined, '2.0']) {
    test(`valid answer receipt version ${JSON.stringify(jsonrpc)} retains control (lifetime=${lifetime})`, t => {
      const f = fixture(t, lifetime);
      f.join();
      const answerer = f.join();
      const answer = f.send(answerer, 'asyncQuestion/answer', {
        threadId: 'thread', questionId: 'question', expectedRevision: 1,
        submissionId: 'submission', answers: question.answer.answers,
      });
      f.reply(answer, { threadId: 'thread', question, accepted: true, duplicate: false,
        startedTurn: { id: 'answer-turn', status: 'running' } }, jsonrpc);
      assert.equal(f.broker.threadOwners.get('thread'), answerer);
      assert.deepEqual(f.broker.activeTurns.get('thread'), { owner: answerer, turnId: 'answer-turn' });
      assert.equal(answerer.messages.at(-1).result.accepted, true);
      assert.equal(f.broker.threadDrains.size, 0);
    });
  }
}

for (const operation of ['asyncQuestion/list', 'asyncQuestion/cancel']) {
  for (const [jsonrpc, method, params] of [
    ...['1.0', null, 2, {}].map(jsonrpc => [jsonrpc, undefined]),
    ...[null, '', false, 0].map(method => ['2.0', method]),
    ['2.0', undefined, null],
  ]) {
    test(`${operation} cannot publish a receipt with envelope ${JSON.stringify({ jsonrpc, method, params })}`, t => {
      const f = fixture(t, true), client = f.join();
      const request = f.send(client, operation, { threadId: 'thread', questionId: 'question', expectedRevision: 1 });
      f.reply(request, { threadId: 'thread', ...(operation === 'asyncQuestion/list'
        ? { questions: [question] } : { question: { ...question, status: 'cancelled' } }) }, jsonrpc, method, params);
      assert.equal(client.messages.at(-1).error?.code, -32001, 'invalid receipts cannot replace or close the card');
      f.reply(f.send(client, 'asyncQuestion/list', { threadId: 'thread' }), {
        threadId: 'thread', questions: [question],
      }, '2.0');
      assert.deepEqual(client.messages.at(-1).result.questions, [question]);
    });
  }
}

for (const operation of ['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']) {
  for (const method of [undefined, null, '', false, 0]) {
    test(`${operation} confirms a refusal only without a method field (${JSON.stringify(method)})`, () => {
      const response = { id: 1, method, error: { code: -32602, message: 'Original refusal' } };
      const projected = projectAsyncQuestionResponse(response, { method: operation, params: { threadId: 'thread' } });
      if (method === undefined) assert.equal(projected, response, 'valid refusal retains its original meaning');
      else {
        assert.equal(projected.error?.code, -32001);
        assert.match(projected.error.message, /unknown/i, 'a malformed refusal cannot authorize a mutation retry');
      }
    });
  }
}
