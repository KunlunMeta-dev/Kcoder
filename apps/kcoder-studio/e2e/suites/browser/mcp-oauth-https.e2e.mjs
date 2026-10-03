import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startHttpsGatewayProxy } from '../../harness/https-gateway-proxy.mjs';
import { startOAuthMcpFixture } from '../../harness/oauth-mcp.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'https-gateway-browser-oauth-callback',
  tier: 'full-integration',
  modelPolicy: 'model-independent real TLS proxy/browser/Gateway/app-server with owned OAuth fixture; no model requests',
}, async context => {
  const proxy = await startHttpsGatewayProxy(context);
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'https-oauth' });
  const fixture = await startOAuthMcpFixture(context, { manualApproval: true });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {
    providers: {}, mcp_servers: [{ name: 'HTTPS OAuth MCP', transport: 'http', url: fixture.root + '/mcp' }],
  });
  const binary = resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.jsonc', [{ id: 'local', label: 'HTTPS fixture', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true,
    env: { KCODER_CONFIG_DIR: profile, KCODER_STUDIO_PUBLIC_ORIGINS: proxy.origin } });
  proxy.setTarget(gateway.baseUrl);
  const chromium = await startChromium(context);
  // Trust only this isolated browser context's self-signed fixture, without changing system trust.
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  try {
    await page.goto(proxy.origin + '/plugins/manage', { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.getByTestId('kcoder-plugin-tab-mcp').waitFor({ timeout: 60000 });
    await page.getByTestId('kcoder-plugin-tab-mcp').click();
    const panel = page.getByTestId('kcoder-mcp-management');
    const opened = page.context().waitForEvent('page');
    await panel.getByRole('button', { name: /授权登录|^Authorize$/ }).click();
    const popup = await opened;
    await popup.locator('#approve').waitFor({ timeout: 15000 });
    assert.equal(new URL(new URL(popup.url()).searchParams.get('redirect_uri')).origin, proxy.origin);
    await popup.locator('#approve').click();
    await popup.getByText('授权已保存，请返回 KCoder Studio 使用该服务。', { exact: true }).waitFor();
    assert.equal(new URL(popup.url()).origin, proxy.origin);
    await panel.getByRole('button', { name: /注销授权|Sign out/ }).waitFor({ timeout: 15000 });
    assert.equal(proxy.callbackRequests.length, 1);
    assert.equal(proxy.callbackRequests[0].sessionHeaderPresent, false);
    assert.equal(proxy.callbackRequests[0].host, new URL(proxy.origin).host);
    await page.screenshot({ path: context.pathInArtifacts('https-authorized.png') });
    await panel.getByRole('button', { name: /注销授权|Sign out/ }).click();
    await panel.getByRole('button', { name: /授权登录|^Authorize$/ }).waitFor();
    await popup.close();
    await context.writeArtifactJson('https-oauth-results.json', {
      tlsProxy: true, publicOriginCallback: true, authorized: true, loggedOut: true,
      callbackRequests: proxy.callbackRequests,
    });
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    await context.writeArtifactJson('failure-ui.json', { text: await page.locator('body').innerText().catch(() => '') });
    throw error;
  }
});
