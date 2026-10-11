import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOAuthMcpFixture } from '../../harness/oauth-mcp.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// QA: isolated profile and real OAuth/MCP target; cancel one browser flow, authorize the next,
// observe the panel update, sign out, and let RunContext clean browser/Gateway/target resources.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'mcp-management-browser-authorization-cancel-and-logout',
  tier: 'full-integration',
  modelPolicy: 'model-independent real browser/Gateway/app-server/OAuth fixture; no model requests',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'oauth-ui' });
  const fixture = await startOAuthMcpFixture(context, { manualApproval: true });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {
    providers: {}, mcp_servers: [],
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
    await panel.getByRole('button', { name: /添加 MCP|Add MCP/ }).click();
    const install = page.getByTestId('kcoder-mcp-install-form');
    await install.getByLabel(/服务名称|Server name/).fill('Browser OAuth MCP');
    await install.getByLabel(/服务地址|Server URL/).fill(fixture.root + '/mcp');
    await install.getByRole('button', { name: /保存 MCP|Save MCP/ }).click();
    await install.waitFor({ state: 'detached' });
    await panel.getByText('Browser OAuth MCP', { exact: true }).waitFor();
    const saved = JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8'));
    assert.deepEqual(saved.providers, {});
    assert.equal(saved.mcp_servers[0].name, 'Browser OAuth MCP');
    const cookies = await page.context().cookies(gateway.baseUrl);
    const cookie = cookies.map(item => item.name + '=' + item.value).join('; ');
    context.registerSecret(cookie);
    const rpcToken = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content');
    context.registerSecret(rpcToken);
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', rpcToken), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close MCP UI catalog RPC', () => rpc.close());
    await initializeRpc(rpc, 'mcp-ui-catalog');

    const authorize = () => panel.getByRole('button', { name: /授权登录|^Authorize$/ });
    const openAuthorization = async () => {
      const opened = page.context().waitForEvent('page');
      await authorize().click();
      const popup = await opened;
      await popup.locator('#approve').waitFor({ timeout: 15000 });
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
    const ready = await rpc.request('thread/start', {});
    assert.ok(JSON.stringify(await rpc.request('tools/catalog', { threadId: ready.thread.id })).includes('oauth_probe'));
    await rpc.request('thread/delete', { threadId: ready.thread.id });

    await panel.getByRole('button', { name: /注销授权|Sign out/ }).click();
    await authorize().waitFor();
    await approved.close();
    await panel.getByTestId('kcoder-mcp-remove').click();
    await panel.getByRole('alertdialog').getByRole('button', { name: /^取消$|^Cancel$/ }).click();
    await panel.getByText('Browser OAuth MCP', { exact: true }).waitFor();
    await panel.getByTestId('kcoder-mcp-remove').click();
    await panel.getByRole('alertdialog').getByRole('button', { name: /^删除$|^Remove$/ }).click();
    await panel.getByText('Browser OAuth MCP', { exact: true }).waitFor({ state: 'detached' });
    const removed = JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8'));
    assert.deepEqual(removed.providers, {});
    assert.deepEqual(removed.mcp_servers, []);
    const withoutMcp = await rpc.request('thread/start', {});
    assert.ok(!JSON.stringify(await rpc.request('tools/catalog', { threadId: withoutMcp.thread.id })).includes('oauth_probe'));
    await rpc.request('thread/delete', { threadId: withoutMcp.thread.id });
    await page.getByTestId('kcoder-plugins-refresh').click();
    await context.writeArtifactJson('ui-results.json', { cancelled: true, authorized: true, loggedOut: true, refreshedConfiguration: true, installedThroughUi: true, removedThroughUi: true, newSessionToolsVerified: true, events: fixture.events });
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    await context.writeArtifactJson('failure-ui.json', { text: await page.locator('body').innerText().catch(() => '') });
    throw error;
  }
});
