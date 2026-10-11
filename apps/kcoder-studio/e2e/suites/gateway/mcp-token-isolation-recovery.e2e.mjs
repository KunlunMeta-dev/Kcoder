import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startOAuthMcpFixture } from '../../harness/oauth-mcp.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await runE2E(import.meta.url, { testId: 'revoked-mcp-token-does-not-log-out-runtime-or-healthy-service', tier: 'full-integration',
  modelPolicy: 'model-independent OAuth revocation, error classification and explicit reauthorization through real tools' }, async context => {
  let revoked = false;
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'token-scope' });
  const expired = await startOAuthMcpFixture(context, { isTokenRevoked: () => revoked });
  const healthy = await startOAuthMcpFixture(context);
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    if (body.messages.some(message => message.role === 'tool')) return [{ delta: { content: 'TOKEN_SCOPE_DONE' }, finishReason: 'stop' }];
    const tools = body.tools.filter(tool => tool.function?.name.includes('oauth_probe'));
    assert.equal(tools.length, 2, 'both registered service snapshots remain addressable');
    return [{ delta: { role: 'assistant', tool_calls: tools.map((tool, index) => ({ index, id: `token-probe-${index}`, type: 'function', function: { name: tool.function.name, arguments: '{}' } })) }, finishReason: 'tool_calls' }];
  } });
  const home = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024, no_proxy: true } },
    mcp_servers: [{ name: 'expired', transport: 'http', url: expired.root + '/mcp' }, { name: 'healthy', transport: 'http', url: healthy.root + '/mcp' }] });
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: home } });
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
  context.addCleanup('close token recovery RPC', () => rpc.close()); await initializeRpc(rpc, 'mcp-token-scope');
  const pid = (await rpc.request('server/resources/read')).processId;
  const authorize = async name => {
    const flow = await rpc.request('gateway/mcp/login', { server: { name } }); context.registerSecret(flow.authorizationUrl);
    await (await fetch(flow.authorizationUrl)).text();
    const result = await rpc.waitFor(message => message.method === 'mcp/authorizationChanged' && message.params?.flowId === flow.flowId, 15000, 'authorization committed');
    assert.equal(result.params.status, 'authorized');
  };
  await authorize('expired'); await authorize('healthy');
  const create = async () => (await rpc.request('thread/start')).thread.id;
  const first = await create(); const held = await create();
  const run = async threadId => {
    const before = model.requests.length;
    const { turn } = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Check service scope' }] });
    const done = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === threadId && message.params?.turnId === turn.id, 30000, 'service turn complete');
    assert.equal(done.params.turn.status, 'completed');
    return model.requests.slice(before).flatMap(body => body.messages.filter(message => message.role === 'tool'));
  };
  const initial = await run(first); assert.equal(initial.filter(message => String(message.content).includes('OAUTH_TOOL_OK')).length, 2);
  const beforeUnauthorized = expired.events.filter(event => event === 'unauthorized').length;
  revoked = true;
  const results = await run(held);
  assert.equal(results.filter(message => String(message.content).includes('OAUTH_TOOL_OK')).length, 1, 'unrelated service still executes');
  assert.ok(results.some(message => /401|unauthorized|authorization|authenticate/i.test(String(message.content))), 'MCP failure is explicit in its tool result');
  assert.ok(expired.events.filter(event => event === 'unauthorized').length - beforeUnauthorized <= 3, 'revocation must not create an unbounded retry loop');
  assert.equal((await fetch(gateway.baseUrl + '/api/servers')).status, 200, 'MCP error cannot log out Gateway');
  assert.equal((await rpc.request('server/resources/read')).processId, pid);
  revoked = false; await authorize('expired');
  const recovered = await run(await create());
  assert.equal(recovered.filter(message => String(message.content).includes('OAUTH_TOOL_OK')).length, 2);
  assert.equal((await rpc.request('server/resources/read')).processId, pid, 'reauthorization requires no application restart');
  return { revokedServiceIsolated: true, healthyServiceUsable: true, gatewayAuthenticated: true, sameProcessRecovered: true, modelRequests: model.requests.length };
});
