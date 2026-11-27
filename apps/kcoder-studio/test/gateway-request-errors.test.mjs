import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioStaticRoute } from '../src/studio-static-route.js';
import { sendGatewayLoginStorageError, sendGatewayRequestError, serveStudioStaticRequest } from '../src/gateway-request-errors.mjs';
import { gatewayLoginStorageError } from '../desktop/gateway-startup-failure.mjs';

test('authenticated login exposes only an allowlisted storage recovery reason', () => {
  const writes = [];
  const response = { writeHead: (...args) => writes.push(args), end: value => writes.push(value) };
  assert.equal(sendGatewayLoginStorageError(response, {
    code: 'MOBILE_DEVICE_STORAGE_UNAVAILABLE', reason: 'store_busy', message: 'private fixture value',
  }), true);
  assert.equal(writes[0][0], 503);
  assert.equal(writes[0][1]['x-kcoder-desktop-storage-failure'], 'store_busy');
  assert.doesNotMatch(JSON.stringify(writes), /private fixture value/);
  writes.length = 0;
  assert.equal(sendGatewayLoginStorageError(response, {
    code: 'MOBILE_DEVICE_STORAGE_UNAVAILABLE', reason: 'private fixture value',
  }), false);
  assert.equal(sendGatewayLoginStorageError(response, { code: 'OTHER', reason: 'store_busy' }), false);
  assert.deepEqual(writes, []);
  for (const reason of ['network_storage', 'reparse_point', 'owner_mismatch', 'unsafe_file',
    'identity_unavailable', 'validation_failed', 'powershell_unavailable', 'execution_failed', 'output_limit',
    'timeout', 'invalid_identity', 'store_busy']) {
    writes.length = 0;
    assert.equal(sendGatewayLoginStorageError(response, { code: 'MOBILE_DEVICE_STORAGE_UNAVAILABLE', reason }), true);
    assert.equal(gatewayLoginStorageError(writes[0][1]['x-kcoder-desktop-storage-failure'], 'owned').reason, reason);
  }
  for (const [code, reason] of [['ENOSPC', 'space_exhausted'], ['EDQUOT', 'space_exhausted'],
    ['EACCES', 'access_denied'], ['EPERM', 'access_denied'], ['EROFS', 'read_only'],
    ['EMFILE', 'resource_limit'], ['ENFILE', 'resource_limit'], ['EIO', 'io_unavailable']]) {
    writes.length = 0;
    assert.equal(sendGatewayLoginStorageError(response, { code, message: 'private fixture value' }), true);
    const error = gatewayLoginStorageError(writes[0][1]['x-kcoder-desktop-storage-failure'], 'owned');
    assert.equal(error.code, 'DESKTOP_LOGIN_STORAGE_IO');
    assert.equal(error.reason, reason);
    assert.doesNotMatch(JSON.stringify(writes), /private fixture value/);
  }
});

test('only static misses are 404; API failures are private 500s and a started response is closed', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owned-gateway-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<head></head>');
  const serve = createStudioStaticRoute({ webRoot: root, gatewayToken: 'inert', requestPublicPrefix: () => '', contentSecurityPolicy: "default-src 'self'" });
  const logs = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/fault') throw Object.assign(new Error('private-error-canary'), { code: 'ENOENT' });
      if (request.url === '/api/started') { response.writeHead(200); response.write('prefix'); throw new Error('private-error-canary'); }
      await serveStudioStaticRequest(serve, request, response, new URL(request.url, 'http://localhost').pathname);
    } catch { sendGatewayRequestError(response, { warn: value => logs.push(value) }); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const path of ['/missing.js', '/%E0%A4%A', '/..%2Foutside.js']) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 404); assert.equal(await response.text(), 'Not found');
  }
  const failed = await fetch(base + '/api/fault', { signal: AbortSignal.timeout(1000) });
  assert.equal(failed.status, 500); assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.equal(await failed.text(), 'Internal server error');
  await assert.rejects(async () => { const response = await fetch(base + '/api/started', { signal: AbortSignal.timeout(1000) }); await response.text(); });
  assert.deepEqual(logs, ['GATEWAY_REQUEST_FAILED', 'GATEWAY_REQUEST_FAILED']);
});
