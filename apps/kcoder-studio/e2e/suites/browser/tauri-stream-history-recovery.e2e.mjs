import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit isolated Tauri binary required');
await runE2E(import.meta.url, { testId: 'native-stream-burst-history-reload-and-followup', tier: 'manual-live',
  modelPolicy: 'model-independent native streaming and authoritative history replay; no model quality claim' }, async context => {
  const expected = 'NATIVE_BEGIN_' + 'x'.repeat(620) + '_NATIVE_END';
  const fixture = await startApprovalModelFixture(context, { textOnly: true,
    textOnlyChunks: ['NATIVE_BEGIN_', ...Array(620).fill('x'), '_NATIVE_END'], textOnlyChunkDelayMs: 2 });
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist') });
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await writeFile(client.settingsPath, JSON.stringify({ active_provider: 'fixture', providers: { fixture: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: fixture.baseUrl,
      default_model: 'fixture', context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024, no_proxy: true,
    } } }), { mode: 0o600 });
    await client.command('navigate', { value: '/settings/personal/models' });
    await cmd('waitFor', 'provider-edit-fixture::fixture', { timeoutMs: 15000 });
    await client.command('navigate', { value: '/' });
    await cmd('waitFor', 'chat-message-input'); await cmd('fill', 'chat-message-input', { value: 'NATIVE_STREAM_HISTORY' });
    await cmd('waitFor', 'send-message-button', { enabled: true }); await cmd('click', 'send-message-button');
    await cmd('waitFor', 'message-assistant', { text: '_NATIVE_END', timeoutMs: 30000 });
    assert.ok((await client.command('getText')).includes(expected));
    await cmd('click', 'plugins-button'); await cmd('waitFor', 'plugins-add-marketplace-button');
    await client.command('click', { selector: '[data-testid^="runtime-local-task-row-"]' });
    await cmd('waitFor', 'message-assistant', { text: '_NATIVE_END' });
    assert.ok((await client.command('getText')).includes(expected));
    await cmd('fill', 'chat-message-input', { value: 'NATIVE_STREAM_FOLLOWUP' });
    await cmd('waitFor', 'send-message-button', { enabled: true }); await cmd('click', 'send-message-button');
    await waitFor(async () => (await client.command('getText')).split(expected).length === 3, 30000, 'two exact native replies');
    await waitFor(async () => Number(await client.command('getElementCount', {
      selector: '[data-testid="assistant-thinking-spinner"], [data-testid^="runtime-local-task-row-"] .animate-spin',
    })) === 0, 15000, 'native terminal state in list and transcript');
    assert.equal(fixture.requests.length, 2);
    await client.capture('native-history-recovered.png');
    return { replies: 2, streamChunksPerReply: 622, reloadedFromHistory: true };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
