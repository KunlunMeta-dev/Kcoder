// Model-independent transport tests: real TCP/HTTP/WebSocket through both relay processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { startRelay } from '../src/server.mjs';
import { startClient } from '../src/client.mjs';

const secret = 'test-secret-0123456789-0123456789-0123456789';
function http(port, body = null) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/test', method: body ? 'POST' : 'GET', headers: { host: 'public.example:8451', authorization: 'Bearer gateway-test' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}
function health(port) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/_relay/health' }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}
function nextOpen(control, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      control.removeListener('message', onMessage);
      control.removeListener('close', onClose);
    };
    const finish = (error, message) => {
      cleanup();
      if (error) reject(error); else resolve(message);
    };
    const onMessage = raw => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return finish(new Error('relay control sent invalid JSON')); }
      if (message.type === 'open') finish(null, message);
    };
    const onClose = () => finish(new Error('relay control closed before the next open'));
    const timer = setTimeout(() => finish(new Error('timed out waiting for relay control open')), timeoutMs);
    control.on('message', onMessage);
    control.once('close', onClose);
  });
}
async function unauthorized(port, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/_relay/control`, { headers });
  ws.on('error', () => {});
  return new Promise(resolve => ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); }));
}
async function fixture(t, options = {}) {
  const gateway = createServer((req, res) => {
    assert.equal(req.headers.host, 'public.example:8451');
    assert.equal(req.headers.authorization, 'Bearer gateway-test');
    req.pipe(res);
  });
  const wss = new WebSocketServer({ server: gateway });
  wss.on('connection', ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const relay = await startRelay({ secret, device: 'test', controlPort: 0, proxyPort: 0, ...options });
  let client;
  t.after(async () => {
    client?.close();
    await relay.close();
    for (const ws of wss.clients) ws.terminate();
    gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
    wss.close();
  });
  return { relay, async connect() {
    await new Promise(resolve => {
      client = startClient({ secret, device: 'test', url: `http://127.0.0.1:${relay.controlPort}`, allowInsecure: true, gateway: `http://127.0.0.1:${gateway.address().port}`, retryMs: 30, onOnline: resolve });
    });
    return client;
  } };
}
test('offline returns 503; unauthorized, wrong device and duplicate control rejected', async t => {
  const { relay, connect } = await fixture(t);
  assert.equal((await http(relay.proxyPort)).status, 503);
  assert.equal(await unauthorized(relay.controlPort, {}), 401);
  assert.equal(await unauthorized(relay.controlPort, { authorization: `Bearer ${secret}`, 'x-kcoder-device': 'other' }), 401);
  await connect();
  assert.equal(await unauthorized(relay.controlPort, { authorization: `Bearer ${secret}`, 'x-kcoder-device': 'test' }), 409);
});
test('concurrent HTTP binary streaming preserves request authority, credentials and bytes', async t => {
  const { relay, connect } = await fixture(t); await connect();
  const payload = Buffer.alloc(3 * 1024 * 1024, 173);
  const responses = await Promise.all(Array.from({ length: 8 }, () => http(relay.proxyPort, payload)));
  for (const res of responses) { assert.equal(res.status, 200); assert.deepEqual(res.body, payload); }
});
test('WebSocket binary/text survives tunnelling; disconnect closes resources; fresh client reconnects', async t => {
  const { relay, connect } = await fixture(t); const client = await connect();
  const ws = new WebSocket(`ws://127.0.0.1:${relay.proxyPort}/rpc`);
  ws.on('error', () => {}); await once(ws, 'open');
  for (const value of ['hello', Buffer.alloc(300000, 91)]) {
    const received = once(ws, 'message'); ws.send(value);
    const [data, binary] = await received;
    assert.deepEqual(data, Buffer.from(value)); assert.equal(binary, typeof value !== 'string');
  }
  const closed = once(ws, 'close'); client.close(); await closed;
  assert.equal((await http(relay.proxyPort)).status, 503);
  await connect(); assert.equal((await http(relay.proxyPort, 'again')).body.toString(), 'again');
});
test('missing data connection times out and releases capacity', async t => {
  const { relay } = await fixture(t, { connectTimeout: 100, maxConnections: 1 });
  const control = new WebSocket(`ws://127.0.0.1:${relay.controlPort}/_relay/control`, { headers: { authorization: `Bearer ${secret}`, 'x-kcoder-device': 'test' } });
  control.on('error', () => {}); t.after(() => control.terminate()); await once(control, 'open');

  const firstOpenPromise = nextOpen(control);
  const firstResponsePromise = http(relay.proxyPort);
  const firstOpen = await firstOpenPromise;
  assert.match(firstOpen.id, /^[a-f0-9]{48}$/);
  assert.equal((await firstResponsePromise).status, 503);

  const firstExpired = await health(relay.controlPort);
  assert.equal(firstExpired.status, 200);
  assert.deepEqual(JSON.parse(firstExpired.body.toString()), { online: true, connections: 0, pending: 0 });

  const secondOpenPromise = nextOpen(control);
  const secondResponsePromise = http(relay.proxyPort);
  const secondOpen = await secondOpenPromise;
  assert.match(secondOpen.id, /^[a-f0-9]{48}$/);
  assert.notEqual(secondOpen.id, firstOpen.id);
  assert.equal((await secondResponsePromise).status, 503);

  const secondExpired = await health(relay.controlPort);
  assert.equal(secondExpired.status, 200);
  assert.deepEqual(JSON.parse(secondExpired.body.toString()), { online: true, connections: 0, pending: 0 });
});

