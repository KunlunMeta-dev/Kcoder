import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { startRelay } from '../../../../kcoder-relay/src/server.mjs';
import { hashAdminPassword } from '../../../../kcoder-relay/src/admin-auth.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { runE2E } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, {
  testId: 'relay-administrator-one-use-activation', tier: 'smoke',
  modelPolicy: 'model-independent real Relay HTTP and browser UI; HTTPS origin simulated by owned browser routing, no public deployment or phone acceptance',
}, async context => {
  const password = randomBytes(24).toString('base64url'); context.registerSecret(password);
  const relay = await startRelay({ gateways: [], sharedHosts: ['relay.example'],
    registrationStoreFile: context.pathInState('registration.json'), adminPasswordHash: await hashAdminPassword(password),
    proxyPort: 0, controlPort: 0 });
  context.registerPort('relay-control', relay.controlPort); context.registerPort('relay-proxy', relay.proxyPort);
  let browser;
  try {
    browser = await startChromium(context, { label: 'relay-administration-browser' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // Browser origin/Cookie behavior is exercised without using public DNS or TLS services.
    await page.route('https://relay.example/**', async route => {
      const incoming = route.request();
      const headers = await incoming.allHeaders();
      const data = await new Promise((resolve, reject) => {
        const call = request({ hostname: '127.0.0.1', port: relay.controlPort,
          method: incoming.method(), path: new URL(incoming.url()).pathname,
          headers: { ...headers, host: 'relay.example' } }, response => {
          const chunks = []; response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks),
            headers: Object.fromEntries(Object.entries(response.headers)
              .filter(([key]) => !['connection', 'transfer-encoding', 'content-length', 'keep-alive'].includes(key))
              .map(([key, value]) => [key, String(value)])) }));
        });
        call.once('error', reject); call.end(incoming.postDataBuffer());
      });
      await route.fulfill(data);
    });
    await page.goto('https://relay.example/_relay/admin/');
    await page.getByLabel('账号').fill('admin'); await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('heading', { name: '生成一次性激活码' }).waitFor();
    await page.getByLabel('设备备注').fill('Browser acceptance computer');
    await page.getByRole('button', { name: '生成激活链接' }).click();
    const link = page.getByLabel('一次性激活链接'); await link.waitFor();
    const activationLink = await link.inputValue(); const code = new URLSearchParams(new URL(activationLink).hash.slice(1)).get('code');
    context.registerSecret(code); assert.equal(code.length, 43);
    await page.locator('.row').filter({ hasText: 'Browser acceptance computer' }).waitFor();
    for (const [width, colorScheme] of [[1280, 'light'], [390, 'light'], [320, 'dark']]) {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'dashboard must fit its viewport');
      await page.screenshot({ path: context.pathInArtifacts(`relay-admin-${width}-${colorScheme}.png`), fullPage: true, mask: [link] });
    }
    await page.goto(activationLink); await page.getByRole('heading', { name: '启用桌面中继' }).waitFor();
    await page.getByLabel('桌面激活链接').waitFor(); assert.equal(new URL(page.url()).hash, '', 'activation proof is removed from browser history');
    await page.screenshot({ path: context.pathInArtifacts('relay-activation-320-dark.png'), fullPage: true,
      mask: [page.getByLabel('一次性激活码'), page.getByLabel('桌面激活链接')] });
    await page.goto('https://relay.example/_relay/admin/');
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByText('已撤销', { exact: true }).waitFor();
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByRole('heading', { name: '管理员登录' }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
    return { login: true, createCode: true, activationPage: true, revokeCode: true, logout: true,
      layoutWidths: [1280, 390, 320], themes: ['light', 'dark'], publicTlsAndPhone: 'not tested' };
  } finally { await browser?.close(); await relay.close(); }
});
