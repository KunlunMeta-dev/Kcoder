import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'worktree-settings-target-isolation-and-persistence', tier: 'full-integration',
  modelPolicy: 'model-independent real app-server settings writes and reads; no model turns or worktree deletion',
}, async context => {
  // QA: change target A, switch to B, save a different value, reload and verify both
  // independently via actual RPC. All profile state and workspace roots are run-owned.
  const first = await materializeWorkspace(context, 'minimal', { instanceId: 'settings-a' });
  const second = await materializeWorkspace(context, 'minimal', { instanceId: 'settings-b' });
  await context.writeStateJson('profile/settings.json', {});
  await context.writeStateJson('profile/credentials.json', {});
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Target A', transport: 'local', command: resolve(repoRoot, 'target/debug/kcoder'), workspace: first.path },
    { id: 'second', label: 'Target B', transport: 'local', command: resolve(repoRoot, 'target/debug/kcoder'), workspace: second.path },
  ]);
  const gateway = await startGateway(context, { workspace: first.path, serversFile,
    env: { KCODER_CONFIG_DIR: context.pathInState('profile') } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const readers = await Promise.all(['local', 'second'].map(async id => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, id, token));
    context.addCleanup(`close worktree ${id} reader`, () => rpc.close());
    await initializeRpc(rpc, `worktree-settings-${id}`);
    return rpc;
  }));
  const browser = await startChromium(context, { label: 'worktree-settings-browser' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${gateway.baseUrl}/settings/worktrees`, { waitUntil: 'domcontentloaded' });
    const selector = page.getByTestId('worktrees-device-select');
    await expect(selector).toBeVisible({ timeout: 30000 });
    await selector.selectOption('local');
    const count = page.getByTestId('worktrees-keep-count-input');
    await expect(count).toBeEnabled();
    await count.fill('7'); await count.press('Tab');
    await expect.poll(async () => (await readers[0].request('runtime.worktrees.settings.get')).keepCount).toBe(7);
    await selector.selectOption('second');
    await expect(count).toHaveValue('15');
    await count.fill('3'); await count.press('Tab');
    await expect.poll(async () => (await readers[1].request('runtime.worktrees.settings.get')).keepCount).toBe(3);
    assert.equal((await readers[0].request('runtime.worktrees.settings.get')).keepCount, 7);
    await page.reload();
    await selector.selectOption('local');
    await expect(count).toHaveValue('7');
    await selector.selectOption('second');
    await expect(count).toHaveValue('3');
    return { passed: true, targets: 2, independentSettings: true, reloadPreserved: true, destructiveOperations: 0 };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('worktree-settings-failed.png') }).catch(() => {});
    throw error;
  }
});
