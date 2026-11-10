import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, openRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { captureWebSearchBrowserEvidence } from '../../harness/web-search-browser-capture.mjs';

if (process.env.KCODER_E2E_SEARCH_UI_CAPTURE === '1') {
  await captureWebSearchBrowserEvidence(import.meta.url);
} else {
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'existing-tools-page-search-status-probe-and-new-session-selection', tier: 'full-integration',
  modelPolicy: 'Model-independent actual browser/Gateway/app-server tool settings, status and explicit probe receipt. Empty search source policy prevents external queries. No fixture search results, model or native-host claim.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'search-tools' });
  await context.writeStateJson('config/settings.json', { permission_mode: 'bypass', web: { search: { providers: [] } } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Search tools target', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, serversFile,
    serversStore: context.pathInState('servers-store.json'),
    env: { KCODER_CONFIG_DIR: context.pathInState('config') },
  });
  const token = await waitForGatewayRpcToken(context, gateway);
  const reader = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close search tools reader', () => closeRpcAndWait(reader));
  await reader.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'search-management-e2e', version: '1' }, capabilities: { experimental: { toolSelectionsV1: true } } });
  const before = await reader.request('settings/tools/selection/read');
  const browser = await startChromium(context, { label: 'search-tools-browser' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const methods = [], pageErrors = [];
  let statusReceipt, probeReceipt;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      try { const frame = JSON.parse(String(payload)); if (frame.method?.startsWith('webSearch/')) methods.push(frame.method); } catch { /* Only public method names are recorded. */ }
    });
    socket.on('framereceived', ({ payload }) => {
      try {
        const result = JSON.parse(String(payload)).result;
        if (Array.isArray(result?.candidates) && typeof result.webSearchVisible === 'boolean')
          statusReceipt = { targetId: result.targetId, revision: result.revision, candidates: result.candidates };
        if (typeof result?.requestId === 'string' && ['running', 'completed', 'cancelled', 'unknown'].includes(result.state))
          probeReceipt = { state: result.state, status: result.response?.status, attempts: result.response?.attempts };
      } catch { /* Search diagnostics retain only typed, query-free execution facts. */ }
    });
  });
  try {
    await page.goto(`${gateway.baseUrl}/settings/tools`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('tool-selections-target')).toHaveValue('local', { timeout: 30_000 });
    await page.getByTestId('tool-selections-search').fill('WebSearch');
    const toggle = page.getByTestId('tool-selection-WebSearch');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const detail = page.getByTestId('web-search-details');
    await detail.getByRole('button').first().click();
    await expect(detail).toContainText(/目标来源策略当前未允许搜索来源|target source policy currently allows no search sources/);
    await expect.poll(() => statusReceipt?.candidates).toEqual([]);
    assert.ok(methods.includes('webSearch/status/read'));
    assert.equal(methods.includes('webSearch/probe/start'), false, 'status cannot trigger external search');
    await detail.getByRole('button', { name: /检查搜索|Check search/ }).click();
    await expect(detail).toContainText(/暂时无法检查搜索|Search could not be checked/, { timeout: 10_000 });
    assert.equal(methods.filter(method => method === 'webSearch/probe/start').length, 1);
    assert.ok(methods.includes('webSearch/probe/read'));
    await expect.poll(() => probeReceipt?.state).toBe('completed');
    assert.equal(probeReceipt.status, 'failed');
    assert.deepEqual(probeReceipt.attempts, [], 'the actual native router must not dispatch an external request');
    await page.screenshot({ path: context.pathInArtifacts('existing-tools-search-status.png') });
    await toggle.click();
    await expect.poll(async () => (await reader.request('settings/tools/selection/read')).modes.find(mode => mode.mode === 'kcoder').allowedTools.includes('WebSearch')).toBe(false);
    const after = await reader.request('settings/tools/selection/read');
    assert.deepEqual(after.modes.find(mode => mode.mode === 'kworker').allowedTools, before.modes.find(mode => mode.mode === 'kworker').allowedTools);
    assert.equal(after.modes.find(mode => mode.mode === 'kcoder').allowedTools.includes('WebFetch'), before.modes.find(mode => mode.mode === 'kcoder').allowedTools.includes('WebFetch'));
    await page.getByTestId('tool-selections-mode-kworker').click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    assert.deepEqual(pageErrors, []);
    return { existingToolsPage: true, targetDefaultLocal: true, statusDoesNotProbe: true, explicitProbeReceipt: true,
      independentModeSelections: true, webFetchPreserved: true, successScreenshotReason: 'critical search tool details linked to actual target RPC' };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('search-tools-failed.png') }).catch(() => {});
    await context.writeArtifactJson('search-tools-failure.json', { methods, pageErrors, message: String(error), statusReceipt, probeReceipt, body: (await page.locator('body').innerText()).slice(0, 12000) });
    throw error;
  }
});
}
