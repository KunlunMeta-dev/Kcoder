import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

const names = ['ListSessions', 'SendSessionMessage', 'GetSessionMessageReceipt', 'ListSessionMessageReceipts'];
const disabled = ['ocr', 'skill_manage', 'skill_curator', 'skill_hub', 'CtxInspect', 'LocalMemoryRecall'];
const workerDefaults = ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput', 'TaskStop',
  'Config', 'Sleep', 'remember', 'memory_search', 'memory_get'];
const modes = ['kcoder', 'kworker'];
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'studio-session-tools-defaults-and-new-task-selection', tier: 'full-integration',
  modelPolicy: 'Read actual tool selections and thread catalogs through the Gateway. No turns or model calls.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'session-tools' });
  const provider = await startApprovalModelFixture(context);
  await context.writeStateJson('config/settings.json', {
    active_provider: 'LocalFixture', model: 'metadata', max_retries: 0,
    providers: { LocalFixture: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: provider.baseUrl,
      default_model: 'metadata', discover_models: false, no_proxy: true,
      context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024, capabilities: { text: true, tools: true },
    } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Session tools', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, serversFile,
    serversStore: context.pathInState('servers-store.json'), env: { KCODER_CONFIG_DIR: context.pathInState('config') } });
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
  context.addCleanup('close session tool client', () => closeRpcAndWait(rpc));
  await initializeRpc(rpc, 'session-tool-settings', { toolSelectionsV1: true, studioWorkModesV1: true });
  const read = () => rpc.request('settings/tools/selection/read');
  const defaults = await read();
  for (const name of names) {
    assert.ok(defaults.tools.some(row => row.name === name && row.available), 'Missing selectable tool: ' + name);
    for (const mode of modes) assert.ok(defaults.modes.find(row => row.mode === mode).allowedTools.includes(name));
  }
  for (const name of disabled) {
    const tool = defaults.tools.find(row => row.name === name);
    assert.equal(tool?.unavailableReason, 'disabled_by_configuration', name);
    assert.equal(tool.available, false);
    assert.ok(defaults.modes.every(mode => !mode.allowedTools.includes(name)), name);
  }
  const worker = defaults.modes.find(row => row.mode === 'kworker');
  for (const name of workerDefaults) assert.ok(worker.allowedTools.includes(name), name);
  const start = async mode => (await rpc.request('thread/start', { studioWorkMode: mode })).thread.id;
  const checkThread = async (threadId, mode, expected) => {
    const { tools } = await rpc.request('tools/catalog', { threadId, clientPresentation: { version: 1, studioWorkMode: mode } });
    assert.deepEqual(names.filter(name => tools.some(tool => tool.name === name)), expected);
    assert.ok(tools.every(tool => !disabled.includes(tool.name)));
    if (mode === 'kworker') for (const name of workerDefaults) assert.ok(tools.some(tool => tool.name === name), name);
  };
  const originalWorker = await start('kworker');
  await checkThread(originalWorker, 'kworker', names);

  const browser = await startChromium(context, { label: 'session-tool-settings' });
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  await page.goto(gateway.baseUrl + '/settings/tools', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('tool-selections-target')).toHaveValue('local', { timeout: 30_000 });
  const search = page.getByTestId('tool-selections-search');
  // Search by meaning and by invocation name; all rows still come from Native.
  await search.fill((await search.getAttribute('placeholder')) === '搜索工具' ? '跨会话' : 'cross-session');
  for (const mode of modes) {
    await page.getByTestId('tool-selections-mode-' + mode).click();
    for (const name of names) await expect(page.getByTestId('tool-selection-' + name)).toHaveAttribute('aria-checked', 'true');
  }
  await search.fill('SendSessionMessage');
  const send = page.getByTestId('tool-selection-SendSessionMessage');
  await send.click();
  await expect(send).toHaveAttribute('aria-checked', 'false');
  const updated = await read();
  assert.deepEqual(updated.modes.find(row => row.mode === 'kcoder').allowedTools, defaults.modes.find(row => row.mode === 'kcoder').allowedTools);
  assert.deepEqual(updated.modes.find(row => row.mode === 'kworker').allowedTools, defaults.modes.find(row => row.mode === 'kworker').allowedTools.filter(name => name !== 'SendSessionMessage'));
  await checkThread(await start('kcoder'), 'kcoder', names);
  await checkThread(await start('kworker'), 'kworker', names.filter(name => name !== 'SendSessionMessage'));
  await checkThread(originalWorker, 'kworker', names);
  await send.click();
  await expect(send).toHaveAttribute('aria-checked', 'true');
  await checkThread(await start('kworker'), 'kworker', names);
  assert.equal(provider.requests.length, 0);
  return { defaults: names, disabled, modeDefaults: Object.fromEntries(defaults.modes.map(mode => [mode.mode, mode.allowedTools])),
    settingsAndThreadCatalogsAgree: true, existingWorkerRetainedSelection: true, providerRequests: 0 };
});
