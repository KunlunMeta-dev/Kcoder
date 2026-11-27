import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayUrls } from '../deploy/config.mjs';
import { verifyRelay } from '../src/verify-client.mjs';
import { createServer } from 'node:http';

async function fixture(t, mode = 'success', revokeStatus = 204) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-relay-verify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  class Socket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => mode === 'handshake-error' ? this.emit('error', new Error('PRIVATE_SOCKET_CANARY')) : this.emit('open'));
    }
    send(raw, callback) {
      const request = JSON.parse(raw); callback?.();
      if (!request.id) return;
      queueMicrotask(() => {
        if (mode === 'malformed') { this.emit('message', Buffer.from('PRIVATE_INVALID_JSON_CANARY')); return; }
        if (mode === 'close') { this.emit('close'); return; }
        if (mode === 'rpc-timeout') return;
        if (mode === 'rpc-unrelated') {
          this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '1.0', method: 'fixture/notice' })));
          this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '1.0', id: 999999, result: {}, error: null })));
        }
        const result = request.method === 'initialize' ? { protocolVersion: '2026-07-27' }
          : mode === 'threads-invalid' ? { invalid: true } : { threads: [] };
        this.emit('message', Buffer.from(JSON.stringify({ id: request.id, result,
          ...(mode === 'rpc-legacy' ? {} : { jsonrpc: '2.0' }),
          ...(mode === 'rpc-both' ? { error: null } : {}),
          ...(mode === 'rpc-version' ? { jsonrpc: '1.0' } : {}) })));
        if (mode === 'trailing-malformed' && request.method === 'thread/list')
          this.emit('message', Buffer.from('PRIVATE_TRAILING_FRAME_CANARY'));
      });
    }
    terminate() { this.emit('close'); }
  }
  const fetchResponse = async (url, options) => {
    requests.push({ path: new URL(url).pathname, options });
    assert.ok(options.signal instanceof AbortSignal);
    if (new URL(url).pathname === '/_relay/health') return Response.json({ online: true });
    if (new URL(url).pathname.endsWith('/api/servers')) return Response.json(mode === 'servers-empty' ? { servers: [] } : { servers: [{ id: 'local' }] });
    if (options.method === 'DELETE') return new Response(null, { status: revokeStatus });
    const body = JSON.parse(options.body);
    if (body.token !== 'PAIRING_FIXTURE') return new Response(null, { status: 401 });
    if (mode === 'session-lost') throw new Error('PRIVATE_SESSION_RECEIPT_CANARY');
    if (mode === 'session-no-access') return Response.json({ rpcToken: 'RPC_FIXTURE' });
    if (mode === 'session-no-rpc') return Response.json({ accessToken: 'ACCESS_FIXTURE' });
    return mode === 'session-invalid' ? new Response('PRIVATE_SESSION_CANARY')
      : Response.json({ accessToken: 'ACCESS_FIXTURE', rpcToken: 'RPC_FIXTURE' });
  };
  return { requests, directory, options: { urls: createRelayUrls({ publicUrl: 'https://relay.fixture.invalid', gatewayId: 'fixture', routeMode: 'path' }),
    selectedGateway: { id: 'fixture', gatewaySecret: 'PRIVATE_CREDENTIAL_CANARY' }, Socket, fetchResponse,
    getPairing: async () => ({ token: 'PAIRING_FIXTURE' }), timeoutMs: 100, evidenceDir: directory } };
}

test('Node events.once(open) rejects handshake errors despite an existing no-op error listener', async () => {
  const emitter = new EventEmitter(); emitter.on('error', () => {});
  const opening = once(emitter, 'open'); const failure = new Error('CONTROLLED_HANDSHAKE');
  emitter.emit('error', failure);
  await assert.rejects(opening, error => error === failure);
});

test('importing the CLI wiring does not load configuration or start verification', async () => {
  assert.equal(typeof (await import('../src/verify.mjs')).main, 'function');
});

