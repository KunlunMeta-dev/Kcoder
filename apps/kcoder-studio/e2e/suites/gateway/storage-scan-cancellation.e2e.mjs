import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runE2E } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, { testId: 'storage-read-cancellation-does-not-block-or-cancel-other-scans', tier: 'full-integration',
  modelPolicy: 'model-independent real filesystem scan, JSON-RPC cancellation and resource lifetime' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  await context.writeStateJson('profile/settings.json', { providers: {} });
  const profile = context.pathInState('profile');
  const bulk = resolve(profile, 'scan-fixture'); await mkdir(bulk);
  for (let start = 0; start < 8192; start += 64) {
    await Promise.all(Array.from({ length: 64 }, (_, index) => writeFile(resolve(bulk, `${start + index}.txt`), 'fixture')));
  }
  const gateway = await startGateway(context, { workspace, env: { KCODER_CONFIG_DIR: profile } });
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
  context.addCleanup('close scan client', () => rpc.close());
  await initializeRpc(rpc, 'storage-scans');
  await rpc.request('diagnostics/storage/cancel', { scanId: 'cancel-before-dispatch' });
  await assert.rejects(rpc.request('diagnostics/storage/read', { scanId: 'cancel-before-dispatch' }), /storage scan cancelled/);
  const inFlight = rpc.request('diagnostics/storage/read', { scanId: 'active-scan' }).then(value => ({ value }), error => ({ error }));
  const cancellation = await rpc.request('diagnostics/storage/cancel', { scanId: 'active-scan' });
  const outcome = await inFlight;
  if (outcome.error) assert.match(outcome.error.message, /storage scan cancelled/);
  else assert.equal(outcome.value.partial, false, 'completion may win a cancellation race');
  const fresh = await rpc.request('diagnostics/storage/read', { scanId: 'unrelated-scan' });
  assert.ok(fresh.totalFiles >= 8192);
  assert.equal(fresh.partial, false);
  assert.equal(fresh.skippedEntries, 0);
  assert.ok(Number.isFinite(Date.parse(fresh.scannedAt)));
  await assert.rejects(rpc.request('diagnostics/storage/cancel', { scanId: '../invalid' }), /invalid storage scan id/);
  return { earlyCancellationProven: true, inFlightCancelAccepted: cancellation.cancelled,
    inFlightOutcome: outcome.error ? 'cancelled' : 'completed-before-cancel', unrelatedScanComplete: true, files: fresh.totalFiles };
});
