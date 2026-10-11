import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// QA: owned plugin requiring a synthetic private field; stale identity rejection,
// next-turn injection, real MCP invocation, parsed skill and executed Hook facts,
// disable/uninstall. Model selection is fixed; no autonomy/third-party claim.
await runE2E(import.meta.url, { testId: 'plugin-private-next-turn-runtime-lifecycle', tier: 'full-integration',
  modelPolicy: 'model-independent real Gateway/app-server/MCP/Hook/skill transport' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'plugin-private' });
  const source = context.pathInState('private-plugin');
  const counter = context.pathInState('private-probe.count');
  const controlCounter = context.pathInState('unchanged-server.count');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true });
  await mkdir(resolve(source, 'skills/probe'), { recursive: true });
  await writeFile(resolve(source, 'server.cjs'), await readFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/plugin-private-probe-mcp.cjs')));
  await writeFile(resolve(source, 'skills/probe/SKILL.md'), '---\nname: private-lifecycle-probe\ndescription: Owned parsed skill fixture\n---\nUse the existing private_probe tool.\n');
  await writeFile(resolve(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'private-lifecycle', version: '1.0.0', skills: './skills',
    mcpServers: { private: { type: 'stdio', command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/server.cjs', counter],
      env: { FOO: '${FOO}' } } },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', shell: 'bash', command: 'true', timeout: 5 }] }] } }));
  let called = false; let inspected = false;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    const tool = body.tools?.find(item => item.function?.name?.includes('private_probe'))?.function?.name;
    if (tool && !called) { called = true; return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'private-probe-call', type: 'function',
      function: { name: tool, arguments: '{}' } }] } }, { finishReason: 'tool_calls' }]; }
    if (tool && called && !inspected) { inspected = true; return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'private-config-read', type: 'function',
      function: { name: 'Config', arguments: JSON.stringify({ setting: 'mcp_servers' }) } }] } }, { finishReason: 'tool_calls' }]; }
    return [{ delta: { role: 'assistant', content: 'Protocol fixture completed.' } }, { finishReason: 'stop' }];
  } });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo',
    mcp_servers: [{ name: 'unchanged-control', transport: 'stdio', command: process.execPath, args: [resolve(source, 'server.cjs'), controlCounter, 'control'] }],
    max_retries: 0, tools: { profile: 'full' }, providers: { fixture: { api_format: 'openai_chat_completions',
      authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'model', context_window_tokens: 100000,
      max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true } } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned plugin lifecycle', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: profile, RUST_LOG: 'debug' } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close private plugin RPC', () => rpc.close());
  await initializeRpc(rpc, 'private-plugin-lifecycle');
  const installed = await rpc.request('plugin/install', { path: source });
  const id = installed.plugin.id;
  const before = await rpc.request('plugin/activation/read', { pluginId: id });
  assert.equal(before.phase, 'credentials_required');
  assert.deepEqual(before.components[0].missingNames, ['FOO']);
  const thread = (await rpc.request('thread/start', { cwd: workspace })).thread;
  const run = async text => {
    const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] });
    const completed = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.id, 45000, 'owned plugin turn');
    assert.equal(completed.params.turn.status, 'completed');
  };
  await run('Before private configuration.');
  const controlStarts = await readFile(controlCounter + '.starts', 'utf8');
  await assert.rejects(rpc.request('plugin/credentials/configure', { pluginId: id, values: { FOO: 'p09-public-synthetic-fixture' },
    expectedOperationId: installed.plugin.operationId, expectedGeneration: 0 }), /scope_changed/);
  const configured = await rpc.request('plugin/credentials/configure', { pluginId: id, values: { FOO: 'p09-public-synthetic-fixture' },
    expectedOperationId: installed.plugin.operationId, expectedGeneration: installed.generation });
  assert.equal(configured.effectiveFrom, 'next_turn');
  assert.deepEqual(configured.missingNames, []);
  await run('Check the private protocol fixture.');
  assert.equal(await readFile(counter, 'utf8'), 'x', 'actual tool process must run once');
  assert.equal(await readFile(controlCounter + '.starts', 'utf8'), controlStarts, 'unchanged MCP server must not reconnect for another plugin credential change');
  assert.ok(inspected, 'actual Config tool must read the model-facing MCP settings');
  const safeMcp = await rpc.request('mcp/list', {});
  assert.equal(JSON.stringify(safeMcp).includes('p09-public-synthetic-fixture'), false);
  const active = await rpc.request('plugin/activation/read', { pluginId: id, threadId: thread.id });
  assert.equal(active.threadId, thread.id);
  assert.ok(active.components.some(item => item.kind === 'mcp' && item.phase === 'usable' && item.toolCount > 0));
  assert.ok(active.components.some(item => item.kind === 'skill' && item.phase === 'usable'));
  assert.ok(active.components.some(item => item.kind === 'hook' && item.phase === 'usable'));
  assert.equal(JSON.stringify(rpc.messages()).includes('p09-public-synthetic-fixture'), false, 'secrets never enter transcript/events');
  assert.equal(JSON.stringify(model.requests).includes('p09-public-synthetic-fixture'), false, 'schema, Config and tool data are safe in the actual model request');
  const logs = await readFile(resolve(context.logsDir, 'gateway.log'), 'utf8');
  assert.equal(logs.includes('p09-public-synthetic-fixture'), false, 'untrusted serverInfo never reaches debug logging');
  assert.equal(logs.includes('c-synthetic-fixture'), false, 'split/multiline private stderr never reaches logging');
  await rpc.request('plugin/disable', { pluginId: id });
  assert.equal((await rpc.request('plugin/activation/read', { pluginId: id })).phase, 'disabled');
  await rpc.request('thread/delete', { threadId: thread.id });
  await rpc.request('plugin/uninstall', { pluginId: id });
  assert.equal((await rpc.request('plugin/list', { all: true })).plugins.some(item => item.id === id), false);
  await context.writeArtifactJson('plugin-private-results.json', { staleCasRejected: true, privateNextTurn: true,
    actualMcpCallCount: 1, unchangedServerReused: true, modelConfigAndMcpSummaryPrivate: true, observedSkillAndHook: true, disabled: true, uninstalled: true });
});
