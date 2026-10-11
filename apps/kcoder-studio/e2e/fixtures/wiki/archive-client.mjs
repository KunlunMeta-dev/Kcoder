// Owned real Gateway/app-server fixtures for archive persistence, not model behavior.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { waitFor } from '../../harness/run-context.mjs';
export async function archiveClient(context, binary) {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'wiki-archive' });
  const profile = context.pathInState('archive-profile');
  await context.writeStateJson('archive-profile/settings.json', {
    active_provider: 'offline', permission_mode: 'yolo', max_retries: 0,
    knowledge: { enabled: true }, providers: { offline: { api_format: 'openai_chat_completions',
      endpoint: 'http://127.0.0.1:1', default_model: 'offline', context_window_tokens: 128000, max_output_tokens: 4096, output_headroom_tokens: 4096, authentication: { mode: 'none' }, no_proxy: true } },
  });
  const serversFile = await context.writeStateJson('archive-servers.json', [{ id: 'local', label: 'Owned archive fixture', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: profile } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close archive RPC', () => rpc.close());
  const initialized = await initializeRpc(rpc, 'owned-wiki-archive');
  assert.equal(initialized.capabilities?.experimental?.knowledgeArchiveStreamV1, true, 'Matching CLI must advertise the stream archive contract');
  const library = await rpc.request('knowledge/create', { idempotencyKey: 'archive-fixture', name: 'Native archive evidence' });
  const source = await rpc.request('knowledge/source/importText', { libraryId: library.id, idempotencyKey: 'text', title: 'evidence.txt', text: 'Stable immutable evidence for exact archive restoration.' });
  return { workspace, profile, gateway, rpc, token, initialized, library, source };
}
export async function readyExport(rpc, libraryId) {
  const started = await rpc.request('knowledge/archiveTransfer/exportStart', { libraryId });
  const ready = await waitFor(async () => {
    const status = await rpc.request('knowledge/archiveTransfer/status', { transferId: started.transferId });
    if (status.phase === 'failed' || status.phase === 'cancelled') throw new Error(status.error || status.phase);
    return status.phase === 'ready' ? status : null;
  }, 30000, 'bounded archive export');
  assert.equal(started.totalBytes, ready.totalBytes, 'frozen snapshot estimate equals bytes emitted');
  return ready;
}
export async function smallCollectionFixture(context, binary) {
  const client = await archiveClient(context, binary);
  const ready = await readyExport(client.rpc, client.library.id);
  assert.equal(ready.manifest.segments.length, 1);
  assert.ok(ready.totalBytes < 64 * 1024, 'native synthetic picker fixture is explicitly small');
  const part = await client.rpc.request('knowledge/archiveTransfer/read', { transferId: ready.transferId, index: 0, offset: 0 });
  assert.equal(part.eof, true);
  await client.rpc.request('knowledge/archiveTransfer/cancel', { transferId: ready.transferId });
  return { manifest: ready.manifest, bytes: Buffer.from(part.contentBase64, 'base64'), source: client.source };
}
