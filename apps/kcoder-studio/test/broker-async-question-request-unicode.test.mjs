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
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    return upstream.slice(before).find(message => message.method === method);
  };
  const join = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume', { threadId });
    emit({ id: request.id, result: { thread: { id: threadId } } });
    return client;
  };
  const owner = join('original'), peer = join('peer');
  const turn = send(peer, 'turn/start', { threadId: 'peer' });
  emit({ id: turn.id, result: { turn: { id: 'peer-turn' } } });
  return { broker, upstream, emit, send, owner, peer };
}

const operations = {
  'asyncQuestion/list': { threadId: 'original', includeTerminal: true },
  'asyncQuestion/answer': { threadId: 'original', questionId: 'question', submissionId: 'submission',
    expectedRevision: 1, answers: { item: { text: 'Original answer' } } },
  'asyncQuestion/cancel': { threadId: 'original', questionId: 'question', expectedRevision: 1 },
};

for (const shared of [false, true]) {
  for (const [method, params] of Object.entries(operations)) {
    const corruptions = {
      'nested extension value': value => ({ ...value, extension: { nested: ['\ud800'] } }),
      'nested extension key': value => ({ ...value, extension: { ['\udfff']: 'value' } }),
      ...(method !== 'asyncQuestion/list' ? { 'question identity': value => ({ ...value, questionId: '\ud800' }) } : {}),
      ...(method === 'asyncQuestion/answer' ? {
        'submission identity': value => ({ ...value, submissionId: '\udfff' }),
        'answer item key': value => ({ ...value, answers: { ['\ud800']: { text: 'Answer' } } }),
        'answer text': value => ({ ...value, answers: { item: { text: '\udfff' } } }),
      } : {}),
    };
    for (const [name, corrupt] of Object.entries(corruptions)) {
      test(`${method} rejects invalid Unicode in ${name} without affecting peer work (shared=${shared})`, t => {
        const f = fixture(t, shared), writes = f.upstream.length;
        const peerActive = f.broker.activeTurns.get('peer'), peerMessages = f.peer.messages.length;
        assert.equal(f.send(f.owner, method, corrupt(params)), undefined,
          'a frame Rust cannot parse must never reach the shared protocol stream');
        assert.equal(f.upstream.length, writes);
        assert.equal(f.owner.messages.at(-1).error?.code, -32602);
        assert.equal(f.broker.activeTurns.get('peer'), peerActive);
        assert.equal(f.peer.messages.length, peerMessages);
        assert.equal(f.broker.threadOwners.get('original'), f.owner);
        const corrected = f.send(f.owner, method, params);
        assert.ok(corrected, 'the original operation remains available after correcting the input');
        assert.deepEqual(corrected.params.answers, params.answers);
        assert.equal(f.upstream.filter(message => message.method === method).length, 1,
          'only the explicit corrected operation is sent');
        f.emit({ method: 'turn/completed', params: { threadId: 'peer', turnId: 'peer-turn' } });
        assert.equal(f.broker.activeTurns.has('peer'), false);
        assert.equal(f.peer.messages.at(-1).method, 'turn/completed');
      });
    }
  }
  test(`valid Unicode and literal escape text are preserved (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const params = { ...operations['asyncQuestion/answer'], questionId: '原题-😀', submissionId: '提交-😀',
      answers: { ['题目-😀']: { text: '原文 \\ud800 😀' } }, extension: { ['键-😀']: '值-😀' } };
    assert.deepEqual(f.send(f.owner, 'asyncQuestion/answer', params).params, { ...params, asyncUserQuestions: true });
  });
}
