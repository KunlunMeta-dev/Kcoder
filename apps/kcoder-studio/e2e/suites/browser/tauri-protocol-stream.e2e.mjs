import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startProtocolStreamFixture } from '../../harness/protocol-stream-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('UNMET_PREREQUISITE: explicit Tauri binary required');
for (const apiFormat of ['anthropic_messages', 'openai_chat_completions', 'openai_responses']) {
await runE2E(import.meta.url, {
  testId: `tauri-three-protocol-stream-rendering-${apiFormat}`, tier: 'manual-live',
  modelPolicy: 'model-independent native protocol projection; fixed loopback SSE through real Gateway and CLI',
}, async context => {
  const fixture = await startProtocolStreamFixture(context);
  const results = [];
    const client = await startOwnedAiVerify(context, {
      tauriBin: process.env.KCODER_E2E_TAURI_BIN,
      kcoderBin: resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist'),
    });
    const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
    const count = selector => client.command('getElementCount', { selector }).then(Number);
    try {
      await command('waitFor', 'desktop-sidebar', { visible: true });
      // Owned verification profile only; model setup is not the behavior under test.
      const key = 'native-protocol-fixture'; context.registerSecret(key);
      await writeFile(resolve(dirname(client.settingsPath), 'credentials.json'), JSON.stringify({ fixture: { type: 'api', key } }), { mode: 0o600 });
      await writeFile(client.settingsPath, JSON.stringify({
        active_provider: 'fixture', max_retries: 0,
        providers: { fixture: { api_format: apiFormat,
          endpoint: apiFormat === 'anthropic_messages' ? fixture.baseUrl.replace(/\/v1$/, '') : fixture.baseUrl,
          ...(apiFormat === 'openai_chat_completions' ? { chat_protocol: 'minimax' } : {}),
          default_model: 'fixture-model', no_proxy: true, context_window_tokens: 128000,
          max_output_tokens: 1024, output_headroom_tokens: 1024 } },
      }), { mode: 0o600 });
      await client.command('navigate', { value: '/settings/personal/models' });
      await command('waitFor', 'provider-edit-fixture::fixture-model', { timeoutMs: 15000 });
      await client.command('navigate', { value: '/' });
      for (const mode of ['complete', 'eof']) {
        const before = fixture.requests.length;
        await command('waitFor', 'project-new-conversation-button', { timeoutMs: 15000 });
        await command('click', 'project-new-conversation-button');
        await command('waitFor', 'chat-message-input', { visible: true });
        await command('fill', 'chat-message-input', { value: `FIXTURE_${mode.toUpperCase()}` });
        await command('waitFor', 'send-message-button', { enabled: true });
        await command('click', 'send-message-button');
        await command('waitFor', 'message-assistant', { text: 'TEXT_TAIL', timeoutMs: 30000 });
        if (mode === 'eof') await command('waitFor', 'assistant-error-card', { timeoutMs: 30000 });
        await waitFor(async () => await count('[data-testid="assistant-thinking-spinner"]') === 0, 30000, 'native terminal rendering');
        if (await count('[data-testid="final-processing-toggle"][aria-expanded="false"]')) await command('click', 'final-processing-toggle');
        await command('waitFor', 'assistant-thinking-toggle');
        if (await count('[data-testid="assistant-thinking-toggle"][aria-expanded="false"]')) await command('click', 'assistant-thinking-toggle');
        assert.equal(await command('getText', 'assistant-thinking-content'), 'THINK_TAIL');
        assert.equal(await count('[data-testid="assistant-error-card"]'), mode === 'eof' ? 1 : 0);
        assert.equal(fixture.requests.length - before, 1);
        results.push({ apiFormat, mode, nativeThinkingAndText: true });
      }
      await client.capture(`${apiFormat}-native-eof.png`);
    } catch (error) {
      client.markFailed(); await client.capture(`${apiFormat}-failure.png`).catch(() => {}); throw error;
    } finally { await client.stop(); }
  return { results, requests: fixture.requests.length };
});
}
