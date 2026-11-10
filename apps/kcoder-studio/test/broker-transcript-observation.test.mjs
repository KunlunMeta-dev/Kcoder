import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const capability = 'threadTranscriptObservationV1';
const observation = { observationId: 'a'.repeat(64), viewKey: 'b'.repeat(64) };
const cursor = `tp1:ob1-${observation.observationId}:2`;
const initialize = offer => ({ protocolVersion: '2026-07-27',
  clientInfo: { name: 'observation-contract', version: '1' },
  capabilities: { experimental: offer === undefined ? {} : { [capability]: offer } } });
const initialized = supported => ({ protocolVersion: '2026-07-27',
  capabilities: { experimental: { residentThreads: true, ...(supported ? { [capability]: true } : {}) } } });

function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true,
    maxMessageBytes: 1024 * 1024, serverId: 'observation-contract',
    adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  const requests = []; let pending = '';
  child.stdin.on('data', chunk => {
    pending += chunk.toString('utf8');
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n');
      requests.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1);
    }
  });
  const client = () => {
    const value = { channel: 'runtime', authorizationOwner: 'same-workspace', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value); return value;
  };
  const request = async (owner, id, method, params) => {
    broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    await new Promise(resolve => setImmediate(resolve)); return requests.at(-1);
  };
  const respond = async (id, payload) => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  return { broker, requests, client, request, respond };
}

for (const concurrent of [false, true]) for (const modernFirst of [false, true]) {
  test(`observation choices and cursors remain per client (concurrent=${concurrent}, modernFirst=${modernFirst})`, async () => {
    const f = fixture();
    try {
      const modern = f.client(); const legacy = f.client();
      const first = modernFirst ? modern : legacy; const second = first === modern ? legacy : modern;
      const init = owner => f.request(owner, owner === modern ? 'modern-init' : 'legacy-init',
        'initialize', initialize(owner === modern ? true : undefined));
      const upstream = await init(first);
      assert.equal(upstream.params.capabilities.experimental[capability], true);
      assert.equal(first[capability], undefined, 'pending offers cannot authorize response fields');
      if (concurrent) await init(second);
      await f.respond(upstream.id, { result: initialized(true) });
      if (!concurrent) await init(second);
      for (const [owner, enabled] of [[modern, true], [legacy, false]]) {
        assert.equal(owner[capability], enabled);
        assert.equal(owner.messages.at(-1).result.capabilities.experimental[capability], enabled);
        await f.request(owner, 'duplicate', 'initialize', initialize(!enabled));
        assert.ok(owner.messages.at(-1).error);
        assert.equal(owner[capability], enabled, 'duplicate initialize cannot change the frozen choice');
      }
      for (const method of ['thread/read', 'thread/read/indexed', 'thread/resume']) {
        const page = { messages: [], rangeStart: 2, rangeEnd: 2, hasMoreBefore: true,
          beforeCursor: cursor, transcriptObservationV1: observation };
        const result = method === 'thread/resume'
          ? { thread: { id: 'thread' }, history: { status: 'ready', page } } : { thread: { id: 'thread' }, ...page };
        const original = structuredClone(result);
        for (const [owner, enabled] of [[modern, true], [legacy, false]]) {
          if (method === 'thread/resume') f.broker.threadOwners.set('thread', owner);
          const read = await f.request(owner, method, method, { threadId: 'thread' });
          await f.respond(read.id, { result });
          const received = owner.messages.at(-1).result;
          const projected = method === 'thread/resume' ? received.history.page : received;
          assert.deepEqual(projected.transcriptObservationV1, enabled ? observation : undefined);
          assert.equal(projected.beforeCursor, enabled ? cursor : '2');
        }
        assert.deepEqual(result, original, 'one client projection cannot mutate its peer source');
      }
    } finally { f.broker.clearTransientState(); }
  });
}

test('observation projection preserves tracked cursors, errors and old backend behavior', async () => {
  const f = fixture();
  try {
    const owner = f.client();
    const init = await f.request(owner, 'init', 'initialize', initialize(false));
    await f.respond(init.id, { result: initialized(false) });
    assert.equal(Object.hasOwn(owner.messages.at(-1).result.capabilities.experimental, capability), false);
    for (const beforeCursor of ['2', 'tp1:committed-generation:2']) {
      const request = await f.request(owner, beforeCursor, 'thread/read/indexed', { threadId: 'thread' });
      await f.respond(request.id, { result: { messages: [], rangeStart: 2, hasMoreBefore: true, beforeCursor } });
      assert.equal(owner.messages.at(-1).result.beforeCursor, beforeCursor);
    }
    const request = await f.request(owner, 'stale', 'thread/read/indexed', { threadId: 'thread', beforeCursor: cursor });
    const error = { code: -32041, message: '游标对应的观察已失效' };
    await f.respond(request.id, { error });
    assert.deepEqual(owner.messages.at(-1).error, error);
  } finally { f.broker.clearTransientState(); }
});

test('observation initialize rejects nonboolean offers before freezing or forwarding', async () => {
  const f = fixture();
  try {
    for (const offer of ['true', 1, null]) {
      const owner = f.client();
      await f.request(owner, 'invalid', 'initialize', initialize(offer));
      assert.equal(owner[capability], undefined);
      assert.equal(owner.messages.at(-1).error.code, -32602);
      assert.equal(f.requests.length, 0);
    }
  } finally { f.broker.clearTransientState(); }
});

test('observation projection never invents a numeric cursor from an invalid observed range', async () => {
  const f = fixture();
  try {
    const owner = f.client();
    const init = await f.request(owner, 'init', 'initialize', initialize(false));
    await f.respond(init.id, { result: initialized(true) });
    for (const rangeStart of [undefined, 1, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const read = await f.request(owner, 'bad-range', 'thread/read/indexed', { threadId: 'thread' });
      await f.respond(read.id, { result: { messages: [], rangeStart, hasMoreBefore: true,
        beforeCursor: cursor, transcriptObservationV1: observation } });
      assert.equal(owner.messages.at(-1).result, undefined);
      assert.equal(owner.messages.at(-1).error.code, -32603);
    }
  } finally { f.broker.clearTransientState(); }
});
