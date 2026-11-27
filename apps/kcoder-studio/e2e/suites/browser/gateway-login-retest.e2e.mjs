import assert from 'node:assert/strict';
import { copyFile, mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { runE2E, repoRoot, appRoot } from '../../harness/run-context.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { closeChromiumProfileAndWaitForExit } from '../../harness/chromium-profile-exit.mjs';
import { loginUrl } from '../../../src/studio-login-link.js';

await runE2E(import.meta.url, { testId: 'gateway-login-confirmed-retest', tier: 'full-integration',
  modelPolicy: 'No model. System Chromium exercises real Gateway login, fresh Desktop cookies and production Mobile fragment bootstrap through an owned Metro transport fixture, not the full Expo UI.' }, async context => {
  const web = context.pathInState('web'), config = context.pathInState('config'), data = context.pathInState('gateway-data');
  await Promise.all([mkdir(web), mkdir(config, { mode: 0o700 }), mkdir(data, { mode: 0o700 })]);
  const source = await readFile(join(repoRoot, 'apps/kcoder-studio/renderer/index.html'), 'utf8');
  const viewport = source.match(/name="viewport"\s+content="([^"]+)"/)?.[1];
  assert.equal(viewport, 'width=device-width, initial-scale=1');
  await writeFile(join(web, 'index.html'), `<!doctype html><html><head><meta name="viewport" content="${viewport}"></head><body><main id="owned-workbench">Owned workbench</main></body></html>`);
  const gateway = await startGateway(context, { auth: true, workspace: web, serversStore: join(data, 'servers.json'),
    env: { KCODER_STUDIO_WEB_ROOT: web, KCODER_CONFIG_DIR: config, KCODER_HOME: config,
      KCODER_STUDIO_DATA_DIR: data, KCODER_STUDIO_RENDERER_MODE: 'static', KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_P2P: '0' } });
  const login = await fetch(`${gateway.baseUrl}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: gateway.authToken }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0]; context.registerSecret(cookie);
  const info = await (await fetch(`${gateway.baseUrl}/api/gateway/browser-access`, { headers: { cookie } })).json();
  context.registerSecret(info.token); assert.equal(info.linkKind, 'single-use');
  const browser = await startChromium(context), page = await browser.newPage({ viewport: { width: 980, height: 760 } });
  let secretNetworkQueries = 0;
  const navigation = [], errors = [];
  page.on('response', response => { if (navigation.length < 30) navigation.push({ path: new URL(response.url()).pathname, status: response.status(), method: response.request().method() }); });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { const url = request.url(); if (url.includes(gateway.authToken) || url.includes(info.token)) secretNetworkQueries++; });
  try {
    await page.goto(loginUrl(gateway.baseUrl, info.token));
    await page.locator('#owned-workbench').waitFor({ state: 'visible', timeout: 10000 });
  } catch (error) {
    await context.writeArtifactJson('login-browser-failure.json', { navigation, errors,
      document: await page.evaluate(() => ({ path: location.pathname, hashPresent: Boolean(location.hash), body: document.body.innerText.slice(0, 2000) })) });
    throw error;
  }
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(secretNetworkQueries, 0);
  const socketAllowed = await page.evaluate(base => new Promise(resolve => {
    const url = new URL('/rpc?token=cookie-auth&server=local', base); url.protocol = 'ws:';
    const socket = new WebSocket(url); const timer = setTimeout(() => { socket.close(); resolve(false); }, 5000);
    socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(true); };
    socket.onerror = () => { clearTimeout(timer); resolve(false); };
  }), gateway.baseUrl);
  assert.equal(socketAllowed, true);
  for (const saved of await page.context().cookies()) context.registerSecret(saved.value);
  const session = (await page.context().cookies()).find(value => value.name === 'kcoder_studio_session');
  assert.equal(session?.httpOnly, true); assert.equal(session?.sameSite, 'Strict');
  let externalRequests = 0;
  const external = createServer((_request, response) => { externalRequests++; response.end('owned alternate origin'); });
  context.addCleanup('close owned CSP alternate origin', () => new Promise(resolve => { external.closeAllConnections(); external.close(resolve); }));
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  context.registerPort('login-csp-alternate-origin', external.address().port);
  const blocked = await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, `http://127.0.0.1:${external.address().port}`);
  assert.equal(blocked, true); assert.equal(externalRequests, 0);
  await page.screenshot({ path: context.pathInArtifacts('gateway-single-use-login.png') });
  const replay = await browser.newPage();
  await replay.goto(loginUrl(gateway.baseUrl, info.token));
  await replay.getByRole('alert').waitFor({ state: 'visible' });
  await replay.getByLabel('服务器访问令牌').fill('x'.repeat(4096));
  await replay.getByRole('button', { name: '登录', exact: true }).click();
  await replay.getByRole('heading', { name: '提交内容过大' }).waitFor({ state: 'visible' });
  assert.match(await replay.locator('body').innerText(), /请求编号：[a-f0-9-]{36}/);
  const persistent = await (await fetch(gateway.baseUrl + '/api/gateway/browser-access?kind=persistent', { headers: { cookie } })).json();
  context.registerSecret(persistent.token); context.registerSecret(persistent.mobileWebToken);
  assert.equal(persistent.linkKind, 'persistent');
  const permanentPage = await browser.newPersistentPage();
  permanentPage.on('request', request => {
    if ([gateway.authToken, persistent.token, persistent.mobileWebToken].some(secret => request.url().includes(secret))) secretNetworkQueries++;
  });
  await permanentPage.goto(loginUrl(gateway.baseUrl, persistent.token));
  await permanentPage.locator('#owned-workbench').waitFor({ state: 'visible' });
  const before = (await permanentPage.context().cookies()).find(value => value.name === 'kcoder_studio_session');
  context.registerSecret(before.value);
  await permanentPage.goto(loginUrl(gateway.baseUrl, persistent.token));
  await permanentPage.locator('#owned-workbench').waitFor({ state: 'visible' });
  const after = (await permanentPage.context().cookies()).find(value => value.name === 'kcoder_studio_session');
  assert.equal(after.value, before.value, 'opening the same link renews the current session instead of allocating another');
  await permanentPage.close();
  const browserExit = await closeChromiumProfileAndWaitForExit(context, browser);
  assert.equal(browserExit.outcome, 'graceful-exit-observed');
  const reopenedBrowser = await startChromium(context, { label: 'reopened-chromium', profileName: 'chromium' });
  const reopened = await reopenedBrowser.newPersistentPage();
  await reopened.goto(gateway.baseUrl);
  await reopened.locator('#owned-workbench').waitFor({ state: 'visible' });
  await reopened.context().clearCookies();
  await reopened.goto(loginUrl(gateway.baseUrl, persistent.token));
  await reopened.locator('#owned-workbench').waitFor({ state: 'visible' });
  assert.equal(new URL(reopened.url()).hash, '');
  assert.equal(secretNetworkQueries, 0);
  const rotated = await fetch(gateway.baseUrl + '/api/gateway/browser-access?kind=persistent', { method: 'POST',
    headers: { cookie, origin: gateway.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ token: persistent.token }) });
  assert.equal(rotated.status, 200);
  await reopened.goto(loginUrl(gateway.baseUrl, persistent.token));
  await reopened.getByRole('alert').waitFor({ state: 'visible' });

  // Snapshot Gateway wiring into owned state; its Vite shell has no plugins
  // that could rewrite assets watched by another development session.
  const devRoot = context.pathInState('dev-gateway'), devRenderer = join(devRoot, 'renderer');
  const devData = context.pathInState('dev-data'), devConfig = context.pathInState('dev-config');
  await Promise.all([mkdir(devRenderer, { recursive: true }), mkdir(devData, { mode: 0o700 }), mkdir(devConfig, { mode: 0o700 })]);
  await Promise.all([
    copyFile(join(appRoot, 'dev-server.mjs'), join(devRoot, 'dev-server.mjs')),
    copyFile(join(appRoot, 'package.json'), join(devRoot, 'package.json')),
    copyFile(join(appRoot, 'renderer/package.json'), join(devRenderer, 'package.json')),
    copyFile(join(web, 'index.html'), join(devRenderer, 'index.html')),
    copyFile(join(appRoot, 'e2e/fixtures/web-access-vite.config.ts'), join(devRenderer, 'vite.config.ts')),
    ...['src', 'shared', 'node_modules', 'desktop'].map(name => symlink(join(appRoot, name), join(devRoot, name), 'junction')),
    symlink(join(appRoot, 'renderer/node_modules'), join(devRenderer, 'node_modules'), 'junction'),
  ]);
  const { build } = createRequire(join(appRoot, 'mobile/package.json'))('esbuild');
  const mobileSource = join(appRoot, 'mobile/src/gateway/web-pairing-bootstrap.ts');
  const compiled = await build({ bundle: true, write: false, format: 'esm', platform: 'browser',
    stdin: { resolveDir: appRoot, sourcefile: 'owned-mobile-entry.js', contents: `
      import { getWebPairingBootstrapState } from ${JSON.stringify(mobileSource)};
      const intent = getWebPairingBootstrapState('/connect', location.pathname);
      if (!intent || intent.kind !== 'intent') throw new Error('Missing original Mobile pairing intent');
      const response = await fetch('/api/mobile/session', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: intent.token, durableDeviceAuthorization: true, deviceLabel: 'Owned browser acceptance' }) });
      const grant = await response.json();
      const headers = { authorization: 'Bearer ' + grant.accessToken };
      window.ownedMobileAccess = { paired: response.status,
        servers: (await fetch('/api/servers', { headers })).status,
        admin: (await fetch('/api/gateway/browser-access?kind=persistent', { headers })).status };
      document.getElementById('owned-mobile').textContent = 'Mobile connected';
    ` } });
  const metroRequests = [];
  const metro = createServer((request, response) => {
    metroRequests.push(new URL(request.url, 'http://localhost').pathname);
    const bundle = request.url.startsWith('/src/entry.ts.bundle');
    response.writeHead(200, { 'content-type': bundle ? 'text/javascript' : 'text/html' });
    response.end(bundle ? compiled.outputFiles[0].text : '<!doctype html><main id="owned-mobile"></main><script type="module" src="/src/entry.ts.bundle?platform=web"></script>');
  });
  context.addCleanup('close owned Metro transport fixture', () => new Promise(resolve => { metro.closeAllConnections(); metro.close(resolve); }));
  await new Promise(resolve => metro.listen(0, '127.0.0.1', resolve));
  context.registerPort('mobile-access-metro', metro.address().port);
  const devGateway = await startGateway(context, { label: 'web-access-dev-gateway', gatewayRoot: devRoot,
    auth: true, workspace: web, serversStore: join(devData, 'servers.json'),
    env: { KCODER_STUDIO_WEB_ROOT: web, KCODER_HOME: devConfig, KCODER_CONFIG_DIR: devConfig,
      KCODER_STUDIO_DATA_DIR: devData, KCODER_STUDIO_RENDERER_MODE: 'vite',
      KCODER_STUDIO_MOBILE_DEV_PORT: String(metro.address().port), KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_P2P: '0' } });
  const devLogin = await fetch(devGateway.baseUrl + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: devGateway.authToken }) });
  const devCookie = devLogin.headers.get('set-cookie').split(';', 1)[0]; context.registerSecret(devCookie);
  const devAccess = await (await fetch(devGateway.baseUrl + '/api/gateway/browser-access?kind=persistent', { headers: { cookie: devCookie } })).json();
  context.registerSecret(devAccess.token); context.registerSecret(devAccess.mobileWebToken);
  const desktopFresh = await reopenedBrowser.newPage();
  assert.equal((await desktopFresh.context().cookies()).length, 0);
  await desktopFresh.goto(loginUrl(devGateway.baseUrl, devAccess.token));
  await desktopFresh.locator('#owned-workbench').waitFor({ state: 'visible' });
  const mobileFresh = await reopenedBrowser.newPage();
  assert.equal((await mobileFresh.context().cookies()).length, 0);
  const mobileLink = new URL('/mobile/connect', devGateway.baseUrl);
  mobileLink.searchParams.set('gateway', devGateway.baseUrl);
  mobileLink.hash = new URLSearchParams({ token: devAccess.mobileWebToken }).toString();
  await mobileFresh.goto(mobileLink.toString());
  await mobileFresh.locator('#owned-mobile').filter({ hasText: 'Mobile connected' }).waitFor({ state: 'visible' });
  assert.deepEqual(await mobileFresh.evaluate(() => window.ownedMobileAccess), { paired: 200, servers: 200, admin: 403 });
  assert.equal(new URL(mobileFresh.url()).hash, '');
  assert.equal((await mobileFresh.context().cookies()).length, 0, 'Mobile pairing does not grant a desktop admin cookie');
  for (const path of ['/api/servers', '/mobile/open-editor', '/mobile/src/entry.ts.map', '/mobile/message']) {
    const denied = await fetch(devGateway.baseUrl + path, { redirect: 'manual' });
    assert.equal(denied.status, 401, path);
  }
  assert.deepEqual(metroRequests, ['/connect', '/src/entry.ts.bundle']);
  await context.writeArtifactJson('web-access-dev-entry.json', { desktopFreshContextEntry: true,
    mobileFreshContextEntry: true, actualMobileFragmentBootstrap: true, mobileGrantUsable: true,
    desktopAdminNotGrantedToMobile: true, unsafeMetroRoutesDenied: true, modelRequests: 0,
    metroBoundary: 'owned transport fixture serving compiled production pairing bootstrap; not full Expo UI acceptance' });
  await context.writeArtifactJson('gateway-login-retest.json', { singleUseLogin: true, replayRejected: true,
    persistentRepeatLogin: true, existingSessionReused: true, actualBrowserRestartRestoresCookie: true,
    persistentLoginWithoutCookie: true, revokedLinkRejected: true,
    cleanNetworkUrls: true, httpOnlySession: true, boundedErrorVisible: true, externalConnectBlocked: true, sameOriginSocketAllowed: true, viewportAllowsZoom: true });
});
