import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, { testId: 'storage-clean-rechecks-live-snapshot-across-processes', tier: 'full-integration', modelPolicy: 'model-independent real streaming HTTP and two app-server processes sharing a private configuration directory' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  // Stop Git discovery at this owned workspace rather than inheriting the
  // checkout's .git through target/. The real fallback uses an isolated repo.
  await writeFile(resolve(workspace, '.git'), 'gitdir: ./owned-nonexistent-git\n');
  const model = await startApprovalModelFixture(context, { sessionApprovalPrompt: 'hold snapshot', sessionApprovalCount: 1,
    sessionApprovalCommand: 'printf active > snapshot-active; while [ ! -f snapshot-release ]; do sleep 0.05; done; printf done > snapshot-finished',
    sessionApprovalFinalText: 'SNAPSHOT_FINISHED' });
  const config = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', { permission_mode: 'yolo', active_provider: 'fixture', turn_file_changes: { enabled: true }, providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture', no_proxy: true,
    context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
  } } });
  const idle = resolve(config, 'projects/idle/turn-file-changes/snapshot-repository-idle');
  await mkdir(resolve(idle, 'objects'), { recursive: true });
  await writeFile(resolve(idle, 'objects/fixture'), 'KEEP_UNTIL_CLEAN');
  const connect = async label => {
    const gateway = await startGateway(context, { label, workspace, env: { KCODER_CONFIG_DIR: config } });
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
    context.addCleanup(`close ${label}`, () => rpc.close());
    await initializeRpc(rpc, label);
    return rpc;
  };
  const worker = await connect('snapshot-worker');
  const cleaner = await connect('snapshot-cleaner');
  const preview = await cleaner.request('diagnostics/storage/read');
  assert.ok(preview.totalBytes > 0);
  const { thread } = await worker.request('thread/start');
  const { turn } = await worker.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'hold snapshot while streaming' }] });
  await waitFor(() => stat(resolve(workspace, 'snapshot-active')).then(() => true, () => false), 15000, 'active mutating tool after snapshot capture');
  await assert.rejects(cleaner.request('diagnostics/storage/clean', { target: 'turn-snapshots', confirm: true }), /storage is busy/i);
  assert.equal(await readFile(resolve(idle, 'objects/fixture'), 'utf8'), 'KEEP_UNTIL_CLEAN');
  await writeFile(resolve(workspace, 'snapshot-release'), 'release');
  const finished = await worker.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, 30000, 'snapshot turn completion');
  assert.equal(finished.params.turn.status, 'completed');
  const result = await cleaner.request('diagnostics/storage/clean', { target: 'turn-snapshots', confirm: true });
  assert.ok(result.removedBytes >= 16);
  assert.equal(await stat(idle).then(() => true, () => false), false);
  return { distinctProcesses: true, previewThenBusyRefused: true, noPartialCleanup: true, retryAfterTurnCompleted: true };
});
