import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit isolated Tauri binary required');
if (process.env.KCODER_E2E_READONLY_TRANSCRIPT === '1') {
  await runE2E(import.meta.url, { testId: 'native-readonly-transcript-open-reopen', tier: 'manual-live',
    modelPolicy: 'real empty resident threads and native transcript reads; no turn/start or model request',
    retainSuccessEvidence: true, evidenceReason: 'Executor-scoped transcript requests require native conversation restoration' }, async context => {
    const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
    const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN,
      kcoderBin: binary, rendererRoot: resolve(appRoot, 'renderer/dist') });
    const policy = JSON.parse(await readFile(resolve(client.runRoot, 'artifacts/launch-policy.json'), 'utf8'));
    const origin = new URL(policy.gatewayOrigin);
    assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname));
    const gateway = { baseUrl: origin.origin, wsUrl: origin.origin.replace(/^http/, 'ws') };
    const token = await waitForGatewayRpcToken(context, gateway);
    const { servers } = await (await fetch(gateway.baseUrl + '/api/servers')).json();
    const serverId = servers.find(server => server.transport === 'local').id;
    const seed = await openRpc(gatewayRpcUrl(gateway, serverId, token), { headers: { Origin: gateway.baseUrl } });
    context.addCleanup('close readonly thread seed', () => seed.close());
    const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
    try {
      await initializeRpc(seed, 'readonly-transcript');
      const ids = [];
      const titles = new Map();
      for (const title of ['Readonly transcript A', 'Readonly transcript B']) {
        const { thread } = await seed.request('thread/start');
        await seed.request('thread/metadata/update', { threadId: thread.id, title });
        assert.deepEqual((await seed.request('thread/read', { threadId: thread.id, limit: 20 })).messages, []);
        ids.push(thread.id);
        titles.set(thread.id, title);
      }
      const open = async id => {
        await client.command('navigate', { value: `/runtime-tasks?deviceId=${encodeURIComponent(serverId)}&taskId=${encodeURIComponent(`kcoder:${serverId}:${id}`)}` });
        const row = `[data-testid^="runtime-local-task-row-"][data-testid$="${id}"]`;
        await client.command('waitFor', { selector: row, timeoutMs: 20000 });
        await client.command('click', { selector: row });
        await command('waitFor', 'workbench-pane-task-title', { text: titles.get(id) });
        assert.equal((await command('getText', 'workbench-pane-task-title')).trim(), titles.get(id));
        await command('waitFor', 'chat-empty-state');
        assert.equal(Number(await command('getElementCount', 'chat-loading-state')), 0);
        assert.equal(Number(await command('getElementCount', 'assistant-error-card')), 0);
      };
      await open(ids[0]);
      await open(ids[1]);
      await client.command('navigate', { value: '/settings' });
      await open(ids[0]);
      await client.capture('native-readonly-transcript-reopened.png');
      return { residentThreads: 2, transcriptReads: true, taskSwitch: true, reopened: true, modelRequests: 0 };
    } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
    finally { seed.close(); await client.stop(); }
  });
} else await runE2E(import.meta.url, { testId: 'native-stream-burst-history-reload-and-followup', tier: 'manual-live',
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
