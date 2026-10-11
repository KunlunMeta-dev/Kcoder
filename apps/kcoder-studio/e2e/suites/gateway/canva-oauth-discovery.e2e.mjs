import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { login as loginGateway } from '../../harness/http.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'canva-live-registration-authorization-entry',
  tier: 'manual-live',
  modelPolicy: 'Explicit live Canva registration and authorization-entry probe; no model request or personal account login',
}, async context => {
  assert.equal(process.env.KCODER_E2E_CANVA_LIVE, '1',
    'UNMET_PREREQUISITE: explicitly enable KCODER_E2E_CANVA_LIVE=1 to register a Canva OAuth client');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'canva' });
  const configDir = context.pathInState('config');
  await context.writeStateJson('config/settings.json', {
    mcp_servers: [{ name: 'canva', transport: 'http', url: 'https://mcp.canva.com/mcp' }],
  });
  const serversFile = await context.writeStateJson('servers.jsonc', [
    { id: 'canva', label: 'Canva live probe', transport: 'local', command: binary, workspace },
  ]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary,
    auth: true, env: { KCODER_CONFIG_DIR: configDir } });
  const cookie = await loginGateway(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie } });
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'canva', token), {
    headers: { Cookie: cookie, Origin: gateway.baseUrl },
  });
  context.addCleanup('close Canva RPC', () => rpc.close());
  await initializeRpc(rpc, 'canva-live-discovery');
  const login = await rpc.request('gateway/mcp/login', { server: { name: 'canva' } }, 60000);
  context.registerSecret(login.authorizationUrl);
  let cancelled = false;
  context.addCleanup('cancel pending Canva authorization', async () => {
    if (!cancelled) await rpc.request('mcp/cancel', { flowId: login.flowId });
  });
  const authorization = new URL(login.authorizationUrl);
  for (const key of ['client_id', 'state', 'code_challenge']) {
    const value = authorization.searchParams.get(key);
    if (value) context.registerSecret(value);
  }
  assert.equal(authorization.origin, 'https://mcp.canva.com');
  assert.equal(authorization.pathname, '/authorize');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('resource'), 'https://mcp.canva.com/mcp');
  const scopes = (authorization.searchParams.get('scope') || '').split(' ');
  assert.ok(scopes.includes('profile:read'));
  assert.ok(scopes.includes('design:content:read'));
  assert.equal(new URL(authorization.searchParams.get('redirect_uri')).origin, gateway.baseUrl);
  const response = await fetch(authorization, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const location = response.headers.get('location');
  if (location) context.registerSecret(location);
  await response.body?.cancel();
  assert.equal(response.status, 302, 'Canva authorization entry must accept the registered client');
  const destination = new URL(location);
  assert.equal(destination.origin, 'https://www.canva.com');
  assert.equal(destination.pathname, '/api/oauth/authorize');
  await rpc.request('mcp/cancel', { flowId: login.flowId });
  cancelled = true;
  await context.writeArtifactJson('canva-live-result.json', {
    actualGatewayAndRuntime: true,
    dynamicRegistrationAccepted: true,
    authorizationEntryAccepted: true,
    resourceMetadataScopesRequested: true,
    pendingFlowCancelled: true,
    personalAccountAuthenticated: false,
    canvaToolCallVerified: false,
  });
});
