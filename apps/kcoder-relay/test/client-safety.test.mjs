// Default regression coverage for the approved client fixes, with no live Relay.
import assert from 'node:assert/strict';
import { once, getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { startClient, startRegisteredClient, ensureRegisteredClientIdentity, checkRegisteredClientAccess } from '../src/client.mjs';
import { prepareClientIdentity, saveRegisteredClientIdentity, readRegisteredClientIdentity } from '../src/client-identity.mjs';
import { startRelay } from '../src/server.mjs';
import { assignment, gatewaySecret, registrationKey, secret, ownedRoot, environment, capture, bounded, wait,
  clientPath, tlsCliFixture } from './fixtures/client-safety-resources.mjs';

const canary = 'PRIVATE_CLIENT_CANCEL_CANARY';
const registrationResponse = () => new Response(JSON.stringify({ ...assignment, gatewaySecret,
  maxConnections: 128, maxBytesPerWindow: 67108864, trafficWindowMs: 60000 }), { status: 201 });
const safeCancellation = error => {
  assert.equal(error.name, 'AbortError'); assert.equal(error.code, 'RELAY_REGISTRATION_CANCELLED');
  assert.equal(error.externalOutcome, 'unknown');
  assert.equal(JSON.stringify(error).includes(canary), false);
  assert.equal(String(error).includes(canary), false); assert.equal(String(error.stack).includes(canary), false);
};

test('typed control frames cannot crash a child or stop its independent client and later valid opens', async t => {
  const f = await ownedRoot(t), child = fileURLToPath(new URL('./fixtures/client-safety-child.mjs', import.meta.url));
  const result = await capture([child], environment(f.root), f.root);
  assert.equal(result.timedOut, false); assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { rejected: 5, localConnections: 3,
    independentOwnerSurvived: true, ownedPeersClosed: true });
});

test('the real CLI reports 401 and 403 with one fixed terminal diagnostic and a nonzero exit', async t => {
  const f = await tlsCliFixture(t), results = [];
  for (const status of [401, 403]) {
    f.setStatus(() => status); const before = f.requests.length;
    const result = await capture([clientPath], f.env, f.root);
    assert.equal(result.timedOut, false); assert.equal(f.requests.length - before, 1);
    results.push(result);
  }
  for (const result of results) {
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), 'RELAY_AUTHORIZATION_DENIED');
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(secret), false); assert.equal(result.stderr.includes(gatewaySecret), false);
  }
});

test('the real CLI keeps the existing retry after a temporary handshake rejection', async t => {
  const f = await tlsCliFixture(t); f.setStatus(attempt => attempt === 1 ? 503 : 101);
  const began = performance.now(), result = await capture([clientPath], f.env, f.root, true);
  assert.equal(result.timedOut, false); assert.equal(result.code, 0); assert.equal(f.requests.length, 2);
  assert.ok(performance.now() - began >= 1900);
  assert.equal(result.stdout.includes('KCoder relay connected'), true);
  assert.equal(result.stderr.includes('RELAY_AUTHORIZATION_DENIED'), false);
});

test('Gateway URL parse failure has one fixed code and retains its cause only locally', () => {
  let error;
  try { startClient({ url: 'https://owned.example.test', secret, gateway: `http://user:${canary}@` }); }
  catch (caught) { error = caught; }
  assert.equal(error?.code, 'RELAY_GATEWAY_URL_INVALID');
  assert.equal(error.cause?.input === `http://user:${canary}@`, true);
  assert.equal(String(error).includes(canary), false); assert.equal(JSON.stringify(error).includes(canary), false);
});

test('the real CLI projects only the approved Gateway parse code without its private cause', async t => {
  const f = await tlsCliFixture(t);
  const result = await capture([clientPath], { ...f.env, KCODER_RELAY_LOCAL_GATEWAY: `http://user:${canary}@` }, f.root);
  assert.equal(result.timedOut, false); assert.equal(result.code, 1); assert.equal(f.requests.length, 0);
  assert.equal(result.stderr.trim(), 'RELAY_GATEWAY_URL_INVALID');
  assert.equal(result.stderr.includes(canary), false); assert.equal(result.stderr.includes('at validateGateway'), false);
});

test('a pre-aborted startup has a fixed classification before identity creation or send', async t => {
  const f = await ownedRoot(t), controller = new AbortController(), identityFile = join(f.root, 'not-created', 'identity.json');
  controller.abort(new Error(canary)); let sends = 0;
  const error = await ensureRegisteredClientIdentity({ url: 'https://owned.example.test', identityFile,
    gatewaySecret, registrationKey, signal: controller.signal, fetchImpl: async () => { sends++; return registrationResponse(); } }).catch(error => error);
  safeCancellation(error); assert.equal(sends, 0); await assert.rejects(lstat(join(f.root, 'not-created')), { code: 'ENOENT' });
});

