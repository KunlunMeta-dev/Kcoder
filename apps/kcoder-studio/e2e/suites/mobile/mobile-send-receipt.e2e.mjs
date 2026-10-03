import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { appRoot, repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Deterministic model frames exercise acceptance and recovery, not model quality.
await runE2E(import.meta.url, { testId: 'mobile-ordinary-send-readonly-receipt', tier: 'full-integration',
  modelPolicy: 'model-independent real Mobile UI and Gateway; corrupted acceptance response and withheld first receipt' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { textOnly: true });
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
  let starts = 0, receipts = 0, deletes = 0;
  await page.routeWebSocket('**/rpc*', socket => {
    const upstream = socket.connectToServer();
    const methods = new Map();
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.id !== undefined && message.method) methods.set(message.id, message.method);
      if (message.method === 'turn/start') { starts++; assert.ok(message.params.clientMessageId); }
      if (message.method === 'thread/delete') deletes++;
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      const message = JSON.parse(String(raw));
      const method = methods.get(message.id);
      if (method === 'turn/start' && message.result) {
        socket.send(JSON.stringify({ ...message, result: {} })); return;
      }
      if (method === 'turn/receipt/read' && message.result) {
        receipts++;
        if (receipts === 1) { socket.send(JSON.stringify({ ...message, result: { receipt: null } })); return; }
      }
      socket.send(raw);
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
    await page.getByTestId('message-input').fill('MOBILE_SEND_ONCE');
    await page.getByTestId('send-message').click();
    await page.getByTestId('runtime-reconcile-send').waitFor({ timeout: 30000 });
    await page.getByText('deterministic renderer response: MOBILE_SEND_ONCE', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(starts, 1); assert.equal(receipts, 1);
    await page.screenshot({ path: context.pathInArtifacts('mobile-send-unknown.png') });
    await page.getByTestId('runtime-reconcile-send').click();
    await page.getByTestId('runtime-reconcile-send').waitFor({ state: 'hidden' });
    assert.equal(starts, 1); assert.equal(receipts, 2); assert.equal(deletes, 0);
    assert.equal(model.requests.length, 2);
    assert.equal(await page.getByTestId('message-user').filter({ hasText: 'MOBILE_SEND_ONCE' }).count(), 1);
    await page.reload();
    await page.getByText('deterministic renderer response: MOBILE_SEND_ONCE', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId('message-user').filter({ hasText: 'MOBILE_SEND_ONCE' }).count(), 1);
    return { starts, receipts, deletes, providerRequests: model.requests.length, authoritativeReload: true };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {}); throw error;
  } finally { await page.close(); }
});
