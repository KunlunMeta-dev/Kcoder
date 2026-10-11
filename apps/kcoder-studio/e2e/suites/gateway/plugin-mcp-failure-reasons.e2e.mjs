import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startActivationMcp } from '../../harness/activation-mcp.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// QA: owned plugin + real MCP peers; one bounded deterministic Provider turn only
// drives mounting. Check typed activation reasons, empty tool safety, no raw error,
// no account/OAuth flow, then exact-owner cleanup. Model quality is outside scope.
await runE2E(import.meta.url, { testId: 'plugin-mcp-safe-activation-reasons', tier: 'full-integration',
  modelPolicy: 'model-independent real Gateway/app-server/MCP transport' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'activation-reasons' });
  const mcp = await startActivationMcp(context);
  const model = await startApprovalModelFixture(context, { textOnlyResponse: 'Transport check finished.' });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo',
    max_retries: 0, tools: { profile: 'full' }, providers: { fixture: { api_format: 'openai_chat_completions',
      authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'model', context_window_tokens: 100000,
      max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true } } });
  const source = context.pathInState('activation-plugin');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true });
  const cases = [ ['a_connection', 'disconnect', 'failed', 'mcp_connection_failed'],
    ['b_protocol', 'protocol', 'failed', 'mcp_protocol_failed'],
    ['c_authorization', 'unauthorized', 'authorization_required', 'mcp_authorization_required'],
    ['d_zero', 'zero', 'mounted', 'mcp_no_tools'], ['z_timeout', 'timeout', 'failed', 'mcp_timeout'] ];
  await writeFile(resolve(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'activation-reasons', version: '1.0.0',
    mcpServers: Object.fromEntries(cases.map(([name, route]) => [name, { type: 'http', url: `${mcp}/${route}` }])) }));
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned activation failure peers', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: profile, RUST_LOG: 'debug' } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close activation RPC', () => rpc.close());
  await initializeRpc(rpc, 'activation-reasons');
  const installed = await rpc.request('plugin/install', { path: source });
  const thread = (await rpc.request('thread/start', { cwd: workspace }, 45000)).thread;
  const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Read-only transport mounting check.' }] }, 45000);
  const completed = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.id, 45000, 'bounded transport check');
  assert.equal(completed.params.turn.status, 'completed');
  const active = await rpc.request('plugin/activation/read', { pluginId: installed.plugin.id, threadId: thread.id });
  for (const [name, , phase, errorCode] of cases) {
    const component = active.components.find(item => item.kind === 'mcp' && item.name.includes(name));
    assert.ok(component, `missing ${name}`);
    assert.equal(component.phase, phase);
    assert.equal(component.errorCode, errorCode);
    if (name === 'c_authorization') assert.equal(component.authorization, 'notAuthorized');
    if (name === 'd_zero') assert.equal(component.toolCount, 0);
  }
  assert.equal(active.components.some(component => component.phase === 'usable'), false);
  const summaries = await rpc.request('mcp/list', {});
  const reasons = summaries.servers.map(server => server.lastConnectionFailure);
  for (const reason of ['connectionFailed', 'protocolFailed', 'authorizationRequired', 'timedOut']) assert.ok(reasons.includes(reason));
  assert.equal(JSON.stringify([active, summaries, rpc.messages(), model.requests]).includes('private-protocol-marker'), false);
  assert.equal((await readFile(gateway.logPath, 'utf8')).includes('private-protocol-marker'), false);
  await rpc.request('thread/delete', { threadId: thread.id });
  await rpc.request('plugin/uninstall', { pluginId: installed.plugin.id });
  await context.writeArtifactJson('activation-reasons.json', { cases: cases.map(([name, , phase, errorCode]) => ({name, phase, errorCode})),
    typedReasons: true, authorizationFacts: true, emptyToolsMountedOnly: true, payloadRedacted: true });
});
