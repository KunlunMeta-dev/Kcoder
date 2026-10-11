import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createMobileWebStatic } from '../src/mobile-web-static.js';

const token = '/__kcoder_mobile_mount_v1__';
const secret = 'fixture-pair-token-at-least-thirty-two-characters';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-mobile-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const texts = {
    'index.html': `<html><script>window.base="${token}"</script><script src="${token}/_expo/app.js"></script></html>`,
    '_expo/app.js': `const base="${token}";`,
    '_expo/.routes.json': '{"redirects":[]}',
  };
  const files = [];
  for (const [path, value] of Object.entries(texts)) {
    const bytes = Buffer.from(value);
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    files.push({ path, size: bytes.length, sha256: sha(bytes), text: true, replacements: value.split(token).length - 1 });
  }
  await writeFile(join(root, 'kcoder-mobile-web.json'), JSON.stringify({ version: 1, baseToken: token, files }));
  await writeFile(join(root, '.env'), 'not-public');
  return { root, serve: createMobileWebStatic({ root, publicOrigins: new Set(['https://relay.example']), pairingToken: secret,
    directPort: () => 4173, contentSecurityPolicy: "default-src 'self'; script-src 'self'; object-src 'none'" }) };
}
async function request(serve, url, { method = 'GET', mount, headers = {}, host = '127.0.0.1:4173' } = {}) {
  if (mount) {
    host = 'relay.example';
    headers = { ...headers, 'x-kcoder-mobile-mount': mount, 'x-kcoder-mobile-mount-proof':
      createHmac('sha256', secret).update(JSON.stringify(['kcoder-mobile-mount-v1', host, mount])).digest('hex') };
  }
  const response = { status: null, headers: {}, body: '', writeHead(status, value) { this.status = status; this.headers = value; }, end(value) { this.body = value === undefined ? '' : String(value); } };
  response.handled = await serve({ url, method, headers: { host, ...headers }, socket: {} }, response, new URL(url, 'http://localhost').pathname);
  return response;
}

test('one artifact serves direct and signed Relay mounts with exact route metadata and CSP hashes', async t => {
  const { serve } = await fixture(t);
  const direct = await request(serve, '/mobile/');
  assert.equal(direct.status, 200);
  assert.ok(direct.body.includes('/mobile/_expo/app.js'));
  assert.ok(!direct.body.includes(token) && !direct.body.includes(secret) && !direct.body.includes('kcoder-rpc-token'));
  const inlineHash = createHash('sha256').update('window.base="/mobile"').digest('base64');
  assert.ok(direct.headers['content-security-policy'].includes(`'sha256-${inlineHash}'`));
  assert.equal(direct.headers['cache-control'], 'no-store');
  const relay = await request(serve, '/mobile/h/profile/task/server/thread', { mount: '/g/assigned-A' });
  assert.equal(relay.status, 200);
  assert.ok(relay.body.includes('/g/assigned-A/mobile/_expo/app.js'));
  const metadata = await request(serve, '/mobile-entry', { mount: '/g/assigned-A' });
  assert.deepEqual(JSON.parse(metadata.body), { version: 1, available: true,
    mobileUrl: 'https://relay.example/g/assigned-A/mobile/', gatewayUrl: 'https://relay.example/g/assigned-A' });
  assert.equal((await request(serve, '/mobile/_expo/.routes.json')).status, 200);
});

test('asset validators bind each mount and preserve conditional GET plus HEAD semantics', async t => {
  const { serve } = await fixture(t);
  const a = await request(serve, '/mobile/_expo/app.js', { mount: '/g/A' });
  const b = await request(serve, '/mobile/_expo/app.js', { mount: '/g/B', headers: { 'if-none-match': a.headers.etag } });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.notEqual(a.headers.etag, b.headers.etag);
  assert.ok(b.body.includes('/g/B/mobile'));
  const cached = await request(serve, '/mobile/_expo/app.js', { mount: '/g/B', headers: { 'if-none-match': b.headers.etag } });
  assert.equal(cached.status, 304); assert.equal(cached.body, '');
  const head = await request(serve, '/mobile/_expo/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.ok(Number(head.headers['content-length']) > 0);
});

test('untrusted presentation headers, hidden/unlisted resources and non-static operations fail closed', async t => {
  const { serve } = await fixture(t);
  assert.equal((await request(serve, '/mobile/', { headers: { 'x-kcoder-mobile-mount': '/g/forged' } })).status, 403);
  assert.equal((await request(serve, '/mobile/', { host: 'untrusted.example:4173' })).status, 403);
  for (const path of ['/mobile/.env', '/mobile/_expo/.secret', '/mobile/_expo/absent.js', '/mobile/%2eenv'])
    assert.equal((await request(serve, path)).status, 404);
  assert.equal((await request(serve, '/mobile/', { method: 'POST' })).status, 405);
  const api = await request(serve, '/api/servers');
  assert.equal(api.handled, false); assert.equal(api.status, null);
});

test('hash mismatch is rejected before publishing changed resource bytes', async t => {
  const { root, serve } = await fixture(t);
  await writeFile(join(root, '_expo/app.js'), 'changed');
  await assert.rejects(request(serve, '/mobile/_expo/app.js'), /hash mismatch/);
});

test('login relative Mobile Web link stays inside both Relay route forms', async () => {
  const source = await readFile(new URL('../dev-server.mjs', import.meta.url), 'utf8');
  const href = /<a href="(mobile\/)"/.exec(source)?.[1];
  assert.equal(href, 'mobile/');
  for (const path of ['/g/assigned/login', '/g/assigned/'])
    assert.equal(new URL(href, 'https://relay.example' + path).pathname, '/g/assigned/mobile/');
  assert.equal(new URL(href, 'http://127.0.0.1:4173/login').pathname, '/mobile/');
});
test('actual HTTP delivery preserves signed mount, validators and unpaired entry without API handling', async t => {
  const { serve } = await fixture(t);
  let observedHost;
  const server = createServer((req, res) => {
    observedHost = req.headers.host;
    serve(req, res, new URL(req.url, 'http://localhost').pathname).then(handled => {
      if (!handled) { res.writeHead(401); res.end('API authorization required'); }
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mount = '/g/http-assigned';
  const headers = { host: 'relay.example', 'x-kcoder-mobile-mount': mount,
    'x-kcoder-mobile-mount-proof': createHmac('sha256', secret).update(JSON.stringify(['kcoder-mobile-mount-v1', 'relay.example', mount])).digest('hex') };
  const get = (path, requestHeaders = headers) => new Promise((resolve, reject) => {
    const req = httpRequest(origin + path, { headers: requestHeaders }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject); req.end();
  });
  const entry = await get('/mobile-entry');
  assert.equal(observedHost, 'relay.example');
  assert.equal(entry.status, 200);
  assert.equal(JSON.parse(entry.body).gatewayUrl, 'https://relay.example/g/http-assigned');
  assert.equal(entry.headers['set-cookie'], undefined);
  const html = await get('/mobile/sessions');
  assert.equal(html.status, 200);
  assert.ok(html.body.includes(mount + '/mobile/_expo/app.js'));
  const asset = await get('/mobile/_expo/app.js');
  assert.equal(asset.status, 200);
  const cached = await get('/mobile/_expo/app.js', { ...headers, 'if-none-match': asset.headers.etag });
  assert.equal(cached.status, 304);
  assert.equal((await get('/api/servers')).status, 401);
});
