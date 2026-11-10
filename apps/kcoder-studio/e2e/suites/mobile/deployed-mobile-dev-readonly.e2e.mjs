import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { startChromium } from '../../harness/chromium.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'deployed-mobile-dev-readonly', tier: 'manual-live',
  modelPolicy: 'Explicit deployed Expo inspection with an owned browser; no pairing, task input or model calls.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_MOBILE_READ, '1');
  const base = new URL(process.env.KCODER_E2E_DEPLOYED_MOBILE_URL);
  assert.equal(base.protocol, 'https:');
  assert.ok(!base.username && !base.password && !base.search && !base.hash);
  assert.match(base.pathname, /^\/g\/[a-f0-9]{32}\/mobile\/?$/);
  const prefix = base.pathname.replace(/\/mobile\/?$/, '');
  const environment = process.env.KCODER_E2E_DEPLOYED_ENV_FILE;
  const info = await lstat(environment);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const line = (await readFile(environment, 'utf8')).split(/\r?\n/)
    .find(value => value.startsWith('KCODER_STUDIO_AUTH_TOKEN='));
  assert.ok(line);
  const token = line.slice(line.indexOf('=') + 1).replace(/^["']|["']$/g, '');
  context.registerSecret(token);
  const browser = await startChromium(context, { startTimeoutMs: 60_000 });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [], failures = [], sockets = new Set();
  const socketPaths = new Map();
  const network = await page.context().newCDPSession(page);
  await network.send('Network.enable');
  network.on('Network.webSocketCreated', event => {
    socketPaths.set(event.requestId, new URL(event.url).pathname);
  });
  network.on('Network.webSocketHandshakeResponseReceived', event => {
    const path = socketPaths.get(event.requestId);
    if (event.response.status === 101 &&
        [`${prefix}/mobile/hot`, `${prefix}/mobile/message`].includes(path)) sockets.add(path);
  });
  context.addCleanup('detach Mobile inspection network observer', () => network.detach());
  page.on('pageerror', error => errors.push(error.name));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === base.origin && url.pathname.includes('/mobile/') && response.status() >= 400)
      failures.push({ path: url.pathname, status: response.status() });
  });
  context.addCleanup('logout owned deployed Mobile inspection', async () => {
    await page.request.post(`${base.origin}${prefix}/logout`, {
      headers: { Origin: base.origin }, maxRedirects: 0, timeout: 8000,
    });
  });
  try {
    await page.goto(`${base.origin}${prefix}/login?${new URLSearchParams({
      token, returnTo: `${prefix}/mobile/welcome`,
    })}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForFunction(() => document.querySelector('#root')?.textContent?.trim().length > 0,
      undefined, { timeout: 180_000 });
    await page.getByTestId('welcome-direct-connection').waitFor({ timeout: 60_000 });
    await waitFor(() => sockets.size === 2, 60_000, 'Expo hot and message WebSockets');
    assert.equal(await page.evaluate(() => globalThis.__DEV__), true);
    assert.equal(new URL(page.url()).pathname, `${prefix}/mobile/welcome`);
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
    const response = await page.request.get(`${base.origin}${prefix}/api/servers`);
    assert.equal(response.status(), 200);
    await page.screenshot({ path: context.pathInArtifacts('mobile-dev-welcome.png') });
    await context.writeArtifactJson('deployed-mobile.json', {
      origin: base.origin, path: new URL(page.url()).pathname, development: true,
      hotReloadSockets: [...sockets].sort(), pageErrors: errors, failedRequests: failures,
      serverDirectoryReadable: true,
    });
  } finally {
    await context.writeArtifactJson('diagnostics.json', {
      path: new URL(page.url()).pathname, openedSockets: [...sockets],
      requestedSockets: [...socketPaths.values()], pageErrors: errors, failedRequests: failures,
      body: context.redactText((await page.locator('body').innerText().catch(() => '')).slice(0, 1400)),
    });
    if (new URL(page.url()).pathname.startsWith(`${prefix}/mobile/`))
      await page.screenshot({ path: context.pathInArtifacts('mobile-inspection.png') }).catch(() => {});
  }
});
