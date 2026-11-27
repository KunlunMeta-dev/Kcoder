import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
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
  broker.receive(client, JSON.stringify({ id: 'resume', method: 'thread/resume', params: { threadId: 'thread' } }));
  child.stdout.write(`${JSON.stringify({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } })}\n`);
  return { broker, child, upstream, client };
}

const operations = {
  'asyncQuestion/list': { threadId: 'thread', includeTerminal: true },
  'asyncQuestion/answer': { threadId: 'thread', questionId: 'question', submissionId: 'submission',
    expectedRevision: 1, answers: { item: { text: 'Original answer' } } },
  'asyncQuestion/cancel': { threadId: 'thread', questionId: 'question', expectedRevision: 1 },
};

for (const [method, params] of Object.entries(operations)) {
  for (const rawId of ['-1', '-0', '1.5', '1e999', '9007199254740993', '1.0000000000000001', '1e0']) {
    test(`${method} rejects unrepresentable request ID ${rawId} before upstream rewriting`, t => {
      const f = fixture(t), writes = f.upstream.length;
      // Keep the actual JSON numeral: stringify would turn infinity into null
      // or round an unsafe integer before this reaches the receive boundary.
      f.broker.receive(f.client, `{"id":${rawId},"method":${JSON.stringify(method)},"params":${JSON.stringify(params)}}`);
      assert.equal(f.upstream.length, writes, 'an invalid correlation ID cannot authorize a rewritten operation');
      assert.equal(f.client.messages.at(-1).error?.code, -32602);
      assert.match(f.client.messages.at(-1).error.message, /request ID/);
      assert.equal(f.client.messages.at(-1).id, null, 'a rounded ID cannot claim another request’s reply');
      assert.equal(f.broker.pending.size, 0, 'rejected input cannot leave an uncorrelatable waiter');
      assert.equal(f.broker.threadOwners.get('thread'), f.client);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      f.broker.receive(f.client, JSON.stringify({ id: 'corrected', method: 'asyncQuestion/list',
        params: operations['asyncQuestion/list'] }));
      f.child.stdout.write(`${JSON.stringify({ id: f.upstream.at(-1).id,
        result: { threadId: 'thread', questions: [] } })}\n`);
      assert.deepEqual(f.client.messages.at(-1), { id: 'corrected', result: { threadId: 'thread', questions: [] } });
      assert.equal(f.upstream.length, writes + 1, 'explicit readback never replays a rejected mutation');
    });
  }
}

for (const id of [0, Number.MAX_SAFE_INTEGER, '', '原请求-😀', '9007199254740993']) {
  test(`valid request ID ${JSON.stringify(id)} retains exact response correlation`, t => {
    const f = fixture(t);
    f.broker.receive(f.client, JSON.stringify({ id, method: 'asyncQuestion/list',
      params: operations['asyncQuestion/list'] }));
    assert.equal(f.upstream.at(-1).method, 'asyncQuestion/list');
    f.child.stdout.write(`${JSON.stringify({ id: f.upstream.at(-1).id,
      result: { threadId: 'thread', questions: [] } })}\n`);
    assert.equal(f.client.messages.at(-1).id, id);
  });
}

