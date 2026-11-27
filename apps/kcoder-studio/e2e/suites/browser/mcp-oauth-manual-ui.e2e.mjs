import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOAuthMcpFixture } from '../../harness/oauth-mcp.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// QA: isolated profile and real OAuth/MCP target; cancel one browser flow, authorize the next,
// observe the panel update, sign out, and let RunContext clean browser/Gateway/target resources.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'mcp-management-manual-client-authorization',
  tier: 'full-integration',
  modelPolicy: 'model-independent real browser/Gateway/app-server/OAuth fixture; no model requests',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'oauth-ui' });
  const secret = randomBytes(24).toString('hex');
  context.registerSecret(secret);
  const fixture = await startOAuthMcpFixture(context, {
    manualApproval: true, manualClient: { id: 'manual-ui-client', secret, method: 'client_secret_basic' },
  });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {
    providers: {}, mcp_servers: [{ name: 'Browser OAuth MCP', transport: 'http', url: fixture.root + '/mcp' }],
  });
  const binary = resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.jsonc', [{
    id: 'local', label: 'OAuth UI fixture', runtime: 'kcoder', transport: 'local', command: binary, workspace,
  }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(gateway.baseUrl + '/plugins/manage', { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.getByTestId('kcoder-plugin-management').waitFor({ timeout: 60000 });
    await page.getByTestId('kcoder-plugin-tab-mcp').click();
    const panel = page.getByTestId('kcoder-mcp-management');
    await panel.getByText('Browser OAuth MCP', { exact: true }).waitFor();
    const authorize = () => panel.getByRole('button', { name: /授权登录|^Authorize$/ });
    await authorize().click();
    await panel.getByRole('alert').waitFor();
    const openAuthorization = async () => {
      await panel.locator('summary').click();
      const form = panel.locator('form');
      await form.getByLabel(/客户端 ID|Client ID/).fill('manual-ui-client');
      await form.getByLabel(/客户端认证方式|Client authentication/).selectOption('client_secret_basic');
      await form.getByLabel(/客户端密钥|Client secret/).fill(secret);
      const opened = page.context().waitForEvent('page');
      await form.getByRole('button', { name: /授权登录|^Authorize$/ }).click();
      const popup = await opened;
      await popup.locator('#approve').waitFor({ timeout: 15000 });
      assert.equal(new URL(popup.url()).searchParams.get('redirect_uri'), gateway.baseUrl + '/oauth/mcp/callback');
      return popup;
    };
    const cancelled = await openAuthorization();
    await panel.getByRole('button', { name: /取消授权|Cancel authorization/ }).click();
    await authorize().waitFor();
    assert.equal(fixture.events.filter(event => event === 'token-exchange').length, 0);
    await cancelled.close();
    const approved = await openAuthorization();
    await approved.locator('#approve').click();
    await approved.getByText('授权已保存，请返回 KCoder Studio 使用该服务。', { exact: true }).waitFor();
    await panel.getByRole('button', { name: /注销授权|Sign out/ }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: context.pathInArtifacts('authorized.png') });
    assert.equal(fixture.events.filter(event => event === 'token-exchange').length, 1);
    await panel.getByRole('button', { name: /注销授权|Sign out/ }).click();
    await authorize().waitFor();
    await approved.close();
    await writeFile(resolve(profile, 'settings.json'), JSON.stringify({ providers: {}, mcp_servers: [] }), { mode: 0o600 });
    await page.getByTestId('kcoder-plugins-refresh').click();
    await panel.getByText('Browser OAuth MCP', { exact: true }).waitFor({ state: 'detached' });
    await context.writeArtifactJson('ui-results.json', { cancelled: true, authorized: true, loggedOut: true, refreshedConfiguration: true, manualClient: true, noDynamicRegistration: !fixture.events.includes('register'), events: fixture.events });
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    await context.writeArtifactJson('failure-ui.json', { text: await page.locator('body').innerText().catch(() => '') });
    throw error;
  }
});
