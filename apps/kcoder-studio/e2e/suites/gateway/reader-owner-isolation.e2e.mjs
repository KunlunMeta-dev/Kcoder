import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, { testId: 'shared-broker-history-reader-does-not-own-active-turn',
  tier: 'full-integration', modelPolicy: 'model-independent real streaming transport, owner cleanup and shared process routing' }, async context => {
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const fixture = await startApprovalModelFixture(context, { textOnly: true,
    delayedRequestNumbers: [2, 3], streamDelayMs: 5000, textOnlyResponse: 'OWNER_COMPLETED' });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'reader-owner' });
  const settings = await context.writeStateJson('config/settings.json', { active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: fixture.baseUrl,
    default_model: 'fixture', context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 8192, no_proxy: true,
  } } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owner fixture', transport: 'local', command: binary, workspace, settingsFile: settings }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: dirname(settings) } });
  const url = gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway));
  const connect = async label => { const rpc = await openRpc(url); context.addCleanup(`close ${label}`, () => rpc.close()); await initializeRpc(rpc, label); return rpc; };
  const owner = await connect('execution-owner');
  const { thread } = await owner.request('thread/start');
  const start = async text => (await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] })).turn;
  const finished = turn => owner.waitFor(m => m.method === 'turn/completed' && m.params?.threadId === thread.id && m.params?.turnId === turn.id, 15000, 'owner completion');
  await finished(await start('Seed history'));
  const active = await start('Owner still working');
  await waitFor(() => fixture.requests.length === 2, 10000, 'held owner request');
  const reader = await connect('temporary-history-reader');
  const processBefore = await owner.request('server/resources/read');
  assert.equal((await reader.request('server/resources/read')).processId, processBefore.processId, 'reader reuses the actual broker process');
  const history = await reader.request('thread/read', { threadId: thread.id });
  assert.ok(JSON.stringify(history).includes('OWNER_COMPLETED'));
  reader.close();
  await waitFor(() => reader.socket.readyState === 3, 5000, 'reader detached');
  const completed = await finished(active);
  assert.equal(completed.params.turn.status, 'completed', 'reader close cannot cancel the owner turn');
  assert.equal(fixture.requests.length, 2, 'reader never triggers a model request');
  const observer = await connect('owner-cleanup-observer');
  const cancelled = await start('Close the real owner');
  await waitFor(() => fixture.requests.length === 3, 10000, 'second held owner request');
  owner.close();
  await waitFor(() => owner.socket.readyState === 3, 5000, 'owner detached');
  await waitFor(async () => {
    const value = await observer.request('thread/read', { threadId: thread.id });
    return value.messages.some(message => message.turnId === cancelled.id && ['interrupted', 'cancelled'].includes(message.status));
  }, 15000, 'owner disconnect persists a terminal turn');
  assert.equal((await observer.request('server/resources/read')).processId, processBefore.processId, 'remaining observer keeps shared process alive');
  await context.writeArtifactJson('reader-owner.json', { sharedProcess: true, readerClosePreservesTurn: true,
    ownerCloseCleansTurn: true, activeTurnId: active.id, cancelledTurnId: cancelled.id, modelRequests: fixture.requests.length });
});
