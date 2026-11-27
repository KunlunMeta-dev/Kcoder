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
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const client = () => {
    const value = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value);
    Object.assign(value, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
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
for (const [method, flag] of [['thread/delete', 'deleted'], ['thread/dispose', 'disposed']]) {
  for (const [name, result] of [
    ['conflicting legacy alias', { threadId: 'thread', thread_id: 'other' }],
    ['conflicting nested locator', { threadId: 'thread', thread: { id: 'other' } }],
    ['nested request envelope masking a foreign task', { threadId: 'other', params: { threadId: 'thread' } }],
    ['non-boolean release flag', { threadId: 'thread', [flag]: 'false' }],
  ]) {
    test(`${method} with ${name} preserves original question refresh`, t => {
      const f = fixture(t);
      const recovering = f.client();
      const list = f.send(f.owner, 'asyncQuestion/list');
      const resume = f.send(recovering, 'thread/resume');
      f.reply(f.send(f.owner, method), result);
      const release = f.owner.messages.at(-1);

      const questions = [{ threadId: 'thread', questionId: 'original-question', revision: 1 }];
      f.reply(list, { threadId: 'thread', questions });
      assert.deepEqual(f.owner.messages.at(-1).result?.questions, questions);
      f.reply(resume, { thread: { id: 'thread' } });
      assert.equal(recovering.messages.at(-1).result?.thread.id, 'thread');
      assert.equal(f.broker.threadOwners.get('thread'), f.owner);
      assert.equal(release.error?.code, -32001);
      assert.deepEqual(f.upstream.map(request => request.method),
        ['thread/resume', 'asyncQuestion/list', 'thread/resume', method]);
    });
  }
}

for (const method of ['thread/delete', 'thread/dispose']) {
  test(`${method} still fences an older list when the release locators agree`, t => {
    const f = fixture(t);
    const list = f.send(f.owner, 'asyncQuestion/list');
    const result = { threadId: 'thread', thread_id: 'thread' };
    f.reply(f.send(f.owner, method), result);
    assert.deepEqual(f.owner.messages.at(-1).result, result);

    f.reply(list, { threadId: 'thread', questions: [] });
    assert.equal(f.owner.messages.at(-1).error?.code, -32023);
  });
}

for (const [method, flag] of [['thread/delete', 'deleted'], ['thread/dispose', 'disposed']]) {
  test(`${method} with a false result flag preserves in-flight question lookup and resume`, t => {
    const f = fixture(t);
    const recovering = f.client();
    const list = f.send(f.owner, 'asyncQuestion/list');
    const resume = f.send(recovering, 'thread/resume');
    const result = { threadId: 'thread', [flag]: false };
    f.reply(f.send(f.owner, method), result);
    assert.deepEqual(f.owner.messages.at(-1).result, result);

    const questions = [{ threadId: 'thread', questionId: 'original-question', revision: 1 }];
    f.reply(list, { threadId: 'thread', questions });
    assert.deepEqual(f.owner.messages.at(-1).result?.questions, questions);
    f.reply(resume, { thread: { id: 'thread' } });
    assert.equal(recovering.messages.at(-1).result?.thread.id, 'thread');
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.deepEqual(f.upstream.map(request => request.method),
      ['thread/resume', 'asyncQuestion/list', 'thread/resume', method]);
  });
}
