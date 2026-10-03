import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startGateway } from './gateway-process.mjs';
import { stageGatewayDependencies } from './stage-gateway-dependencies.mjs';

const studioRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('packaged Gateway starts outside the repository and overrides a CommonJS parent scope', async t => {
  // This verifies module loading, HTTP startup and authentication, not model behavior.
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-packaged-gateway-'));
  const gatewayRoot = join(directory, 'Installed Studio', 'resources', 'gateway');
  let gateway;
  t.after(async () => {
    try { await gateway?.stop(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  await mkdir(gatewayRoot, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  if (process.env.KCODER_STUDIO_PACKAGED_GATEWAY) {
    await cp(resolve(process.env.KCODER_STUDIO_PACKAGED_GATEWAY), gatewayRoot, { recursive: true });
  } else {
    await stageGatewayDependencies();
    const config = JSON.parse(await readFile(join(studioRoot, 'package.json'), 'utf8'));
    for (const resource of config.build.extraResources.filter(resource => resource.to.startsWith('gateway/'))) {
      await cp(resolve(studioRoot, resource.from), resolve(gatewayRoot, resource.to.slice('gateway/'.length)), { recursive: true });
    }
  }
  const webRoot = join(directory, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>packaged Gateway ready</body></html>');
  gateway = await startGateway({
    nodeBinary: process.env.KCODER_STUDIO_GATEWAY_NODE_BIN || process.execPath,
    gatewayScript: join(gatewayRoot, 'dev-server.mjs'),
    cwd: directory,
    timeoutMs: 10000,
    env: {
      HOME: directory, XDG_CONFIG_HOME: directory,
      KCODER_CONFIG_DIR: join(directory, 'profile'),
      KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_SCENARIO: '',
      KCODER_STUDIO_WORKSPACE: directory,
      KCODER_STUDIO_WEB_ROOT: webRoot,
      KCODER_STUDIO_SERVERS_FILE: '',
      KCODER_STUDIO_SERVERS_STORE: join(directory, 'servers.json'),
      KCODER_STUDIO_RESOURCE_POLICY_FILE: '',
    },
  });
  const headers = { cookie: `kcoder_studio_session=${encodeURIComponent(gateway.cookieValue)}` };
  const page = await fetch(gateway.baseUrl, { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /packaged Gateway ready/);
  const response = await fetch(`${gateway.baseUrl}/api/servers`, { headers });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).servers));
  const exit = gateway.exit;
  await gateway.stop();
  assert.deepEqual(await exit, { code: 0, signal: null });
});