test('verification records root and gateway separately only after the owned session is revoked', async t => {
  const f = await fixture(t);
  const evidence = await verifyRelay(f.options);
  assert.equal(evidence.publicUrl, 'https://relay.fixture.invalid/');
  assert.equal(evidence.gatewayUrl, f.options.urls.gatewayBase.toString().replace(/\/$/, ''));
  assert.equal(f.requests.at(-1).options.method, 'DELETE');
  assert.equal(JSON.stringify(evidence).includes('CANARY'), false);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'verification.json'), 'utf8')), evidence);
});

for (const [mode, code] of [['handshake-error', 'RELAY_VERIFICATION_WEBSOCKET_FAILED'], ['malformed', 'RELAY_VERIFICATION_RPC_INVALID_JSON'],
  ['close', 'RELAY_VERIFICATION_WEBSOCKET_CLOSED'], ['servers-empty', 'RELAY_VERIFICATION_SERVERS_INVALID']]) {
  test(`verification failure (${mode}) revokes its owned session and publishes no PASS`, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(verifyRelay(f.options), error => error.code === code && !String(error).includes('CANARY'));
    assert.equal(f.requests.filter(row => row.options.method === 'DELETE').length, 1);
    await assert.rejects(readFile(join(f.directory, 'verification.json')), { code: 'ENOENT' });
  });
}

test('cleanup failure preserves a primary protocol failure and cannot publish success by itself', async t => {
  for (const mode of ['malformed', 'success']) {
    const f = await fixture(t, mode, 503);
    await assert.rejects(verifyRelay(f.options), error => mode === 'malformed'
      ? error.code === 'RELAY_VERIFICATION_RPC_INVALID_JSON' && error.cleanupUnconfirmed === true
      : error.code === 'RELAY_VERIFICATION_SESSION_REVOKE_UNCONFIRMED');
    await assert.rejects(readFile(join(f.directory, 'verification.json')), { code: 'ENOENT' });
  }
  const misleadingOk = await fixture(t, 'success', 200);
  await assert.rejects(verifyRelay(misleadingOk.options), { code: 'RELAY_VERIFICATION_SESSION_REVOKE_UNCONFIRMED' });
});

test('an unparseable created session remains unknown without inventing a revocation credential or retry', async t => {
  for (const mode of ['session-invalid', 'session-lost']) {
    const f = await fixture(t, mode);
    await assert.rejects(verifyRelay(f.options), { code: 'RELAY_VERIFICATION_SESSION_UNCONFIRMED', externalOutcome: 'unknown' });
    assert.equal(f.requests.filter(row => row.options.method === 'POST').length, 3);
    assert.equal(f.requests.filter(row => row.options.method === 'DELETE').length, 0);
  }
});

test('health rejects HTTP errors before JSON and every request has a bounded abort signal', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyRelay({ ...f.options, fetchResponse: async () => new Response('PRIVATE_HTML_CANARY', { status: 502 }) }),
    { code: 'RELAY_VERIFICATION_HEALTH_HTTP_502' });
  let aborted = false;
  await assert.rejects(verifyRelay({ ...f.options, timeoutMs: 10, fetchResponse: async (_url, { signal }) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('fixture deadline')), 1000);
    signal.addEventListener('abort', () => { aborted = true; clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
  }) }), { code: 'RELAY_VERIFICATION_HEALTH_REQUEST_FAILED' });
  assert.equal(aborted, true);
});

for (const [mode, code] of [['rpc-both', 'RELAY_VERIFICATION_RPC_INVALID_FRAME'],
  ['rpc-version', 'RELAY_VERIFICATION_RPC_INVALID_FRAME'], ['threads-invalid', 'RELAY_VERIFICATION_THREAD_LIST_INVALID']]) {
  test(`valid JSON with an invalid protocol payload (${mode}) cannot publish PASS`, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(verifyRelay(f.options), { code });
    assert.equal(f.requests.filter(row => row.options.method === 'DELETE').length, 1);
    await assert.rejects(readFile(join(f.directory, 'verification.json')), { code: 'ENOENT' });
  });
}

