import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { copyFile, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { studioRendererMode, createStudioViteRenderer } from '../src/studio-vite-renderer.js';

test('renderer mode is explicit; static packages do not require Vite', () => {
  assert.equal(studioRendererMode({}), 'static');
  assert.equal(studioRendererMode({ KCODER_STUDIO_RENDERER_MODE: 'vite' }), 'vite');
  assert.throws(() => studioRendererMode({ KCODER_STUDIO_RENDERER_MODE: 'invalid' }));
});

test('static Gateway loads without development renderer dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-static-renderer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['studio-vite-renderer.js', 'gateway-login-presentation.js']) {
    await copyFile(new URL(`../src/${name}`, import.meta.url), join(root, name));
  }
  const module = await import(pathToFileURL(join(root, 'studio-vite-renderer.js')).href);
  assert.equal(module.studioRendererMode({}), 'static');
});

test('owned Vite serves mounted modules, exact CSP hashes and real HMR without a second listener', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-vite-renderer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rendererRoot = join(root, 'renderer');
  await mkdir(rendererRoot);
  await mkdir(join(root, 'shared'));
  await symlink(fileURLToPath(new URL('../renderer/node_modules', import.meta.url)), join(rendererRoot, 'node_modules'), 'dir');
  await writeFile(join(rendererRoot, 'package.json'), '{"type":"module"}');
  const configuration = fileURLToPath(new URL('../renderer/vite.config.ts', import.meta.url));
  await writeFile(join(rendererRoot, 'vite.config.ts'),
    `import configuration from ${JSON.stringify(configuration)}; export default env => configuration({...env, mode:'test'});`);
  await mkdir(join(rendererRoot, 'e2e/fixtures'), { recursive: true });
  const preview = join(rendererRoot, 'e2e/fixtures/preview.html');
  await writeFile(preview, '<html>Owned test preview</html>');
  await mkdir(join(rendererRoot, 'public'));
  await writeFile(join(rendererRoot, 'public/runtime-config.js'), '// Public fixture runtime configuration.');
  await writeFile(join(rendererRoot, 'index.html'), '<html><head></head><body><script src="%BASE_URL%runtime-config.js"></script><script type="module" src="/src.js"></script></body></html>');
  await writeFile(join(rendererRoot, 'src.js'), "export const value = 'before'; if(import.meta.hot) import.meta.hot.accept();");
  const largeModule = `export const text = ${JSON.stringify('owned-vite-resource '.repeat(8000))};`;
  await writeFile(join(rendererRoot, 'large.js'), largeModule);
  await writeFile(join(rendererRoot, '.env'), 'KCODER_PRIVATE_FIXTURE=must-not-be-served');
  const renderer = await createStudioViteRenderer({ rendererRoot, cacheDir: join(root, 'vite-cache'),
    publicAccessUrl: new URL('https://preview.example/g/fixture'), gatewayToken: 'cookie-auth',
    contentSecurityPolicy: "default-src 'self'; script-src 'self'", requestPublicPrefix: () => '/g/fixture' });
  t.after(() => renderer.close());
  const server = createServer((req, res) => {
    // This fixture exercises the middleware contract, not Gateway authentication.
    const url = new URL(req.url, 'http://localhost');
    void renderer.handle(req, res, url.pathname).catch(() => { res.writeHead(500); res.end(); });
  });
  server.on('upgrade', (req, socket, head) => renderer.upgrade(req, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const htmlResponse = await fetch(origin);
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /\/g\/fixture\/@vite\/client/);
  assert.match(html, /\/g\/fixture\/src.js/);
  assert.match(html, /src="\/g\/fixture\/runtime-config.js"/);
  assert.doesNotMatch(html, /\/g\/fixture\/g\/fixture/);
  assert.match(html, /kcoder-app-base-path/);
  assert.match(htmlResponse.headers.get('content-security-policy'), /'sha256-/);
  assert.doesNotMatch(htmlResponse.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal(htmlResponse.headers.get('content-encoding'), null,
    'Credential-bearing HTML must remain outside asset compression');
  const readRaw = headers => new Promise((resolve, reject) => {
    const request = get(`${origin}/large.js`, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode,
        headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
  });
  const plain = await readRaw({ 'accept-encoding': 'identity' });
  const zipped = await readRaw({ 'accept-encoding': 'gzip' });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.match(zipped.headers.vary, /Accept-Encoding/);
  assert.equal(zipped.headers['content-length'], undefined);
  assert.deepEqual(gunzipSync(zipped.bytes), plain.bytes);
  assert.ok(zipped.bytes.length < plain.bytes.length / 10,
    'Relay must carry the compressed bytes rather than only compressing after transit');
  const conditional = await fetch(`${origin}/large.js`, {
    headers: { 'accept-encoding': 'gzip', 'if-none-match': plain.headers.etag },
  });
  assert.equal(conditional.status, 304);
  assert.equal((await conditional.arrayBuffer()).byteLength, 0);
  const source = await fetch(`${origin}/src.js`);
  assert.equal(source.status, 200);
  assert.match(await source.text(), /before/);
  for (const path of ['/.env', '/__open-in-editor?file=package.json']) {
    const response = await fetch(origin + path);
    assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /must-not-be-served/);
  }
  assert.equal((await fetch(origin + '/src.js', { method: 'POST' })).status, 405);
  const client = await (await fetch(`${origin}/@vite/client`)).text();
  const token = client.match(/const wsToken = "([^"]+)"/)[1];
  assert.match(client, /\/g\/fixture\/__vite_hmr/);
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/__vite_hmr?token=${token}`, 'vite-hmr', { origin });
  t.after(() => ws.terminate());
  const messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(String(bytes))));
  await once(ws, 'open');
  const checkpoint = messages.length;
  await writeFile(preview, '<html>Updated owned test preview</html>');
  await writeFile(join(rendererRoot, 'src.js'), "export const value = 'after'; if(import.meta.hot) import.meta.hot.accept();");
  const deadline = Date.now() + 5000;
  while (!messages.some(m => m.type === 'update') && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  assert.ok(messages.some(m => m.type === 'connected'));
  assert.ok(messages.some(m => m.type === 'update' && m.updates.some(u => u.path === '/src.js')));
  assert.match(await (await fetch(`${origin}/src.js`)).text(), /after/);
  await new Promise(done => setTimeout(done, 250));
  assert.ok(!messages.slice(checkpoint).some(m => m.type === 'full-reload'), 'A test preview must not reload every desktop');
  await writeFile(join(rendererRoot, 'index.html'), `${html}\n<!-- Updated real entry -->`);
  const reloadDeadline = Date.now() + 5000;
  while (!messages.slice(checkpoint).some(m => m.type === 'full-reload') && Date.now() < reloadDeadline)
    await new Promise(done => setTimeout(done, 25));
  assert.ok(messages.slice(checkpoint).some(m => m.type === 'full-reload'), 'Real entry changes still require a reload');
});

test('bundled Vite navigation keeps compiled assets, private metadata and CSP on the Gateway mount', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-vite-bundled-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rendererRoot = join(root, 'renderer');
  await mkdir(rendererRoot);
  await mkdir(join(root, 'shared'));
  await symlink(fileURLToPath(new URL('../renderer/node_modules', import.meta.url)), join(rendererRoot, 'node_modules'), 'dir');
  await writeFile(join(rendererRoot, 'package.json'), '{"type":"module"}');
  const configuration = fileURLToPath(new URL('../renderer/vite.config.ts', import.meta.url));
  await writeFile(join(rendererRoot, 'vite.config.ts'),
    `import configuration from ${JSON.stringify(configuration)}; export default env => ({...configuration({...env, mode:'test'}), experimental:{bundledDev:true}});`);
  await writeFile(join(rendererRoot, 'index.html'), '<html><head></head><body><script type="module" src="/src.js"></script></body></html>');
  await writeFile(join(rendererRoot, 'src.js'), 'document.body.dataset.fixture = "compiled-bundled-fixture"; window.loadFixture = () => import("./lazy.js"); if(import.meta.hot) import.meta.hot.accept();');
  await writeFile(join(rendererRoot, 'lazy.js'), 'export const value = "mounted-dynamic-module";');
  const renderer = await createStudioViteRenderer({ rendererRoot, cacheDir: join(root, 'vite-cache'),
    publicAccessUrl: new URL('https://preview.example/g/fixture'), gatewayToken: 'owned-fixture-token',
    contentSecurityPolicy: "default-src 'self'; script-src 'self'", requestPublicPrefix: () => '/g/fixture' });
  t.after(() => renderer.close());
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    void renderer.handle(req, res, url.pathname).catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let html, response, entry;
  const deadline = Date.now() + 15000;
  do {
    response = await fetch(origin);
    html = await response.text();
    entry = html.match(/<script[^>]+src="([^"]+)"/);
    if (entry) break;
    await new Promise(done => setTimeout(done, 50));
  } while (Date.now() < deadline);
  assert.equal(response.status, 200);
  assert.ok(entry, 'The Vite-generated entry must replace the unbundled source index');
  assert.match(entry[1], /^\/g\/fixture\//);
  assert.doesNotMatch(html, /src="\/src.js"/);
  assert.match(html, /kcoder-rpc-token" content="owned-fixture-token/);
  assert.match(html, /kcoder-app-base-path" content="\/g\/fixture/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline/);
  const module = await fetch(new URL(entry[1], origin));
  assert.equal(module.status, 200);
  assert.equal(module.headers.get('cache-control'), 'private, no-cache');
  assert.ok(module.headers.get('etag'));
  const code = await module.text();
  assert.match(code, /compiled-bundled-fixture/);
  const dynamicImport = code.match(/import\(["']([^"']*lazy[^"']*\.js)["']\)/);
  assert.ok(dynamicImport, 'The fixture must retain a real dynamic import');
  const dynamicUrl = new URL(dynamicImport[1], new URL(entry[1], origin));
  assert.ok(dynamicUrl.pathname.startsWith('/g/fixture/'), 'Dynamic assets must retain the Gateway mount');
  const dynamicModule = await fetch(dynamicUrl);
  assert.equal(dynamicModule.status, 200);
  const dynamicCode = await dynamicModule.text();
  assert.match(dynamicCode, /\/g\/fixture\/@vite\/lazy\?/, 'Lazy compilation must retain the Gateway mount');
  assert.doesNotMatch(dynamicCode, /[\x60"']\/@vite\/lazy\?/, 'A root-relative lazy compiler request cannot cross the Relay mount');
  assert.doesNotMatch(code, /owned-fixture-token/, 'Private navigation metadata must never enter shared compiled assets');
  const cached = await fetch(new URL(entry[1], origin), { headers: { 'if-none-match': module.headers.get('etag') } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
  const head = await fetch(origin, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('cache-control'), 'no-store');
  assert.equal(head.headers.get('etag'), null);
  assert.equal(await head.text(), '');
});
