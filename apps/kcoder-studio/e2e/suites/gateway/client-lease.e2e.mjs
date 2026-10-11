import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, { testId: 'gateway-client-liveness-expiry', tier: 'full-integration',
  modelPolicy: 'model-independent real WebSocket ping lease and owner cleanup check' }, async context => {
  const kcoderBin = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'client-lease' });
  const configDir = context.pathInState('config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson('config/settings.jsonc', {});
  const serversFile = await context.writeStateJson('servers.jsonc', [{ id: 'local', label: 'Local', transport: 'local', command: kcoderBin, workspace }]);
  const gateway = await startGateway(context, { kcoderBin, workspace, serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_SCENARIO: 'markdown-showcase', KCODER_STUDIO_APP_SERVER_IDLE_MS: '250' } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const silent = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close silent RPC', () => silent.close());
  await initializeRpc(silent, 'silent-lease');
  const healthy = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close healthy RPC', () => healthy.close());
  await initializeRpc(healthy, 'healthy-lease');
  const before = await healthy.request('server/resources/read');
  let suppressedPongs = 0;
  const write = silent.socket.socket.write.bind(silent.socket.socket);
  // Keep TCP connected while deliberately withholding protocol pong acknowledgments.
  silent.socket.socket.write = (chunk, ...args) => {
    if (Buffer.isBuffer(chunk) && (chunk[0] & 0x0f) === 10) { suppressedPongs++; return true; }
    return write(chunk, ...args);
  };
  const startedAt = Date.now();
  await waitFor(() => silent.socket.readyState === 3, 70_000, 'silent client lease expiry', 100, context.abortSignal);
  assert.ok(suppressedPongs > 0, 'a real ping must have been received');
  assert.ok(Date.now() - startedAt >= 50_000, 'expiry must follow the production lease, not an incidental close');
  assert.equal(healthy.socket.readyState, 1);
  assert.equal((await healthy.request('server/resources/read')).instanceId, before.instanceId);
  healthy.close();
  await waitFor(() => {
    try { process.kill(before.processId, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 10_000, 'backend exit after the healthy client closes', 50, context.abortSignal);
  return { silentLeaseExpired: true, healthyClientPreserved: true, backendExited: true };
});
