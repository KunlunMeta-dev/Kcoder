import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { PEER_CHUNK_BYTES, encodePeerFrame } from '../shared/gatewayPeerTransport.js';
import { createMobilePeerTunnel } from './mobile-peer-tunnel.js';

const ownerToken = 'A'.repeat(40);
const rotatedToken = 'B'.repeat(40);
const nextToken = 'C'.repeat(40);
const refreshToken = 'd'.repeat(64);

function makeSession(token, generation = 'generation-1') {
  return {
    token,
    deviceId: 'device-owner',
    authorizationGeneration: generation,
    expiresAt: Date.now() + 60_000,
    accessExpiresAt: Date.now() + 60_000,
    wsLeaseExpiresAt: Date.now() + 60_000,
    allowedServerIds: new Set(['server-a']),
  };
}

function makeChannel() {
  return {
    frames: [],
    closed: false,
    sendMessage(raw) { this.frames.push(JSON.parse(raw)); return true; },
    bufferedAmount() { return 0; },
    isOpen() { return !this.closed; },
    setBufferedAmountLowThreshold() {},
    close() { this.closed = true; },
  };
}

function waitFor(predicate, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > 2_000) return reject(new Error(`Timed out waiting for ${label}`));
      setImmediate(poll);
    };
    poll();
  });
}

async function sendFrame(tunnel, value, { raw = false } = {}) {
  tunnel.receive(raw ? JSON.stringify(value) : encodePeerFrame(value));
  await waitFor(() => tunnel.diagnostics.pendingFrames === 0 || tunnel.closed, value.type);
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function tunnelFixture({
  base,
  initialSession = null,
  offerOwnerKind = 'pairing',
  offerOwnerToken: boundOfferToken = ownerToken,
  pairingProof = false,
  sessions = [],
  family = {},
  now = Date.now,
  WebSocket = class FakeWebSocket extends EventEmitter {},
} = {}) {
  const handle = new EventEmitter();
  const trace = [];
  const byToken = new Map(sessions.map(session => [session.token, session]));
  const authSessions = new Map(byToken);
  const families = new Map();
  const deviceFamily = {
    expiresAt: Date.now() + 60_000,
    authorizationGeneration: 'generation-1',
    sockets: new Set(initialSession ? [handle] : []),
    ...family,
  };
  families.set('device-owner', deviceFamily);
  const ownership = {
    async bind(value, token) {
      trace.push(`bind:${token === ownerToken ? 'owner' : 'other'}`);
      if (value !== handle) return null;
      const session = byToken.get(token);
      if (session) deviceFamily.sockets.add(handle);
      return session ?? null;
    },
  };
  const tunnel = createMobilePeerTunnel({
    pc: {}, handle, WebSocket,
    getLocalBase: () => base,
    rpcToken: 'rpc-secret',
    authSessionById: async token => { trace.push(`session:${token === ownerToken ? 'owner' : 'other'}`); return byToken.get(token) ?? null; },
    authSessions,
    ownership,
    pairingProof,
    getTarget: id => id === 'server-a' ? { id, security: null } : null,
    getDefaultTarget: () => ({ id: 'server-a' }),
    getTargetIds: () => ['server-a'],
    getDeviceFamily: deviceId => families.get(deviceId),
    initialSession,
    offerOwnerKind,
    offerOwnerToken: boundOfferToken,
    now,
  });
  const channel = makeChannel();
  tunnel.attach(channel);
  return { tunnel, channel, handle, authSessions, families, family: deviceFamily, byToken, trace };
}

function startHttp(id, { path = '/api/mobile/session', method = 'POST', headers = { 'content-type': 'application/json' }, bodyLength }) {
  return { version: 1, type: 'http.request.start', id, method, path, headers, bodyLength };
}

async function sendBody(tunnel, id, body) {
  const bytes = Buffer.from(body);
  await sendFrame(tunnel, { version: 1, type: 'http.request.chunk', id, seq: 0, data: bytes.toString('base64') });
  await sendFrame(tunnel, { version: 1, type: 'http.request.end', id });
}

async function closeServerAndTunnel(server, tunnel) {
  tunnel.close();
  await server.close();
}

test('pairing offer token must equal the token in the bounded pairing request before loopback dispatch', async t => {
  let requestCount = 0;
  const server = await listen((request, response) => { requestCount += 1; request.resume(); response.end('{}'); });
  const fixture = tunnelFixture({ base: server.base, pairingProof: true, offerOwnerToken: ownerToken });
  t.after(() => closeServerAndTunnel(server, fixture.tunnel));
  const otherValidToken = rotatedToken;
  const body = JSON.stringify({ token: otherValidToken, durableDeviceAuthorization: true, deviceLabel: 'phone' });
  await sendFrame(fixture.tunnel, startHttp('pair-mismatch', { bodyLength: Buffer.byteLength(body) }));
  await sendBody(fixture.tunnel, 'pair-mismatch', body);
  assert.equal(requestCount, 0);
  assert.ok(fixture.channel.frames.some(frame => frame.type === 'error'));
});

test('pairing requests with unknown or oversized body length are rejected before loopback dispatch', async t => {
  let requestCount = 0;
  const server = await listen((request, response) => { requestCount += 1; request.resume(); response.end('{}'); });
  t.after(() => server.close());
  for (const [index, bodyLength] of [null, 4097].entries()) {
    const fixture = tunnelFixture({ base: server.base, pairingProof: true });
    await sendFrame(fixture.tunnel, startHttp(`pair-bound-${index}`, { bodyLength }));
    assert.equal(fixture.tunnel.closed, true);
    fixture.tunnel.close();
  }
  assert.equal(requestCount, 0);
});

test('access offer identity rejects a different first Bearer before loopback dispatch', async t => {
  let requestCount = 0;
  const server = await listen((request, response) => { requestCount += 1; request.resume(); response.end('{}'); });
  const session = makeSession(ownerToken);
  const other = makeSession(rotatedToken);
  const fixture = tunnelFixture({ base: server.base, initialSession: session, offerOwnerKind: 'access', offerOwnerToken: ownerToken, sessions: [session, other] });
  t.after(() => closeServerAndTunnel(server, fixture.tunnel));
  await sendFrame(fixture.tunnel, startHttp('access-mismatch', {
    method: 'GET', path: '/api/servers', headers: { authorization: `Bearer ${rotatedToken}` }, bodyLength: 0,
  }));
  assert.equal(requestCount, 0);
  assert.ok(fixture.channel.frames.some(frame => frame.type === 'error'));
});

test('device refresh buffers and validates the exact owner body before loopback forwarding', async t => {
  const dispatched = [];
  const server = await listen((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      dispatched.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      const body = JSON.stringify({ accessToken: nextToken, deviceId: 'device-owner', authorizationGeneration: 'generation-1' });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
      response.end(body);
    });
  });
  const original = makeSession(ownerToken);
  const rotated = makeSession(nextToken);
  const fixture = tunnelFixture({ base: server.base, initialSession: original, offerOwnerKind: 'access', offerOwnerToken: ownerToken, sessions: [original, rotated] });
  t.after(() => closeServerAndTunnel(server, fixture.tunnel));
  const requestBody = JSON.stringify({ refreshToken, rotationId: 'rotation-identifier-123', deviceId: 'device-owner' });
  await sendFrame(fixture.tunnel, startHttp('refresh-good', {
    path: '/api/mobile/session/refresh', headers: { 'content-type': 'application/json' }, bodyLength: Buffer.byteLength(requestBody),
  }));
  assert.equal(dispatched.length, 0, 'refresh body must be buffered before a request is opened');
  await sendBody(fixture.tunnel, 'refresh-good', requestBody);
  await waitFor(() => fixture.channel.frames.some(frame => frame.type === 'http.response.end' && frame.id === 'refresh-good'), 'refresh response');
  assert.deepEqual(dispatched, [{
    method: 'POST', url: '/api/mobile/session/refresh', authorization: undefined, body: requestBody,
  }]);
  assert.ok(fixture.channel.frames.some(frame => frame.type === 'http.response.start' && frame.status === 200));
  assert.ok(fixture.authSessions.has(nextToken));
});

