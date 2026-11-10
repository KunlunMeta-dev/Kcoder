import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { startChromium } from '../../harness/chromium.mjs';
import { runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'deployed-independent-channel-read', tier: 'manual-live',
  modelPolicy: 'Explicit public deployment inspection with an owned browser. Existing Gateway login and channel inventory only; no binding mutation, receive loop, platform send or model call.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_CHANNEL_READ, '1');
  const base = new URL(process.env.KCODER_E2E_DEPLOYED_DESKTOP_URL);
  assert.equal(base.protocol, 'https:');
  assert.ok(!base.search && !base.hash && !base.username && !base.password);
  const loginUrlFile = process.env.KCODER_E2E_DEPLOYED_LOGIN_URL_FILE;
  const file = loginUrlFile ?? process.env.KCODER_E2E_DEPLOYED_ENV_FILE;
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077));
  const contents = await readFile(file, 'utf8');
  const token = loginUrlFile
    ? new URL(contents.trim()).searchParams.get('token')
    : parseEnv(contents).KCODER_STUDIO_AUTH_TOKEN;
  assert.ok(token); context.registerSecret(token);
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: process.env.KCODER_E2E_DEPLOYED_SELF_SIGNED === '1' });
  context.addCleanup('close deployed channel page', () => page.close());
  const prefix = base.pathname.replace(/\/$/, '');
  const failures = [], errors = [], mutations = [], legacyReads = [];
  page.on('pageerror', error => errors.push(context.redactText(error.message)));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400) failures.push({ path, status: response.status() });
  });
  page.on('request', request => {
    if (new URL(request.url()).pathname === `${prefix}/api/channels` && request.method() !== 'GET')
      mutations.push(request.method());
  });
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try {
      const message = JSON.parse(String(payload));
      if (message.method?.startsWith('integrations/connectivity/')
          || message.method?.startsWith('integrations/services/channel/')) legacyReads.push(true);
    } catch { /* Non-RPC frames are unrelated to this assertion. */ }
  }));
  await page.goto(`${base.origin}${prefix}/login`, { timeout: 30000 });
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([page.waitForURL(url => !url.pathname.endsWith('/login')),
    page.locator('button[type="submit"]').click()]);
  context.addCleanup('logout owned channel inspection session', async () => {
    const response = await page.request.post(`${base.origin}${prefix}/logout`, {
      headers: { Origin: base.origin }, maxRedirects: 0, timeout: 8000,
    });
    assert.equal(response.status(), 303);
  });
  const read = page.waitForResponse(response => new URL(response.url()).pathname === `${prefix}/api/channels`
    && response.request().method() === 'GET', { timeout: 60000 });
  await page.goto(`${base.origin}${prefix}/channels`, { timeout: 60000 });
  const response = await read;
  assert.equal(response.status(), 200);
  const inventory = await response.json();
  assert.ok(inventory.installationId && Array.isArray(inventory.connections) && Array.isArray(inventory.chats));
  const workspace = page.getByTestId('octop-channels-workspace');
  await workspace.waitFor({ timeout: 60000 });
  const clientSync = workspace.getByTestId('channel-client-sync');
  assert.equal(typeof inventory.settings?.mirrorClientTurns, 'boolean');
  assert.equal(await clientSync.isChecked(), inventory.settings.mirrorClientTurns);
  assert.equal(await clientSync.isEnabled(), true);
  await page.waitForFunction(count => document.querySelectorAll('[data-testid="channel-connection-instance"]').length === count,
    inventory.connections.length, { timeout: 30000 });
  assert.equal(await workspace.getByRole('alert').count(), 0);
  for (const platform of (process.env.KCODER_E2E_DEPLOYED_CHANNEL_PLATFORMS ?? 'feishu,qq,weixin').split(',')) {
    assert.ok(inventory.connections.some(connection => connection.platform === platform && connection.hasCredential), platform);
    if (process.env.KCODER_E2E_DEPLOYED_CHANNEL_CONNECTED === '1')
      assert.ok(inventory.connections.some(connection => connection.platform === platform && connection.enabled && connection.state === 'connected'), platform);
  }
  for (const chat of inventory.chats) {
    assert.ok(Number.isSafeInteger(chat.bindingRevision));
    assert.ok(Array.isArray(chat.deliveries));
  }
  await page.screenshot({ path: context.pathInArtifacts('deployed-independent-channels.png'), fullPage: true });
  const proof = { settings: inventory.settings,
    connections: inventory.connections.map(row => ({ platform: row.platform, state: row.state, hasCredential: row.hasCredential })),
    observedChats: inventory.chats.length, boundChats: inventory.chats.filter(row => row.binding).length,
    failures, errors, channelMutations: mutations.length, legacyChannelCalls: legacyReads.length,
    platformMessages: 0, modelCalls: 0 };
  await context.writeArtifactJson('deployed-channels-proof.json', proof);
  assert.deepEqual(failures, []); assert.deepEqual(errors, []);
  assert.deepEqual(mutations, []); assert.deepEqual(legacyReads, []);
});
