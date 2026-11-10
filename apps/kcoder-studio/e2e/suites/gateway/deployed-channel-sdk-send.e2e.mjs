import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, open } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { startChromium } from '../../harness/chromium.mjs';
import { runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'deployed-channel-ui-and-sdk-send', tier: 'manual-live',
  modelPolicy: 'Authorized deployed Web connection cards/chat discovery followed by one real same-origin SDK send per selected QQ/Weixin account. No task creation, binding change, synthetic ingress or model call.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_CHANNEL_SEND, '1');
  const base = new URL(process.env.KCODER_E2E_DEPLOYED_DESKTOP_URL);
  assert.equal(base.protocol, 'https:');
  assert.ok(!base.search && !base.hash && !base.username && !base.password);
  const file = process.env.KCODER_E2E_DEPLOYED_ENV_FILE;
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077));
  const token = parseEnv(await readFile(file, 'utf8')).KCODER_STUDIO_AUTH_TOKEN;
  assert.ok(token); context.registerSecret(token);
  const platforms = (process.env.KCODER_E2E_DEPLOYED_CHANNEL_PLATFORMS ?? 'qq,weixin').split(',');
  assert.ok(platforms.length && new Set(platforms).size === platforms.length
    && platforms.every(platform => ['qq', 'weixin'].includes(platform)));
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: process.env.KCODER_E2E_DEPLOYED_SELF_SIGNED === '1' });
  context.addCleanup('close deployed SDK acceptance page', () => page.close());
  const prefix = base.pathname.replace(/\/$/, ''), url = path => `${base.origin}${prefix}${path}`;
  const errors = [], actions = [];
  page.on('pageerror', error => errors.push(context.redactText(error.message)));
  page.on('request', request => {
    if (new URL(request.url()).pathname === `${prefix}/api/channels` && request.method() === 'POST')
      actions.push(request.postDataJSON().action);
  });
  await page.goto(url('/login'), { timeout: 30000 });
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([page.waitForURL(value => !value.pathname.endsWith('/login')),
    page.locator('button[type="submit"]').click()]);
  context.addCleanup('logout owned SDK acceptance session', async () => {
    const response = await page.request.post(url('/logout'), { headers: { Origin: base.origin }, maxRedirects: 0, timeout: 8000 });
    assert.equal(response.status(), 303);
  });
  await page.goto(url('/channels'), { timeout: 60000 });
  const workspace = page.getByTestId('octop-channels-workspace');
  await workspace.waitFor({ timeout: 60000 });
  const read = () => page.evaluate(async endpoint => {
    const response = await fetch(endpoint); if (!response.ok) throw Error('CHANNEL_READ_FAILED');
    return response.json();
  }, url('/api/channels'));
  const inventory = await read(), selected = [];
  const bindingSnapshot = value => value.chats.map(chat => [chat.id, chat.bindingRevision, chat.binding]);
  const zh = JSON.parse(await readFile(new URL('../../../renderer/src/i18n/locales/zh-CN/connectivity.json', import.meta.url), 'utf8'));
  const en = JSON.parse(await readFile(new URL('../../../renderer/src/i18n/locales/en/connectivity.json', import.meta.url), 'utf8'));
  const label = key => new RegExp(`^(?:${[zh, en].map(locale => key.split('.').reduce((value, part) => value[part], locale)).join('|')})$`);
  for (const platform of platforms) {
    const connection = inventory.connections.find(row => row.platform === platform && row.enabled && row.hasCredential);
    assert.ok(connection && connection.state === 'connected', `${platform} existing connection must be healthy`);
    const chats = inventory.chats.filter(chat => chat.connectionId === connection.id);
    assert.equal(chats.length, 1, 'Live sends require one unambiguous existing recipient');
    const card = workspace.locator('[data-testid="channel-connection-instance"]').filter({ has: page.locator(`details p`, { hasText: connection.id }) });
    await card.getByRole('button', { name: label('chatTasks.observedChats') }).click();
    const list = card.getByTestId('channel-external-chats'); await list.waitFor();
    assert.equal(await list.locator('li').count(), 1);
    selected.push({ platform, chat: chats[0] });
  }
  await page.screenshot({ path: context.pathInArtifacts('channel-cards-and-existing-chats.png'), fullPage: true });
  assert.deepEqual(actions, [], 'Inspecting connection cards must not change credentials or bindings');
  assert.deepEqual(errors, []);
  assert.deepEqual(bindingSnapshot(await read()), bindingSnapshot(inventory));
  const journal = await open(process.env.KCODER_E2E_CHANNEL_SEND_RECEIPT, 'wx', 0o600);
  context.addCleanup('close durable deployed-send journal', () => journal.close());
  const record = async value => { await journal.writeFile(JSON.stringify(value) + '\n'); await journal.sync(); };
  const marker = `KCoder 开发 Web 通道验证 ${randomUUID().slice(0, 8)}`, results = [];
  for (const { platform, chat } of selected) {
    const deliveryId = `web-sdk-check-${platform}-${randomUUID()}`;
    await record({ platform, marker, deliveryId, phase: 'recorded-before-send' });
    const result = await page.evaluate(async ({ endpoint, body }) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
      return { status: response.status, value: await response.json() };
    }, { endpoint: url('/api/channels'), body: { action: 'send', chatId: chat.id, deliveryId, text: marker } });
    const proof = { platform, marker, deliveryId, status: result.status, state: result.value.state,
      code: result.value.code ?? result.value.receipt?.code };
    results.push(proof); await record(proof);
  }
  await context.writeArtifactJson('deployed-sdk-send.json', { results, errors, channelActions: actions,
    existingBindingsUnchanged: JSON.stringify(bindingSnapshot(await read())) === JSON.stringify(bindingSnapshot(inventory)),
    bindingPickerChecked: false, realInboundTested: false, modelCalls: 0 });
  assert.deepEqual(actions, platforms.map(() => 'send'));
  assert.deepEqual(bindingSnapshot(await read()), bindingSnapshot(inventory));
  assert.deepEqual(errors, []);
  assert.ok(results.every(row => row.status === 200 && row.state === 'accepted'), 'Inspect durable receipts; never replay an unknown send');
});
