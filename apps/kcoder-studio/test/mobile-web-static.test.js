import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMobileWebStatic } from '../src/mobile-web-static.js';
import { loginPage } from '../src/gateway-login-presentation.js';

const token = '/__kcoder_mobile_mount_v1__';
const secret = 'fixture-pair-token-at-least-thirty-two-characters';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, options = {}) {
  const { includeLargeAsset = false, ...staticOptions } = options;
  const root = await mkdtemp(join(tmpdir(), 'kcoder-mobile-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const texts = {
    'index.html': `<html><script>window.base="${token}"</script><script src="${token}/_expo/app.js"></script></html>`,
    'h/[profileId]/index.html': `<html data-route="profile"><script src="${token}/_expo/app.js"></script></html>`,
    'h/[profileId]/task/[serverId]/[threadId].html': `<html data-route="task"><script src="${token}/_expo/app.js"></script></html>`,
    '_expo/app.js': `const base="${token}";`,
    '_expo/.routes.json': '{"redirects":[]}',
  };
  if (includeLargeAsset) texts['assets/large.js'] = `globalThis.fixturePayload="${'x'.repeat(8192)}";`;
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
    directPort: () => 4173, contentSecurityPolicy: "default-src 'self'; script-src 'self'; object-src 'none'", ...staticOptions }) };
}
async function request(serve, url, { method = 'GET', mount, headers = {}, host = '127.0.0.1:4173' } = {}) {
  if (mount) {
    host = 'relay.example';
    headers = { ...headers, 'x-kcoder-mobile-mount': mount, 'x-kcoder-mobile-mount-proof':
      createHmac('sha256', secret).update(JSON.stringify(['kcoder-mobile-mount-v1', host, mount])).digest('hex') };
  }
  const response = { status: null, headers: {}, body: '', bodyBytes: Buffer.alloc(0), writeHead(status, value) { this.status = status; this.headers = value; }, end(value) { this.bodyBytes = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value)); this.body = this.bodyBytes.toString('utf8'); } };
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

