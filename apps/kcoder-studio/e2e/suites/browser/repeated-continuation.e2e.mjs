import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'renderer-continues-a-second-failed-attempt', tier: 'full-integration',
  modelPolicy: 'loopback HTTP fails twice; real renderer retries and attempt persistence',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'repeat' });
  const model = await startApprovalModelFixture(context, { textOnly: true,
    textOnlyResponse: 'REPEATED_CONTINUATION_DONE', httpErrorPrompt: 'REPEAT_FAILURE',
    httpErrorStatus: 503, httpErrorMatchLimit: 2 });
  const config = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'fixture-model', context_window_tokens: 64000, output_headroom_tokens: 1024,
      max_output_tokens: 1024, no_proxy: true } } });
  const key = 'synthetic-repeat-attempt'; context.registerSecret(key);
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'));
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: config } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${gateway.baseUrl}/?e2e=1`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('chat-message-input').waitFor({ timeout: 30000 });
  await page.getByTestId('chat-message-input').click();
  await page.keyboard.insertText('REPEAT_FAILURE');
  await page.getByTestId('send-message-button').click();
  await page.getByTestId('assistant-error-retry').waitFor({ timeout: 30000 });
  await page.getByTestId('assistant-error-retry').click();
  await page.getByTestId('assistant-error-continued').waitFor({ timeout: 30000 });
  await page.getByTestId('assistant-error-retry').waitFor({ timeout: 30000 });
  await page.getByTestId('assistant-error-retry').click();
  await page.getByText('REPEATED_CONTINUATION_DONE', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('assistant-error-continued').count(), 2);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('REPEATED_CONTINUATION_DONE', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('assistant-error-continued').count(), 2);
  assert.equal(await page.getByTestId('assistant-error-retry').count(), 0);
  assert.equal(model.requests.length, 3);
  await page.screenshot({ path: context.pathInArtifacts('repeated-continuation.png') });
  return { preservedFailedAttempts: 2, modelRequests: model.requests.length };
});
