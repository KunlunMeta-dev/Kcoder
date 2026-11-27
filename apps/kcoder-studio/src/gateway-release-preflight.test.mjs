import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGatewayReleaseResources } from './gateway-release-preflight.mjs';
import { studioRendererMode } from './studio-vite-renderer.js';

test('release entry refuses development servers and unbuilt or development artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-release-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, 'web'), mobileRoot = join(root, 'mobile');
  await Promise.all([mkdir(webRoot), mkdir(mobileRoot)]);
  const env = { KCODER_STUDIO_DEPLOYMENT_MODE: 'release' };
  for (const patch of [{ KCODER_STUDIO_RENDERER_MODE: 'vite' }, { KCODER_STUDIO_MOBILE_DEV_PORT: '14175' }])
    assert.throws(() => studioRendererMode({ ...env, ...patch }), /Release Gateway/);
  await assert.rejects(assertGatewayReleaseResources({ env, webRoot, mobileRoot }), /missing/);
  await Promise.all([writeFile(join(webRoot, 'index.html'), '<script src="/src/startup.ts"></script>'),
    writeFile(join(mobileRoot, 'index.html'), '<html>Static mobile</html>'), writeFile(join(mobileRoot, 'kcoder-mobile-web.json'), '{}')]);
  await assert.rejects(assertGatewayReleaseResources({ env, webRoot, mobileRoot }), /Development/);
  await writeFile(join(webRoot, 'index.html'), '<script src="/assets/app-12345678.js"></script>');
  await assert.rejects(assertGatewayReleaseResources({ env, webRoot, mobileRoot }), /inventory/);
  await assertGatewayReleaseResources({ env, webRoot, mobileRoot, prepareMobile: async () => {} });
  await assertGatewayReleaseResources({ env: {}, webRoot: '/not-required', mobileRoot: '/not-required' });
});
