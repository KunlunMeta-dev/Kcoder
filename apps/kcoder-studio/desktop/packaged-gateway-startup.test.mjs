import { stageConnectivityResources } from '../../kcoder-channel-host/packaging/stage-resources.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { startGateway } from './gateway-process.mjs';
import { stageGatewayDependencies } from './stage-gateway-dependencies.mjs';
import { verifyGatewayEntryClosure } from '../../../scripts/release/desktop-entry-closure.mjs';

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
    const stagedDependencies = await stageGatewayDependencies();
    assert.ok(stagedDependencies.packages.ws, 'portable WebSocket dependency is staged for the Gateway');
    if (stagedDependencies.p2pNative.status === 'included') {
      assert.equal(stagedDependencies.packages['node-datachannel'], '0.32.0');
    } else {
      assert.equal(stagedDependencies.p2pNative.status, 'omitted');
    }
    const config = JSON.parse(await readFile(join(studioRoot, 'package.json'), 'utf8'));
    assert.ok(config.files.includes('shared/gatewayRequestDeadline.js'), 'npm Gateway inventory includes its shared runtime import');
    assert.ok(config.build.extraResources.some(resource => resource.from === 'shared/gatewayRequestDeadline.js' &&
      resource.to === 'gateway/shared/gatewayRequestDeadline.js'), 'Electron Gateway inventory preserves the shared runtime path');
    assert.ok(config.files.includes('shared/gatewayConnectionRoutes.js') && config.files.includes('shared/gatewayConnectionRoutes.d.ts'), 'npm Gateway inventory includes the shared connection contract and declarations');
    for (const extension of ['js', 'd.ts']) assert.ok(config.build.extraResources.some(resource =>
      resource.from === `shared/gatewayConnectionRoutes.${extension}` &&
      resource.to === `gateway/shared/gatewayConnectionRoutes.${extension}`), `Electron Gateway inventory includes the shared connection contract ${extension}`);
    assert.ok(config.files.includes('shared/migrationInstructions.mjs'), 'npm Gateway includes the shared instruction runtime');
    assert.ok(config.build.extraResources.some(resource => resource.from === 'shared/migrationInstructions.mjs' &&
      resource.to === 'gateway/shared/migrationInstructions.mjs'), 'Electron Gateway includes the shared instruction runtime');
    assert.ok(config.files.includes('shared/integrationControlMethods.mjs'), 'npm Gateway includes finite native integration methods');
    assert.ok(config.build.extraResources.some(resource => resource.from === 'shared/integrationControlMethods.mjs' &&
      resource.to === 'gateway/shared/integrationControlMethods.mjs'), 'Electron Gateway includes finite native integration methods');
    for (const extension of ['mjs', 'd.mts']) {
      const path = `shared/webSearchMethods.${extension}`;
      assert.ok(config.files.includes(path), `npm Gateway includes web search methods ${extension}`);
      assert.ok(config.build.extraResources.some(resource => resource.from === path &&
        resource.to === `gateway/${path}`), `Electron Gateway preserves web search methods ${extension}`);
    }
    assert.ok(config.files.includes('shared/generated/validator.mjs'), 'npm Gateway includes the generated runtime contract validator');
    assert.ok(config.build.extraResources.some(resource => resource.from === 'shared/generated/validator.mjs' &&
      resource.to === 'gateway/shared/generated/validator.mjs'), 'Electron Gateway includes the generated runtime contract validator');
    for (const extension of ['js', 'd.ts']) {
      assert.ok(config.files.includes(`shared/gatewayPeerTransport.${extension}`), `npm Gateway inventory includes peer transport ${extension}`);
      assert.ok(config.build.extraResources.some(resource => resource.from === `shared/gatewayPeerTransport.${extension}` &&
        resource.to === `gateway/shared/gatewayPeerTransport.${extension}`), `Electron Gateway inventory includes peer transport ${extension}`);
    }
    for (const name of ['taskStateObservations.mjs']) {
      assert.ok(config.files.includes(`shared/${name}`), `npm Gateway inventory includes ${name}`);
      assert.ok(config.build.extraResources.some(resource => resource.from === `shared/${name}` &&
        resource.to === `gateway/shared/${name}`), `Electron Gateway inventory includes ${name}`);
    }
    const packagedResources = resolve(gatewayRoot, '..');
    for (const resource of config.build.extraResources.filter(resource =>
      resource.to.startsWith('gateway/') || resource.to.startsWith('kcoder-relay/'))) {
      const destination = resource.to.startsWith('gateway/')
        ? resolve(gatewayRoot, resource.to.slice('gateway/'.length))
        : resolve(packagedResources, resource.to);
      if (resource.from === 'mobile/dist') {
        // This entry-closure test uses owned static HTML, not an Expo build.
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'index.html'), '<html><body>Mobile fixture</body></html>');
      } else await cp(resolve(studioRoot, resource.from), destination, { recursive: true });
    }
    await stageConnectivityResources({ destination: resolve(packagedResources, 'kcoder-channel-host') });
    verifyGatewayEntryClosure(packagedResources);
    const packagedRequire = createRequire(join(gatewayRoot, 'package.json'));
    assert.equal(typeof packagedRequire('ws').WebSocketServer, 'function');
    if (stagedDependencies.p2pNative.status === 'included') {
      assert.equal(typeof packagedRequire('node-datachannel').getLibraryVersion(), 'string');
    }
  }
  const token = randomBytes(32).toString('base64url');
  const { createMobileDeviceAuth, mobileDeviceStoreIdentity, MobileDeviceAuthError } =
    await import(pathToFileURL(join(gatewayRoot, 'src/mobile-device-auth.js')).href);
  let accountRoot;
  // Allocate a fresh owned account store whose real kernel lock is available.
  // An unrelated loopback listener may occupy a store's hashed mutex port.
  // No Gateway startup, user state or business mutation is retried here.
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = await mkdtemp(join(directory, 'account-'));
    try {
      await createMobileDeviceAuth({ directory: candidate, identity: mobileDeviceStoreIdentity(token) }).privateRetentionVerifier();
      accountRoot = candidate;
      break;
    } catch (error) {
      if (!(error instanceof MobileDeviceAuthError) || error.status !== 503 ||
          error.message !== 'Device authorization local store lock unavailable') throw error;
      t.diagnostic('owned account store allocation encountered a contended kernel lock');
    }
  }
  assert.ok(accountRoot, 'an owned account store must acquire its actual kernel mutex before startup');
  const webRoot = join(directory, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>packaged Gateway ready</body></html>');
  gateway = await startGateway({
    token,
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
      KCODER_STUDIO_SERVERS_STORE: join(accountRoot, 'servers.json'),
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
  const stagedGatewayPackage = JSON.parse(await readFile(join(gatewayRoot, 'package.json'), 'utf8'));
  const statusResponse = await fetch(`${gateway.baseUrl}/api/servers/status`, { headers });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).gatewayRuntimeVersion, stagedGatewayPackage.version);
  const exit = gateway.exit;
  await gateway.stop();
  assert.deepEqual(await exit, process.platform === 'win32'
    ? { code: null, signal: 'SIGTERM' }
    : { code: 0, signal: null });
});
