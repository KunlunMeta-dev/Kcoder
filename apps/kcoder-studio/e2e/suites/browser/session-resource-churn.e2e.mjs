import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'bounded-ui-navigation-reconnect-cancel-resource-churn', tier: 'full-integration',
  modelPolicy: 'model-independent six-round UI/transport/process lifecycle under identical resource conditions' }, async context => {
  const rounds = 6;
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'ui-churn' });
  const model = await startApprovalModelFixture(context, { textOnly: true,
    delayedRequestNumbers: Array.from({ length: rounds }, (_, index) => index + 1), streamDelayMs: 30000 });
  const home = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', max_retries: 0, providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
    default_model: 'fixture', context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024, no_proxy: true,
  } } });
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: home } });
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
  context.addCleanup('close resource observer', () => rpc.close()); await initializeRpc(rpc, 'resource-observer');
  const processInfo = await rpc.request('server/resources/read');
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    const Native = window.WebSocket; const sockets = new Set(); window.__readStates = []; window.__liveSocketCount = () => sockets.size;
    window.WebSocket = class extends Native { constructor(...args) { super(...args); sockets.add(this);
      this.addEventListener('close', () => sockets.delete(this), { once: true }); this.addEventListener('message', event => { try { const m = JSON.parse(event.data); if (Array.isArray(m.result?.messages)) window.__readStates.push({thread:m.result.thread, messages:m.result.messages.map(x=>({role:x.role,turnId:x.turnId,status:x.status,id:x.id}))}); } catch {} }); } };
  });
  await page.goto(gateway.baseUrl);
  const observations = [];
  for (let round = 0; round < rounds; round++) {
    await page.getByTestId('chat-message-input').fill(`CHURN_ROUND_${round}`);
    await page.getByTestId('send-message-button').click();
    await waitFor(() => model.requests.length === round + 1, 15000, 'one intended streaming request');
    await page.getByTestId('desktop-chat-scroll-content').getByText(`ACTIVE_STREAM_PARTIAL: CHURN_ROUND_${round}`, { exact: true }).waitFor({ timeout: 15000 });
    await page.getByTestId('plugins-button').click(); await page.getByTestId('plugins-add-marketplace-button').waitFor();
    const active = await rpc.request('server/resources/read');
    assert.equal(active.processId, processInfo.processId);
    assert.equal(active.activity.runningTurns, 1, 'navigation must not evict protected execution');
    await page.locator('[data-testid^="runtime-local-task-row-"]:visible').first().click();
    try { await page.getByTestId('pause-response-button').click({ timeout: 5000 }); }
    catch (error) {
      await context.writeArtifactJson('reopen-diagnostic.json', { resource: await rpc.request('server/resources/read'), text: await page.locator('body').innerText(), reads: await page.evaluate(() => window.__readStates) });
      await page.screenshot({ path: context.pathInArtifacts('reopen-diagnostic.png') }); throw error;
    }
    await waitFor(async () => (await rpc.request('server/resources/read')).activity.runningTurns === 0, 15000, 'cancel acknowledged');
    await page.reload();
    await page.getByTestId('chat-message-input').waitFor({ timeout: 15000 });
    await waitFor(async () => {
      const resource = await rpc.request('server/resources/read');
      return resource.activity.pendingServiceRequests === 0 && resource.activity.runningTurns === 0;
    }, 15000, 'settled resource baseline');
    const resource = await rpc.request('server/resources/read');
    assert.equal(resource.processId, processInfo.processId, 'one shared app-server survives churn');
    assert.equal(resource.activity.residentThreads, 1, 'same conversation does not allocate more residents');
    assert.equal(resource.activity.pendingApprovals, 0);
    assert.equal(resource.activity.pendingQuestions, 0);
    assert.equal(resource.activity.terminalSessions, 0);
    assert.equal(resource.activity.browserSessions, 0);
    let lastSockets = -1; let stableSince = Date.now();
    const liveSockets = await waitFor(async () => {
      const count = await page.evaluate(() => window.__liveSocketCount());
      if (count !== lastSockets) { lastSockets = count; stableSince = Date.now(); }
      return Date.now() - stableSince >= 1000 ? { count } : null;
    }, 15000, 'same settled client-count baseline', 100);
    observations.push({ round: round + 1, liveSockets: liveSockets.count,
      processId: resource.processId, residentThreads: resource.activity.residentThreads, runningTurns: resource.activity.runningTurns });
  }
  await context.writeArtifactJson('churn-rounds.json', observations);
  assert.ok(observations.every(value => value.liveSockets <= observations[0].liveSockets + 1), 'live client count must not grow per navigation round');
  assert.equal(model.requests.length, rounds);
  await page.close(); rpc.close(); await context.stopOwned('gateway');
  const metrics = (await readFile(gateway.logPath, 'utf8')).split('\n').filter(line => line.startsWith('{"event":"broker-lifecycle",')).map(JSON.parse);
  assert.equal(metrics.length, 1, 'navigation reuses one broker');
  assert.equal(metrics[0].brokerCount, 0, 'broker count returns to zero after shutdown');
  await context.writeArtifactJson('churn-observations.json', { observations, brokersCreated: metrics.length, finalBrokerCount: 0 });
  return { rounds, modelRequests: model.requests.length, stableProcess: true, finalBrokerCount: 0 };
});
