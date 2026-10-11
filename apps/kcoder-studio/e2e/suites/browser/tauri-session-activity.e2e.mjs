import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit isolated Tauri binary required');
await runE2E(import.meta.url, { testId: 'native-distinct-waiting-and-safe-recent-error-status', tier: 'manual-live',
  modelPolicy: 'model-independent failure metadata and native approval lifecycle through real Gateway/CLI' }, async context => {
  const fixture = await startApprovalModelFixture(context, { httpErrorPrompt: 'NATIVE_ERROR_SUMMARY', httpErrorMatchLimit: 1,
    httpErrorStatus: 503, responseSteps: ({ body }) => {
      if (body.messages.at(-1)?.role === 'tool') return [{ delta: { content: 'ACTIVITY_NATIVE_DONE' }, finishReason: 'stop' }];
      return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'native-approval', type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'printf approved > native-approval-done' }) } }] } }, { finishReason: 'tool_calls' }];
    } });
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist') });
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await writeFile(client.settingsPath, JSON.stringify({ active_provider: 'fixture', permission_mode: 'ask', max_retries: 0, providers: { fixture: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: fixture.baseUrl,
      default_model: 'fixture', context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024, no_proxy: true,
    } } }), { mode: 0o600 });
    await client.command('navigate', { value: '/settings/personal/models' });
    await cmd('waitFor', 'provider-edit-fixture::fixture', { timeoutMs: 15000 });
    await client.command('navigate', { value: '/' });
    await cmd('waitFor', 'chat-message-input'); await cmd('fill', 'chat-message-input', { value: 'NATIVE_ERROR_SUMMARY' });
    await cmd('waitFor', 'send-message-button', { enabled: true }); await cmd('click', 'send-message-button');
    await cmd('waitFor', 'assistant-error-card', { timeoutMs: 15000 });
    await client.command('waitFor', { selector: '[data-testid^="runtime-task-recent-error-"]', text: '最近失败', timeoutMs: 15000 });
    await client.capture('native-recent-error.png');
    await cmd('fill', 'chat-message-input', { value: 'NATIVE_WAIT_SUMMARY' });
    await cmd('waitFor', 'send-message-button', { enabled: true }); await cmd('click', 'send-message-button');
    await cmd('waitFor', 'request-user-input-card', { timeoutMs: 15000 });
    await client.command('waitFor', { selector: '[data-testid^="runtime-task-activity-"][data-activity="waiting_approval"]', text: '等待审批', timeoutMs: 15000 });
    await client.capture('native-waiting-approval.png');
    await client.command('click', { selector: '[data-testid="request-user-input-card"] [data-testid^="request-user-input-option-"]' });
    await cmd('waitFor', 'message-assistant', { text: 'ACTIVITY_NATIVE_DONE', timeoutMs: 15000 });
    assert.equal(fixture.requests.length, 3);
    return { safeRecentError: true, waitingHasDistinctVisibleText: true, approvalOperable: true, modelRequests: 3 };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
