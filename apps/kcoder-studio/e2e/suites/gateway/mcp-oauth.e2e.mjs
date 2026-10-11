import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startOAuthMcpFixture } from '../../harness/oauth-mcp.mjs';
import { login as loginGateway } from '../../harness/http.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'mcp-oauth-browser-relay-new-session',
  tier: 'full-integration',
  modelPolicy: 'model-independent real Gateway/app-server/OAuth/MCP tool roundtrip with synthetic loopback Provider; no model-quality assertions',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'oauth' });
  const fixture = await startOAuthMcpFixture(context, { resourceScopes: ['probe:read'] });
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    if (body.messages.some(message => message.role === 'tool')) {
      return [{ delta: { content: 'OAUTH_TURN_COMPLETE' }, finishReason: 'stop' }];
    }
    const tool = body.tools.find(tool => tool.function?.name.includes('oauth_probe'));
    assert.ok(tool, 'authorized MCP tool must reach the Provider');
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'oauth-probe-call', type: 'function',
      function: { name: tool.function.name, arguments: '{}' } }] }, finishReason: 'tool_calls' }];
  } });
  const configDir = context.pathInState('oauth-home');
  const settings = {
    active_provider: 'fixture',
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl, default_model: 'fixture',
      authentication: { mode: 'none' }, context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024 } },
    mcp_servers: [{ name: 'oauth', transport: 'http', url: fixture.root + '/mcp' }],
  };
  await context.writeStateJson('oauth-home/settings.json', settings);
  const aliasSettings = await context.writeStateJson('alias-settings.json', {
    mcp_servers: [{ name: 'oauth-alias', transport: 'http', url: fixture.root + '/mcp?alias=second' }],
  });
  const serversFile = await context.writeStateJson('servers.jsonc', [
    { id: 'oauth', label: 'OAuth fixture', transport: 'local', command: binary, workspace },
    { id: 'alias', label: 'OAuth alias fixture', transport: 'local', command: binary, workspace, settingsFile: aliasSettings },
  ]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true, env: { KCODER_CONFIG_DIR: configDir } });
  const cookie = await loginGateway(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie } });
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'oauth', token), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup('close OAuth RPC', () => rpc.close());
  await initializeRpc(rpc, 'oauth-e2e');
  assert.equal((await rpc.request('mcp/list')).servers[0].authorization, 'notAuthorized');
  const login = await rpc.request('gateway/mcp/login', { server: { name: 'oauth' } });
  context.registerSecret(login.authorizationUrl);
  const callbackAddress = new URL(new URL(login.authorizationUrl).searchParams.get('redirect_uri'));
  assert.equal(callbackAddress.origin, gateway.baseUrl, 'browser callback uses the reachable Gateway origin');
  const browser = await fetch(login.authorizationUrl);
  const authorizationPage = await browser.text();
  assert.equal(browser.status, 200, authorizationPage);
  const completion = await rpc.waitFor(message => message.method === 'mcp/authorizationChanged' && message.params.flowId === login.flowId,
    15_000, 'OAuth completion');
  assert.equal(completion.params.status, 'authorized');
  assert.equal((await rpc.request('mcp/list')).servers[0].authorization, 'authorized');
  const { thread } = await rpc.request('thread/start', {});
  const catalog = await rpc.request('tools/catalog', { threadId: thread.id });
  assert.ok(JSON.stringify(catalog).includes('oauth_probe'), 'new conversation must discover authorized MCP tools');
  assert.ok(fixture.events.includes('tools/list'));
  rpc.socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'approval/request' && message.id !== undefined) {
      rpc.respond(message.id, { decision: 'accept' });
    }
  });
  const { turn } = await rpc.request('turn/start', {
    threadId: thread.id, input: [{ type: 'text', text: 'Run the owned OAuth probe.' }],
  });
  const completed = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.id,
    20_000, 'OAuth MCP tool turn');
  await context.writeArtifactJson('tool-diagnostics.json', { events: fixture.events, modelRequests: model.requests, messages: rpc.messages() });
  assert.equal(completed.params.turn.status, 'completed', completed.params.error?.message);
  assert.ok(fixture.events.includes('tools/call'));
  assert.ok(model.requests.some(request => JSON.stringify(request.messages).includes('OAUTH_TOOL_OK')));
  const alias = await openRpc(gatewayRpcUrl(gateway, 'alias', token), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup('close alias OAuth RPC', () => alias.close());
  await initializeRpc(alias, 'oauth-alias-e2e');
  assert.deepEqual((await alias.request('mcp/list')).servers.map(server => server.name), ['oauth-alias']);
  const aliasLogin = await alias.request('gateway/mcp/login', { server: { name: 'oauth-alias' } });
  context.registerSecret(aliasLogin.authorizationUrl);
  const aliasBrowser = await fetch(aliasLogin.authorizationUrl);
  assert.equal(aliasBrowser.status, 200);
  await aliasBrowser.text();
  const aliasCompletion = await alias.waitFor(message => message.method === 'mcp/authorizationChanged' && message.params.flowId === aliasLogin.flowId,
    15000, 'alias OAuth completion');
  assert.equal(aliasCompletion.params.status, 'authorized');
  const aliasBefore = await alias.request('thread/start', {});
  assert.ok(JSON.stringify(await alias.request('tools/catalog', { threadId: aliasBefore.thread.id })).includes('oauth_probe'));
  await rpc.request('mcp/logout', { name: 'oauth' });
  assert.equal((await rpc.request('mcp/list')).servers[0].authorization, 'notAuthorized');
  const next = await rpc.request('thread/start', {});
  const afterLogout = await rpc.request('tools/catalog', { threadId: next.thread.id });
  assert.ok(!JSON.stringify(afterLogout).includes('oauth_probe'));
  assert.equal((await alias.request('mcp/list')).servers[0].authorization, 'notAuthorized');
  const aliasAfter = await alias.request('thread/start', {});
  assert.ok(!JSON.stringify(await alias.request('tools/catalog', { threadId: aliasAfter.thread.id })).includes('oauth_probe'),
    'logout in another app-server must invalidate shared-token alias tool caches');
  await alias.request('thread/delete', { threadId: aliasBefore.thread.id });
  await alias.request('thread/delete', { threadId: aliasAfter.thread.id });
  await rpc.request('thread/delete', { threadId: thread.id });
  await rpc.request('thread/delete', { threadId: next.thread.id });
  await context.writeArtifactJson('oauth-results.json', { authorized: true, newSessionTools: true, toolRoundtrip: true, logoutReload: true, crossProcessAliasLogout: true, events: fixture.events });
});
