import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Fixed model transport; all assertions concern real versioned scripts and store state.
await runE2E(import.meta.url, {
  testId: 'plugin-version-update-uninstall-retained-conversations', tier: 'full-integration',
  modelPolicy: 'model-independent real plugin scripts, atomic store and live thread snapshots',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'versions' });
  const source = context.pathInState('source with spaces');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true });
  const version = async number => {
    await writeFile(resolve(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'version-demo', version: `${number}.0.0`, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', shell: 'bash', command: 'bash "${CLAUDE_PLUGIN_ROOT}/run.sh"', timeout: 5 }] }] } }));
    await writeFile(resolve(source, 'run.sh'), `printf ${number} >> version-count\n`);
  };
  await version(1);
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: 'assistant', content: 'Fixture complete.' }, finishReason: 'stop' }] });
  await context.writeStateJson('config with spaces/settings.json', { active_provider: 'fixture', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture', context_window_tokens: 64000, max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true } } });
  await context.writeStateJson('config with spaces/credentials.json', {});
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Plugin versions reader', transport: 'local', command: binary, workspace }, { id: 'writer', label: 'Plugin versions writer', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: context.pathInState('config with spaces') } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close version RPC', () => rpc.close());
  await initializeRpc(rpc, 'plugin-version-retention');
  const writer = await openRpc(gatewayRpcUrl(gateway, 'writer', token));
  context.addCleanup('close independent plugin writer', () => writer.close());
  await initializeRpc(writer, 'plugin-version-writer');
  const probe = (await writer.request('thread/start', {})).thread;
  const writerStarted = await writer.waitFor(message => message.method === 'thread/started' && message.params?.threadId === probe.id, 10000, 'writer process identity');
  await writer.request('thread/delete', { threadId: probe.id });

  const run = async (threadId, text) => {
    const before = new Set(rpc.messages());
    const { turn } = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text }] });
    const completed = await rpc.waitFor(message => !before.has(message) && message.method === 'turn/completed' && message.params?.threadId === threadId && message.params?.turnId === turn.id, 45000, 'version hook turn');
    assert.equal(completed.params.turn.status, 'completed');
  };
  const first = await writer.request('plugin/install', { path: source });
  const a = (await rpc.request('thread/start', {})).thread;
  const readerStarted = await rpc.waitFor(message => message.method === 'thread/started' && message.params?.threadId === a.id, 10000, 'reader process identity');
  assert.notEqual(readerStarted.params.serverId, writerStarted.params.serverId, 'reader and writer must be separate app-server instances');
  await run(a.id, 'A1');
  await version(2);
  const second = await writer.request('plugin/install', { path: source });
  assert.notEqual(first.plugin.root, second.plugin.root);
  await run(a.id, 'A still version 1');
  const b = (await rpc.request('thread/start', {})).thread;
  await run(b.id, 'B version 2');
  assert.equal(await readFile(resolve(workspace, 'version-count'), 'utf8'), '112');
  await writer.request('plugin/disable', { pluginId: second.plugin.id });
  const disabled = (await rpc.request('thread/start', {})).thread;
  await run(disabled.id, 'Disabled for new conversation');
  assert.equal(await readFile(resolve(workspace, 'version-count'), 'utf8'), '112');
  await run(a.id, 'A remains bound while disabled');
  await writer.request('plugin/enable', { pluginId: second.plugin.id });
  const enabled = (await rpc.request('thread/start', {})).thread;
  await run(enabled.id, 'Enabled for new conversation');
  assert.equal(await readFile(resolve(workspace, 'version-count'), 'utf8'), '11212');

  await assert.rejects(writer.request('plugin/uninstall', { pluginId: second.plugin.id, purgeData: true }), /busy/);
  assert.ok(writer.messages().some(message => message.error?.data?.kind === 'busy'));
  await writer.request('plugin/uninstall', { pluginId: second.plugin.id, purgeData: false });
  const c = (await rpc.request('thread/start', {})).thread;
  await run(c.id, 'C without plugin');
  await run(a.id, 'A after uninstall');
  await run(b.id, 'B after uninstall');
  assert.equal(await readFile(resolve(workspace, 'version-count'), 'utf8'), '1121212');
  assert.ok(await stat(first.plugin.root));
  assert.ok(await stat(second.plugin.root));
  for (const thread of [a, b, c, disabled, enabled]) await rpc.request('thread/delete', { threadId: thread.id });
  await writer.request('plugin/list', { all: true });
  assert.equal(await stat(first.plugin.root).then(() => true, () => false), false, 'released old version is reclaimed');
  assert.equal(await stat(second.plugin.root).then(() => true, () => false), false, 'released uninstalled version is reclaimed');
  // An async hook owns its version even after its originating thread is removed.
  await writeFile(resolve(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'version-demo', version: '3.0.0', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', shell: 'bash', command: 'bash "${CLAUDE_PLUGIN_ROOT}/run.sh"', timeout: 30, async: true }] }] } }));
  await writeFile(resolve(source, 'payload.txt'), 'ASYNC_VERSION3');
  await writeFile(resolve(source, 'run.sh'), 'while [ ! -f release-async ]; do sleep 0.01; done\ncat "${CLAUDE_PLUGIN_ROOT}/payload.txt" > async-result\n');
  const third = await writer.request('plugin/install', { path: source });
  const d = (await rpc.request('thread/start', {})).thread;
  await run(d.id, 'D starts detached hook');
  await writer.request('plugin/uninstall', { pluginId: third.plugin.id, purgeData: false });
  const e = (await rpc.request('thread/start', {})).thread;
  await rpc.request('thread/delete', { threadId: d.id });
  await writer.request('plugin/list', { all: true });
  assert.ok(await stat(third.plugin.root), 'detached hook must keep its immutable version');
  await writeFile(resolve(workspace, 'release-async'), 'go');
  await waitFor(async () => (await readFile(resolve(workspace, 'async-result'), 'utf8').catch(() => '')) === 'ASYNC_VERSION3', 10000, 'async hook reads retained support file');
  await waitFor(async () => {
    await writer.request('plugin/list', { all: true });
    return !(await stat(third.plugin.root).then(() => true, () => false));
  }, 10000, 'finished async hook releases version');
  await rpc.request('thread/delete', { threadId: e.id });
  return { oldVersionPreserved: true, asyncResourcesPreserved: true, independentAppServerWriter: true, newConversationUsesUpdate: true, disableIsSnapshotScoped: true, pluginRootContainsSpaces: true, ordinaryUninstallPreservesReaders: true, purgeWhileBusyRejected: true, releasedVersionsReclaimed: true };
});
