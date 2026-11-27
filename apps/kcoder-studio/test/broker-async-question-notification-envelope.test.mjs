import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'gateway-target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current',
    capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emitRaw = json => child.stdout.write(`${json}\n`);
  const emit = message => emitRaw(JSON.stringify(message));
  let sequence = 0;
  const resume = (threadId, async = true) => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: async });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: threadId } } }) };
  };
  return { broker, upstream, emit, emitRaw, resume };
}

const changed = (threadId, serverId = 'server-current') => ({ method: 'asyncQuestion/changed', params: {
  serverId, threadId, question: { threadId, questionId: 'async-question', revision: 1 },
} });

for (const shared of [false, true]) {
  for (const id of [null, 500, 'request-500']) {
    test(`${shared ? 'shared' : 'exclusive'}: async update request id=${id} cannot replace an original question owner`, t => {
      const f = fixture(t, shared), original = f.resume('original'), peer = f.resume('peer', false);
      original.finish(); peer.finish();
      const question = { id, method: 'question/request', params: {
        threadId: 'original', turnId: 'turn', questionId: 'question',
        questions: [{ id: 'item', prompt: 'Continue the original task?', options: [], allowsFreeform: true }],
      } };
      // Null is not a valid original request ID; it must still never be registered by an update.
      if (id !== null) {
        f.emit(question);
        assert.equal(f.broker.serverRequests.get(id), original.client, 'the original question owns its waiter before the invalid update');
      }
      const before = peer.client.messages.length, writes = f.upstream.length;
      for (const serverId of ['server-current', 'server-previous'])
        f.emit({ ...changed('peer', serverId), id });
      assert.equal(peer.client.messages.length, before, 'request envelopes cannot bypass notification capability checks');
      assert.equal(f.broker.serverRequests.get(id), id === null ? undefined : original.client,
        'an update cannot overwrite the waiter of another task');
      assert.equal(f.upstream.length, writes, 'never reply to the update ID, which may belong to a real waiter');
      if (id !== null) {
        const answers = { item: { answers: ['Continue'] } };
        f.broker.receive(original.client, JSON.stringify({ id, result: { answers } }));
        assert.equal(f.upstream.filter(message => message.id === id && message.result).length, 1,
          'the original question remains answerable exactly once');
        assert.deepEqual(f.upstream.at(-1).result.answers, answers);
      }
      const valid = changed('original');
      f.emit(valid);
      assert.deepEqual(original.client.messages.at(-1), valid, 'later valid notifications remain deliverable');
      assert.equal(peer.client.messages.length, before);
    });

    test(`${shared ? 'shared' : 'exclusive'}: async update request id=${id} cannot be refused or delivered during recovery`, t => {
      const f = fixture(t, shared), owner = shared ? f.resume('original') : null;
      owner?.finish();
      const recovering = f.resume('original');
      const writes = f.upstream.length, ownerMessages = owner?.client.messages.length;
      f.emit({ ...changed('original'), id });
      assert.equal(f.upstream.length, writes, 'unowned recovery must not send an error to a potentially live request ID');
      assert.equal(f.broker.serverRequests.has(id), false);
      const valid = changed('original');
      f.emit(valid); recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread, 'the original task still resumes');
      assert.deepEqual(recovering.client.messages.slice(1), [valid]);
      if (owner) assert.deepEqual(owner.client.messages.slice(ownerMessages), [valid]);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
    });
  }
}

for (const shared of [false, true]) {
  for (const version of ['1.0', null, 2, '']) {
    test(`${shared ? 'shared' : 'exclusive'}: invalid JSON-RPC version ${JSON.stringify(version)} cannot break question recovery`, t => {
      const f = fixture(t, shared), owner = shared ? f.resume('original') : null;
      owner?.finish();
      const recovering = f.resume('original');
      // Distinct revisions avoid conflating invalid envelope admission with replay coalescing.
      for (let revision = 1; revision <= 65; revision++) {
        const invalid = changed('original');
        invalid.jsonrpc = version;
        invalid.params.question.revision = revision;
        f.emit(invalid);
      }
      const current = { ...changed('original'), jsonrpc: '2.0' };
      const legacy = changed('original');
      legacy.params.question.revision = 2;
      f.emit(current); f.emit(legacy); recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread,
        'invalid protocol frames must not turn successful original-task resume into -32047');
      assert.deepEqual(recovering.client.messages.slice(1), [legacy],
        'the recovering client gets the newest read hint regardless of accepted envelope spelling');
      if (owner) assert.deepEqual(owner.client.messages.slice(1), [current, legacy],
        'live clients still receive both valid hints and reject invalid envelopes');
      const before = recovering.client.messages.length;
      f.emit({ ...changed('original'), jsonrpc: version });
      assert.equal(recovering.client.messages.length, before, 'invalid versions cannot refresh a live card');
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
        'recovery does not answer, cancel, interrupt or replay original task input');
    });
  }
}