test('a rejected data WebSocket upgrade releases its waiting HTTP socket', async t => {
  const { relay } = await fixture(t, { connectTimeout: 1000, maxConnections: 1 });
  const control = new WebSocket(`ws://127.0.0.1:${relay.controlPort}/_relay/control`, {
    headers: { authorization: `Bearer ${secret}`, 'x-kcoder-device': 'test' },
  });
  control.on('error', () => {});
  t.after(() => control.terminate());
  await once(control, 'open');

  const openRequest = new Promise(resolve => {
    control.once('message', raw => resolve(JSON.parse(raw.toString())));
  });
  const waiting = createConnection({ host: '127.0.0.1', port: relay.proxyPort });
  waiting.on('error', () => {});
  t.after(() => waiting.destroy());
  await once(waiting, 'connect');
  waiting.write('GET /waiting HTTP/1.1\r\nHost: public.example:8451\r\nConnection: keep-alive\r\n\r\n');
  const message = await openRequest;
  assert.equal(message.type, 'open');
  assert.match(message.id, /^[a-f0-9]{48}$/);

  const malformed = createConnection({ host: '127.0.0.1', port: relay.controlPort });
  malformed.on('error', () => {});
  t.after(() => malformed.destroy());
  await once(malformed, 'connect');
  malformed.write([
    `GET /_relay/data?id=${message.id} HTTP/1.1`,
    'Host: localhost',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    `Authorization: Bearer ${secret}`,
    'x-kcoder-device: test',
    '',
    '',
  ].join('\r\n'));

  const upstreamResult = await new Promise(resolve => {
    const chunks = [];
    const finish = () => resolve(Buffer.concat(chunks).toString('utf8'));
    waiting.on('data', chunk => chunks.push(chunk));
    waiting.once('close', finish);
    setTimeout(finish, 300).unref();
  });
  waiting.destroy();
  malformed.destroy();
  assert.match(upstreamResult, /503 Service Unavailable/,
    'the original proxy request must receive a bounded failure when its data tunnel is rejected');
});
test('production client rejects plaintext relay and non-loopback Gateway', () => {
  assert.throws(() => startClient({ url: 'http://public.example', secret, device: 'test' }), /HTTPS/);
  assert.throws(() => startClient({ url: 'https://public.example', gateway: 'http://10.0.0.1', secret, device: 'test' }), /loopback/);
});
test('client reconnects automatically after the relay process restarts', async t => {
  const gateway = createServer((req, res) => req.pipe(res));
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  let relay = await startRelay({ secret, device: 'test', controlPort: 0, proxyPort: 0 });
  const controlPort = relay.controlPort, proxyPort = relay.proxyPort;
  let onlineCount = 0, connected;
  let nextOnline = new Promise(resolve => { connected = resolve; });
  const client = startClient({ secret, device: 'test', url: `http://127.0.0.1:${controlPort}`, allowInsecure: true, gateway: `http://127.0.0.1:${gateway.address().port}`, retryMs: 20, onOnline: () => { onlineCount++; connected(); } });
  t.after(async () => { client.close(); await relay.close(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  await nextOnline;
  await relay.close();
  nextOnline = new Promise(resolve => { connected = resolve; });
  relay = await startRelay({ secret, device: 'test', controlPort, proxyPort });
  await Promise.race([nextOnline, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('reconnect timed out')), 5000); timeout.unref(); })]);
  assert.equal(onlineCount, 2);
  assert.equal((await http(proxyPort, 'after restart')).body.toString(), 'after restart');
});
