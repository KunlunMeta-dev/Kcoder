import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes, unlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioStaticRoute } from '../src/studio-static-route.js';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';

test('application routes preserve Relay bases and injection while sandbox aliases stay private', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-static-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'widget-sandbox'));
  await mkdir(join(root, 'task'));
  const html = '<html><head></head><body><script src="/assets/main.js"></script></body></html>';
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'task/[id].html'), html.replace('<body>', '<body>task-template'));
  await writeFile(join(root, 'widget-sandbox/host-v1.html'), '<html><head></head>fixed-widget</html>');
  const serve = createStudioStaticRoute({ webRoot: root, gatewayToken: 'synthetic-fixture-only',
    desktopHost: true, contentSecurityPolicy: "default-src 'self'",
    requestPublicPrefix: () => '/g/fixture' });
  async function deliver(pathname) {
    const res = { headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = String(body ?? ''); } };
    await serve({ method: 'GET' }, res, pathname);
    return res;
  }
  for (const pathname of ['/', '/task/real-thread']) {
    const res = await deliver(pathname);
    assert.equal(res.status, 200);
    assert.match(res.body, /kcoder-rpc-token/);
    assert.match(res.body, /src="\/g\/fixture\/assets\/main.js"/);
    assert.match(res.body, /kcoder-app-base-path/);
    assert.match(res.body, /<meta name="kcoder-experience-api" content="v1">/);
    if (pathname !== '/') assert.match(res.body, /task-template/);
  }
  for (const pathname of ['/widget-sandbox/host-v1.html', '/widget-sandbox/host-v1',
    '/%77idget-sandbox/host-v1', '/widget-sandbox%2fhost-v1.html',
    '/api/widgets/unknown', '/api%2fwidgets/isolated-v1.html']) {
    const res = await deliver(pathname);
    assert.equal(res.status, 404, pathname);
    assert.doesNotMatch(res.body, /synthetic-fixture-only|fixed-widget/);
  }
});


test('relative build assets resolve from the local or Relay root on a directly opened nested page', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-static-relative-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<html><head><link href="./assets/app.css"></head><body><script src="./assets/main.js"></script><script src="//cdn.example.test/external.js"></script><a href="#details">Details</a></body></html>');
  for (const prefix of ['', '/g/fixture']) {
  const serve = createStudioStaticRoute({ webRoot: root, gatewayToken: 'synthetic-relative-only',
    desktopHost: false, contentSecurityPolicy: "default-src 'self'",
    requestPublicPrefix: () => prefix });
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = String(body); } };
  await serve({ method: 'GET' }, response, '/personalization/skills');
  assert.equal(response.status, 200);
  const scriptPath = response.body.match(/<script src="([^"]+)"/)[1];
  assert.equal(new URL(scriptPath, `https://gateway.test${prefix}/personalization/skills`).pathname,
    `${prefix}/assets/main.js`);
  assert.ok(response.body.includes(`href="${prefix}/assets/app.css"`));
  assert.match(response.body, /src="\/\/cdn.example.test\/external.js"/);
  assert.match(response.body, /href="#details"/);
  }
});