for (const field of ['result', 'error']) {
  test(`an async update carrying ${field} cannot settle a pending original-task list`, t => {
    const f = fixture(t, true), owner = f.resume('original');
    owner.finish();
    f.broker.receive(owner.client, JSON.stringify({
      id: 'client-list', method: 'asyncQuestion/list', params: { threadId: 'original' },
    }));
    const request = f.upstream.at(-1);
    assert.equal(request.method, 'asyncQuestion/list');
    const result = { threadId: 'original', questions: [changed('original').params.question] };
    const invalid = { ...changed('original'), id: request.id };
    invalid[field] = field === 'error' ? { code: -32001, message: 'unrelated update' } : result;
    f.emit(invalid);
    assert.equal(owner.client.messages.length, 1, 'only the real list receipt may settle the request');
    f.emit({ jsonrpc: '2.0', id: request.id, result });
    assert.deepEqual(owner.client.messages.at(-1), { jsonrpc: '2.0', id: 'client-list', result });
    const valid = changed('original');
    f.emit(valid);
    assert.deepEqual(owner.client.messages.at(-1), valid);
    assert.deepEqual(f.upstream.map(message => message.method), ['thread/resume', 'asyncQuestion/list']);
  });
}

test('an async update with a null ID cannot close the shared app-server stream', t => {
  const f = fixture(t, true), owner = f.resume('original'), peer = f.resume('peer');
  owner.finish(); peer.finish();
  f.emit({ ...changed('original'), id: null, error: { code: -32600, message: 'invalid update' } });

  assert.equal(f.broker.closed, false);
  assert.equal(owner.client.messages.length, 1);
  const valid = changed('peer');
  f.emit(valid);
  assert.deepEqual(peer.client.messages.at(-1), valid);
  assert.deepEqual(f.upstream.map(message => message.method), ['thread/resume', 'thread/resume']);
});

for (const method of ['thread/delete', 'thread/dispose']) {
  for (const [defect, malformedResult] of [
    ['duplicate receipt ID'],
    ['duplicate nested task locator', '{"thread":{"id":"peer","id":"original"}}'],
    ['scalar thread locator', '{"threadId":"original","thread":"peer"}'],
    ['array widget locator', '{"threadId":"original","widget":[{"threadId":"peer"}]}'],
  ]) {
    test(`${defect} in a ${method} receipt preserves the original task and question refresh`, t => {
      const f = fixture(t, true), owner = f.resume('original'), peer = f.resume('peer');
      owner.finish(); peer.finish();
      const send = (client, id, method, threadId) => {
        f.broker.receive(client, JSON.stringify({ id, method, params: { threadId } }));
        assert.equal(f.upstream.at(-1).method, method);
        return f.upstream.at(-1).id;
      };
      const listId = send(owner.client, 'list', 'asyncQuestion/list', 'original');
      const releaseId = send(owner.client, 'release', method, 'original');
      const peerListId = send(peer.client, 'peer-list', 'asyncQuestion/list', 'peer');

      if (malformedResult === undefined) {
        f.emitRaw(`{"jsonrpc":"2.0","id":${peerListId},"id":${releaseId},"result":{"threadId":"original"}}`);
        assert.equal(f.broker.pending.has(releaseId), true, 'an ambiguous ID cannot settle the release');
        assert.equal(f.broker.pending.has(peerListId), true, 'an ambiguous ID cannot settle the peer refresh');
      } else {
        f.emitRaw(`{"jsonrpc":"2.0","id":${releaseId},"result":${malformedResult}}`);
        assert.equal(owner.client.messages.at(-1).id, 'release');
        assert.equal(owner.client.messages.at(-1).error?.code, -32001);
      }

      assert.equal(f.broker.threadOwners.get('original'), owner.client);
      assert.equal(f.broker.threadOwners.get('peer'), peer.client);
      const result = { threadId: 'original', questions: [changed('original').params.question] };
      f.emit({ id: listId, result });
      assert.deepEqual(owner.client.messages.at(-1).result, result);
      f.emit({ id: peerListId, result: { threadId: 'peer', questions: [] } });
      assert.deepEqual(peer.client.messages.at(-1).result, { threadId: 'peer', questions: [] });

      if (malformedResult === undefined) {
        f.emit({ id: releaseId, result: { threadId: 'original' } });
        assert.equal(owner.client.messages.at(-1).id, 'release');
        assert.deepEqual(owner.client.messages.at(-1).result, { threadId: 'original' });
        assert.equal(f.broker.threadOwners.has('original'), false);
      }
    });
  }
}