test('large static assets negotiate gzip and preserve the decoded resource bytes', async t => {
  const { serve } = await fixture(t, { includeLargeAsset: true });
  const identity = await request(serve, '/mobile/assets/large.js');
  const compressed = await request(serve, '/mobile/assets/large.js', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(identity.status, 200);
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.match(compressed.headers.vary, /(?:^|,)\s*accept-encoding\s*(?:,|$)/i);
  assert.equal(Number(compressed.headers['content-length']), compressed.bodyBytes.length);
  assert.equal(gunzipSync(compressed.bodyBytes).toString('utf8'), identity.body);
  assert.ok(compressed.bodyBytes.length < identity.bodyBytes.length / 2);
  assert.notEqual(compressed.headers.etag, identity.headers.etag);
});

test('identity remains available when gzip is excluded or has a lower q value', async t => {
  const { serve } = await fixture(t, { includeLargeAsset: true });
  const identity = await request(serve, '/mobile/assets/large.js');
  for (const acceptEncoding of ['gzip;q=0', 'gzip;q=0.4, identity;q=0.8']) {
    const response = await request(serve, '/mobile/assets/large.js', { headers: { 'accept-encoding': acceptEncoding } });
    assert.equal(response.status, 200, acceptEncoding);
    assert.equal(response.headers['content-encoding'], undefined, acceptEncoding);
    assert.equal(response.body, identity.body, acceptEncoding);
    assert.equal(response.headers.etag, identity.headers.etag, acceptEncoding);
  }
});

test('HEAD and conditional validators stay bound to the selected content-coding variant', async t => {
  const { serve } = await fixture(t, { includeLargeAsset: true });
  const gzipGet = await request(serve, '/mobile/assets/large.js', { headers: { 'accept-encoding': 'gzip' } });
  const gzipHead = await request(serve, '/mobile/assets/large.js', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gzipHead.status, 200);
  assert.equal(gzipHead.body, '');
  assert.equal(gzipHead.headers['content-encoding'], 'gzip');
  assert.equal(gzipHead.headers['content-length'], gzipGet.headers['content-length']);
  assert.equal(gzipHead.headers.etag, gzipGet.headers.etag);

  const gzipCached = await request(serve, '/mobile/assets/large.js', {
    headers: { 'accept-encoding': 'gzip', 'if-none-match': gzipGet.headers.etag },
  });
  assert.equal(gzipCached.status, 304);
  assert.equal(gzipCached.headers['content-encoding'], 'gzip');
  assert.match(gzipCached.headers.vary, /(?:^|,)\s*accept-encoding\s*(?:,|$)/i);

  const identityWithGzipValidator = await request(serve, '/mobile/assets/large.js', {
    headers: { 'if-none-match': gzipGet.headers.etag },
  });
  assert.equal(identityWithGzipValidator.status, 200);
  assert.equal(identityWithGzipValidator.headers['content-encoding'], undefined);
  assert.notEqual(identityWithGzipValidator.headers.etag, gzipGet.headers.etag);
  const identityHead = await request(serve, '/mobile/assets/large.js', { method: 'HEAD' });
  assert.equal(identityHead.headers['content-length'], identityWithGzipValidator.headers['content-length']);
});

test('known host and task routes accept dotted identities on direct and signed mounts', async t => {
  const { serve } = await fixture(t);
  const profile = 'http---127.0.0.1-4188-2f-fixture-1';
  const paths = [`/mobile/h/${profile}`, `/mobile/h/${profile}/`,
    `/mobile/h/${profile}/task/server.example/thread.1`];
  for (const mount of [undefined, '/g/assigned-dotted']) {
    for (const path of paths) {
      const response = await request(serve, path, { mount });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
      assert.ok(response.body.includes(`${mount ?? ''}/mobile/_expo/app.js`));
      assert.equal(response.headers['cache-control'], 'no-store');
      const head = await request(serve, path, { mount, method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      assert.equal(head.headers['content-length'], response.headers['content-length']);
    }
  }
  for (const path of ['/mobile/missing.js', '/mobile/assets/missing.otf', '/mobile/_expo/missing.js',
    '/mobile/h/.hidden', '/mobile/h/profile/task/.server/thread.1', '/mobile/h/profile/task/server/.thread',
    '/mobile/h/profile/extra.js', '/mobile/h/profile/task/server/thread/extra.js',
    '/mobile/h/%2e%2e/secret', '/mobile/h/profile%2ftask', '/mobile/h/%252e%252e']) {
    assert.equal((await request(serve, path)).status, 404, path);
  }
});

test('dynamic profile template still verifies its resource hash', async t => {
  const { root, serve } = await fixture(t);
  const template = join(root, 'h/[profileId]/index.html');
  const html = await readFile(template, 'utf8');
  await writeFile(template, html.replace('data-route="profile"', 'data-route="fixture"'));
  await assert.rejects(request(serve, '/mobile/h/http---gateway.example-fixture'), /hash mismatch/);
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

test('login relative Mobile Web and favicon links stay inside both Relay route forms', async () => {
  const source = loginPage();
  const href = /<a href="(mobile\/)"/.exec(source)?.[1];
  assert.equal(href, 'mobile/');
  for (const path of ['/g/assigned/login', '/g/assigned/'])
    assert.equal(new URL(href, 'https://relay.example' + path).pathname, '/g/assigned/mobile/');
  assert.equal(new URL(href, 'http://127.0.0.1:4173/login').pathname, '/mobile/');
  const favicon = /<link rel="icon" href="([^"]+)"/.exec(source)?.[1];
  assert.equal(favicon, 'favicon.ico');
  for (const path of ['/g/assigned/login', '/g/assigned/'])
    assert.equal(new URL(favicon, 'https://relay.example' + path).pathname, '/g/assigned/favicon.ico');
  assert.equal(new URL(favicon, 'http://127.0.0.1:4173/login').pathname, '/favicon.ico');
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
  for (const path of ['/mobile/h/http---127.0.0.1-fixture', '/mobile/h/http---gateway.example-fixture/task/server.example/thread.1']) {
    const direct = await get(path, { host: '127.0.0.1:4173' });
    assert.equal(direct.status, 200);
    assert.ok(direct.body.includes('/mobile/_expo/app.js'));
    const relay = await get(path);
    assert.equal(relay.status, 200);
    assert.ok(relay.body.includes(mount + '/mobile/_expo/app.js'));
  }
  const asset = await get('/mobile/_expo/app.js');
  assert.equal(asset.status, 200);
  const cached = await get('/mobile/_expo/app.js', { ...headers, 'if-none-match': asset.headers.etag });
  assert.equal(cached.status, 304);
  assert.equal((await get('/api/servers')).status, 401);
});

// Exercise the real HTTP handler with the same dotted profile shape minted by
// mobileSessionExchange; a route parameter is not an asset extension.
test('actual HTTP reload serves dotted profile Home and nested task routes at both mounts', async t => {
  const { serve } = await fixture(t);
  const server = createServer((req, res) => {
    serve(req, res, new URL(req.url, 'http://localhost').pathname).then(handled => {
      if (!handled) { res.writeHead(401); res.end('API authorization required'); }
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const profile = 'http---127.0.0.1-4173-2f.67.2f.41-mgrw1234-1';
  for (const mount of ['', '/g/reload-assigned']) {
    const host = mount ? 'relay.example' : '127.0.0.1:4173';
    const headers = { host, ...(mount ? { 'x-kcoder-mobile-mount': mount,
      'x-kcoder-mobile-mount-proof': createHmac('sha256', secret)
        .update(JSON.stringify(['kcoder-mobile-mount-v1', host, mount])).digest('hex') } : {}) };
    const get = path => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, headers }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.once('error', reject); req.end();
    });
    for (const route of [`h/${profile}`, `h/${profile}/`, `h/${profile}/task/server.with.dots/thread.with.dots`]) {
      const response = await get('/mobile/' + route);
      assert.equal(response.status, 200, `${mount || 'direct'} ${route}`);
      assert.match(response.headers['content-type'], /^text\/html/);
      assert.ok(response.body.includes(`${mount}/mobile/_expo/app.js`));
      assert.ok(response.body.includes(`data-route="${route.includes('/task/') ? 'task' : 'profile'}"`));
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.ok(!response.body.includes(secret));
    }
    for (const route of ['absent.js', 'absent.map', '_expo/absent.js', 'assets/absent.map',
      `h/${profile}/absent.js`, `h/${profile}/task/server/thread/absent.map`,
      'h/.hidden', 'h/%2e%2e', 'h/a%2fb', 'h/a%5cb', 'h/a/../b']) {
      assert.equal((await get('/mobile/' + route)).status, 404, `${mount || 'direct'} ${route}`);
    }
    assert.equal((await get('/api/servers')).status, 401);
  }
});

test('actual Gateway serves configured legacy Relay mount without proof and rejects proof conflicts', async t => {
  const { root } = await fixture({ after() {} });
  const state = await mkdtemp(join(tmpdir(), 'kcoder-mobile-legacy-gateway-'));
  const child = spawn(process.execPath, ['dev-server.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH, NODE_ENV: 'test', HOME: state, XDG_CONFIG_HOME: state,
      KCODER_CONFIG_DIR: join(state, 'profile'), KCODER_STUDIO_SERVERS_STORE: join(state, 'servers.json'),
      KCODER_STUDIO_WORKSPACE: state, KCODER_STUDIO_WEB_ROOT: state, KCODER_STUDIO_MOBILE_WEB_ROOT: root,
      KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0', KCODER_STUDIO_AUTH_TOKEN: secret,
      KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_PUBLIC_ORIGINS: 'https://relay.example,https://peer.example',
      KCODER_STUDIO_PUBLIC_ACCESS_URL: 'https://relay.example/g/configured-id' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed; await Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]);
    t.diagnostic(`owned Gateway pid=${child.pid} closed; owned source/state removed`);
  });
  child.stderr.resume();
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Owned Gateway startup timeout')), 60000);
    child.once('close', () => { clearTimeout(timer); reject(new Error('Owned Gateway exited before ready')); });
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/KCoder Studio: (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const get = (path, headers = { host: 'relay.example' }) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { headers, timeout: 5000 }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('timeout', () => req.destroy(new Error('Owned HTTP request timeout'))); req.once('error', reject); req.end();
  });
  const entry = await get('/mobile-entry');
  assert.equal(entry.status, 200);
  assert.deepEqual(JSON.parse(entry.body), { version: 1, available: true,
    mobileUrl: 'https://relay.example/g/configured-id/mobile/', gatewayUrl: 'https://relay.example/g/configured-id' });
  assert.equal(entry.headers['set-cookie'], undefined);
  assert.deepEqual(JSON.parse((await get('/mobile-entry', { host: 'relay.example', 'x-forwarded-prefix': '/g/forged' })).body), JSON.parse(entry.body));
  assert.match((await get('/mobile/')).body, /\/g\/configured-id\/mobile\/_expo\/app\.js/);
  const asset = await get('/mobile/_expo/app.js'); assert.equal(asset.status, 200); assert.match(asset.body, /\/g\/configured-id\/mobile/);
  assert.equal((await get('/mobile')).headers.location, '/g/configured-id/mobile/');
  const direct = await get('/mobile-entry', {});
  assert.equal(direct.status, 200); assert.equal(JSON.parse(direct.body).gatewayUrl, base);
  assert.match((await get('/mobile/', {})).body, /src="\/mobile\/_expo\/app\.js"/);
  assert.equal((await get('/mobile-entry', { host: 'unknown.example' })).status, 421);
  const peer = await get('/mobile-entry', { host: 'peer.example', 'x-forwarded-prefix': '/g/forged' });
  assert.equal(peer.status, 200); assert.equal(JSON.parse(peer.body).gatewayUrl, 'https://peer.example');
  for (const headers of [
    { 'x-kcoder-mobile-mount': '/g/configured-id' },
    { 'x-kcoder-mobile-mount-proof': '0'.repeat(64) },
    { 'x-kcoder-mobile-mount': '/g/configured-id', 'x-kcoder-mobile-mount-proof': '0'.repeat(64) },
  ]) assert.equal((await get('/mobile-entry', { host: 'relay.example', ...headers })).status, 403);
  const signed = prefix => ({ host: 'relay.example', 'x-kcoder-mobile-mount': prefix,
    'x-kcoder-mobile-mount-proof': createHmac('sha256', secret).update(JSON.stringify(['kcoder-mobile-mount-v1', 'relay.example', prefix])).digest('hex') });
  assert.equal((await get('/mobile-entry', signed('/g/configured-id'))).status, 200);
  assert.equal((await get('/mobile-entry', signed('/g/conflicting-id'))).status, 403);
  assert.equal((await get('/mobile-entry', { ...signed('/g/conflicting-id'), host: 'RELAY.EXAMPLE' })).status, 421);
  assert.equal((await get('/api/servers')).status, 401);
});

test('explicit root public access conflicts with a Relay proof on that authority only', async t => {
  const { serve } = await fixture(t, { publicAccessUrl: new URL('https://relay.example/') });
  assert.equal((await request(serve, '/mobile-entry', { mount: '/g/other' })).status, 403);
  assert.equal(JSON.parse((await request(serve, '/mobile-entry', { host: 'relay.example' })).body).gatewayUrl, 'https://relay.example');
});
