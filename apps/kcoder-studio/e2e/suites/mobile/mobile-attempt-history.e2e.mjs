import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'mobile-preserves-failed-attempt-after-continuation-and-restart', tier: 'full-integration',
  modelPolicy: 'model-independent loopback HTTP failure; actual app-server persistence and Mobile Web UI',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'attempt-mobile' });
  const model = await startApprovalModelFixture(context, { textOnly: true,
    textOnlyResponse: 'ATTEMPT_RECOVERED', httpErrorPrompt: 'ATTEMPT_HISTORY_MOBILE',
    httpErrorStatus: 503, httpErrorMatchLimit: 1 });
  const config = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'fixture-model', context_window_tokens: 64000, output_headroom_tokens: 1024,
      max_output_tokens: 1024, no_proxy: true } } });
  const key = 'synthetic-attempt-history'; context.registerSecret(key);
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'));
  const gateway = await startGateway(context, { workspace, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_WEB_ROOT: resolve(appRoot, 'mobile/dist') } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const connect = async () => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
    context.addCleanup('close attempt history RPC', () => rpc.close());
    await initializeRpc(rpc, 'attempt-history-mobile'); return rpc;
  };
  let rpc = await connect();
  const { thread } = await rpc.request('thread/start', {});
  const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'ATTEMPT_HISTORY_MOBILE' }] });
  const failed = await rpc.waitFor(m => m.method === 'turn/completed' && m.params?.turnId === turn.id, 30000, 'original failure');
  assert.equal(failed.params.turn.status, 'failed');
  await rpc.request('turn/start', { threadId: thread.id, retryFromTurnId: turn.id,
    retryOperationId: 'attempt-mobile-recovery', input: [] });
  const recovered = await rpc.waitFor(m => m !== failed && m.method === 'turn/completed' && m.params?.turnId === turn.id, 30000, 'continued completion');
  assert.equal(recovered.params.turn.status, 'completed');
  await rpc.request('thread/metadata/update', { threadId: thread.id, title: 'Attempt history mobile' });
  await rpc.request('gateway/app-server/restart', { confirm: true });
  rpc.close(); rpc = await connect();
  const history = await rpc.request('thread/read', { threadId: thread.id, limit: 50 });
  const prior = history.messages.find(message => message.status === 'failed');
  assert.equal(prior.attemptId, turn.id);
  assert.ok(prior.continuedByAttemptId);
  assert.equal(prior.content, '', 'a failure without body must remain a visible row');
  rpc.close();
  await waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED, 5000, 'seed RPC closure');

  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('welcome-direct-connection').click();
  await page.getByTestId('gateway-endpoint').fill(gateway.baseUrl);
  await page.getByTestId('gateway-connect').click();
  await page.getByTestId('new-workspace').waitFor({ timeout: 30000 });
  await page.getByTestId('sessions').click();
  await page.getByTestId('session-search').fill('Attempt history mobile');
  await page.getByTestId(`session-${thread.id}`).click();
  await page.getByTestId('message-attempt-failure').waitFor({ timeout: 30000 });
  await page.getByText('ATTEMPT_RECOVERED', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('message-attempt-failure').count(), 1);
  assert.ok((await page.getByTestId('message-attempt-failure').innerText()).includes('已从失败处继续'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('message-attempt-failure').waitFor({ timeout: 30000 });
  await page.getByText('ATTEMPT_RECOVERED', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(model.requests.length, 2, 'opening history must not issue model requests');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const header = await page.getByTestId('task-header').boundingBox();
    const title = await page.getByTestId('task-header-title').boundingBox();
    const status = await page.getByTestId('task-header-status').boundingBox();
    assert.ok(header && title && status);
    assert.ok(title.y >= header.y, 'long cwd must not clip the task title');
    assert.ok(status.y + status.height <= header.y + header.height, 'status stays inside header');
    assert.ok(status.height <= 18, 'cwd remains a single line');
    assert.ok(status.x >= 0 && status.x + status.width <= width, 'status fits narrow viewport');
    await page.screenshot({ path: context.pathInArtifacts(`mobile-header-${width}.png`) });
  }
  await page.screenshot({ path: context.pathInArtifacts('mobile-attempt-history.png') });
  return { attemptRows: 1, modelRequests: model.requests.length, restoredAfterProcessRestart: true };
});
