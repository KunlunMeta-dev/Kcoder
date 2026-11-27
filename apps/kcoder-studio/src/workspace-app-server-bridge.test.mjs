import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWorkspaceAppServerBridge } from './workspace-app-server-bridge.mjs';
import { createWebSocketFrameCodec } from './websocket-frame-codec.js';
import { requireCapturedNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';

const { frame, decodeFrames } = createWebSocketFrameCodec({ maxMessageBytes: 1024 });

function clientFrame(payload, opcode, fin) {
  const encoded = frame(payload, opcode);
  const header = encoded.subarray(0, encoded.length - payload.length);
  if (!fin) header[0] &= 0x7f;
  header[1] |= 0x80;
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([header, mask, payload.map((byte, index) => byte ^ mask[index % 4])]);
}

function fixture(maxMessageBytes = 1024) {
  const { frame, decodeFrames } = createWebSocketFrameCodec({ maxMessageBytes });
  const socket = new EventEmitter();
  Object.assign(socket, { writable: true, destroyed: false, write: () => true,
    pause() {}, resume() {}, isPaused: () => false,
    end() { this.writable = false; }, destroy() { this.destroyed = true; } });
  const calls = { detached: 0, idle: 0, stopped: 0, blocked: 0, released: 0, received: [] };
  const target = { id: 'source', runtime: 'kcoder', transport: 'local' };
  const session = { allowedServerIds: new Set(['source']) };
  let sessionActive = true;
  const broker = { closed: false, clients: new Set(), attach(client) { client.initialized = true; this.clients.add(client); },
    detach(client) { calls.detached++; this.clients.delete(client); },
    receive(client, raw) { calls.received.push({ client, raw }); },
    blockStdout() { calls.blocked++; }, releaseStdout() { calls.released++; } };
  const retention = Object.freeze({ marker: 'original-retention-capability' });
  const bridge = createWorkspaceAppServerBridge({
    captureRetentionAuthority: () => retention, deviceFamilies: new Map(),
    serversById: new Map([['source', target]]), workspaceBrokerKey: () => 'original-broker-selection',
    loginContexts: { identity: () => null, generation: () => 1 },
    mcpCallbacks: { create() {} }, maxMessageBytes,
    frame, decodeFrames,
    WebSocketLivenessLease: class { start() {} stop() { calls.stopped++; } pong() {} },
    scheduleWorkspaceBrokerIdle() { calls.idle++; }, targetSignature: JSON.stringify,
    serverHealthSignature: JSON.stringify,
    verifySession: (id, observed) => id === 'original-session' && observed === session && sessionActive,
  });
  bridge(socket, target, 'runtime', { broker, key: 'original-broker-selection' }, Buffer.alloc(0),
    'https://owned-gateway.example', 'original-login-owner', session, '/owned-workspace', 'original-session');
  return { socket, broker, calls, client: [...broker.clients][0], retention,
    revoke() { sessionActive = false; } };
}

test('a large message arriving in network chunks has a linear receive-copy budget', t => {
  const f = fixture(2 * 1024 * 1024);
  t.after(() => f.socket.emit('close'));
  const text = JSON.stringify({ jsonrpc: '2.0', id: 'owned-read', method: 'server/resources/read', params: {} })
    + ' '.repeat(1024 * 1024);
  const encoded = clientFrame(Buffer.from(text), 1, true);
  const concat = Buffer.concat, copy = Buffer.prototype.copy, from = Buffer.from;
  let copiedBytes = 0;
  t.mock.method(Buffer, 'concat', function (parts, length) {
    copiedBytes += length ?? parts.reduce((sum, part) => sum + part.length, 0);
    return concat.call(this, parts, length);
  });
  t.mock.method(Buffer.prototype, 'copy', function (...args) {
    const copied = copy.apply(this, args); copiedBytes += copied; return copied;
  });
  t.mock.method(Buffer, 'from', function (value, ...args) {
    if (ArrayBuffer.isView(value)) copiedBytes += value.byteLength;
    return from.call(this, value, ...args);
  });
  for (let offset = 0; offset < encoded.length; offset += 4096)
    f.socket.emit('data', encoded.subarray(offset, offset + 4096));
  const measured = copiedBytes;
  t.mock.restoreAll();
  assert.deepEqual(f.calls.received, [{ client: f.client, raw: text }]);
  t.diagnostic(JSON.stringify({ wireBytes: encoded.length, chunkBytes: 4096, copiedBytes: measured }));
  assert.ok(measured <= encoded.length * 8, `receive copying exceeded the linear budget: ${measured}`);
});

test('existing socket attachment keeps its retention authority and captures only the actual session', () => {
  const f = fixture();
  assert.equal(f.client.retentionAuthority, f.retention);
  assert.equal(requireCapturedNativeRemoteSourceClient(f.client.nativeRemoteSourceOwner), f.client.nativeRemoteSourceOwner);
  f.revoke();
  assert.throws(() => f.client.nativeRemoteSourceOwner.verify());
  f.socket.emit('close');
});

test('socket frame delivery stays bound to the original attached broker client', () => {
  const f = fixture();
  f.socket.emit('data', clientFrame(Buffer.from('original-frame'), 1, true));
  assert.deepEqual(f.calls.received, [{ client: f.client, raw: 'original-frame' }]);
  f.socket.emit('close');
});

for (const fragmented of [false, true]) {
  test(`invalid UTF-8 cannot reach the task broker as a rewritten answer (fragmented=${fragmented})`, () => {
    const f = fixture();
    const writes = [];
    f.socket.write = data => { writes.push(data); return true; };
    const prefix = Buffer.from('{"id":1,"method":"asyncQuestion/answer","params":{"threadId":"original","questionId":"question","submissionId":"submission","expectedRevision":1,"answers":{"item":{"text":"');
    const first = Buffer.concat([prefix, Buffer.from([0xf0, 0x9f])]);
    const last = Buffer.from('x"}}}}');
    if (fragmented) {
      f.socket.emit('data', clientFrame(first, 1, false));
      assert.deepEqual(f.calls.received, []);
      assert.equal(f.socket.writable, true);
      f.socket.emit('data', clientFrame(last, 0, true));
    } else {
      f.socket.emit('data', clientFrame(Buffer.concat([first, last]), 1, true));
    }
    assert.deepEqual(f.calls.received, [], 'no mutated answer may reach the original task');
    assert.equal(f.socket.writable, false);
    assert.equal(f.broker.clients.has(f.client), false, 'release the answer connection before socket close');
    assert.equal(f.calls.stopped, 1);
    assert.throws(() => f.client.nativeRemoteSourceOwner.verify());
    assert.match(writes[0].toString(), /server\/transportError/);
    f.socket.emit('data', clientFrame(Buffer.concat([prefix, Buffer.from('valid"}}}}')]), 1, true));
    assert.deepEqual(f.calls.received, []);
    f.socket.emit('close');
    assert.equal(f.calls.detached, 1);
    assert.equal(f.calls.idle, 1);
    assert.equal(f.broker.closed, false);
  });
}

test('answer text preserves split Unicode characters and literal replacement characters', () => {
  const f = fixture();
  const answer = JSON.stringify({ id: 1, method: 'asyncQuestion/answer', params: {
    threadId: 'original', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
    answers: { item: { text: '原答案😀�' } },
  } });
  const bytes = Buffer.from(answer);
  const split = bytes.indexOf(Buffer.from('😀')) + 2;
  f.socket.emit('data', clientFrame(bytes.subarray(0, split), 1, false));
  assert.deepEqual(f.calls.received, []);
  f.socket.emit('data', clientFrame(bytes.subarray(split), 0, true));
  assert.deepEqual(f.calls.received, [{ client: f.client, raw: answer }]);
  f.socket.emit('close');
});

for (const coalesced of [false, true]) {
  test(`answer before WebSocket Close reaches the broker once (coalesced=${coalesced})`, () => {
    const f = fixture();
    const answer = JSON.stringify({ id: 1, method: 'asyncQuestion/answer', params: {
      threadId: 'original', questionId: 'question', submissionId: 'submission', expectedRevision: 1,
      answers: { item: { text: '原答案' } },
    } });
    const data = clientFrame(Buffer.from(answer), 1, true);
    const close = clientFrame(Buffer.from([0x03, 0xe8]), 8, true);
    const trailing = clientFrame(Buffer.from(answer.replace('原答案', '迟到的答案')), 1, true);
    if (!coalesced) f.socket.emit('data', data);
    f.socket.emit('data', Buffer.concat(coalesced ? [data, close, trailing] : [close, trailing]));
    f.socket.emit('data', trailing);
    f.socket.emit('close');
    assert.deepEqual(f.calls.received, [{ client: f.client, raw: answer }]);
    assert.equal(f.socket.writable, false);
    assert.equal(f.calls.detached, 1);
    assert.equal(f.broker.closed, false);
  });
}

test('an answer arriving during explicit detach cannot cut off the detach receipt', async () => {
  const f = fixture();
  const writes = [];
  f.socket.write = data => { writes.push(data); return true; };
  const detach = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gateway/client/detach',
    params: { confirm: true, force: false } });
  const answer = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'asyncQuestion/answer',
    params: { threadId: 'original', questionId: 'question', submissionId: 'submission',
      expectedRevision: 1, answers: { item: { text: 'original answer' } } } });
  const receipt = { jsonrpc: '2.0', id: 1, result: { detached: true } };
  f.broker.receive = (client, raw) => {
    if (!f.broker.clients.has(client)) throw new Error('gateway client is not attached');
    f.calls.received.push(raw);
    f.broker.detach(client);
    queueMicrotask(() => {
      client.send(receipt);
      client.close();
    });
  };
  f.socket.emit('data', Buffer.concat([clientFrame(Buffer.from(detach), 1, true),
    clientFrame(Buffer.from(answer), 1, true)]));
  await Promise.resolve();
  assert.deepEqual(f.calls.received, [detach]);
  assert.deepEqual(writes, [frame(JSON.stringify(receipt))]);
  assert.equal(f.socket.writable, false);
  f.socket.emit('close');
  assert.equal(f.calls.idle, 1);
});