test('refresh rejects wrong device, malformed body, and expired family without forwarding', async t => {
  let requestCount = 0;
  const server = await listen((request, response) => { requestCount += 1; request.resume(); response.end('{}'); });
  t.after(() => server.close());
  const owner = makeSession(ownerToken);
  const cases = [
    { name: 'wrong-device', body: JSON.stringify({ refreshToken, rotationId: 'rotation-identifier-123', deviceId: 'other-device' }) },
    { name: 'malformed-fields', body: JSON.stringify({ refreshToken: 'bad', rotationId: 'short', deviceId: 'device-owner' }) },
  ];
  for (const testCase of cases) {
    const fixture = tunnelFixture({ base: server.base, initialSession: owner, sessions: [owner] });
    const body = testCase.body;
    await sendFrame(fixture.tunnel, startHttp(testCase.name, { path: '/api/mobile/session/refresh', bodyLength: Buffer.byteLength(body) }));
    await sendBody(fixture.tunnel, testCase.name, body);
    assert.equal(requestCount, 0, testCase.name);
    fixture.tunnel.close();
  }
  const expiredOwner = makeSession(ownerToken);
  const expired = tunnelFixture({
    base: server.base,
    initialSession: expiredOwner,
    sessions: [expiredOwner],
    family: { expiresAt: Date.now() - 1 },
  });
  const validBody = JSON.stringify({ refreshToken, rotationId: 'rotation-identifier-123', deviceId: 'device-owner' });
  await sendFrame(expired.tunnel, startHttp('expired-family', { path: '/api/mobile/session/refresh', bodyLength: Buffer.byteLength(validBody) }));
  assert.equal(requestCount, 0, 'expired device family must not dispatch refresh');
  expired.tunnel.close();
});

