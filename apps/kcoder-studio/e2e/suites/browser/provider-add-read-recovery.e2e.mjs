import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'provider-add-after-settings-read-recovery',
  tier: 'full-integration',
  modelPolicy: 'Real renderer, Gateway and app-server; isolated settings and loopback provider only.',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', {
    instanceId: 'provider-add',
  });
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const settingsPath = await context.writeStateJson('profile/settings.json', { providers: {} });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local', label: 'Provider add fixture', transport: 'local', command: binary, workspace,
  }]);
  const gateway = await startGateway(context, {
    workspace, serversFile, kcoderBin: binary, auth: true, startTimeoutMs: 60000,
    env: { KCODER_CONFIG_DIR: context.pathInState('profile') },
  });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let failRead = true;
  let saves = 0;
  const readErrors = [];
  await page.routeWebSocket('**/rpc?**', route => {
    const upstream = route.connectToServer();
    const reads = new Set();
    route.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.method === 'runtime.providers.list') reads.add(frame.id);
      if (frame.method === 'runtime.providers.upsert') saves++;
      upstream.send(message);
    });
    upstream.onMessage(message => {
      const frame = JSON.parse(String(message));
      const isRead = reads.delete(frame.id);
      if (isRead && frame.error) {
        readErrors.push({
          code: frame.error.code,
          message: context.redactText(String(frame.error.message)),
        });
      }
      if (isRead && failRead) {
        route.send(JSON.stringify({
          jsonrpc: '2.0', id: frame.id,
          error: { code: -32000, message: 'Owned provider-read transport fault' },
        }));
      } else {
        route.send(message);
      }
    });
  });
  try {
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith('/login')),
      page.locator('button[type="submit"]').click(),
    ]);
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
    await page.goto(gateway.baseUrl + '/settings/personal/models');
    await page.getByRole('alert').filter({ hasText: '读取 API 配置失败' }).waitFor();
    assert.equal(await page.getByTestId('provider-new').isDisabled(), true);
    assert.equal(saves, 0);
    failRead = false;
    await page.getByTestId('provider-refresh').click();
    await waitFor(() => page.getByTestId('provider-new').isEnabled(), 30000, 'provider read recovered');
    await page.getByTestId('provider-new').click();
    await page.getByTestId('provider-template').selectOption('local-openai');
    await page.getByTestId('provider-id').fill('qa-added-provider');
    await page.getByTestId('provider-endpoint').fill(model.baseUrl);
    await page.getByTestId('provider-model').fill('qa-added-model');
    await page.getByTestId('provider-advanced-settings').locator('summary').click();
    await page.getByTestId('provider-contextWindowTokens').fill('128000');
    await page.getByTestId('provider-maxOutputTokens').fill('4096');
    await page.getByTestId('provider-save').click();
    const row = page.getByTestId('provider-edit-qa-added-provider::qa-added-model');
    await row.waitFor({ timeout: 30000 });
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.ok(settings.providers['qa-added-provider']);
    assert.equal(saves, 1);
    await page.reload();
    await row.waitFor({ timeout: 30000 });
    await page.screenshot({
      path: context.pathInArtifacts('added-model-after-reload.png'),
      mask: [page.locator('input[name="token"], input[type="password"]')],
    });
    return { readFailureBlocksAdd: true, refreshRecovers: true, saved: true, reloadPreserves: true };
  } catch (error) {
    await context.writeArtifactJson('provider-read-errors.json', { readErrors });
    await page.screenshot({
      path: context.pathInArtifacts('failure.png'),
      mask: [page.locator('input[name="token"], input[type="password"]')],
    }).catch(() => {});
    throw error;
  } finally {
    await page.close();
  }
});
