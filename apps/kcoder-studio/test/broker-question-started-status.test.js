import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

for (const shared of [false, true]) {
  test(`nonrunning start snapshots cannot exhaust original-question refresh (shared=${shared})`, t => {
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
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    const resume = id => {
      broker.receive(client, JSON.stringify({ id, method: 'thread/resume', params: { threadId: 'thread' } }));
      assert.equal(upstream.at(-1).method, 'thread/resume');
      return upstream.at(-1);
    };
    const finish = request => broker.routeServerMessage({ id: request.id, result: { thread: { id: 'thread' } } });
    if (shared) finish(resume(1));
    const refresh = resume(2);
    for (let sequence = 0; sequence < 513; sequence++) broker.routeServerMessage({ method: 'turn/started',
      params: { threadId: 'thread', turnId: 'turn', sequence, turn: { id: 'turn', status: 'completed' } } });
    const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
      question: { threadId: 'thread', questionId: 'question', revision: 1 } } };
    broker.routeServerMessage(changed);
    const started = { method: 'turn/started', params: { threadId: 'thread', turnId: 'turn',
      turn: { id: 'turn', status: 'running' } } };
    broker.routeServerMessage(started);
    finish(refresh);
    assert.equal(client.messages.some(message => message.error?.code === -32047), false,
      'invalid lifecycle snapshots must not overflow the task recovery queue');
    assert.deepEqual(client.messages.filter(message => message.method === 'asyncQuestion/changed'), [changed]);
    assert.deepEqual(client.messages.filter(message => message.method === 'turn/started'), [started]);
    assert.equal(broker.threadOwners.get('thread'), client);
  });
}
