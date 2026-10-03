import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { appRoot, repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Deterministic model frames exercise acceptance and recovery, not model quality.
await runE2E(import.meta.url, { testId: 'mobile-restore-overflow-requires-authoritative-reload', tier: 'full-integration',
  modelPolicy: 'model-independent real Mobile UI and Gateway; genuine streamed notifications exceed bounded restore buffer' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyChunks: ['MOBILE_BOUND_BEGIN_', ...Array(620).fill('x'), '_MOBILE_BOUND_END'], textOnlyChunkDelayMs: 1 });
  await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      authentication: { mode: 'none' }, default_model: 'fixture', no_proxy: true,
      context_window_tokens: 1000000, max_output_tokens: 1024, output_headroom_tokens: 1024 } } });
  const gateway = await startGateway(context, { workspace, kcoderBin: resolve(repoRoot, 'target/debug/kcoder'),
    env: { KCODER_CONFIG_DIR: context.pathInState('profile'), KCODER_STUDIO_WEB_ROOT: resolve(appRoot, 'mobile/dist') } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close receipt seed', () => rpc.close());
  await initializeRpc(rpc, 'mobile-receipt-seed');
  const { thread } = await rpc.request('thread/start');
  const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'SEED' }] });
  await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.id, 30000, 'seed completion');
  await rpc.request('thread/metadata/update', { threadId: thread.id, title: 'Mobile receipt fixture' });
  rpc.close();
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let injected = false, deltas = 0, released = false;
  await page.routeWebSocket('**/rpc*', socket => {
    const upstream = socket.connectToServer();
    const reads = new Set();
    let held;
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (['thread/read', 'thread/read/indexed'].includes(message.method)) reads.add(message.id);
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (!injected && reads.has(message.id) && message.result) {
        injected = true; held = raw;
        // Same connection owns this deliberate test turn. All streamed frames
        // below are produced by the real app-server, not synthetic UI events.
        upstream.send(JSON.stringify({ jsonrpc: '2.0', id: 900001, method: 'turn/start',
          params: { threadId: thread.id, input: [{ type: 'text', text: 'MOBILE_OVERFLOW' }] } }));
        return;
      }
      if (held && message.method === 'item/delta') deltas++;
      socket.send(raw);
      if (held && message.method === 'turn/completed') {
        released = true; socket.send(held); held = null;
      }
    });
  });
  try {
    await page.goto(gateway.baseUrl);
    await page.getByTestId('welcome-direct-connection').click();
    await page.getByTestId('gateway-endpoint').fill(gateway.baseUrl);
    await page.getByTestId('gateway-connect').click();
    await page.getByTestId('new-workspace').waitFor({ timeout: 30000 });
    await page.getByTestId('sessions').click();
    await page.getByTestId('session-search').fill('Mobile receipt fixture');
    await page.getByTestId(`session-${thread.id}`).click();
    await page.getByText('会话更新超过缓存上限，请重新连接以读取完整记录。', { exact: true }).waitFor({ timeout: 30000 });
    assert.ok(deltas > 512); assert.equal(released, true);
    await page.screenshot({ path: context.pathInArtifacts('mobile-buffer-reset.png') });
    await page.reload();
    const expected = 'MOBILE_BOUND_BEGIN_' + 'x'.repeat(620) + '_MOBILE_BOUND_END';
    await page.getByText(expected, { exact: true }).nth(1).waitFor({ timeout: 30000 });
    assert.equal(await page.getByText(expected, { exact: true }).count(), 2);
    assert.equal(model.requests.length, 2);
    assert.equal(await page.getByTestId('message-user').filter({ hasText: 'MOBILE_OVERFLOW' }).count(), 1);
    return { deltas, providerRequests: model.requests.length, resetRequired: true, authoritativeReload: true };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {}); throw error;
  } finally { await page.close(); }
});