test('AVIF expert assets have an image type and missing images never receive the token-bearing shell', async t => {
 const root = await mkdtemp(join(tmpdir(), 'kcoder-static-avif-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(join(root, 'index.html'), '<html><head></head></html>');
 await writeFile(join(root, 'expert.avif'), Buffer.from([0, 0, 0, 32]));
 const serve = createStudioStaticRoute({webRoot:root,gatewayToken:'synthetic-avif-only',desktopHost:false,contentSecurityPolicy:"default-src 'self'",requestPublicPrefix:()=>'/g/fixture'});
 const response={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
 await serve({method:'GET'},response,'/expert.avif');
 assert.equal(response.status,200);
 assert.equal(response.headers['content-type'],'image/avif');
 assert.equal(response.headers['x-content-type-options'],'nosniff');
 assert.ok(Buffer.isBuffer(response.body));
 await assert.rejects(serve({method:'GET'},response,'/missing.avif'), {code:'ENOENT'});
});

test('already mounted HTML and CSS paths acquire the Relay prefix only once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-static-mounted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), `<html><head><link href="/g/fixture/assets/app.css"></head><body>
    <script src='/g/fixture/assets/main.js'></script><form action="/g/fixture?save=1"></form>
    <a href="/g/fixture#details">Details</a><a href="/g/fixture-other/page">Other path</a>
    <script src="//cdn.example.test/main.js"></script></body></html>`);
  await writeFile(join(root, 'app.css'), `a{background:url('/g/fixture/assets/a.png')}b{background:url(/assets/b.png)}c{background:url(//cdn.example.test/c.png)}d{background:url("/assets/d.png" )}e{background:url('/assets/e)f.png')}f{background:url("/g/fixture/assets/f)g.png" )}g{background:url(/assets/a\\ b.png)}`);
  const serve = createStudioStaticRoute({ webRoot: root, gatewayToken: 'synthetic-mounted-only',
    desktopHost: false, contentSecurityPolicy: "default-src 'self'", requestPublicPrefix: () => '/g/fixture' });
  const response = { writeHead() {}, end(body) { this.body = String(body); } };
  await serve({ method: 'GET' }, response, '/');
  assert.match(response.body, /href="\/g\/fixture\/assets\/app.css"/);
  assert.match(response.body, /src='\/g\/fixture\/assets\/main.js'/);
  assert.match(response.body, /action="\/g\/fixture\?save=1"/);
  assert.match(response.body, /href="\/g\/fixture#details"/);
  assert.match(response.body, /href="\/g\/fixture\/g\/fixture-other\/page"/);
  assert.match(response.body, /src="\/\/cdn.example.test\/main.js"/);
  await serve({ method: 'GET' }, response, '/app.css');
  assert.equal(response.body, `a{background:url('/g/fixture/assets/a.png')}b{background:url(/g/fixture/assets/b.png)}c{background:url(//cdn.example.test/c.png)}d{background:url("/g/fixture/assets/d.png" )}e{background:url('/g/fixture/assets/e)f.png')}f{background:url("/g/fixture/assets/f)g.png" )}g{background:url(/g/fixture/assets/a\\ b.png)}`);
});

test('static code is compressed on the wire while credential-bearing HTML stays uncompressed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-static-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `export const text=${JSON.stringify('owned static resource '.repeat(4000))};`;
  await writeFile(join(root, 'large.js'), source);
  await writeFile(join(root, 'index.html'), '<html><head></head><body>fixture</body></html>');
  const serve = createStudioStaticRoute({ webRoot: root, gatewayToken: 'synthetic-wire-only',
    contentSecurityPolicy: "default-src 'self'", requestPublicPrefix: () => '/g/fixture' });
  const server = createServer((request, response) => {
    void serve(request, response, new URL(request.url, 'http://localhost').pathname)
      .catch(() => { response.writeHead(500); response.end(); });
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const read = (path, encoding, method = 'GET') => new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'accept-encoding': encoding },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const plain = await read('/large.js', 'identity');
  const gzip = await read('/large.js', 'gzip');
  assert.equal(gzip.status, 200);
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.match(gzip.headers.vary, /Accept-Encoding/);
  assert.deepEqual(gunzipSync(gzip.body), plain.body);
  assert.ok(gzip.body.length < plain.body.length / 10);
  assert.equal(plain.body.toString(), source);
  assert.equal((await read('/large.js', 'gzip;q=0, identity')).headers['content-encoding'], undefined);
  const head = await read('/large.js', 'gzip', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  const html = await read('/', 'gzip');
  assert.equal(html.headers['content-encoding'], undefined);
  assert.match(html.body.toString(), /synthetic-wire-only/);
  assert.equal(html.headers['cache-control'], 'no-store');
});


async function conditionalFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-static-conditional-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  const source = 'export default "' + 'a'.repeat(512 * 1024) + '";';
  const asset = join(root, 'assets/entry-1234ABCD.js');
  await writeFile(asset, source);
  await writeFile(join(root, 'assets/theme-1234ABCD.css'), 'body{background:url(/assets/image.svg)}');
  await writeFile(join(root, 'assets/unhashed.js'), 'export default 1;');
  await writeFile(join(root, 'assets/config-1234ABCD.json'), '{"owned":true}');
  await writeFile(join(root, 'runtime-config.js'), 'globalThis.runtime={};');
  await writeFile(join(root, 'index.html'), '<html><head></head><body>owned</body></html>');
  const serve = createStudioStaticRoute({ webRoot: root, gatewayToken: 'synthetic-conditional-only',
    contentSecurityPolicy: "default-src 'self'", requestPublicPrefix: request => request.headers?.['x-fixture-prefix'] ?? '' });
  const deliver = async (path, method = 'GET', headers = {}) => {
    const response = { headers: {}, writeHead(status, fields) { this.status = status; this.headers = fields; },
      end(body) { this.body = Buffer.from(body ?? ''); } };
    await serve({ method, headers }, response, path);
    return response;
  };
  return { root, asset, source, deliver };
}

test('warm conditional source assets open current files without rereading their bodies', async t => {
  const fixture = await conditionalFixture(t);
  let opens = 0, metadataReads = 0, bodyReads = 0, closes = 0;
  const originalRead = fs.promises.readFile, originalOpen = fs.promises.open;
  const read = t.mock.method(fs.promises, 'readFile', (...args) => {
    if (String(args[0]) === fixture.asset) bodyReads++;
    return originalRead(...args);
  });
  const open = t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === fixture.asset) {
      opens++;
      const read = handle.readFile.bind(handle), stat = handle.stat.bind(handle), close = handle.close.bind(handle);
      handle.readFile = (...args) => { bodyReads++; return read(...args); };
      handle.stat = (...args) => { metadataReads++; return stat(...args); };
      handle.close = (...args) => { closes++; return close(...args); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const first = await fixture.deliver('/assets/entry-1234ABCD.js');
    assert.equal(first.body.toString(), fixture.source);
    opens = 0; metadataReads = 0; bodyReads = 0; closes = 0;
    const statuses = []; let responseBytes = 0;
    for (let index = 0; index < 100; index++) {
      const result = await fixture.deliver('/assets/entry-1234ABCD.js', index % 2 ? 'HEAD' : 'GET',
        { 'if-none-match': first.headers.etag ?? '"missing-validator"' });
      statuses.push(result.status); responseBytes += result.body.length;
    }
    assert.deepEqual({ opens, metadataReads, bodyReads, closes },
      { opens: 100, metadataReads: 100, bodyReads: 0, closes: 100 });
    assert.deepEqual(statuses, Array(100).fill(304));
    assert.equal(responseBytes, 0);
    assert.equal(first.headers['cache-control'], 'private, no-cache');
  } finally { read.mock.restore(); open.mock.restore(); syncBuiltinESMExports(); }
});

test('source validators follow current file identity and do not turn a removed file into 304', async t => {
  const fixture = await conditionalFixture(t), timestamp = new Date('2020-01-01T00:00:00Z');
  await utimes(fixture.asset, timestamp, timestamp);
  const first = await fixture.deliver('/assets/entry-1234ABCD.js'), before = await stat(fixture.asset, { bigint: true });
  const replacement = fixture.source.replace('aaa', 'bbb');
  await writeFile(fixture.asset, replacement); await utimes(fixture.asset, timestamp, timestamp);
  const after = await stat(fixture.asset, { bigint: true });
  assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  const changed = await fixture.deliver('/assets/entry-1234ABCD.js', 'GET', { 'if-none-match': first.headers.etag });
  assert.equal(changed.status, 200); assert.equal(changed.body.toString(), replacement);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  await unlink(fixture.asset);
  await assert.rejects(fixture.deliver('/assets/entry-1234ABCD.js', 'GET', { 'if-none-match': '*' }), { code: 'ENOENT' });
});

test('conditional CSS keeps mount variants separate and dynamic documents remain no-store', async t => {
  const { deliver } = await conditionalFixture(t);
  const first = await deliver('/assets/theme-1234ABCD.css', 'GET', { 'x-fixture-prefix': '/g/first' });
  const second = await deliver('/assets/theme-1234ABCD.css', 'GET',
    { 'x-fixture-prefix': '/g/second', 'if-none-match': first.headers.etag });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.match(first.body.toString(), /\/g\/first\/assets\/image.svg/);
  assert.match(second.body.toString(), /\/g\/second\/assets\/image.svg/);
  assert.notEqual(first.headers.etag, second.headers.etag);
  for (const validator of [second.headers.etag, second.headers.etag.replace(/^W\//, ''),
    '"other", ' + second.headers.etag, '*']) {
    const cached = await deliver('/assets/theme-1234ABCD.css', 'GET',
      { 'x-fixture-prefix': '/g/second', 'if-none-match': validator });
    assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
  }
  for (const path of ['/', '/runtime-config.js', '/assets/unhashed.js', '/assets/config-1234ABCD.json']) {
    const value = await deliver(path, 'GET', { 'if-none-match': '*' });
    assert.equal(value.status, 200); assert.equal(value.headers['cache-control'], 'no-store');
    assert.equal(value.headers.etag, undefined);
  }
});
