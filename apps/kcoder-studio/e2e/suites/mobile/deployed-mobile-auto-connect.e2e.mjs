import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { startChromium } from '../../harness/chromium.mjs';
import { runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'deployed-mobile-auto-connect', tier: 'manual-live',
  modelPolicy: 'Explicit deployed login and Mobile pairing with an owned browser/device; no task input or model calls.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_MOBILE_CONNECT, '1');
  const file = process.env.KCODER_E2E_DEPLOYED_MOBILE_CONNECT_URL_FILE;
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const entry = new URL((await readFile(file, 'utf8')).trim());
  assert.equal(entry.protocol, 'https:');
  assert.match(entry.pathname, /^\/g\/[a-f0-9]{32}\/login$/);
  const prefix = entry.pathname.replace(/\/login$/, '');
  const target = new URL(entry.searchParams.get('returnTo'), entry.origin);
  assert.equal(target.pathname, `${prefix}/mobile/connect`);
  context.registerSecret(entry.searchParams.get('token'));
  context.registerSecret(new URLSearchParams(entry.hash.slice(1)).get('token'));
  const browser = await startChromium(context, { startTimeoutMs: 60_000 });
  const desktop = process.env.KCODER_E2E_DEPLOYED_MOBILE_DESKTOP === '1';
  const page = await browser.newPage(desktop ? {
    viewport: { width: 1330, height: 900 }, locale: 'zh-CN', colorScheme: 'dark',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0',
  } : { viewport: { width: 390, height: 844 } });
  const responses = [], errors = [], reads = [];
  const sessions = new Map();
  let serverCount = null;
  page.on('pageerror', error => errors.push(context.redactText(error.stack ?? error.message)));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== entry.origin) return;
    if (url.pathname.includes('/api/') || response.status() >= 400)
      responses.push({ path: url.pathname, status: response.status(), method: response.request().method() });
    if (url.pathname === `${prefix}/api/mobile/session` && response.request().method() === 'POST' && response.ok()) {
      reads.push(response.json().then(payload => {
        for (const key of ['accessToken', 'rpcToken', 'refreshToken']) if (payload[key]) context.registerSecret(payload[key]);
        if (payload.accessToken) sessions.set(payload.accessToken, payload.deviceId ?? null);
        if (Array.isArray(payload.initialServers?.servers)) serverCount = payload.initialServers.servers.length;
      }));
    }
    if (url.pathname === `${prefix}/api/servers` && response.ok()) {
      reads.push(response.json().then(payload => {
        const servers = Array.isArray(payload) ? payload : payload.servers;
        if (Array.isArray(servers)) serverCount = servers.length;
      }));
    }
  });
  context.addCleanup('logout owned deployed browser session', () => page.request.post(`${entry.origin}${prefix}/logout`, {
    headers: { Origin: entry.origin }, maxRedirects: 0, timeout: 8000,
  }));
  context.addCleanup('revoke owned deployed Mobile sessions', async () => {
    await Promise.all(reads);
    await page.goto('about:blank');
    for (const [token, deviceId] of sessions) {
      const response = await page.request.delete(`${entry.origin}${prefix}/api/mobile/session`, {
        headers: { Authorization: `Bearer ${token}`, Origin: entry.origin }, timeout: 15_000,
      });
      const detail = response.status() === 204 ? '' : context.redactText((await response.text()).slice(0, 500));
      assert.ok([204, 401].includes(response.status()),
        `Owned Mobile session cleanup: ${JSON.stringify({ deviceId, status: response.status(), detail })}`);
    }
  });
  try {
    await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForURL(url => url.pathname.startsWith(`${prefix}/mobile/h/`), { timeout: 120_000 });
    await page.getByTestId(/^home-interface-/).waitFor({ timeout: 60_000 });
    await Promise.all(reads);
    assert.ok(sessions.size > 0, 'Fresh browser completed actual pairing');
    assert.ok(serverCount > 0, 'Actual Gateway targets loaded');
    assert.equal(new URL(page.url()).hash, '');
    assert.deepEqual(errors, []);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.getByTestId(/^home-interface-/).waitFor({ timeout: 60_000 });
    await page.getByTestId(/^thread-(?!recent-error-)/).first().waitFor({ timeout: 90_000 });
    await page.screenshot({ path: context.pathInArtifacts('mobile-connected-home.png') });
    await context.writeArtifactJson('mobile-auto-connect.json', {
      path: new URL(page.url()).pathname, fragmentCleared: true, serverCount,
      pairedSessions: sessions.size, pairedDevices: [...sessions.values()], reloadRestored: true,
      visibleTasks: await page.getByTestId(/^thread-(?!recent-error-)/).count(), responses, errors,
    });
  } finally {
    await Promise.all(reads);
    await context.writeArtifactJson('diagnostics.json', {
      path: new URL(page.url()).pathname, fragmentPresent: Boolean(new URL(page.url()).hash),
      body: context.redactText((await page.locator('body').innerText().catch(() => '')).slice(0, 1800)),
      serverCount, pairedSessions: sessions.size, pairedDevices: [...sessions.values()], responses, errors,
    });
    await page.screenshot({ path: context.pathInArtifacts('mobile-inspection.png') }).catch(() => {});
  }
});
