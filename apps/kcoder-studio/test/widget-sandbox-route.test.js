import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWidgetSandboxRoute } from '../src/widget-sandbox-route.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-widget-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'widget-sandbox'));
  const body = '<!doctype html><html><body>fixed runtime</body></html>';
  const policy = { version: 1, documentSha256: createHash('sha256').update(body).digest('hex'),
    csp: "default-src 'none'; connect-src 'none'; base-uri 'none'" };
  await writeFile(join(root, 'widget-sandbox/host-v1.html'), body);
  await writeFile(join(root, 'widget-sandbox/policy-v1.json'), JSON.stringify(policy));
  await writeFile(join(root, 'widget-sandbox/isolated-v1.html'), body);
  await writeFile(join(root, 'widget-sandbox/isolated-policy-v1.json'), JSON.stringify({
    ...policy, requiresNativeProcessAuthorization: true,
  }));
  return { root, body, policy };
}

function response() {
  return { status: null, headers: {}, body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body } };
}

test('managed and isolated fixed aliases bypass HTML credential injection and use separate CSP', async t => {
  const { root, body } = await fixture(t);
  const serve = createWidgetSandboxRoute({ roots: [root] });
  for (const path of ['/api/widgets/sandbox-v1.html', '/widget-sandbox/host-v1.html',
    '/api/widgets/isolated-v1.html', '/widget-sandbox/isolated-v1.html']) {
    const res = response();
    assert.equal(await serve({ method: 'GET' }, res, path), true);
    assert.equal(res.status, 200); assert.equal(res.body.toString(), body);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'self'/);
    assert.doesNotMatch(res.body.toString(), /kcoder-rpc-token/);
  }
});

test('isolated resource fails closed without native authorization policy', async t => {
  const { root, policy } = await fixture(t);
  await writeFile(join(root, 'widget-sandbox/isolated-policy-v1.json'), JSON.stringify(policy));
  const res = response();
  await createWidgetSandboxRoute({ roots: [root] })({ method: 'GET' }, res, '/api/widgets/isolated-v1.html');
  assert.equal(res.status, 503);
  assert.doesNotMatch(String(res.body), /fixed runtime/);
});

test('only missing roots select fallback; verified bytes remain an immutable snapshot', async t => {
  const { root, body } = await fixture(t);
  const serve = createWidgetSandboxRoute({ roots: [join(root, 'missing-build'), root] });
  const res = response();
  await serve({ method: 'GET' }, res, '/api/widgets/sandbox-v1.html');
  assert.equal(res.status, 200); assert.equal(res.body.toString(), body);
  await writeFile(join(root, 'widget-sandbox/host-v1.html'), body + 'changed');
  const corrupt = response(); await serve({ method: 'GET' }, corrupt, '/api/widgets/sandbox-v1.html');
  assert.equal(corrupt.status, 200);
  assert.equal(corrupt.body.toString(), body);
  const cold = response();
  await createWidgetSandboxRoute({ roots: [root] })({ method: 'GET' }, cold, '/api/widgets/sandbox-v1.html');
  assert.equal(cold.status, 503);
  await rm(join(root, 'widget-sandbox/host-v1.html'));
  const retained = response();
  await serve({ method: 'HEAD' }, retained, '/widget-sandbox/host-v1.html');
  assert.equal(retained.status, 200);
  assert.equal(retained.body, undefined);
});

test('fixed handler never serves user paths and supports HEAD without a body', async t => {
  const { root } = await fixture(t);const serve = createWidgetSandboxRoute({ roots: [root] });
  assert.equal(await serve({ method: 'GET' }, response(), '/api/widgets/private-user.html'), false);
  const head = response();await serve({ method: 'HEAD' }, head, '/api/widgets/sandbox-v1.html');
  assert.equal(head.status, 200);assert.equal(head.body, undefined);
  const post = response();await serve({ method: 'POST' }, post, '/api/widgets/sandbox-v1.html');
  assert.equal(post.status, 405);
});
