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
    emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const prompt = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', [field]: 'original', appServerEpoch: 'epoch',
    ...(kind === 'question' ? { questions: [{ id: 'item', header: 'Choice', prompt: 'Continue?',
      options: [], allowsFreeform: true, multiSelect: false }] }
      : { action: { type: 'command', command: 'echo fixture' }, reason: 'Controlled approval' }),
  } };
  const reply = client => broker.receive(client, JSON.stringify({ id: 500,
    result: kind === 'question' ? { answers: { item: { answers: ['Continue'] } } } : { decision: 'accept' } }));
  return { broker, upstream, emit, join, field, prompt, reply };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    for (const identity of [null, false, 7, {}, [], '', ' ']) {
      test(`${kind}: invalid initial identity ${JSON.stringify(identity)} cannot consume the original waiter (shared=${shared})`, t => {
        const f = fixture(t, kind, shared), owner = f.join(), viewer = shared ? f.join() : null;
        const delivered = [owner.messages.length, viewer?.messages.length], writes = f.upstream.length;
        f.emit({ ...f.prompt, params: { ...f.prompt.params, [f.field]: identity } });
        assert.deepEqual([owner.messages.length, viewer?.messages.length], delivered,
          'an unusable interaction identity must not open a card');
        assert.equal(f.broker.serverRequests.has(500), false, 'invalid input must not reserve a waiter');
        assert.equal(f.upstream.length, writes, 'invalid input must not respond to a potentially unrelated ID');
        f.emit(f.prompt);
        assert.deepEqual(owner.messages.at(-1), f.prompt);
        if (viewer) assert.deepEqual(viewer.messages.at(-1), f.prompt);
        f.reply(owner);
        assert.equal(f.upstream.length, writes + 1, 'the original input is forwarded once');
        const receipt = { method: `${kind}/resolved`, params: { ...f.prompt.params,
          requestId: 500, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
        f.emit(receipt);
        assert.deepEqual(owner.messages.at(-1), receipt);
        if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
        const settled = owner.messages.length;
        f.emit(f.prompt); f.emit(receipt);
        assert.equal(owner.messages.length, settled, 'the original terminal receipt stays final');
        assert.equal(f.upstream.length, writes + 1);
      });
    }

    test(`${kind}: invalid identities cannot exhaust capacity or reject an ownerless waiter (shared=${shared})`, t => {
      const f = fixture(t, kind, shared);
      const malformed = { ...f.prompt, params: { ...f.prompt.params, [f.field]: {} } };
      f.emit(malformed);
      assert.equal(f.upstream.length, 0, 'an invalid ownerless frame cannot settle the real waiter');
      const owner = f.join(), writes = f.upstream.length;
      for (let id = 1000; id < 1513; id++) f.emit({ ...malformed, id });
      f.emit(f.prompt);
      assert.deepEqual(owner.messages.at(-1), f.prompt, 'valid input still fits after malformed traffic');
      assert.equal(f.upstream.length, writes);
      f.reply(owner);
      assert.equal(f.upstream.length, writes + 1);
    });

    test(`${kind}: legacy omitted identities keep their existing routing (shared=${shared})`, t => {
      const f = fixture(t, kind, shared), owner = f.join(), writes = f.upstream.length;
      const prompt = structuredClone(f.prompt);
      delete prompt.params[f.field];
      f.emit(prompt);
      assert.deepEqual(owner.messages.at(-1), prompt);
      f.reply(owner);
      assert.equal(f.upstream.length, writes + 1);
    });
  }
}
