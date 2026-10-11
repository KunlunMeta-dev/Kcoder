import assert from 'node:assert/strict';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runE2E } from '../../harness/run-context.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'gateway-access-links-and-weekly-mobile-credential-rotation',
  tier: 'smoke',
  modelPolicy: 'model-independent real Gateway authentication, mobile pairing, QR UI, and device revocation',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  await context.writeStateJson('kcoder-home/settings.json', { providers: {} });
  const gateway = await startGateway(context, { workspace, auth: true, label: 'mobile-pairing-settings-gateway' });
  const browser = await startChromium(context, { label: 'mobile-pairing-settings-browser' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const diagnostics = [];
  page.on('pageerror', error => diagnostics.push(error.message));
  page.on('console', message => {
    if (
      message.type() === 'error' &&
      !/40[13] \((Unauthorized|Forbidden)\)/.test(message.text())
    ) diagnostics.push(message.text());
  });
  try {
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith('/login')),
      page.locator('button[type="submit"]').click(),
    ]);
    await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible' });
    await page.goto(`${gateway.baseUrl}/settings/access-links`);
    await page.getByTestId('mobile-pairing-qr').waitFor({ state: 'visible' });
    await page.getByTestId('mobile-web-address').fill('https://mobile-web.example');
    await page.getByTestId('mobile-web-pairing-qr').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('settings-nav-access-links').getAttribute('aria-current'), 'page');
    assert.equal(await page.getByTestId('mobile-gateway-address').inputValue(), gateway.baseUrl);

    const initial = await page.evaluate(async () => (await fetch('/api/mobile/pairing', { cache: 'no-store' })).json());
    context.registerSecret(initial.token);
    assert.match(initial.token, /^[a-f0-9]{64}$/);
    assert.notEqual(initial.token, gateway.authToken);
    assert.equal(initial.expiresAt % (7 * 24 * 60 * 60_000), 0);
    assert.equal(await page.locator('[data-testid="mobile-pairing-qr"] svg').count(), 1);
    assert.equal(await page.locator('[data-testid="mobile-web-pairing-qr"] svg').count(), 1);
    assert.equal(new URL(page.url()).searchParams.has('token'), false, 'pairing secret must not enter browser history');

    const legacy = await page.evaluate(async token => fetch('/api/mobile/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    }).then(response => response.status), initial.token);
    assert.equal(legacy, 401, 'the QR credential only creates durable device grants');
    const paired = await page.evaluate(async token => {
      const response = await fetch('/api/mobile/session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, durableDeviceAuthorization: true, deviceLabel: 'E2E phone' }),
      });
      return { status: response.status, grant: await response.json() };
    }, initial.token);
    context.registerSecret(paired.grant.accessToken);
    context.registerSecret(paired.grant.refreshToken);
    assert.equal(paired.status, 200);
    await page.reload();
    await page.getByText('E2E phone', { exact: true }).waitFor({ state: 'visible' });

    const adminOnly = await page.evaluate(async accessToken => fetch('/api/mobile/pairing', {
      headers: { authorization: `Bearer ${accessToken}` }, cache: 'no-store',
    }).then(response => response.status), paired.grant.accessToken);
    assert.equal(adminOnly, 403, 'paired phones cannot retrieve a code that authorizes other phones');

    await page.getByTestId('mobile-pairing-rotate').click();
    const rotated = await page.evaluate(async () => (await fetch('/api/mobile/pairing', { cache: 'no-store' })).json());
    context.registerSecret(rotated.token);
    assert.notEqual(rotated.token, initial.token);
    const oldCodeStatus = await page.evaluate(async token => fetch('/api/mobile/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, durableDeviceAuthorization: true }),
    }).then(response => response.status), initial.token);
    assert.equal(oldCodeStatus, 401, 'rotating the QR immediately rejects the old code');
    assert.equal(await page.getByText('E2E phone', { exact: true }).count(), 1, 'code rotation preserves paired devices');

    page.once('dialog', dialog => dialog.accept());
    await page.getByTestId(`mobile-paired-device-revoke-${paired.grant.deviceId}`).click();
    await page.getByText('还没有配对手机。').waitFor({ state: 'visible' });
    const revokedRefresh = await page.evaluate(async grant => fetch('/api/mobile/session/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: grant.refreshToken, rotationId: 'e2e-revocation-check-01' }),
    }).then(response => response.status), paired.grant);
    assert.equal(revokedRefresh, 401, 'revoked device refresh credentials stop working');

    const gatewayAddress = page.getByTestId('mobile-gateway-address');
    await gatewayAddress.fill('javascript:alert(1)');
    await page.getByText('请输入有效的 Gateway 地址以生成二维码。').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('mobile-pairing-qr').count(), 0);
    assert.deepEqual(diagnostics, []);
    return { settingsRoute: true, mobileAppAndWebQrShown: true, codeRotation: true, pairedDeviceSurvivedRotation: true, revokeRejectedRefresh: true, invalidAddressBlocked: true };
  } finally {
    await page.close();
    await browser.close();
  }
});