test('caller abort during fetch keeps its original enrollment proof and releases the request listener', async t => {
  const f = await ownedRoot(t), controller = new AbortController(), identityFile = join(f.root, 'identity.json');
  let started, originalProof;
  const fetching = new Promise(resolve => { started = resolve; });
  const pending = ensureRegisteredClientIdentity({ url: 'https://owned.example.test', identityFile, gatewaySecret, registrationKey,
    signal: controller.signal, fetchImpl: async (_url, init) => {
      originalProof = JSON.parse(init.body).enrollmentToken; started();
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    } }).catch(error => error);
  await bounded(fetching); controller.abort(new Error(canary)); safeCancellation(await bounded(pending));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const current = await prepareClientIdentity({ identityFile, relayUrl: 'https://owned.example.test', gatewaySecret });
  assert.equal(current.enrollmentToken, originalProof);
});

test('caller abort while reading the registration body is still classified and detached', async t => {
  const f = await ownedRoot(t), controller = new AbortController(); let reading;
  const bodyRead = new Promise(resolve => { reading = resolve; });
  const pending = ensureRegisteredClientIdentity({ url: 'https://owned.example.test', identityFile: join(f.root, 'body.json'),
    gatewaySecret, registrationKey, signal: controller.signal, fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(body) {
        body.enqueue(new TextEncoder().encode('{'));
        init.signal.addEventListener('abort', () => body.error(init.signal.reason), { once: true });
      }, pull() { reading(); },
    }), { status: 201 }) }).catch(error => error);
  await bounded(bodyRead); controller.abort(new Error(canary)); safeCancellation(await bounded(pending));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a committed registration followed by abort stays unknown and reconciles only the original proof', async t => {
  const f = await ownedRoot(t), controller = new AbortController();
  const relay = await startRelay({ registrationKey, registrationStoreFile: join(f.root, 'store.json'),
    sharedHosts: ['owned-client-fix.test'], controlPort: 0, proxyPort: 0 });
  f.close(() => relay.close());
  const url = `http://127.0.0.1:${relay.controlPort}`, identityFile = join(f.root, 'identity.json');
  const payloads = []; let committed;
  const options = { url, allowInsecure: true, gatewaySecret, registrationKey, identityFile };
  const error = await ensureRegisteredClientIdentity({ ...options, signal: controller.signal, fetchImpl: async (input, init) => {
    payloads.push(JSON.parse(init.body)); const response = await fetch(input, init);
    assert.equal(response.status, 201); committed = await response.json();
    controller.abort(new Error(canary)); throw controller.signal.reason;
  } }).catch(error => error);
  safeCancellation(error); assert.equal(payloads.length, 1);
  const pending = await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret });
  assert.equal(pending.enrollmentToken, payloads[0].enrollmentToken);
  const restored = await ensureRegisteredClientIdentity({ ...options, fetchImpl: async (input, init) => {
    payloads.push(JSON.parse(init.body)); return fetch(input, init);
  } });
  assert.deepEqual(payloads[1], payloads[0]); assert.deepEqual(restored, { id: committed.id, secret: committed.secret });
  assert.deepEqual(await readRegisteredClientIdentity({ identityFile, relayUrl: url, gatewaySecret }), restored);
});

test('registration success, HTTP refusal and network failure all retire their request signals', async t => {
  const f = await ownedRoot(t);
  for (const mode of ['success', 'refused', 'network']) {
    const controller = new AbortController(); let requestSignal;
    await ensureRegisteredClientIdentity({ url: 'https://owned.example.test', gatewaySecret, registrationKey,
      identityFile: join(f.root, `${mode}.json`), signal: controller.signal, fetchImpl: async (_url, init) => {
        requestSignal = init.signal;
        if (mode === 'network') throw new Error('owned network failure');
        return mode === 'refused' ? new Response(null, { status: 403 }) : registrationResponse();
      } }).catch(error => { if (mode === 'success') throw error; });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(requestSignal?.aborted, false); controller.abort(new Error(canary));
    assert.equal(requestSignal.aborted, false, 'a finished request must not retain its parent abort subscription');
  }
});

test('access requests work on supported runtimes and retire listeners without inventing revocation', async t => {
  const f = await ownedRoot(t), url = 'https://owned.example.test', identityFile = join(f.root, 'identity.json');
  const pending = await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret });
  await saveRegisteredClientIdentity({ identityFile, relayUrl: url, gatewaySecret, ...pending, ...assignment });
  for (const mode of ['authorized', 'denied', 'unknown', 'revoked']) {
    const controller = new AbortController(); let requestSignal, sends = 0;
    const outcome = await checkRegisteredClientAccess({ url, identityFile, gatewaySecret, signal: controller.signal,
      revoke: mode === 'revoked', fetchImpl: async (_input, init) => {
        sends++; requestSignal = init.signal;
        if (mode === 'unknown') throw new Error('owned access failure');
        return new Response(null, { status: mode === 'denied' ? 403 : 204 });
      } });
    assert.equal(outcome, mode); assert.equal(sends, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort(new Error(canary)); assert.equal(requestSignal.aborted, false);
  }
});

