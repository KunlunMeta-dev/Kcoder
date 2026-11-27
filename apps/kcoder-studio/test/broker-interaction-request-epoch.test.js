import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
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
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    emit({ id: request.id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const prompt = { id: 500, method: `${kind}/request`, params: {
    serverId: 'server-fixture', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
    [kind === 'question' ? 'questionId' : 'approvalId']: 'original',
    ...(kind === 'question'
      ? { questions: [{ id: 'item', header: 'Choice', prompt: 'Continue?',
        options: [], allowsFreeform: true, multiSelect: false }] }
      : { action: { type: 'command', command: 'echo fixture' }, reason: 'Controlled approval' }),
  } };
  const answer = kind === 'question' ? { answers: { item: { answers: ['Continue'] } } } : { decision: 'accept' };
  return { broker, upstream, emit, join, prompt, answer };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    for (const appServerEpoch of [false, 7, {}, [], '', ' ']) {
      test(`${kind}: invalid initial epoch ${JSON.stringify(appServerEpoch)} cannot reserve input (shared=${shared})`, t => {
        const f = fixture(t, kind, shared), owner = f.join(), viewer = shared ? f.join() : null;
        const counts = [owner.messages.length, viewer?.messages.length], writes = f.upstream.length;
        f.emit({ ...f.prompt, params: { ...f.prompt.params, appServerEpoch } });
        assert.deepEqual([owner.messages.length, viewer?.messages.length], counts,
          'unusable lifetime identities cannot open a card');
        assert.equal(f.broker.serverRequests.has(500), false, 'invalid input cannot reserve the original waiter');
        assert.equal(f.upstream.length, writes, 'invalid input cannot reject a same-ID original waiter');

        f.emit(f.prompt);
        assert.deepEqual(owner.messages.at(-1), f.prompt, 'the valid same-ID prompt remains deliverable');
        if (viewer) assert.deepEqual(viewer.messages.at(-1), f.prompt);
        f.broker.receive(owner, JSON.stringify({ id: 500, result: f.answer }));
        assert.equal(f.upstream.length, writes + 1, 'the original input can be answered once');
        const receipt = { method: `${kind}/resolved`, params: { ...f.prompt.params,
          requestId: 500, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
        f.emit(receipt);
        assert.deepEqual(owner.messages.at(-1), receipt);
        if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
        const settled = owner.messages.length;
        f.emit(f.prompt); f.emit(receipt);
        assert.equal(owner.messages.length, settled, 'settled input stays closed');
        assert.equal(f.upstream.length, writes + 1);
      });
    }

    test(`${kind}: invalid initial epochs cannot consume interaction capacity (shared=${shared})`, t => {
      const f = fixture(t, kind, shared), owner = f.join(), writes = f.upstream.length;
      for (let id = 1000; id < 1513; id++)
        f.emit({ ...f.prompt, id, params: { ...f.prompt.params, appServerEpoch: {} } });
      f.emit(f.prompt);
      assert.deepEqual(owner.messages.at(-1), f.prompt, 'the original question still fits after malformed traffic');
      assert.equal(f.upstream.length, writes, 'malformed requests never produce a waiter response');
      f.broker.receive(owner, JSON.stringify({ id: 500, result: f.answer }));
      assert.equal(f.upstream.length, writes + 1);
    });

    test(`${kind}: an ownerless invalid epoch cannot reject the original waiter (shared=${shared})`, t => {
      const f = fixture(t, kind, shared);
      f.emit({ ...f.prompt, params: { ...f.prompt.params, appServerEpoch: '' } });
      assert.equal(f.upstream.length, 0, 'no refusal may settle a possibly unrelated waiter');
      const owner = f.join(), writes = f.upstream.length;
      f.emit(f.prompt);
      assert.deepEqual(owner.messages.at(-1), f.prompt, 'reconnection still receives the original prompt');
      f.broker.receive(owner, JSON.stringify({ id: 500, result: f.answer }));
      assert.equal(f.upstream.length, writes + 1);
    });

    for (const appServerEpoch of [undefined, null, 'epoch']) {
      test(`${kind}: compatible initial epoch ${appServerEpoch} remains answerable (shared=${shared})`, t => {
        const f = fixture(t, kind, shared), owner = f.join(), writes = f.upstream.length;
        const prompt = JSON.parse(JSON.stringify({ ...f.prompt, params: { ...f.prompt.params, appServerEpoch } }));
        f.emit(prompt);
        assert.deepEqual(owner.messages.at(-1), prompt);
        f.broker.receive(owner, JSON.stringify({ id: 500, result: f.answer }));
        assert.equal(f.upstream.length, writes + 1);
        const receipt = { method: `${kind}/resolved`, params: { ...prompt.params,
          requestId: 500, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
        f.emit(receipt);
        assert.deepEqual(owner.messages.at(-1), receipt);
      });
    }
  }
}
