import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createMobileWebDevProxy } from './mobile-web-dev-proxy.js';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('Mobile development uses the mounted bundle path and forwards no Gateway credentials', async t => {
  const requests = [];
  const upstream = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'metro=ignored' });
    response.end('<script src="/src/entry.ts.bundle?platform=web"></script>');
  });
  const port = await listen(t, upstream);
  const gateway = createServer((request, response) => {
    void proxy.handle(request, response, new URL(request.url, 'http://localhost'));
  });
  const gatewayPort = await listen(t, gateway);
  const address = `http://127.0.0.1:${gatewayPort}`;
  const access = new URL(`${address}/g/dev`);
  const proxy = createMobileWebDevProxy({
    port: String(port), rendererMode: 'vite', publicAccessUrl: access,
    allowedOrigin: (origin, host) => origin === access.origin && host === access.host,
  });
  const headers = { host: access.host, origin: access.origin, cookie: 'kcoder_studio_session=private',
    authorization: 'Bearer private', 'x-kcoder-mobile-mount-proof': 'private' };
  const result = await fetch(`${address}/mobile/`, { headers });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), '<script src="/g/dev/mobile/src/entry.ts.bundle?platform=web"></script>');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/');
  for (const key of ['cookie', 'authorization', 'x-kcoder-mobile-mount-proof']) assert.equal(requests[0].headers[key], undefined);
  const controls = await fetch(`${address}/mobile/open-editor`, { headers });
  assert.equal(controls.status, 404);
  const write = await fetch(`${address}/mobile/`, { headers, method: 'POST' });
  assert.equal(write.status, 405);
  const crossOrigin = await fetch(`${address}/mobile/`, { headers: { ...headers, origin: 'https://other.example' } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(requests.length, 1);
  assert.equal(proxy.isUpgrade('/mobile/hot'), true);
  assert.equal(proxy.isUpgrade('/mobile/message'), true);
  assert.equal(proxy.isUpgrade('/hot'), false);
  assert.equal(proxy.isUpgrade('/mobile/inspector'), false);
});

test('Mobile development proxy requires Vite and a numeric loopback port', () => {
  assert.equal(createMobileWebDevProxy({ rendererMode: 'static' }), null);
  assert.throws(() => createMobileWebDevProxy({ port: '14175', rendererMode: 'static' }), /requires Vite/);
  assert.throws(() => createMobileWebDevProxy({ port: 'http://example.com:14175', rendererMode: 'vite' }), /loopback port/);
});
