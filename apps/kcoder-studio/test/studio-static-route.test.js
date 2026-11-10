import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioStaticRoute } from '../src/studio-static-route.js';

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