test('refresh response generation change is rejected after original Gateway validation', async t => {
  let requestCount = 0;
  const server = await listen((request, response) => {
    requestCount += 1; request.resume();
    const body = JSON.stringify({ accessToken: nextToken, deviceId: 'device-owner', authorizationGeneration: 'generation-2' });
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
    response.end(body);
  });
  const owner = makeSession(ownerToken);
  const changed = makeSession(nextToken, 'generation-2');
  const fixture = tunnelFixture({ base: server.base, initialSession: owner, sessions: [owner, changed] });
  t.after(() => closeServerAndTunnel(server, fixture.tunnel));
  const body = JSON.stringify({ refreshToken, rotationId: 'rotation-identifier-123', deviceId: 'device-owner' });
  await sendFrame(fixture.tunnel, startHttp('refresh-generation', { path: '/api/mobile/session/refresh', bodyLength: Buffer.byteLength(body) }));
  await sendBody(fixture.tunnel, 'refresh-generation', body);
  await waitFor(() => fixture.channel.frames.some(frame => frame.type === 'error' && frame.id === 'refresh-generation'), 'generation rejection');
  assert.equal(requestCount, 1);
  assert.equal(fixture.channel.frames.some(frame => frame.type === 'http.response.start' && frame.id === 'refresh-generation'), false);
  assert.equal(fixture.authSessions.has(nextToken), true);
  assert.equal(fixture.family.authorizationGeneration, 'generation-1');
});

function wsFixture(t, { sessions = [makeSession(ownerToken)], initialSession = makeSession(ownerToken) } = {}) {
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    constructor(url, protocols, options) {
      super();
      this.url = url;
      this.protocols = protocols;
      this.options = options;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => this.emit('open'));
    }
    send(data, options, callback) { this.sent.push({ data: Buffer.from(data), binary: options.binary }); callback?.(); }
    close(code, reason) { this.closeArgs = [code, reason]; this.emit('close', code, Buffer.from(reason)); }
    terminate() { this.terminated = true; }
    pong() {}
  }
  const fixture = tunnelFixture({ base: 'http://127.0.0.1:4175/', WebSocket: FakeWebSocket, sessions, initialSession, offerOwnerKind: 'access', offerOwnerToken: ownerToken });
  t.after(() => fixture.tunnel.close());
  return { ...fixture, sockets };
}

async function openRpc(fixture) {
  await sendFrame(fixture.tunnel, {
    version: 1, type: 'ws.open', id: 'rpc-one',
    path: '/rpc?channel=runtime&server=server-a&token=rpc-secret',
    authorization: `Bearer ${ownerToken}`, protocols: [],
  });
  await waitFor(() => fixture.channel.frames.some(frame => frame.type === 'ws.opened' || frame.type === 'error'), 'RPC open');
  assert.ok(fixture.channel.frames.some(frame => frame.type === 'ws.opened'), JSON.stringify({ frames: fixture.channel.frames, diagnostics: fixture.tunnel.diagnostics, sockets: fixture.sockets.length, authenticated: fixture.tunnel.authenticated, trace: fixture.trace }));
}

test('WebSocket incomplete assemblies are capped at eight and rejection releases the operation budget', async t => {
  const fixture = wsFixture(t);
  await openRpc(fixture);
  for (let index = 0; index < 8; index += 1) {
    await sendFrame(fixture.tunnel, {
      version: 1, type: 'ws.message.start', id: 'rpc-one', messageId: `message-${index}`,
      binary: false, byteLength: 0,
    });
  }
  assert.equal(fixture.tunnel.diagnostics.activeAssemblies, 8);
  await sendFrame(fixture.tunnel, {
    version: 1, type: 'ws.message.start', id: 'rpc-one', messageId: 'message-overflow', binary: false, byteLength: 0,
  });
  await waitFor(() => fixture.tunnel.diagnostics.operationCount === 0, 'RPC operation cleanup');
  assert.equal(fixture.tunnel.diagnostics.activeAssemblies, 0);
  assert.equal(fixture.tunnel.diagnostics.aggregateBytes, 0);
  assert.ok(fixture.sockets[0].closeArgs);
});

