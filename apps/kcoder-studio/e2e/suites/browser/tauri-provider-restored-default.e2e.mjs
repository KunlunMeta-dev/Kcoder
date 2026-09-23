import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit Tauri binary required');
await runE2E(import.meta.url, {
  testId: 'tauri-restored-provider-default', tier: 'manual-live',
  modelPolicy: 'real native WebView restoration and typing; deterministic HTTP protocol, no model quality assertion',
}, async context => {
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'NATIVE_RESTORE_DONE' });
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN, kcoderBin: resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await writeFile(client.settingsPath, JSON.stringify({ active_provider: 'restore', providers: {
      restore: { api_format: 'openai_chat_completions', endpoint: model.baseUrl, default_model: 'native-restore',
        authentication: { mode: 'none' }, no_proxy: true, context_window_tokens: 128000,
        max_output_tokens: 4096, output_headroom_tokens: 4096 },
    } }), { mode: 0o600 });
    await client.command('navigate', { value: '/' });
    await command('waitFor', 'project-new-conversation-button', { visible: true });
    await command('click', 'project-new-conversation-button');
    await command('waitFor', 'chat-message-input', { visible: true });
    await command('fill', 'chat-message-input', { value: 'NATIVE_INITIAL_CONVERSATION' });
    await command('waitFor', 'send-message-button', { enabled: true });
    await command('click', 'send-message-button');
    await command('waitFor', 'message-assistant', { text: 'NATIVE_RESTORE_DONE' });
    // A native navigation reloads the page and reconstructs the selected runtime.
    await client.command('navigate', { value: '/' });
    const row = '[data-testid^="runtime-local-task-row-"]';
    await client.command('waitFor', { selector: row, text: 'NATIVE_INITIAL_CONVERSATION' });
    await client.command('click', { selector: row });
    await command('waitFor', 'chat-message-input', { visible: true });
    await command('fill', 'chat-message-input', { value: 'NATIVE_RESTORED_DRAFT' });
    await command('waitFor', 'send-message-button', { enabled: true });
    await command('click', 'send-message-button');
    await waitFor(() => model.requests.some(request => JSON.stringify(request.messages).includes('NATIVE_RESTORED_DRAFT')),
      20000, 'restored native request');
    await waitFor(async () => Number(await client.command('getElementCount', { selector: '[data-testid="pause-response-button"]' })) === 0, 15000, 'native restored turn completes');
    assert.equal(model.requests.length, 2);
    assert.ok(model.requests.every(request => request.model === 'native-restore'));
    await client.capture('native-restored-model.png');
    return { nativeRestore: true, originalModel: true, twoRequests: true };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
