import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { startOAuthMcpFixture } from '../../harness/oauth-mcp.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'mcp-manual-client-no-registration-and-retry',
  tier: 'full-integration',
  modelPolicy: 'model-independent real Gateway/app-server/OAuth fixture; no model requests',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'manual-oauth' });
  const secret = randomBytes(24).toString('hex');
  context.registerSecret(secret);
  const tokenResponseFields = {};
  const fixture = await startOAuthMcpFixture(context, {
    tokenResponseFields,
    manualClient: { id: 'manual-client', secret, method: 'client_secret_basic' },
  });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {
    providers: {}, mcp_servers: [{ name: 'manual', transport: 'http', url: fixture.root + '/mcp' }],
  });
  const binary = resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.jsonc', [{ id: 'local', label: 'Manual OAuth', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: profile } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close manual OAuth RPC', () => rpc.close());
  await initializeRpc(rpc, 'manual-oauth');
  await assert.rejects(rpc.request('gateway/mcp/login', { server: { name: 'manual' } }), /client|registration/i);
  for (const [clientSecret, expected] of [['invalid-fixture-secret', 'failed'], [secret, 'authorized']]) {
    context.registerSecret(clientSecret);
    const login = await rpc.request('gateway/mcp/login', {
      server: { name: 'manual' }, clientId: 'manual-client',
      clientAuthentication: 'client_secret_basic', clientSecret,
    });
    context.registerSecret(login.authorizationUrl);
    const redirect = new URL(login.authorizationUrl).searchParams.get('redirect_uri');
    assert.equal(redirect, gateway.baseUrl + '/oauth/mcp/callback');
    const response = await fetch(login.authorizationUrl);
    assert.equal(response.status, expected === 'authorized' ? 200 : 502);
    const pageText = await response.text();
    if (expected === 'authorized') assert.match(pageText, /授权已保存/);
    else assert.match(pageText, /token_exchange_failed; invalid_client; HTTP 401/);
    const completion = await rpc.waitFor(message => message.method === 'mcp/authorizationChanged' && message.params.flowId === login.flowId,
      15000, 'manual OAuth result');
    assert.equal(completion.params.status, expected);
  }
  assert.equal((await rpc.request('mcp/list')).servers[0].authorization, 'authorized');
  assert.ok(!JSON.stringify(rpc.messages()).includes(secret));
  assert.ok(fixture.events.includes('invalid-client'));
  assert.ok(!fixture.events.includes('register'));
  await rpc.request('mcp/logout', { name: 'manual' });
  assert.equal((await rpc.request('mcp/list')).servers[0].authorization, 'notAuthorized');
  tokenResponseFields.scope = ['private-synthetic-scope'];
  const malformed = await rpc.request('gateway/mcp/login', {
    server: { name: 'manual' }, clientId: 'manual-client',
    clientAuthentication: 'client_secret_basic', clientSecret: secret,
  });
  context.registerSecret(malformed.authorizationUrl);
  const malformedResponse = await fetch(malformed.authorizationUrl);
  assert.equal(malformedResponse.status, 502);
  const diagnostic = await malformedResponse.text();
  assert.match(diagnostic, /token_response_invalid/);
  assert.match(diagnostic, /scope=array/);
  assert.ok(!diagnostic.includes('private-synthetic-scope'));
  assert.equal((await rpc.request('mcp/list')).servers[0].authorization, 'notAuthorized');
  await context.writeArtifactJson('manual-oauth-results.json', { wrongSecretRejected: true, retryAuthorized: true, stableCallback: true, noDynamicRegistration: true, events: fixture.events });
});
