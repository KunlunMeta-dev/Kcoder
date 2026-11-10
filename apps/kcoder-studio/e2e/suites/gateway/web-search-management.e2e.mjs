import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { login } from '../../harness/http.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { WEB_SEARCH_METHODS as M } from '../../../shared/webSearchMethods.mjs';

await runE2E(import.meta.url, {
  testId: 'web-search-management-target-owner-revision-and-read-only-recovery', tier: 'pr-smoke',
  modelPolicy: 'Model-independent actual Gateway/app-server status, explicit probe and receipt ownership. Empty source policy guarantees no external search; no model, service-health, result-quality or native GUI claim.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'search-management' });
  const config = await context.writeStateJson('config/settings.json', { permission_mode: 'bypass', web: { search: { providers: [] } } });
  const restricted = await context.writeStateJson('restricted.json', { tools: { disabled: ['WebSearch'] } });
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'main', label: 'Search management', transport: 'local', command: binary, workspace },
    { id: 'restricted', label: 'Restricted search', transport: 'local', command: binary, workspace, settingsFile: restricted },
  ]);
  const gateway = await startGateway(context, { auth: true, kcoderBin: binary, workspace, serversFile,
    serversStore: context.pathInState('servers-store.json'),
    env: { KCODER_CONFIG_DIR: context.pathInState('config') },
  });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' });
  const connect = async (target, capabilities = true) => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, target, token), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close ${target} search RPC`, () => closeRpcAndWait(rpc));
    const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'search-management-e2e', version: '1' }, capabilities: { experimental: capabilities ? { webSearchStatusV1: true, webSearchProbeV1: true } : {} } });
    assert.equal(initialized.capabilities.experimental.webSearchStatusV1, capabilities);
    return rpc;
  };
  const owner = await connect('main');
  const peer = await connect('main');
  const other = await connect('restricted');
  const legacy = await connect('main', false);
  await assert.rejects(legacy.request(M.status, { mode: 'kcoder' }), /UNSUPPORTED/);
  const status = await owner.request(M.status, { mode: 'kcoder' });
  assert.equal(status.webSearchVisible, true); assert.deepEqual(status.candidates, []);
  const denied = await other.request(M.status, { mode: 'kcoder' });
  assert.equal(denied.webSearchVisible, false);
  const binding = { requestId: 'diagnostic-main', expectedRevision: status.revision };
  assert.equal((await owner.request(M.read, binding)).state, 'unknown');
  assert.equal((await owner.request(M.cancel, binding)).state, 'unknown');
  await assert.rejects(owner.request(M.start, { ...binding, mode: 'kcoder', query: 'private query' }), /unknown field|INVALID_REQUEST/);
  await assert.rejects(owner.request(M.start, { ...binding, requestId: 'stale-diagnostic', expectedRevision: 'stale', mode: 'kcoder' }), /REVISION_CONFLICT/);
  await assert.rejects(other.request(M.start, { requestId: 'denied', expectedRevision: denied.revision, mode: 'kcoder' }), /POLICY_DENIED/);
  await owner.request(M.start, { ...binding, mode: 'kcoder' });
  let receipt;
  await waitFor(async () => { receipt = await owner.request(M.read, binding); return receipt.state !== 'running'; }, 5_000, 'native diagnostic terminal receipt');
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.response.status, 'failed'); assert.deepEqual(receipt.response.attempts, []);
  assert.deepEqual(await owner.request(M.start, { ...binding, mode: 'kcoder' }), receipt);
  assert.equal((await peer.request(M.read, binding)).state, 'unknown');
  assert.equal((await peer.request(M.cancel, binding)).state, 'unknown');
  assert.deepEqual(await owner.request(M.read, binding), receipt);
  assert.equal((await owner.request(M.status, { mode: 'kcoder' })).revision, status.revision);
  return { configOwned: Boolean(config), statusReadNoExternalSearch: true, probeHasNoAllowedSources: true, sameRequestNotReplayed: true, peerIsolation: true, targetPolicy: true, legacyCapability: true };
});
