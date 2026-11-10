import assert from 'node:assert/strict';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { exportMobileWeb } from '../../harness/mobile-web-export.mjs';
import { appRoot, retainedArtifactRunRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { fileURLToPath } from 'node:url';
import { captureMobileExportSourceSnapshot } from '../../harness/mobile-export-source-snapshot.mjs';
import { materializeOwnedDependencies } from '../../harness/owned-dependencies.mjs';
import { copyFrozenMobileWeb } from '../../harness/frozen-copy.mjs';
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from '../../../mobile/scripts/gateway-mobile-web-manifest.mjs';

process.umask(0o077);

await runE2E(import.meta.url, {
  testId: 'mobile-web-session-recovery', tier: 'full-integration', retainSuccessLogs: true,
  modelPolicy: 'real isolated Gateway authentication and Chromium Mobile Web; mock runtime metadata only; no Provider, turn, personal session or shared preview',
}, async context => {
  const reuseRun = process.env.KCODER_E2E_SESSION_RECOVERY_REUSE_RUN;
  let mobile;
  if (reuseRun) {
    assert.match(reuseRun, /^\d{8}-\d{6}\.\d{3}Z$/);
    const root = retainedArtifactRunRoot(fileURLToPath(import.meta.url), reuseRun);
    const artifacts = resolve(root, 'artifacts');
    const result = JSON.parse(await readFile(resolve(artifacts, 'result.json'), 'utf8'));
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.cleanupErrors, []);
    const manifestPath = resolve(artifacts, 'mobile-web-export-session-recovery-web-export-manifest.json');
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.bundleSha256, process.env.KCODER_E2E_SESSION_RECOVERY_REUSE_BUNDLE_SHA256);
    const snapshot = JSON.parse(await readFile(resolve(artifacts, 'source-snapshot.json'), 'utf8'));
    const connectSource = await readFile(resolve(appRoot, 'mobile/src/app/connect.tsx'));
    assert.equal(snapshot.files.find(row => row.root === 'mobile' && row.path === 'src/app/connect.tsx').sha256,
      createHash('sha256').update(connectSource).digest('hex'), 'the retained login implementation must match current source');
    const staged = await materializeOwnedDependencies(context, {
      sourceRoot: resolve(artifacts, 'mobile-web'), destination: context.pathInState('retained-mobile-staging'),
      label: 'session-recovery-retained-static-copy',
    });
    // Remove only the copied deployment sidecar; the frozen copier verifies
    // every remaining byte against the original complete Expo export receipt.
    await unlink(resolve(staged.root, 'kcoder-mobile-web.json'));
    const path = context.pathInState('retained-mobile');
    await copyFrozenMobileWeb({ sourceRoot: staged.root, destination: path, manifestPath,
      expectedBundleSha256: manifest.bundleSha256, expectedSourceTreeSha256: manifest.sourceTreeSha256 });
    mobile = { path, bundleManifestPath: manifestPath, bundleFiles: manifest.bundleFiles,
      bundleSha256: manifest.bundleSha256, sourceTreeSha256: manifest.sourceTreeSha256 };
    await context.writeArtifactJson('retained-export-reuse.json', {
      originalRun: reuseRun, originalManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      bundleSha256: mobile.bundleSha256, currentConnectSourceMatched: true, freshExportPerformed: false,
    });
  } else {
  const snapshotRoot = context.pathInState('source-snapshot');
  const snapshot = await captureMobileExportSourceSnapshot({
    sourceRoots: [
      { name: 'mobile', path: resolve(appRoot, 'mobile'), destination: 'apps/kcoder-studio/mobile' },
      { name: 'studio-shared', path: resolve(appRoot, 'shared'), destination: 'apps/kcoder-studio/shared' },
    ], snapshotRoot, layout: 'preflight-source-root', freezeFiles: true,
  });
  await context.writeArtifactJson('source-snapshot.json', snapshot);
  console.log('[session-recovery] freeze dependency snapshot');
  const dependencies = await materializeOwnedDependencies(context, {
    sourceRoot: resolve(appRoot, 'mobile/node_modules'), destination: context.pathInState('dependency-snapshot'),
    label: 'session-recovery-dependency-snapshot',
  });
  let phase;
  mobile = await exportMobileWeb(context, {
    mobileRoot: resolve(snapshotRoot, 'apps/kcoder-studio/mobile'),
    sourceRoots: [
      { name: 'mobile', path: resolve(snapshotRoot, 'apps/kcoder-studio/mobile'), destination: 'apps/kcoder-studio/mobile' },
      { name: 'studio-shared', path: resolve(snapshotRoot, 'apps/kcoder-studio/shared'), destination: 'apps/kcoder-studio/shared' },
    ], dependencyRoot: dependencies.root,
    label: 'session-recovery-web-export', deployMount: true, timeoutMs: 10 * 60_000,
    onProgress: progress => {
      const next = progress.phase ?? progress.event;
      if (next !== phase) { console.log(`[session-recovery] ${next}`); phase = next; }
    },
  });
  }
  const gatewaySources = async () => Object.fromEntries(await Promise.all([
    'dev-server.mjs', 'src/browser-session-recovery.js', 'src/mobile-device-auth.js', 'src/workspace-cwd-observation.js',
  ].map(async path => [path, createHash('sha256').update(await readFile(resolve(appRoot, path))).digest('hex')])));
  const gatewayBefore = await gatewaySources();
  const retainedMobile = context.pathInArtifacts('mobile-web');
  await copyFrozenMobileWeb({ sourceRoot: mobile.path, destination: retainedMobile,
    manifestPath: mobile.bundleManifestPath, expectedBundleSha256: mobile.bundleSha256,
    expectedSourceTreeSha256: mobile.sourceTreeSha256 });
  const mobileManifest = await buildGatewayMobileWebManifest(mobile.path, { expectedFiles: mobile.bundleFiles });
  await writeGatewayMobileWebManifest(mobile.path, mobileManifest);
  await writeGatewayMobileWebManifest(retainedMobile, mobileManifest);
  const workspace = context.pathInState('workspace');
  const home = context.pathInState('home');
  await Promise.all([workspace, home].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const serversStore = await context.writeStateJson('gateway/servers.json', [
    { id: 'local', label: 'Recovery test server', transport: 'local', runtime: 'kcoder', workspace },
  ]);
  const authToken = randomBytes(32).toString('base64url');
  const options = { auth: true, authToken, serversStore, workspace,
    env: { HOME: home, USERPROFILE: home, KCODER_CONFIG_DIR: resolve(home, 'config'),
      KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_WEB_ROOT: '', KCODER_STUDIO_MOBILE_WEB_ROOT: mobile.path } };
  const gateway = await startGateway(context, { ...options, label: 'recovery-gateway-initial' });
  const chromium = await startChromium(context, { label: 'session-recovery-chromium', startTimeoutMs: 60_000 });
  const browser = await chromium.browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  context.addCleanup('close owned session-recovery browser context', () => browser.close());
  const page = await browser.newPage();
  const errors = [];
  let pairRequests = 0;
  let refreshRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/api/mobile/session') pairRequests++;
    if (request.method() === 'POST' && path === '/api/mobile/session/refresh') refreshRequests++;
  });
  await page.goto(`${gateway.baseUrl}/login?${new URLSearchParams({ token: authToken, returnTo: '/mobile/welcome' })}`, { waitUntil: 'domcontentloaded' });
  assert.equal(new URL(page.url()).pathname, '/mobile/welcome');
  const pairingResponse = await browser.request.get(`${gateway.baseUrl}/api/mobile/pairing`);
  assert.equal(pairingResponse.status(), 200);
  const pairing = await pairingResponse.json();
  context.registerSecret(pairing.token);
  await page.goto(`${gateway.baseUrl}/mobile/connect?${new URLSearchParams({ gateway: gateway.baseUrl })}#token=${pairing.token}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('sessions').waitFor({ timeout: 30_000 });
  const destination = page.url();
  assert.ok(new URL(destination).pathname.startsWith('/mobile/h/'));
  assert.equal(new URL(destination).hash, '');
  assert.equal(pairRequests, 1);
  const hostCookie = (await browser.cookies()).find(cookie => cookie.name === 'kcoder_studio_session');
  assert.ok(hostCookie?.httpOnly);
  context.registerSecret(hostCookie.value);
  const originalCookie = `${hostCookie.name}=${hostCookie.value}`;

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('sessions').waitFor({ timeout: 30_000 });
  assert.equal(page.url(), destination);
  assert.equal(pairRequests, 1, 'a document reload must not pair a new device');

  await page.goto(`${gateway.baseUrl}/mobile/connect?${new URLSearchParams({ gateway: gateway.baseUrl })}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('sessions').waitFor({ timeout: 30_000 });
  assert.equal(page.url(), destination, 'a scrubbed pairing URL must restore the same saved profile');
  assert.equal(pairRequests, 1);
  await page.screenshot({ path: context.pathInArtifacts('saved-connection-after-reload.png') });

  await context.stopOwned('recovery-gateway-initial');
  const restarted = await startGateway(context, { ...options, port: gateway.port, label: 'recovery-gateway-restarted' });
  assert.equal(restarted.baseUrl, gateway.baseUrl);
  const browserSession = await fetch(`${gateway.baseUrl}/api/mobile/pairing`, { headers: { cookie: originalCookie }, redirect: 'manual' });
  assert.equal(browserSession.status, 200, 'the original host Cookie must survive a Gateway restart');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('sessions').waitFor({ timeout: 30_000 });
  await waitFor(() => refreshRequests > 0, 15_000, 'saved device refresh after Gateway restart');
  assert.equal(page.url(), destination);
  assert.equal(pairRequests, 1, 'Gateway restart must use refresh rather than pair again');
  assert.equal(await page.getByTestId('reauthorize-active-profile').count(), 0);
  await page.screenshot({ path: context.pathInArtifacts('saved-connection-after-gateway-restart.png') });
  assert.deepEqual(errors, []);
  await page.close();

  const logout = await fetch(`${gateway.baseUrl}/logout`, { method: 'POST', redirect: 'manual',
    headers: { cookie: originalCookie, origin: gateway.baseUrl, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(logout.status, 303);
  await context.stopOwned('recovery-gateway-restarted');
  await startGateway(context, { ...options, port: gateway.port, label: 'recovery-gateway-after-logout' });
  assert.equal((await fetch(`${gateway.baseUrl}/api/servers`, { headers: { cookie: originalCookie }, redirect: 'manual' })).status, 401,
    'a logged-out Cookie must remain revoked after restart');
  assert.deepEqual(await gatewaySources(), gatewayBefore, 'Gateway authentication source must stay fixed throughout acceptance');
  await context.writeArtifactJson('session-recovery-evidence.json', {
    pageReloadRestoredSameProfile: true, scrubbedPairingUrlRestoredSameProfile: true,
    hostLoginSurvivedRestart: true, gatewayRestartRefreshedExistingDevice: true,
    logoutStayedRevokedAfterRestart: true, pairRequests, refreshRequests, pageErrors: errors,
    sourceTreeSha256: mobile.sourceTreeSha256, bundleSha256: mobile.bundleSha256,
    gatewaySourceDigests: gatewayBefore,
  });
});
