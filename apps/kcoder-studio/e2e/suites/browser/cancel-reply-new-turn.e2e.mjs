import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { runE2E, repoRoot, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await runE2E(import.meta.url, { testId: 'old-cancel-ack-cannot-stop-new-turn-body', tier: 'full-integration',
  modelPolicy: 'real protocol cancellation/reopen with controlled ACK and delta scheduling; no paid model' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const fixture = await startApprovalModelFixture(context, { textOnly: true, delayedRequestNumbers: [1, 2], streamDelayMs: 30000 });
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: fixture.baseUrl,
    default_model: 'fixture', context_window_tokens: 64000, max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true,
  } } });
  const gateway = await startGateway(context, { workspace, delayCancelReply: true,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), env: { KCODER_CONFIG_DIR: context.pathInState('config') } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(gateway.baseUrl);
    for (let round = 0; round < 2; round++) {
      await page.getByTestId('chat-message-input').fill(`BROWSER_CANCEL_${round}`);
      await page.getByTestId('send-message-button').click();
      const partial = `ACTIVE_STREAM_PARTIAL: BROWSER_CANCEL_${round}`;
      await page.getByTestId('message-assistant').filter({ hasText: partial }).waitFor({ timeout: 15000 });
      await page.getByTestId('plugins-button').click();
      await page.getByTestId('plugins-add-marketplace-button').waitFor();
      await page.locator('[data-testid^="runtime-local-task-row-"]:visible').first().click();
      await page.getByTestId('pause-response-button').waitFor();
      const reply = page.getByTestId('message-assistant').filter({ hasText: partial });
      await reply.waitFor();
      assert.equal(await reply.getByText('已停止', { exact: true }).count(), 0);
      if (round === 1) await page.screenshot({ path: context.pathInArtifacts('new-turn-keeps-streaming.png') });
      await page.getByTestId('pause-response-button').click();
      await waitFor(async () => await page.getByTestId('pause-response-button').count() === 0, 15000, 'cancelled old turn allows next input');
    }
    const fault = JSON.parse(await readFile(context.pathInArtifacts('cancel-reply-fault.json'), 'utf8'));
    assert.deepEqual(fault, { ackHeld: true, ackReleasedAfterNewTurn: true, delayedNewTurnDelta: true, deltaReleased: true });
    assert.equal(fixture.requests.length, 2);
    return { ...fault, modelRequests: 2, currentBodyMatchesExecution: true };
  } catch (error) {
    await context.writeArtifactJson('failure.json', { message: String(error), text: await page.locator('body').innerText() });
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {}); throw error;
  }
});