for (const method of ['asyncQuestion/answer', 'asyncQuestion/cancel']) {
  for (const revision of ['9007199254740993', '1e999', '1.0000000000000001', '1e0']) {
    test(`${method} rejects unrepresentable expectedRevision ${revision} before forwarding`, t => {
      const f = fixture(t), writes = f.upstream.length;
      const params = JSON.stringify({ ...operations[method], expectedRevision: 'revision-marker' })
        .replace('"revision-marker"', revision);
      f.broker.receive(f.client, `{"id":"mutation","method":${JSON.stringify(method)},"params":${params}}`);
      assert.equal(f.upstream.length, writes, 'a rounded revision cannot reach the original task');
      assert.equal(f.client.messages.at(-1).error?.code, -32602);
      assert.match(f.client.messages.at(-1).error.message, /expectedRevision/);
      assert.equal(f.broker.pending.size, 0);

      f.broker.receive(f.client, JSON.stringify({ id: 'readback', method: 'asyncQuestion/list',
        params: operations['asyncQuestion/list'] }));
      assert.equal(f.upstream.length, writes + 1);
      assert.equal(f.upstream.at(-1).method, 'asyncQuestion/list');
    });
  }

  for (const expectedRevision of [0, null, undefined, "1"]) {
    test(`${method} rejects invalid expectedRevision ${JSON.stringify(expectedRevision)} locally`, t => {
      const f = fixture(t), writes = f.upstream.length;
      f.broker.receive(f.client, JSON.stringify({ id: 'invalid-revision', method,
        params: { ...operations[method], expectedRevision } }));
      assert.equal(f.upstream.length, writes, 'an invalid revision must not reach the original task');
      assert.equal(f.broker.pending.size, 0);
      assert.equal(f.client.messages.at(-1).id, 'invalid-revision');
      assert.equal(f.client.messages.at(-1).error?.code, -32602);
      assert.match(f.client.messages.at(-1).error.message, /expectedRevision/);
      assert.equal(f.broker.threadOwners.get('thread'), f.client);

      f.broker.receive(f.client, JSON.stringify({ id: 'readback', method: 'asyncQuestion/list',
        params: operations['asyncQuestion/list'] }));
      assert.equal(f.upstream.length, writes + 1);
      assert.equal(f.upstream.at(-1).method, 'asyncQuestion/list');
    });
  }

  test(`${method} forwards the largest safe expectedRevision unchanged`, t => {
    const f = fixture(t);
    f.broker.receive(f.client, JSON.stringify({ id: 'mutation', method,
      params: { ...operations[method], expectedRevision: Number.MAX_SAFE_INTEGER } }));
    assert.equal(f.upstream.at(-1).method, method);
    assert.equal(f.upstream.at(-1).params.expectedRevision, Number.MAX_SAFE_INTEGER);
  });
}

test('escaped revision keys receive the same validation on Buffer frames', t => {
  const f = fixture(t), writes = f.upstream.length;
  const frame = String.raw`{"id":"mutation","method":"asyncQuestion/cancel","params":{"threadId":"thread","questionId":"question","expected\u0052evision":REVISION}}`;
  f.broker.receive(f.client, Buffer.from(frame.replace('REVISION', '1.0000000000000001')));
  assert.equal(f.upstream.length, writes);
  assert.deepEqual(f.client.messages.at(-1), {
    jsonrpc: '2.0', id: 'mutation', error: { code: -32602, message: 'Invalid async question expectedRevision' },
  });

  f.broker.receive(f.client, Buffer.from(frame.replace('REVISION', '1')));
  assert.equal(f.upstream.length, writes + 1);
  assert.equal(f.upstream.at(-1).params.expectedRevision, 1);
});

test('answer text overflow cannot be rewritten into a valid option-only submission', t => {
  const f = fixture(t), writes = f.upstream.length;
  const params = { ...operations['asyncQuestion/answer'],
    answers: { item: { selectedOptionIds: ['option'], text: 'text-marker' } } };
  // JSON.parse preserves the overflow as Infinity, which JSON.stringify would
  // otherwise turn into Rust's valid optional null text.
  const request = JSON.stringify({ id: 'overflow', method: 'asyncQuestion/answer', params });
  f.broker.receive(f.client, request.replace('"text-marker"', '1e999'));

  assert.deepEqual(f.upstream.slice(writes).map(message => message.params.answers), [],
    'invalid text must not reach the original task as an option-only answer');
  assert.equal(f.client.messages.at(-1).error?.code, -32602);
  assert.equal(f.broker.pending.size, 0);

  f.broker.receive(f.client, request.replace('"overflow"', '"explicit"').replace('"text-marker"', 'null'));
  assert.equal(f.upstream.at(-1).method, 'asyncQuestion/answer');
  assert.deepEqual(f.upstream.at(-1).params.answers, {
    item: { selectedOptionIds: ['option'], text: null },
  });
  assert.equal(f.upstream.length, writes + 1);
});