test('send distinguishes an unwritable socket from a queued frame under backpressure', () => {
  const f = fixture();
  let writes = 0;
  f.socket.writable = false;
  f.socket.write = () => { writes++; return false; };
  assert.deepEqual(f.client.sendWithQueueStatus({ value: 1 }), { queued: false, writable: false });
  assert.equal(writes, 0);
  f.socket.writable = true;
  assert.deepEqual(f.client.sendWithQueueStatus({ value: 1 }), { queued: true, writable: false });
  assert.equal(writes, 1);
  assert.equal(f.calls.blocked, 1);
  f.socket.emit('drain');
  assert.equal(f.calls.released, 1);
  f.socket.emit('close');
});

test('queued question receipts share one drain handler per connection', () => {
  const f = fixture();
  f.socket.write = () => false;
  for (let id = 1; id <= 8; id++) {
    assert.deepEqual(f.client.sendWithQueueStatus({ jsonrpc: '2.0', id, result: {} }),
      { queued: true, writable: false });
  }
  assert.equal(f.socket.listenerCount('drain'), 1);
  f.socket.emit('drain');
  assert.equal(f.calls.released, 1);

  f.client.sendWithQueueStatus({ jsonrpc: '2.0', id: 9, result: {} });
  f.socket.emit('close');
  assert.deepEqual(f.client.sendWithQueueStatus({ jsonrpc: '2.0', id: 10, result: {} }),
    { queued: false, writable: false });
  assert.equal(f.calls.blocked, 9);
  assert.equal(f.socket.listenerCount('drain'), 0);
  f.socket.emit('drain');
  assert.equal(f.calls.released, 1);
});

