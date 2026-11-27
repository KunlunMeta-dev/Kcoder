import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await runE2E(import.meta.url, { testId: 'desktop-original-snapshot-versus-explicit-current-retry', tier: 'full-integration',
  modelPolicy: 'real Desktop UI, loopback HTTP parameters and persistent Bash side effect; no paid model' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'current' });
  const prompt = 'CURRENT_CONFIGURATION_RETRY';
  const model = await startApprovalModelFixture(context, {
    sessionApprovalPrompt: prompt, sessionApprovalCount: 1, sessionApprovalCommand: 'printf x >> current-tool-count.txt',
    sessionApprovalFinalText: 'CURRENT_CONFIGURATION_DONE', httpErrorPrompt: prompt, httpErrorAfterToolResults: 1,
    httpErrorMatchLimit: 2, httpErrorStatus: 503,
  });
  const limits = { context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024 };
  const settings = { active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0, providers: {
    fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture-model', ...limits, no_proxy: true, models: { 'fixture-model': { ...limits, extra_body: { temperature: 0.2 } } } },
  } };
  const settingsPath = await context.writeStateJson('config/settings.json', settings);
  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'));
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: context.pathInState('config') } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const starts = [];
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const rpc = JSON.parse(String(frame.payload)); if (rpc.method === 'turn/start') starts.push({
      retryFromTurnId: rpc.params.retryFromTurnId, retryFromAttemptId: rpc.params.retryFromAttemptId,
      retryModelConfiguration: rpc.params.retryModelConfiguration, model: rpc.params.model,
    }); } catch { /* Other transport frames are irrelevant. */ }
  }));
  try {
    await page.goto(gateway.baseUrl); await page.getByTestId('chat-message-input').fill(prompt);
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('assistant-error-retry').waitFor({ timeout: 30000 });
    settings.providers.fixture.models['fixture-model'].extra_body.temperature = 0.7;
    await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    assert.match(await page.getByTestId('assistant-error-retry').innerText(), /原配置/);
    await page.getByTestId('assistant-error-retry').click();
    await page.getByTestId('assistant-error-continued').waitFor({ timeout: 30000 });
    await page.getByTestId('assistant-error-switch-model-retry').waitFor({ timeout: 30000 });
    assert.match(await page.getByTestId('assistant-error-switch-model-retry').innerText(), /当前配置/);
    settings.providers.fixture.models['fixture-model'].capabilities = { text: true, tools: false, vision: false, reasoning: false };
    await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    await page.getByTestId('chat-message-input').fill('UNSENT_DRAFT_SURVIVES_PREFLIGHT');
    await page.getByTestId('assistant-error-switch-model-retry').click();
    await page.getByTestId('model-control-menu-model').hover();
    await page.locator('[data-testid^="model-option-"]').filter({ hasText: 'fixture-model' }).first().click();
    await waitFor(async () => (await page.locator('body').innerText()).includes('所选模型配置不兼容'), 15000, 'incompatible current configuration rejected before model execution');
    assert.equal(model.requests.length, 3);
    assert.equal(await page.getByTestId('assistant-error-card').count(), 2);
    assert.match(await page.getByTestId('chat-message-input').innerText(), /UNSENT_DRAFT_SURVIVES_PREFLIGHT/);
    settings.providers.fixture.models['fixture-model'].capabilities.tools = true;
    await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    await page.getByTestId('assistant-error-switch-model-retry').click();
    await page.getByTestId('model-control-menu-model').hover();
    await page.locator('[data-testid^="model-option-"]').filter({ hasText: 'fixture-model' }).first().click();
    await page.getByText('CURRENT_CONFIGURATION_DONE', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await readFile(resolve(workspace, 'current-tool-count.txt'), 'utf8'), 'x');
    assert.deepEqual(model.requests.map(request => request.temperature), [0.2, 0.2, 0.2, 0.7]);
    assert.equal(starts.length, 4); assert.equal(starts[1].retryModelConfiguration, undefined);
    assert.equal(starts[1].model, undefined); assert.equal(starts[2].retryModelConfiguration, 'current');
    assert.ok(starts[2].retryFromAttemptId); assert.ok(starts[2].model);
    assert.equal(await page.getByTestId('assistant-error-continued').count(), 2);
    await page.screenshot({ path: context.pathInArtifacts('current-configuration-continued.png') });
    await context.writeArtifactJson('retry-boundaries.json', { starts, temperatures: model.requests.map(request => request.temperature) });
    return { originalSnapshotFrozen: true, sameModelCurrentConfigurationApplied: true, incompatibleRejectedWithoutModelCall: true, rejectionPreservesDraft: true, failedAttemptsPreserved: 2, toolExecutions: 1 };
  } catch (error) {
    await context.writeArtifactJson('failure-diagnostic.json', { error: String(error), text: await page.locator('body').innerText(), starts, requests: model.requests.length });
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {}); throw error;
  }
});
