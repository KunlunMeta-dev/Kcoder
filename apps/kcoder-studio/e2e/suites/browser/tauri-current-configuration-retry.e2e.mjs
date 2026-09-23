import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit isolated Tauri binary required');
await runE2E(import.meta.url, { testId: 'native-original-and-current-configuration-retry-buttons', tier: 'manual-live',
  modelPolicy: 'real Tauri buttons and loopback model request settings; no paid model' }, async context => {
  const fixture = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'NATIVE_CURRENT_CONFIGURATION_DONE',
    httpErrorPrompt: 'NATIVE_CURRENT_CONFIGURATION', httpErrorMatchLimit: 2, httpErrorStatus: 503 });
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist') });
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  const limits = { context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024 };
  const settings = { active_provider: 'fixture', max_retries: 0, providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: fixture.baseUrl,
    default_model: 'fixture-model', ...limits, no_proxy: true,
    models: { 'fixture-model': { ...limits, extra_body: { temperature: 0.2 } } },
  } } };
  try {
    await writeFile(client.settingsPath, JSON.stringify(settings), { mode: 0o600 });
    await client.command('navigate', { value: '/settings/personal/models' });
    await cmd('waitFor', 'provider-edit-fixture::fixture-model', { timeoutMs: 15000 });
    await client.command('navigate', { value: '/' });
    await cmd('waitFor', 'chat-message-input'); await cmd('fill', 'chat-message-input', { value: 'NATIVE_CURRENT_CONFIGURATION' });
    await cmd('waitFor', 'send-message-button', { enabled: true }); await cmd('click', 'send-message-button');
    await cmd('waitFor', 'assistant-error-retry', { text: '使用原配置继续', timeoutMs: 15000 });
    settings.providers.fixture.models['fixture-model'].extra_body.temperature = 0.7;
    await writeFile(client.settingsPath, JSON.stringify(settings), { mode: 0o600 });
    await cmd('click', 'assistant-error-retry'); await cmd('waitFor', 'assistant-error-continued', { timeoutMs: 15000 });
    await cmd('waitFor', 'assistant-error-switch-model-retry', { text: '当前配置', timeoutMs: 15000 });
    await cmd('click', 'assistant-error-switch-model-retry');
    await cmd('hover', 'model-control-menu-model');
    await client.command('waitFor', { selector: '[data-testid^="model-option-"]', timeoutMs: 10000 });
    await client.command('click', { selector: '[data-testid^="model-option-"]' });
    await cmd('waitFor', 'message-assistant', { text: 'NATIVE_CURRENT_CONFIGURATION_DONE', timeoutMs: 15000 });
    assert.deepEqual(fixture.requests.map(request => request.temperature), [0.2, 0.2, 0.7]);
    assert.equal(Number(await client.command('getElementCount', { selector: '[data-testid="assistant-error-continued"]' })), 2);
    await client.capture('native-current-configuration.png');
    return { originalSnapshotFrozen: true, currentSettingsAppliedWithoutRestart: true, failedAttemptsPreserved: 2 };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
