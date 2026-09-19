import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'ordinary-send-no-global-scan-and-stable-sidebar', tier: 'pr-smoke',
  modelPolicy: 'model-independent request-count and DOM stability; local text fixture only',
}, async context => {
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: ({ userText }) => `Reply: ${userText}` });
  const settings = await context.writeStateJson('config/settings.json', {
    active_provider: 'fixture', providers: { fixture: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', context_window_tokens: 128000, output_headroom_tokens: 8192,
      max_output_tokens: 8192, no_proxy: true,
    } },
  });
  const servers = [];
  for (const id of ['a', 'b', 'c']) {
    const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: `sidebar-${id}` });
    servers.push({ id, label: `Server ${id}`, transport: 'local', command: binary, workspace, settingsFile: settings });
  }
  const serversFile = await context.writeStateJson('servers.json', servers);
  const gateway = await startGateway(context, { workspace: servers[0].workspace, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: resolve(settings, '..') } });
  const token = await waitForGatewayRpcToken(context, gateway);
  let selectedThread;
  for (const server of servers) {
    const rpc = await openRpc(gatewayRpcUrl(gateway, server.id, token));
    context.addCleanup(`close seed ${server.id}`, () => rpc.close());
    await initializeRpc(rpc, 'send-stability-seed');
    for (let index = 0; index < 5; index++) {
      const thread = (await rpc.request('thread/start', {})).thread.id;
      await rpc.request('thread/metadata/update', { threadId: thread, title: `${server.id}-${index}` });
      if (server.id === 'c' && index === 0) {
        selectedThread = thread;
        const turn = await rpc.request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'W2_INITIAL' }] });
        await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.turn.id, 15000, 'initial persisted turn');
      }
    }
    rpc.close();
  }
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 500 } });
  const scans = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try {
      const message = JSON.parse(String(payload));
      if (['thread/list', 'runtime.workspaces.list', 'runtime.worktrees.list'].includes(message.method))
        scans.push({ method: message.method, server: new URL(socket.url()).searchParams.get('server') });
    } catch { /* Ignore non-JSON frames. */ }
  }));
  let stage = 'initial-list';
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('desktop-sidebar').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="project-item-button"]').length >= 3);
    for (const button of await page.getByTestId('project-item-button').all()) {
      if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
    }
    const selected = page.getByTestId(`runtime-local-task-row-kcoder:c:${selectedThread}`);
    await selected.waitFor();
    await selected.click();
    await page.getByTestId('message-assistant').filter({ hasText: 'W2_INITIAL' }).waitFor();
    // Complete a deliberate baseline scan before observing ordinary send traffic.
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('local_executor_request', { method: 'runtime.tasks.list', params: {} }));
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const list = document.querySelector('[data-testid="sidebar-worklists-scroll"]');
      list.scrollTop = 0;
      const order = () => [...document.querySelectorAll('[data-testid="project-item-button"]')].map(node => node.closest('[data-sidebar-sortable-id]')?.getAttribute('data-sidebar-sortable-id'));
      const initialOrder = JSON.stringify(order());
      const probe = { scrollCalls: 0, scrollTop: list.scrollTop, orderChanges: [], rows: [...document.querySelectorAll('[data-testid^="runtime-local-task-row-"]')] };
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) {
        if (this.getAttribute('data-testid')?.startsWith('runtime-local-task-row-')) probe.scrollCalls++;
        return original.apply(this, args);
      };
      new MutationObserver(() => { const value = JSON.stringify(order()); if (value !== initialOrder && probe.orderChanges.length < 10) probe.orderChanges.push(value); }).observe(list, { subtree: true, childList: true });
      window.__sendStability = probe;
    });
    const baseline = scans.length;
    stage = 'ordinary-send';
    await page.getByTestId('chat-message-input').click();
    await page.keyboard.insertText('W2_FOLLOWUP');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('message-assistant').filter({ hasText: 'W2_FOLLOWUP' }).waitFor();
    await page.getByTestId('pause-response-button').waitFor({ state: 'hidden' });
    await page.waitForTimeout(250);
    const ordinaryScans = scans.slice(baseline);
    const ordinary = await page.evaluate(() => ({ scrollCalls: window.__sendStability.scrollCalls,
      scrollTop: document.querySelector('[data-testid="sidebar-worklists-scroll"]').scrollTop,
      expectedScrollTop: window.__sendStability.scrollTop, orderChanges: window.__sendStability.orderChanges,
      rowsPreserved: window.__sendStability.rows.every(node => node.isConnected) }));
    assert.deepEqual(ordinaryScans, []);
    assert.equal(ordinary.scrollCalls, 0);
    assert.equal(ordinary.scrollTop, ordinary.expectedScrollTop);
    assert.equal(ordinary.rowsPreserved, true);
    assert.deepEqual(ordinary.orderChanges, []);
    stage = 'new-conversation';
    const project = page.getByTestId('project-item').filter({ has: selected });
    await project.getByTestId('project-new-conversation-button').click();
    await page.getByTestId('chat-message-input').click();
    await page.keyboard.insertText('W2_NEW_CONVERSATION');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('message-assistant').filter({ hasText: 'W2_NEW_CONVERSATION' }).waitFor();
    await page.getByTestId('pause-response-button').waitFor({ state: 'hidden' });
    const created = await page.evaluate(() => ({ orderChanges: window.__sendStability.orderChanges,
      rowsPreserved: window.__sendStability.rows.filter(node => !node.getAttribute('data-testid').startsWith('runtime-local-task-row-kcoder:c:')).every(node => node.isConnected) }));
    assert.deepEqual(created.orderChanges, []);
    assert.equal(created.rowsPreserved, true);
    assert.ok(model.requests.length <= 3);
    await page.screenshot({ path: context.pathInArtifacts('sidebar-stable.png') });
    return { ordinaryScans, ordinary, created, providerRequests: model.requests.length, stage: 'complete' };
  } catch (error) {
    await context.writeArtifactJson('failure-state.json', { stage, scans, text: await page.locator('body').innerText() });
    await page.screenshot({ path: context.pathInArtifacts('failure.png') });
    throw error;
  } finally { await page.close(); }
});