test('list filter overflow cannot become an unfiltered request parameter', t => {
  const f = fixture(t), writes = f.upstream.length;
  f.broker.receive(f.client, '{"id":"overflow","method":"asyncQuestion/list","params":{"threadId":"thread","includeTerminal":1e999}}');

  assert.deepEqual(f.upstream.slice(writes).map(message => message.params), [],
    'an invalid filter must not reach the original task as null');
  assert.equal(f.client.messages.at(-1).error?.code, -32602);
  assert.equal(f.broker.pending.size, 0);

  const question = { threadId: 'thread', questionId: 'question', status: 'cancelled', revision: 2 };
  for (const includeTerminal of [true, false, null, undefined]) {
    const id = `readback-${includeTerminal}`;
    f.broker.receive(f.client, JSON.stringify({ id, method: 'asyncQuestion/list',
      params: { threadId: 'thread', includeTerminal } }));
    const request = f.upstream.at(-1);
    assert.equal(request.method, 'asyncQuestion/list');
    assert.equal(request.params.includeTerminal, includeTerminal);
    const questions = includeTerminal === true ? [question] : [];
    const result = { threadId: 'thread', questions };
    f.child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    assert.deepEqual(f.client.messages.at(-1), { id, result });
  }
  assert.equal(f.upstream.length, writes + 4);
});

test('a repeated request ID cannot claim the reply of an outstanding request', t => {
  const f = fixture(t);
  f.broker.receive(f.client, JSON.stringify({ id: 'readback', method: 'asyncQuestion/list',
    params: operations['asyncQuestion/list'] }));
  const original = f.upstream.at(-1), writes = f.upstream.length;
  f.broker.receive(f.client, String.raw`{"id":"different","\u0069d":"readback","method":"asyncQuestion/cancel","params":{"threadId":"thread","questionId":"question","expectedRevision":1}}`);

  assert.equal(f.upstream.length, writes, 'an ambiguous ID must not forward a cancel');
  assert.equal(f.client.messages.at(-1).id, null);
  assert.equal(f.client.messages.at(-1).error?.code, -32602);
  assert.equal(f.broker.pending.size, 1);
  f.child.stdout.write(`${JSON.stringify({ id: original.id, result: { threadId: 'thread', questions: [] } })}\n`);
  assert.deepEqual(f.client.messages.at(-1), { id: 'readback', result: { threadId: 'thread', questions: [] } });
  assert.equal(f.broker.pending.size, 0);
});

for (const [field, frame] of [
  ['params', '{"params":{"threadId":"another"},"params":{"threadId":"thread","questionId":"question","expectedRevision":1}}'],
  ['threadId', '{"params":{"threadId":"another","threadId":"thread","questionId":"question","expectedRevision":1}}'],
  ['expectedRevision', String.raw`{"params":{"threadId":"thread","questionId":"question","expectedRevision":2,"expected\u0052evision":1}}`],
]) {
  test(`cancel rejects duplicate ${field} before binding to the original task`, t => {
    const f = fixture(t), writes = f.upstream.length;
    f.broker.receive(f.client, Buffer.from(frame.replace('{', '{"id":"cancel","method":"asyncQuestion/cancel",')));
    assert.equal(f.upstream.length, writes);
    assert.equal(f.client.messages.at(-1).id, 'cancel');
    assert.equal(f.client.messages.at(-1).error?.code, -32602);
    assert.equal(f.broker.pending.size, 0);
    assert.equal(f.broker.threadOwners.get('thread'), f.client);
  });
}

for (const [duplicate, answers] of [
  ['item ID', String.raw`{"item":{"text":"First"},"\u0069tem":{"text":"Second"}}`],
  ['text', '{"item":{"text":"First","text":"Second"}}'],
  ['selectedOptionIds', '{"item":{"selectedOptionIds":["first"],"selectedOptionIds":["second"]}}'],
]) {
  test(`answer rejects duplicate ${duplicate} before rewriting the selected answer`, t => {
    const f = fixture(t), writes = f.upstream.length;
    const params = JSON.stringify({ ...operations['asyncQuestion/answer'], answers: 'answer-marker' })
      .replace('"answer-marker"', answers);
    f.broker.receive(f.client, Buffer.from(`{"id":"answer","method":"asyncQuestion/answer","params":${params}}`));

    assert.equal(f.upstream.length, writes, 'an ambiguous answer must not be forwarded');
    assert.equal(f.client.messages.at(-1).id, 'answer');
    assert.equal(f.client.messages.at(-1).error?.code, -32602);
    assert.equal(f.broker.pending.size, 0);

    const corrected = { item: { text: 'First' }, other: { text: 'Second' } };
    f.broker.receive(f.client, JSON.stringify({ id: 'corrected', method: 'asyncQuestion/answer',
      params: { ...operations['asyncQuestion/answer'], answers: corrected } }));
    assert.equal(f.upstream.length, writes + 1);
    assert.deepEqual(f.upstream.at(-1).params.answers, corrected);
  });
}
