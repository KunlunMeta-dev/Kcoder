import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Model-independent: hooks must not execute after their project trust is revoked.
// Real shell side effects and HTTP request counts, never model instruction-following.
await runE2E(import.meta.url, {
  testId: 'project-hook-trust-revocation-with-live-thread', tier: 'full-integration',
  modelPolicy: 'model-independent local transport fixture and real project hooks',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'hook-trust' });
  const fixture = await startApprovalModelFixture(context, { responseSteps: () => [
    { delta: { role: 'assistant', content: 'Transport fixture complete.' } }, { finishReason: 'stop' },
  ] });
  const config = context.pathInState('config');
  await context.writeStateJson('config/settings.json', {
    active_provider: 'fixture', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: fixture.baseUrl,
      default_model: 'fixture-model', context_window_tokens: 64000, max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true } },
  });
  await context.writeStateJson('config/credentials.json', {});
  await context.writeStateJson('config/trusted-folders.json', { trusted: [workspace], never: [] });
  const hook = command => [{ hooks: [{ type: 'command', shell: 'bash', command, timeout: 5 }] }];
  const pluginRoot = resolve(workspace, '.kcoder/plugins/demo');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(resolve(workspace, '.kcoder/settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: hook('printf x >> settings-count') } }));
  await writeFile(resolve(pluginRoot, 'plugin.json'), JSON.stringify({ id: 'demo', name: 'demo', hooks: { UserPromptSubmit: hook('printf x >> plugin-count') } }));
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Hook trust', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: config, KCODER_MAX_RETRIES: '0' } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close hook trust RPC', () => rpc.close());
  await initializeRpc(rpc, 'hook-trust-revocation');
  const { thread } = await rpc.request('thread/start', {});
  const turnIds = [];
  const turn = async (text, threadId = thread.id) => {
    const previousMessages = new Set(rpc.messages());
    const { turn } = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text }] });
    turnIds.push(turn.id);
    return rpc.waitFor(message => !previousMessages.has(message) && message.method === 'turn/completed' && message.params?.threadId === threadId && message.params?.turnId === turn.id, 45000, 'hook turn completion');
  };
  assert.equal((await turn('FIRST_TRUSTED')).params.turn.status, 'completed');
  assert.equal(await readFile(resolve(workspace, 'settings-count'), 'utf8'), 'x');
  assert.equal(await readFile(resolve(workspace, 'plugin-count'), 'utf8'), 'x');
  const before = fixture.requests.length;
  await rpc.request('plugin/trust/set', { path: workspace, action: 'revoke' });
  assert.equal((await turn('REVOKED')).params.turn.status, 'failed');
  assert.equal(fixture.requests.length, before, 'revocation blocks hooks before a new model request');
  assert.equal(await readFile(resolve(workspace, 'settings-count'), 'utf8'), 'x');
  assert.equal(await readFile(resolve(workspace, 'plugin-count'), 'utf8'), 'x');
  await rpc.request('plugin/trust/set', { path: workspace, action: 'trust' });
  assert.equal((await turn('RESTORED')).params.turn.status, 'completed');
  assert.equal(await readFile(resolve(workspace, 'settings-count'), 'utf8'), 'xx');
  assert.equal(await readFile(resolve(workspace, 'plugin-count'), 'utf8'), 'xx');
  // Missing script and an intentional exit-2 guard must remain visible, with
  // plugin identity, rather than being swallowed to make installation look usable.
  const source = context.pathInState('faulty plugin');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true });
  const publish = async version => {
    await writeFile(resolve(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'faulty', version: `${version}.0.0`, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', shell: 'bash', command: 'bash "${CLAUDE_PLUGIN_ROOT}/missing script.sh"', timeout: 5 }] }] } }));
    await rpc.request('plugin/install', { path: source });
  };
  await publish(1);
  const missing = (await rpc.request('thread/start', {})).thread;
  const requestCount = fixture.requests.length;
  const missingResult = await turn('MISSING_SCRIPT', missing.id);
  assert.equal(missingResult.params.turn.status, 'failed');
  assert.ok(missingResult.params.error.message.includes('faulty'));
  assert.ok(missingResult.params.error.message.includes('missing script.sh'));
  assert.equal(fixture.requests.length, requestCount);
  await writeFile(resolve(source, 'missing script.sh'), "printf 'intentional fixture block\\n' >&2\nexit 2\n");
  await publish(2);
  const blocked = (await rpc.request('thread/start', {})).thread;
  const blockedResult = await turn('LEGAL_BLOCK', blocked.id);
  assert.equal(blockedResult.params.turn.status, 'failed');
  assert.ok(blockedResult.params.error.message.includes('faulty'));
  assert.ok(blockedResult.params.error.message.includes('intentional fixture block'));
  assert.equal(fixture.requests.length, requestCount, 'a legitimate Hook block must not be bypassed');
  await writeFile(resolve(source, 'missing script.sh'), 'exit 0\n');
  await publish(3);
  const repaired = (await rpc.request('thread/start', {})).thread;
  assert.equal((await turn('REPAIRED', repaired.id)).params.turn.status, 'completed');
  assert.equal(fixture.requests.length, requestCount + 1);
  for (const session of [thread, missing, blocked, repaired]) await rpc.request('thread/delete', { threadId: session.id });

  await context.writeArtifactJson('hook-trust-results.json', { turnIds, modelRequests: fixture.requests.length });
  return { projectSettingsHookRevoked: true, projectPluginHookRevoked: true, existingThreadRechecked: true, explicitRestoreWorks: true, missingScriptDiagnosed: true, legalBlockPreserved: true, newConversationRepairsFault: true };
});
