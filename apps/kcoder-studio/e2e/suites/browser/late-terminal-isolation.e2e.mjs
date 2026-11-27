import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'old-terminal-cannot-settle-new-live-turn', tier: 'full-integration',
  modelPolicy: 'model-independent real streamed turns; replay a captured older terminal without optional sequence metadata' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { textOnly: true, delayedRequestNumbers: [2], streamDelayMs: 15000 });
  await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', max_retries: 0, providers: { fixture: {
    api_format: 'openai_chat_completions', endpoint: model.baseUrl, authentication: { mode: 'none' }, default_model: 'fixture', no_proxy: true,
    context_window_tokens: 1000000, max_output_tokens: 1024, output_headroom_tokens: 1024,
  } } });
  const gateway = await startGateway(context, { workspace, kcoderBin: resolve(repoRoot, 'target/debug/kcoder'), env: { KCODER_CONFIG_DIR: context.pathInState('profile') } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let oldTerminal, currentSocket;
  await page.routeWebSocket('**/rpc*', socket => {
    const upstream = socket.connectToServer();
    upstream.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.method === 'turn/started') currentSocket = socket;
      if (message.method === 'turn/completed' && !oldTerminal) oldTerminal = message;
      socket.send(raw);
    });
  });
  try {
    await page.goto(gateway.baseUrl);
    await page.getByTestId('chat-message-input').fill('FIRST_TERMINAL');
    await page.getByTestId('send-message-button').click();
    await page.getByText('deterministic renderer response: FIRST_TERMINAL', { exact: true }).waitFor({ timeout: 30000 });
    await page.getByTestId('pause-response-button').waitFor({ state: 'hidden' });
    assert.ok(oldTerminal);
    await page.getByTestId('chat-message-input').fill('SECOND_LIVE_TURN');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('desktop-chat-scroll-content').getByText('ACTIVE_STREAM_PARTIAL: SECOND_LIVE_TURN', { exact: true }).waitFor({ timeout: 30000 });
    // Compatibility notifications may omit sequence. Identity must still fence
    // this old terminal, independently of transport replay deduplication.
    const delayed = structuredClone(oldTerminal);
    delete delayed.params.sequence;
    currentSocket.send(JSON.stringify(delayed));
    await page.getByTestId('plugins-button').click();
    await page.getByTestId('plugins-add-marketplace-button').waitFor();
    await page.locator('[data-testid^="runtime-local-task-row-"]:visible').first().click();
    assert.equal(await page.getByTestId('pause-response-button').isVisible(), true);
    assert.ok(await page.locator('[data-testid^="runtime-local-task-running-"]:visible').count() > 0);
    await page.screenshot({ path: context.pathInArtifacts('current-turn-remains-running.png') });
    await page.getByTestId('desktop-chat-scroll-content').getByText('deterministic renderer response: SECOND_LIVE_TURN', { exact: false }).waitFor({ timeout: 30000 });
    await page.getByTestId('pause-response-button').waitFor({ state: 'hidden' });
    assert.equal(model.requests.length, 2);
    return { providerRequests: 2, capturedLateTerminal: true, currentRunningAfterReopen: true, completedNormally: true };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {}); throw error;
  } finally { await page.close(); }
});