test('normal fragmented WebSocket message is reassembled and empty chunks close and release all resources', async t => {
  const fixture = wsFixture(t);
  await openRpc(fixture);
  await sendFrame(fixture.tunnel, {
    version: 1, type: 'ws.message.start', id: 'rpc-one', messageId: 'normal-message', binary: false, byteLength: 2,
  });
  await sendFrame(fixture.tunnel, {
    version: 1, type: 'ws.message.chunk', id: 'rpc-one', messageId: 'normal-message', seq: 0, data: Buffer.from('ok').toString('base64'),
  });
  await sendFrame(fixture.tunnel, { version: 1, type: 'ws.message.end', id: 'rpc-one', messageId: 'normal-message' });
  assert.equal(fixture.sockets[0].sent.length, 1);
  assert.equal(fixture.sockets[0].sent[0].data.toString('utf8'), 'ok');
  assert.deepEqual(fixture.tunnel.diagnostics, { activeAssemblies: 0, aggregateBytes: 0, pendingBytes: 0, pendingFrames: 0, operationCount: 1 });

  await sendFrame(fixture.tunnel, {
    version: 1, type: 'ws.message.start', id: 'rpc-one', messageId: 'unfinished-message', binary: false, byteLength: 3,
  });
  fixture.tunnel.receive(JSON.stringify({ version: 1, type: 'ws.message.chunk', id: 'rpc-one', messageId: 'unfinished-message', seq: 0, data: '' }));
  await waitFor(() => fixture.tunnel.closed, 'invalid empty chunk rejection');
  assert.equal(fixture.tunnel.diagnostics.activeAssemblies, 0);
  assert.equal(fixture.tunnel.diagnostics.aggregateBytes, 0);
  assert.equal(fixture.tunnel.diagnostics.operationCount, 0);
});

test('buffered DataChannel sends preserve every fragment of a large RPC response exactly once', async t => {
  const fixture = wsFixture(t);
  let bufferedBytes = 0;
  let acceptedFrames = 0;
  let backpressureWaitObserved = false;
  fixture.channel.bufferedAmount = () => {
    if (bufferedBytes > 1024 * 1024 - 16 * 1024) backpressureWaitObserved = true;
    return bufferedBytes;
  };
  fixture.channel.sendMessage = raw => {
    const bytes = Buffer.byteLength(raw);
    fixture.channel.frames.push(JSON.parse(raw));
    bufferedBytes += bytes;
    acceptedFrames += 1;
    setTimeout(() => { bufferedBytes = Math.max(0, bufferedBytes - bytes); }, 1);
    return false;
  };

  await openRpc(fixture);
  const rpcResponse = JSON.stringify({
    jsonrpc: '2.0',
    id: 17,
    result: { contentBase64: 'A'.repeat(Math.ceil(768 * 1024 * 4 / 3)) },
  });
  fixture.sockets[0].emit('message', Buffer.from(rpcResponse), false);
  await waitFor(() => fixture.channel.frames.some(frame => frame.type === 'ws.message.end'), 'large RPC response end');
  await waitFor(() => bufferedBytes === 0, 'queued DataChannel frames to drain');

  const starts = fixture.channel.frames.filter(frame => frame.type === 'ws.message.start');
  const ends = fixture.channel.frames.filter(frame => frame.type === 'ws.message.end');
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  const messageId = starts[0].messageId;
  const chunks = fixture.channel.frames
    .filter(frame => frame.type === 'ws.message.chunk' && frame.messageId === messageId)
    .sort((left, right) => left.seq - right.seq);
  assert.equal(chunks.length, Math.ceil(Buffer.byteLength(rpcResponse) / PEER_CHUNK_BYTES));
  assert.deepEqual(chunks.map(frame => frame.seq), chunks.map((_, index) => index));
  assert.deepEqual(Buffer.concat(chunks.map(frame => Buffer.from(frame.data, 'base64'))), Buffer.from(rpcResponse));
  assert.equal(acceptedFrames, fixture.channel.frames.length, 'every frame was submitted once despite false buffered results');
  assert.equal(backpressureWaitObserved, true, 'the test must exercise bufferedAmount draining above the high watermark');
  assert.equal(fixture.tunnel.closed, false);
  assert.equal(fixture.channel.closed, false);
});

test('a thrown DataChannel send still closes the owned peer', async t => {
  const fixture = wsFixture(t);
  let attempts = 0;
  fixture.channel.sendMessage = () => {
    attempts += 1;
    throw new Error('native DataChannel send failed');
  };
  await sendFrame(fixture.tunnel, {
    version: 1, type: 'ws.open', id: 'rpc-one',
    path: '/rpc?channel=runtime&server=server-a&token=rpc-secret',
    authorization: `Bearer ${ownerToken}`, protocols: [],
  });
  await waitFor(() => fixture.tunnel.closed, 'thrown DataChannel send cleanup');
  assert.equal(attempts, 1, 'a thrown send is not retried');
  assert.equal(fixture.channel.closed, true);
});