test('end, error and close detach only once and do not stop the shared broker', () => {
  const f = fixture();
  f.socket.emit('end'); f.socket.emit('close'); f.socket.emit('error', new Error('owned disconnect'));
  assert.equal(f.calls.detached, 1);
  assert.equal(f.calls.idle, 1);
  assert.equal(f.calls.stopped, 1);
  assert.equal(f.broker.closed, false);
  assert.equal(f.broker.clients.size, 0);
  assert.throws(() => f.client.nativeRemoteSourceOwner.verify());
});

for (const coalesced of [false, true]) {
  test(`a complete answer before an invalid UTF-8 frame is dispatched once (coalesced=${coalesced})`, () => {
    const f = fixture();
    const writes = [];
    f.socket.write = data => { writes.push(data); return true; };
    const answer = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'asyncQuestion/answer',
      params: { threadId: 'original', questionId: 'question', submissionId: 'submission',
        expectedRevision: 1, answers: { item: { text: '原答案' } } } });
    const valid = clientFrame(Buffer.from(answer), 1, true);
    const invalid = clientFrame(Buffer.from([0xff]), 1, true);
    if (!coalesced) f.socket.emit('data', valid);
    f.socket.emit('data', Buffer.concat(coalesced ? [valid, invalid, valid] : [invalid, valid]));
    assert.deepEqual(f.calls.received, [{ client: f.client, raw: answer }]);
    assert.equal(f.calls.detached, 1);
    assert.equal(f.socket.writable, false);
    assert.match(writes[0].toString(), /server\/transportError/);
  });
}

for (const coalesced of [false, true]) {
  test(`Gateway-initiated close fences late answers before socket close event (coalesced=${coalesced})`, t => {
    const f = fixture();
    t.after(() => f.socket.emit('close'));
    const read = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'asyncQuestion/list',
      params: { threadId: 'original' } });
    const answer = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'asyncQuestion/answer',
      params: { threadId: 'original', questionId: 'question', submissionId: 'submission',
        expectedRevision: 1, answers: { item: { text: 'late answer' } } } });
    const readFrame = clientFrame(Buffer.from(read), 1, true);
    const answerFrame = clientFrame(Buffer.from(answer), 1, true);
    const writes = [];
    f.socket.write = data => { writes.push(data); return true; };
    f.broker.receive = (client, raw) => {
      f.calls.received.push(raw);
      if (raw === read) {
        client.send({ jsonrpc: '2.0', id: 1, result: { threadId: 'original', questions: [] } });
        client.close();
      }
    };

    if (coalesced) f.socket.emit('data', Buffer.concat([readFrame, answerFrame]));
    else {
      f.socket.emit('data', readFrame);
      f.socket.emit('data', answerFrame);
    }
    assert.equal(f.broker.clients.has(f.client), true, 'transport close has not fired');
    assert.deepEqual(f.calls.received, [read]);
    assert.deepEqual(writes, [frame(JSON.stringify({ jsonrpc: '2.0', id: 1,
      result: { threadId: 'original', questions: [] } }))]);
  });
}
