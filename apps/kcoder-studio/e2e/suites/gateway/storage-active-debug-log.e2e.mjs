import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
await runE2E(import.meta.url, { testId: 'active-debug-recorder-blocks-other-process-cleanup', tier: 'full-integration', modelPolicy: 'model-independent native OpenAI-compatible adapter, real streamed HTTP and cross-process debug-log cleanup' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyChunks: Array.from({ length: 30 }, () => 'fixture '), textOnlyChunkDelayMs: 200 });
  const config = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', chat_protocol: 'minimax', authentication: { mode: 'none' }, endpoint: model.baseUrl,
    default_model: 'fixture', no_proxy: true, context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
  } } });
  const connect = async (label, enabled) => {
    const gateway = await startGateway(context, { label, workspace, env: { KCODER_CONFIG_DIR: config, DEV_DEBUG: enabled ? '1' : '0' } });
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
    context.addCleanup(`close ${label}`, () => rpc.close()); await initializeRpc(rpc, label); return rpc;
  };
  const worker = await connect('debug-writer', true);
  const cleaner = await connect('debug-cleaner', false);
  const { thread } = await worker.request('thread/start');
  const { turn } = await worker.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'fixture debug storage' }] });
  await waitFor(() => model.requests.length === 1, 15000, 'real request');
  const initial = await cleaner.request('diagnostics/storage/read');
  assert.equal(initial.devDebug.enabled, false);
  assert.ok(initial.devDebug.logFiles > 0);
  await assert.rejects(cleaner.request('diagnostics/storage/clean', { target: 'debug-logs', confirm: true }), /storage is busy/i);
  const finished = await worker.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, 30000, 'writer completion');
  assert.equal(finished.params.turn.status, 'completed');
  const logRoot = resolve(config, 'logs/llm-request');
  const files = await readdir(logRoot, { recursive: true });
  const trace = files.find(file => file.endsWith('.json'));
  assert.ok(trace);
  const recorded = JSON.parse(await readFile(resolve(logRoot, trace), 'utf8'));
  assert.ok(recorded.response.sse_events.length > 0, 'final response is recorded before cleanup becomes possible');
  const result = await cleaner.request('diagnostics/storage/clean', { target: 'debug-logs', confirm: true });
  assert.ok(result.removedFiles > 0);
  assert.equal(result.report.devDebug.logFiles, 0);
  return { activeRecorderProtectedAcrossProcesses: true, finalResponseRecorded: true, cleanupAfterCompletion: true };
});