test('verification does not forward its credential-bearing POST through a redirect', async t => {
  const f = await fixture(t), received = [];
  const target = createServer((request, response) => {
    const chunks = []; request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { received.push(Buffer.concat(chunks).toString()); response.writeHead(401); response.end('denied'); });
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const redirect = createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/untrusted` }); response.end();
  });
  redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening');
  t.after(async () => { for (const server of [redirect, target]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  let caught;
  try {
    await verifyRelay({ ...f.options, fetchResponse: (url, options) =>
      new URL(url).pathname === '/_relay/health' ? f.options.fetchResponse(url, options)
        : fetch(`http://127.0.0.1:${redirect.address().port}/controlled`, options) });
  } catch (error) { caught = error; }
  assert.equal(received.some(body => body.includes(f.options.selectedGateway.gatewaySecret)), false,
    'native fetch must not send the internal credential body to a redirect target');
  assert.equal(caught?.code, 'RELAY_VERIFICATION_INVALID_PAIRING_REQUEST_FAILED');
});

test('legacy omitted versions and unrelated notifications do not complete or poison owned RPC requests', async t => {
  for (const mode of ['rpc-legacy', 'rpc-unrelated']) {
    const f = await fixture(t, mode); const evidence = await verifyRelay(f.options);
    assert.equal(evidence.threadList, 'PASS'); assert.deepEqual(evidence.threadResultKeys, ['threads']);
    assert.equal(f.requests.filter(row => row.options.method === 'DELETE').length, 1);
  }
});

test('a protocol failure in the same incoming batch as the final RPC result cannot become PASS', async t => {
  const f = await fixture(t, 'trailing-malformed');
  await assert.rejects(verifyRelay(f.options), { code: 'RELAY_VERIFICATION_RPC_INVALID_JSON' });
  assert.equal(f.requests.filter(row => row.options.method === 'DELETE').length, 1);
  await assert.rejects(readFile(join(f.directory, 'verification.json')), { code: 'ENOENT' });
});

test('session receipt validation revokes only when an access token is known', async t => {
  for (const [mode, code, revoked] of [
    ['session-no-access', 'RELAY_VERIFICATION_SESSION_UNCONFIRMED', 0],
    ['session-no-rpc', 'RELAY_VERIFICATION_SESSION_RPC_TOKEN_MISSING', 1],
  ]) {
    const f = await fixture(t, mode);
    await assert.rejects(verifyRelay(f.options), error => error.code === code &&
      (revoked === 1 || error.externalOutcome === 'unknown'));
    assert.equal(f.requests.filter(row => row.options.method === 'DELETE').length, revoked);
    assert.equal(f.requests.filter(row => row.options.method === 'POST').length, 3);
  }
});

test('a timed out RPC still revokes the original owned session without repeating a POST', async t => {
  const f = await fixture(t, 'rpc-timeout');
  await assert.rejects(verifyRelay({ ...f.options, timeoutMs: 10 }), { code: 'RELAY_VERIFICATION_RPC_TIMEOUT' });
  assert.equal(f.requests.filter(row => row.options.method === 'DELETE').length, 1);
  assert.equal(f.requests.filter(row => row.options.method === 'POST').length, 3);
});

test('a revocation deadline preserves the primary protocol failure and marks cleanup unconfirmed', async t => {
  const f = await fixture(t, 'malformed'); let revoked = 0;
  await assert.rejects(verifyRelay({ ...f.options, timeoutMs: 10, fetchResponse: (url, options) => {
    if (options.method !== 'DELETE') return f.options.fetchResponse(url, options);
    revoked++;
    return new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('fixture deadline missing')), 1000);
      options.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(options.signal.reason); }, { once: true });
    });
  } }), { code: 'RELAY_VERIFICATION_RPC_INVALID_JSON', cleanupUnconfirmed: true });
  assert.equal(revoked, 1);
  await assert.rejects(readFile(join(f.directory, 'verification.json')), { code: 'ENOENT' });
});
