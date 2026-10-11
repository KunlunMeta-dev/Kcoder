// Exercise close and half-close ordering over real loopback Relay TCP/WebSocket tunnels.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Agent, createServer, request } from 'node:http';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { startClient } from '../src/client.mjs';
import { startRelay } from '../src/server.mjs';

const authority = 'relay-transport-close.test:8451';
const largeBody = makeBody(384 * 1024);

function makeBody(length) {
  const body = Buffer.allocUnsafe(length);
  for (let index = 0; index < body.length; index += 1) body[index] = (index * 31 + 17) & 0xff;
  return body;
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(10);
  }
  throw new Error('timed out waiting for isolated Relay transport state');
}

async function startFixture(t) {
  const secret = randomBytes(32).toString('hex');
  const device = `transport-${randomBytes(4).toString('hex')}`;
  const gateway = createServer((req, res) => {
    if (req.url === '/empty-204') {
      res.writeHead(204, {
        connection: 'close',
        'content-length': '0',
        'x-relay-fixture': 'empty-204',
      });
      res.end();
      return;
    }
    if (req.url === '/large-close') {
      res.writeHead(200, {
        connection: 'close',
        'content-length': String(largeBody.length),
        'content-type': 'application/octet-stream',
        'x-relay-fixture': 'large-close',
      });
      // End immediately after queueing the complete response. The peer sees an
      // orderly close after these bytes, unlike the intentional /abort case.
      res.end(largeBody);
      return;
    }
    if (req.url === '/slow-close') {
      res.writeHead(200, {
        connection: 'close',
        'content-length': String(largeBody.length),
        'content-type': 'application/octet-stream',
        'x-relay-fixture': 'slow-close',
      });
      let offset = 0;
      let timer = null;
      const clear = () => clearTimeout(timer);
      const sendChunk = () => {
        if (res.destroyed || res.writableEnded) return;
        if (offset === largeBody.length) {
          res.end();
          return;
        }
        const next = Math.min(offset + 8 * 1024, largeBody.length);
        const writable = res.write(largeBody.subarray(offset, next));
        offset = next;
        if (writable) timer = setTimeout(sendChunk, 1);
        else res.once('drain', () => { timer = setTimeout(sendChunk, 1); });
      };
      res.once('close', clear);
      sendChunk();
      return;
    }
    if (req.url === '/abort') {
      res.writeHead(200, {
        connection: 'close',
        'content-length': String(largeBody.length),
        'content-type': 'application/octet-stream',
        'x-relay-fixture': 'intentional-abort',
      });
      res.flushHeaders();
      res.write(largeBody.subarray(0, 8 * 1024));
      setImmediate(() => res.socket?.destroy());
      return;
    }
    res.writeHead(404, { connection: 'close', 'content-length': '0' });
    res.end();
  });
  const gatewaySockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  gateway.on('upgrade', (req, socket, head) => {
    if (req.url !== '/rpc') {
      socket.destroy();
      return;
    }
    gatewaySockets.handleUpgrade(req, socket, head, ws => gatewaySockets.emit('connection', ws, req));
  });
  gatewaySockets.on('connection', socket => {
    socket.on('message', (data, binary) => socket.send(data, { binary }));
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');

  const relay = await startRelay({
    secret,
    device,
    controlPort: 0,
    proxyPort: 0,
    connectTimeout: 750,
    maxConnections: 8,
  });
  let onlineTimer;
  let resolveOnline;
  const online = new Promise((resolveOnlineClient, rejectOnlineClient) => {
    resolveOnline = resolveOnlineClient;
    onlineTimer = setTimeout(() => rejectOnlineClient(new Error('isolated reverse client did not become online')), 3000);
  });
  const client = startClient({
    url: `http://127.0.0.1:${relay.controlPort}`,
    secret,
    device,
    gateway: `http://127.0.0.1:${gateway.address().port}`,
    allowInsecure: true,
    retryMs: 20,
    onOnline: () => {
      clearTimeout(onlineTimer);
      resolveOnline();
    },
  });
  try {
    await online;
    await waitFor(async () => {
      const health = await readHealth(relay.controlPort);
      return health.online ? health : null;
    });
  } catch (error) {
    client.close();
    await relay.close();
    gateway.closeAllConnections();
    await new Promise(resolveClose => gateway.close(resolveClose));
    gatewaySockets.close();
    throw error;
  }

  let closed = false;
  t.after(async () => {
    if (closed) return;
    closed = true;
    clearTimeout(onlineTimer);
    client.close();
    for (const socket of gatewaySockets.clients) socket.terminate();
    await relay.close();
    gateway.closeAllConnections();
    await new Promise(resolveClose => gateway.close(resolveClose));
    gatewaySockets.close();
  });

  return {
    relay,
    client,
    async health() { return readHealth(relay.controlPort); },
    async waitIdle() {
      return waitFor(async () => {
        const health = await readHealth(relay.controlPort);
        return health.pending === 0 && health.connections === 0 ? health : null;
      });
    },
    request(path, options = {}) { return requestThroughRelay(relay, path, options); },
    openRpc() { return openRpc(relay.proxyPort); },
  };
}

async function readHealth(port) {
  return new Promise((resolveHealth, rejectHealth) => {
    const outgoing = request({ host: '127.0.0.1', port, path: '/_relay/health', timeout: 1500 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolveHealth(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { rejectHealth(error); }
      });
      response.once('error', rejectHealth);
    });
    outgoing.once('timeout', () => outgoing.destroy(new Error('Relay health request timed out')));
    outgoing.once('error', rejectHealth);
    outgoing.end();
  });
}

function requestThroughRelay(relay, path, { agent = false, slowDownstreamMs = 0, onFirstData, timeoutMs = 5000 } = {}) {
  return new Promise((resolveResponse, rejectResponse) => {
    const outgoing = request({
      host: '127.0.0.1',
      port: relay.proxyPort,
      method: 'GET',
      path,
      agent,
      headers: { host: authority, connection: agent ? 'keep-alive' : 'close' },
    }, response => {
      const chunks = [];
      let sawData = false;
      response.on('data', chunk => {
        chunks.push(Buffer.from(chunk));
        if (!sawData) {
          sawData = true;
          onFirstData?.();
        }
        if (slowDownstreamMs > 0) {
          response.pause();
          setTimeout(() => response.resume(), slowDownstreamMs);
        }
      });
      response.once('end', () => resolveResponse({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        requestSocket: outgoing.socket,
      }));
      response.once('aborted', () => rejectResponse(new Error(`Relay response aborted for ${path}`)));
      response.once('error', rejectResponse);
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error(`Relay request timed out for ${path}`)));
    outgoing.once('error', rejectResponse);
    outgoing.end();
  });
}

function requestForIntentionalAbort(relay) {
  return new Promise((resolveAbort, rejectAbort) => {
    let responseSeen = false;
    let responseStatus = null;
    const outgoing = request({
      host: '127.0.0.1',
      port: relay.proxyPort,
      method: 'GET',
      path: '/abort',
      headers: { host: authority, connection: 'close' },
    }, response => {
      responseSeen = true;
      responseStatus = response.statusCode;
      response.on('data', () => {});
      response.once('aborted', () => resolveAbort({ responseSeen, responseStatus, aborted: true }));
      response.once('end', () => resolveAbort({ responseSeen, responseStatus, aborted: false }));
      response.once('error', () => resolveAbort({ responseSeen, responseStatus, aborted: true }));
    });
    outgoing.setTimeout(4000, () => outgoing.destroy(new Error('intentional-abort probe timed out')));
    outgoing.once('error', error => {
      if (error.code === 'ECONNRESET') resolveAbort({ responseSeen, responseStatus, aborted: true });
      else rejectAbort(error);
    });
    outgoing.end();
  });
}

async function openRpc(proxyPort) {
  const socket = new WebSocket(`ws://127.0.0.1:${proxyPort}/rpc`, {
    headers: { host: authority },
    handshakeTimeout: 3000,
    perMessageDeflate: false,
  });
  socket.on('error', () => {});
  await once(socket, 'open');
  return socket;
}

test('forwards a Connection: close 204 response before releasing the TCP owner', async t => {
  const fixture = await startFixture(t);
  const response = await fixture.request('/empty-204');
  assert.equal(response.status, 204);
  assert.equal(response.headers.connection, 'close');
  assert.equal(response.headers['content-length'], '0');
  assert.equal(response.headers['x-relay-fixture'], 'empty-204');
  assert.deepEqual(response.body, Buffer.alloc(0));
  const idle = await fixture.waitIdle();
  assert.equal(idle.pending, 0);
  assert.equal(idle.connections, 0);
});

test('forwards a large response whose Gateway socket closes immediately after end', async t => {
  const fixture = await startFixture(t);
  const response = await fixture.request('/large-close');
  assert.equal(response.status, 200);
  assert.equal(response.headers.connection, 'close');
  assert.equal(response.headers['content-length'], String(largeBody.length));
  assert.equal(response.headers['x-relay-fixture'], 'large-close');
  assert.deepEqual(response.body, largeBody);
  const idle = await fixture.waitIdle();
  assert.equal(idle.pending, 0);
  assert.equal(idle.connections, 0);
});

test('slow downstream and an independent WSS close do not truncate the HTTP response', async t => {
  const fixture = await startFixture(t);
  const rpc = await fixture.openRpc();
  const echoed = once(rpc, 'message');
  rpc.send('owner-ready');
  const [echo] = await echoed;
  assert.equal(echo.toString(), 'owner-ready');

  let closePromise;
  const response = await fixture.request('/slow-close', {
    slowDownstreamMs: 3,
    onFirstData() {
      closePromise = once(rpc, 'close');
      rpc.close();
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.connection, 'close');
  assert.equal(response.headers['content-length'], String(largeBody.length));
  assert.equal(response.headers['x-relay-fixture'], 'slow-close');
  assert.deepEqual(response.body, largeBody);
  await closePromise;
  const idle = await fixture.waitIdle();
  assert.equal(idle.pending, 0);
  assert.equal(idle.connections, 0);
});

test('an HTTP keep-alive Agent safely opens a new socket after Gateway Connection: close', async t => {
  const fixture = await startFixture(t);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());

  const first = await fixture.request('/empty-204', { agent });
  const second = await fixture.request('/large-close', { agent });
  assert.equal(first.status, 204);
  assert.deepEqual(first.body, Buffer.alloc(0));
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, largeBody);
  assert.notEqual(first.requestSocket, second.requestSocket,
    'the closed tunnel must not be reused as an HTTP keep-alive socket');
  const idle = await fixture.waitIdle();
  assert.equal(idle.pending, 0);
  assert.equal(idle.connections, 0);
});

test('an intentional Gateway socket destroy is surfaced as abort and releases Relay ownership', async t => {
  const fixture = await startFixture(t);
  const result = await requestForIntentionalAbort(fixture.relay);
  assert.equal(result.responseSeen, true, 'the fixture should send response headers before destroying its socket');
  assert.equal(result.responseStatus, 200);
  assert.equal(result.aborted, true,
    'an application-level socket destroy is an abort; complete-body delivery is not guaranteed');
  const idle = await fixture.waitIdle();
  assert.equal(idle.pending, 0);
  assert.equal(idle.connections, 0);
});
