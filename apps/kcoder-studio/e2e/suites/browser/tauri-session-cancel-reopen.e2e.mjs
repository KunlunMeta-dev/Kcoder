import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit isolated Tauri binary required');
await runE2E(import.meta.url, { testId: 'native-active-turn-reopen-after-previous-cancellation', tier: 'manual-live',
  modelPolicy: 'model-independent native execution projection across cancellation and history reads' }, async context => {
  const fixture = await startApprovalModelFixture(context, { textOnly: true, delayedRequestNumbers: [1,2], streamDelayMs: 30000 });
  const client = await startOwnedAiVerify(context, { delayCancelReply: true, tauriBin: process.env.KCODER_E2E_TAURI_BIN,
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
    for (let round = 0; round < 2; round++) {
      await cmd('waitFor', 'chat-message-input'); await cmd('fill', 'chat-message-input', { value: `NATIVE_CANCEL_${round}` });
      await cmd('waitFor', 'send-message-button', { enabled: true }); await cmd('click', 'send-message-button');
      await cmd('waitFor', 'message-assistant', { text: `ACTIVE_STREAM_PARTIAL: NATIVE_CANCEL_${round}`, timeoutMs: 15000 });
      await cmd('click', 'plugins-button'); await cmd('waitFor', 'plugins-add-marketplace-button');
      await client.command('click', { selector: '[data-testid^="runtime-local-task-row-"]' });
      await cmd('waitFor', 'pause-response-button', { enabled: true, timeoutMs: 15000 });
      assert.ok(Number(await client.command('getElementCount', { selector: '[data-testid^="runtime-local-task-running-"]' })) > 0);
      if (round === 1) await client.capture('native-active-reopened.png');
      await cmd('click', 'pause-response-button');
      await waitFor(async () => Number(await client.command('getElementCount', { selector: '[data-testid="pause-response-button"]' })) === 0, 15000, 'cancel settles native composer');
    }
    const fault = JSON.parse(await readFile(resolve(client.runRoot, 'artifacts/cancel-reply-fault.json'), 'utf8'));
    assert.deepEqual(fault, { ackHeld: true, ackReleasedAfterNewTurn: true, delayedNewTurnDelta: true, deltaReleased: true });
    await context.writeArtifactJson('cancel-reply-fault.json', fault);
    assert.equal(fixture.requests.length, 2);
    return { previousCancelCannotSettleNewTurn: true, activeAfterReopen: true, cancels: 2 };
  } catch (error) { client.markFailed(); await context.writeArtifactJson('fixture-requests.json', fixture.requests.map((request, index) => ({ requestNumber: index + 1, model: request.model, lastUserText: [...request.messages].reverse().find(message => message.role === 'user')?.content }))); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
