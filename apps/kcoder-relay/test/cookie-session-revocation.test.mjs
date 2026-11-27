import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { startRelay } from '../src/server.mjs';
import { startClient } from '../src/client.mjs';
import { isolatedGatewayAuthority } from '../src/gateway-origin.mjs';

test('cookie-authenticated session deletion removes the original Relay grant before the next request', { timeout: 10000 }, async t => {
  let valid = true, validations = 0, relay, client;
  const gatewaySecret = 'b'.repeat(40), credential = 'c'.repeat(64), secret = 'a'.repeat(40);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const gateway = createServer(async (incoming, response) => {
    if (incoming.url === '/api/mobile/session/relay-validation') {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      validations++;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!valid || incoming.headers['x-kcoder-relay-validation'] !== gatewaySecret || body.credential !== credential) { response.writeHead(401); response.end(); return; }
      const expiresAt = Date.now() + 60000;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 1, kind: 'access', requestId: body.requestId, accessTokenHash: digest(credential), rpcTokenHash: 'd'.repeat(64), expiresAt, accessExpiresAt: expiresAt })); return;
    }
    incoming.resume();
    if (incoming.method === 'DELETE') { valid = false; response.writeHead(204); response.end(); return; }
    response.writeHead(200); response.end('owned API');
  });
  t.after(async () => {
    const failures = [];
    for (const cleanup of [() => client?.close(), () => relay?.close(), () => new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); })]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned cookie-grant fixture cleanup failed');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  relay = await startRelay({ gateways: [{ id: 'owned', secret, gatewaySecret }], sharedHosts: ['relay.example.test'], controlPort: 0, proxyPort: 0, connectTimeout: 1000 });
  let online;
  const ready = new Promise(resolve => { online = resolve; });
  client = startClient({ url: `http://127.0.0.1:${relay.controlPort}`, gatewayId: 'owned', secret,
    gateway: `http://127.0.0.1:${gateway.address().port}`, allowInsecure: true, retryMs: 30, onOnline: online });
  let timer;
  try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned client did not become ready')), 3000); })]); }
  finally { clearTimeout(timer); }
  const call = method => new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: relay.proxyPort, path: method === 'DELETE' ? '/g/owned/api/mobile/session' : '/g/owned/api/servers', method,
      headers: { host: isolatedGatewayAuthority('relay.example.test', 'owned'), cookie: `__Host-kcoder_studio_session=${credential}` } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode)); response.once('error', reject);
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Owned cookie fixture deadline')));
    outgoing.once('error', reject); outgoing.end();
  });
  assert.equal(await call('GET'), 200); assert.equal(validations, 1);
  assert.equal(await call('DELETE'), 204);
  assert.equal(await call('GET'), 401); assert.equal(validations, 2, 'the deleted Cookie grant cannot remain in the live map');
});
