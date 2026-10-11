import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Real HTTP transport counter, deterministic model tool selection. This checks
// authorization of already registered tools, not model behavior or answer quality.
await runE2E(import.meta.url, {
  testId: 'mcp-project-trust-revocation-live-transport', tier: 'full-integration',
  modelPolicy: 'model-independent real MCP HTTP and retained tool registry',
}, async context => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (raw.length > 1_048_576) throw new Error('oversized fixture request'); }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      const rpc = JSON.parse(raw);
      if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
      if (rpc.method === 'tools/call') calls += 1;
      const result = rpc.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'trust-probe', version: '1' } }
        : rpc.method === 'tools/list' ? { tools: [{ name: 'trust_probe', description: 'Trust probe fixture', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'PROBE_CALLED' }] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.addCleanup('close trust MCP fixture', async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; });
  context.registerPort('trust-mcp', server.address().port);
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'mcp-trust' });
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    const latestUser = body.messages.findLastIndex(message => message.role === 'user' && /MCP_TRUST_(FIRST|REVOKED|RESTORED)/.test(JSON.stringify(message.content)));
    if (body.messages.slice(latestUser + 1).some(message => message.role === 'tool')) return [{ delta: { role: 'assistant', content: 'Fixture complete.' }, finishReason: 'stop' }];
    const tools = body.tools.filter(tool => tool.function.name.endsWith('trust_probe'));
    assert.equal(tools.length, 2, 'the existing thread retains configured and plugin MCP definitions');
    return [{ delta: { role: 'assistant', tool_calls: tools.map((tool, index) => ({ index, id: `trust-call-${index}`, type: 'function', function: { name: tool.function.name, arguments: '{}' } })) }, finishReason: 'tool_calls' }];
  } });
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', context_window_tokens: 64000, max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true } } });
  await context.writeStateJson('config/credentials.json', {});
  await context.writeStateJson('config/trusted-folders.json', { trusted: [workspace], never: [] });
  await mkdir(resolve(workspace, '.kcoder'), { recursive: true });
  await writeFile(resolve(workspace, '.kcoder/settings.json'), JSON.stringify({ mcp_servers: [{ name: 'project-probe', transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` }] }));
  const pluginRoot = resolve(workspace, '.kcoder/plugins/project-probe');
  await mkdir(resolve(pluginRoot, '.claude-plugin'), { recursive: true });
  await writeFile(resolve(pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'project-probe', version: '1.0.0', mcpServers: { probe: { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` } } }));
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'MCP trust', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: context.pathInState('config') } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close MCP trust RPC', () => rpc.close());
  await initializeRpc(rpc, 'mcp-project-trust');
  const { thread } = await rpc.request('thread/start', {});
  const turn = async text => {
    const before = new Set(rpc.messages());
    const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] });
    return rpc.waitFor(message => !before.has(message) && message.method === 'turn/completed' && message.params?.turnId === turn.id, 45000, 'MCP trust turn');
  };
  await turn('MCP_TRUST_FIRST');
  assert.equal(calls, 2);
  await rpc.request('plugin/trust/set', { path: workspace, action: 'revoke' });
  await turn('MCP_TRUST_REVOKED');
  assert.equal(calls, 2, 'retained registry must not call the revoked MCP transport');
  assert.ok(JSON.stringify(model.requests.at(-1)).includes('trust was revoked'));
  await rpc.request('plugin/trust/set', { path: workspace, action: 'trust' });
  await turn('MCP_TRUST_RESTORED');
  assert.equal(calls, 4);
  await rpc.request('thread/delete', { threadId: thread.id });
  return { mcpCalls: calls, retainedRegistryGuarded: true, explicitRestore: true };
});
