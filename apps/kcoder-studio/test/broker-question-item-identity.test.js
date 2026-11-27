import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : null;
  return { broker, upstream, emit, owner, viewer };
}

const item = { id: 'item', header: 'Choice', prompt: 'Which choice?', options: [], allowsFreeform: true };
for (const shared of [false, true]) {
  for (const [name, questions] of [
    ['Unicode blank option label', [{ ...item, options: [{ label: '\u0085', value: 'yes' }] }]],
    ['Unicode blank option value', [{ ...item, options: [{ label: 'Yes', value: '\u0085' }] }]],
    ['Unicode blank item', [{ ...item, id: '\u0085' }]],
    ['Unicode blank prompt', [{ ...item, prompt: '\u0085' }]],
    ['Unicode blank legacy prompt', [{ ...item, prompt: undefined, question: '\u0085' }]],
    ['empty items', []],
    ['null items', null],
    ['null item', [null]],
    ['missing item identity', [{ prompt: 'Missing identity' }]],
    ['empty item identity', [{ ...item, id: ' ' }]],
    ['numeric item identity', [{ ...item, id: 1 }]],
    ['non-Unicode item identity', [{ ...item, id: '\ud800' }]],
    ['non-Unicode prompt', [{ ...item, prompt: '\udfff' }]],
    ['non-Unicode legacy prompt', [{ ...item, prompt: undefined, question: '\ud800' }]],
    ['non-Unicode option label', [{ ...item, options: [{ label: '\udfff', value: 'yes' }] }]],
    ['non-Unicode option value', [{ ...item, options: [{ label: 'Yes', value: '\ud800' }] }]],
    ['duplicate item identity', [item, { ...item, prompt: 'A different question' }]],
    ['non-array items', { item }],
    ['null prompt', [{ ...item, prompt: null }]],
    ['blank prompt', [{ ...item, prompt: '   ' }]],
    ['numeric prompt', [{ ...item, prompt: 4 }]],
    ['null legacy prompt', [{ ...item, prompt: undefined, question: null }]],
    ['blank legacy prompt', [{ ...item, prompt: undefined, question: '   ' }]],
    ['numeric legacy prompt', [{ ...item, prompt: undefined, question: 4 }]],
    ['null options', [{ ...item, options: null }]],
    ['non-array options', [{ ...item, options: {} }]],
    ['null option', [{ ...item, options: [null] }]],
    ['non-object option', [{ ...item, options: ['Yes'] }]],
    ['missing option label and value', [{ ...item, options: [{}] }]],
    ['invalid explicit option label', [{ ...item, options: [{ label: 1, value: 'yes' }] }]],
    ['blank explicit option label', [{ ...item, options: [{ label: ' ', value: 'yes' }] }]],
    ['invalid explicit option value', [{ ...item, options: [{ label: 'Yes', value: null }] }]],
    ['blank explicit option value', [{ ...item, options: [{ label: 'Yes', value: ' ' }] }]],
  ]) test(`${shared ? 'shared' : 'exclusive'} question fences ${name} before reserving its waiter`, t => {
    const f = fixture(t, shared), writes = f.upstream.length;
    const deliveries = [f.owner.messages.length, f.viewer?.messages.length];
    const request = { id: 500, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: 'original', appServerEpoch: 'epoch', questions,
    } };
    f.emit(request);
    assert.equal(f.broker.serverRequests.has(500), false,
      'unusable items cannot bind an answer or expose a fabricated card');
    assert.deepEqual([f.owner.messages.length, f.viewer?.messages.length], deliveries);
    assert.equal(f.upstream.length, writes, 'invalid input cannot settle a possibly valid original waiter');

    // A repaired frame with the same transport ID must still reach its original task.
    const valid = { ...request, params: { ...request.params, questions: [item] } };
    f.emit(valid);
    assert.equal(f.broker.serverRequests.get(500), f.owner);
    assert.deepEqual(f.owner.messages.at(-1), valid);
    if (f.viewer) assert.deepEqual(f.viewer.messages.at(-1), valid);
    f.broker.receive(f.owner, JSON.stringify({ id: 500, result: { answers: { item: { answers: ['original answer'] } } } }));
    assert.equal(f.upstream.length, writes + 1, 'the correct answer is forwarded exactly once');
    assert.deepEqual(f.upstream.at(-1).result.answers, { item: { answers: ['original answer'] } });
    f.emit({ method: 'question/resolved', params: { requestId: 500, threadId: 'thread', turnId: 'turn',
      questionId: 'original', appServerEpoch: 'epoch', reason: 'client_response' } });
    assert.equal(f.owner.messages.at(-1).params.reason, 'client_response');
    if (f.viewer) assert.equal(f.viewer.messages.at(-1).params.reason, 'client_response');
    assert.equal(f.broker.serverRequests.has(500), false);
  });
}

for (const shared of [false, true]) {
  for (const questions of [
    undefined, [{ id: 'item' }], [item],
    [{ ...item, id: '\uFEFF', prompt: '\uFEFF', options: [{ label: '\uFEFF', value: '\uFEFF' }] }],
    [{ ...item, prompt: undefined, question: 'Which original choice?' }],
    [{ ...item, options: [{ label: 'Yes' }] }],
    [{ ...item, options: [{ value: 'yes' }] }],
    [{ ...item, options: [{ label: 'Yes', value: 'yes' }], allowsFreeform: false }],
    [{ ...item, id: '选项-😀', prompt: '继续吗？😀', question: '原题-😀',
      options: [{ label: '是-😀', value: 'yes-😀' }] }],
  ]) test(`${shared ? 'shared' : 'exclusive'} preserves legacy question content ${JSON.stringify(questions)}`, t => {
    const f = fixture(t, shared);
    const request = { id: 500, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: 'original', questions,
    } };
    f.emit(request);
    assert.equal(f.broker.serverRequests.get(500), f.owner);
    assert.deepEqual(f.owner.messages.at(-1), JSON.parse(JSON.stringify(request)));
    if (f.viewer) assert.deepEqual(f.viewer.messages.at(-1), JSON.parse(JSON.stringify(request)));
  });

  for (const options of [[null], [{ label: '\ud800', value: 'yes' }]])
  test(`${shared ? 'shared' : 'exclusive'} unusable choices ${JSON.stringify(options)} cannot exhaust original question capacity`, t => {
    const f = fixture(t, shared), writes = f.upstream.length;
    const deliveries = [f.owner.messages.length, f.viewer?.messages.length];
    for (let id = 500; id < 1013; id++) f.emit({ id, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: `invalid-${id}`,
      questions: [{ ...item, options }],
    } });
    assert.equal(f.broker.serverRequests.size, 0);
    assert.equal(f.upstream.length, writes);
    assert.deepEqual([f.owner.messages.length, f.viewer?.messages.length], deliveries);
    f.emit({ id: 500, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: 'original', questions: [item],
    } });
    assert.equal(f.broker.serverRequests.get(500), f.owner,
      'invalid choices must not reserve a waiter or a terminal ID');
    f.broker.receive(f.owner, JSON.stringify({ id: 500,
      result: { answers: { item: { answers: ['original answer'] } } } }));
    assert.equal(f.upstream.length, writes + 1);
    assert.deepEqual(f.upstream.at(-1).result.answers, { item: { answers: ['original answer'] } });
  });
}