test('the startup budget is not attached to the long-lived registered client owner', async t => {
  const f = await ownedRoot(t), controller = new AbortController(), server = createServer(), peers = new WebSocketServer({ server });
  const locals = new Set(); let connections = 0, control, client;
  const gateway = tcpServer(socket => { connections++; locals.add(socket); socket.on('error', () => {}); socket.once('close', () => locals.delete(socket)); });
  peers.on('connection', (peer, request) => { peer.on('error', () => {}); if (request.url === '/_relay/control') control = peer; });
  server.listen(0, '127.0.0.1'); gateway.listen(0, '127.0.0.1'); await Promise.all([once(server, 'listening'), once(gateway, 'listening')]);
  f.close(async () => {
    client?.close(); for (const peer of peers.clients) peer.terminate(); for (const socket of locals) socket.destroy();
    await bounded(Promise.all([new Promise(resolve => peers.close(resolve)), new Promise(resolve => server.close(resolve)), new Promise(resolve => gateway.close(resolve))]));
    assert.equal(locals.size, 0); assert.equal(peers.clients.size, 0);
  });
  const identityFile = join(f.root, 'identity.json'), url = `http://127.0.0.1:${server.address().port}`;
  const pending = await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret });
  await saveRegisteredClientIdentity({ identityFile, relayUrl: url, gatewaySecret, ...pending, ...assignment });
  let online; const ready = new Promise(resolve => { online = resolve; });
  client = await startRegisteredClient({ url, identityFile, gatewaySecret, allowInsecure: true, signal: controller.signal,
    gateway: `http://127.0.0.1:${gateway.address().port}`, onOnline: online });
  await bounded(ready); controller.abort(new Error(canary));
  control.send(JSON.stringify({ type: 'open', id: 'c'.repeat(48) }));
  await bounded((async () => { while (connections === 0) await wait(5); })());
  assert.equal(connections, 1); assert.equal(control.readyState, 1);
});

test('actual request deadlines stay 10s and 3s while retired requests have no later timeout', async t => {
  const f = await ownedRoot(t), url = 'https://owned.example.test', accessFile = join(f.root, 'access.json');
  const pending = await prepareClientIdentity({ identityFile: accessFile, relayUrl: url, gatewaySecret });
  await saveRegisteredClientIdentity({ identityFile: accessFile, relayUrl: url, gatewaySecret, ...pending, ...assignment });
  const retired = [];
  await ensureRegisteredClientIdentity({ url, gatewaySecret, registrationKey, identityFile: join(f.root, 'retired.json'),
    fetchImpl: async (_url, init) => { retired.push(init.signal); return registrationResponse(); } });
  assert.equal(await checkRegisteredClientAccess({ url, identityFile: accessFile, gatewaySecret,
    fetchImpl: async (_url, init) => { retired.push(init.signal); return new Response(null, { status: 204 }); } }), 'authorized');
  const registration = new AbortController(), access = new AbortController();
  const observed = [], errors = [];
  const fetchUntilDeadline = kind => async (_url, init) => {
    const record = { kind, signal: init.signal, started: performance.now(), aborts: 0 }; observed.push(record);
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      record.aborts++; record.elapsed = performance.now() - record.started; reject(init.signal.reason);
    }, { once: true }));
  };
  const outcomes = await bounded(Promise.all([
    ensureRegisteredClientIdentity({ url, gatewaySecret, registrationKey, identityFile: join(f.root, 'deadline.json'),
      signal: registration.signal, fetchImpl: fetchUntilDeadline('registration') }).catch(error => { errors.push(error); return 'registration_failed'; }),
    checkRegisteredClientAccess({ url, identityFile: accessFile, gatewaySecret, signal: access.signal,
      fetchImpl: fetchUntilDeadline('access') }),
  ]), 12000);
  assert.deepEqual(outcomes, ['registration_failed', 'unknown']); assert.equal(errors.length, 1);
  assert.equal(errors[0].code, undefined, 'internal timeout remains distinct from caller cancellation');
  assert.equal(registration.signal.aborted, false); assert.equal(access.signal.aborted, false);
  for (const record of observed) {
    const duration = record.kind === 'registration' ? 10000 : 3000;
    assert.equal(record.aborts, 1); assert.equal(record.signal.reason.name, 'TimeoutError');
    assert.ok(record.elapsed >= duration - 50); assert.ok(record.elapsed < duration + 1500);
  }
  assert.equal(observed.length, 2); assert.equal(retired.length, 2);
  assert.ok(retired.every(signal => !signal.aborted), 'both completed requests cleared their former deadlines');
  assert.equal(getEventListeners(registration.signal, 'abort').length, 0);
  assert.equal(getEventListeners(access.signal, 'abort').length, 0);
});
