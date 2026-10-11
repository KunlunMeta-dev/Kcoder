import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// QA: drop a real committed save reply at the transport boundary. No RPC result
// or model decision is fabricated. Verify recovery and cleanup in an owned profile.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'provider-save-outcome-recovery', tier: 'full-integration',
  modelPolicy: 'model-independent save transport failure and configuration recovery; loopback HTTP only',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'save-outcome' });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const home = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', { providers: {} });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local', label: 'Save outcome', transport: 'local',
    command: resolve(repoRoot, 'target/debug/kcoder'), workspace,
  }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, env: { KCODER_CONFIG_DIR: home } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  let dropped = false;
  let saveRequests = 0;
  await page.routeWebSocket('**/rpc?**', route => {
    const upstream = route.connectToServer();
    let saveId;
    route.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.method === 'runtime.providers.upsert') {
        saveRequests += 1;
        if (!dropped) saveId = frame.id;
      }
      upstream.send(message);
    });
    upstream.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (!dropped && saveId !== undefined && frame.id === saveId && frame.result?.profiles) {
        dropped = true;
        route.close({ code: 1011, reason: 'fixture transport interruption' });
        upstream.close();
        return;
      }
      route.send(message);
    });
  });
  try {
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
    await page.goto(`${gateway.baseUrl}/settings/personal/models`);
    await page.getByTestId('provider-form').waitFor();
    await page.getByTestId('provider-template').selectOption('local-openai');
    await page.getByTestId('provider-endpoint').fill(model.baseUrl);
    await page.getByTestId('provider-model').fill('outcome-fixture');
    await page.getByTestId('provider-save').click();
    await page.getByTestId('provider-save-recovery').filter({ hasText: '尚不能确认' }).waitFor({ timeout: 30000 });
    assert.equal(dropped, true);
    assert.equal(await page.getByTestId('provider-save').isDisabled(), true);
    assert.equal(await page.getByTestId('provider-model').inputValue(), 'outcome-fixture');
    await page.getByTestId('provider-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(saveRequests, 1);
    const saved = JSON.parse(await readFile(context.pathInState('profile/settings.json'), 'utf8'));
    assert.ok(saved.providers['local-openai'], 'the dropped reply must follow an actual commit');
    await page.getByTestId('provider-refresh').click();
    await page.getByTestId('provider-save-recovery').filter({ hasText: '已读取' }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId('provider-save').isDisabled(), true);
    const row = page.locator('[data-testid^="provider-edit-local-openai"]');
    assert.equal(await row.count(), 1);
    await row.click();
    assert.equal(await page.getByTestId('provider-save').isEnabled(), true);
    assert.equal(await page.getByTestId('provider-apiKey').inputValue(), '');
    await page.getByTestId('provider-save').click();
    await waitFor(async () => (await page.locator('[role="status"]').allTextContents()).some(text => text.includes('下一轮')), 30000, 'reviewed model saved successfully');
    assert.equal(saveRequests, 2);
    assert.equal(await row.count(), 1);
    assert.equal(model.requests.length, 2, 'each explicit save performs one real probe');
    return { committedReplyDropped: true, blockedBlindRetry: true, explicitReviewRecovered: true, saves: saveRequests };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    throw error;
  } finally { await page.close(); }
});
