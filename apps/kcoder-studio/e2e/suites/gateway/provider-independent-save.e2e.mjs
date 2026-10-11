import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Protocol and persistence evidence only: bounded loopback Provider fixtures,
// actual Gateway/app-server requests, no model quality or paid inference claim.
await runE2E(import.meta.url, {
  testId: 'provider-independent-save-revision-and-effective-values',
  tier: 'full-integration',
  modelPolicy: 'model-independent loopback HTTP/SSE, offline save and CAS',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'independent-save' });
  const overload = await startApprovalModelFixture(context, {
    httpErrorPrompt: 'Reply only OK.', httpErrorStatus: 529, httpErrorCode: 'overloaded_error',
  });
  let held = false;
  let release = false;
  const healthy = await startApprovalModelFixture(context, { responseSteps: () => [
    { ready: () => !held || release, delta: { role: 'assistant', content: 'OK' } },
    { finishReason: 'stop' },
  ] });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {
    active_provider: 'fixture', max_tokens: 8192, max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: healthy.baseUrl,
      default_model: 'model', authentication: { mode: 'none' }, no_proxy: true,
      context_window_tokens: 1000000, output_headroom_tokens: 65536, max_output_tokens: 65536 } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local', label: 'Independent save fixture', transport: 'local', command: binary, workspace,
  }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: profile } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close independent provider RPC', () => rpc.close());
  await initializeRpc(rpc, 'provider-independent-save');
  const unscoped = await rpc.request('runtime.providers.list', {});
  assert.equal(unscoped.currentTurnConfiguration, undefined, 'bootstrap Engine is not a conversation snapshot');
  const { thread } = await rpc.request('thread/start', { cwd: workspace, model: 'fixture::model' });
  // A new thread has selected a profile, but has not accepted a turn yet.
  // Establish the actual next-turn resolver/frozen snapshot before comparing it.
  const firstTurn = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'ESTABLISH_ACCEPTED_MODEL_SNAPSHOT' }] });
  const snapshotCompletion = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === firstTurn.turn.id,
    15000, 'accepted model snapshot turn completion');
  await context.writeArtifactJson('snapshot-turn.json', { completion: snapshotCompletion, notifications: rpc.messages().filter(message => message.method === 'error') });
  assert.equal(healthy.requests[0].max_tokens, 8192, 'accepted request honors actual user root output limit');
  const list = await rpc.request('runtime.providers.list', { threadId: thread.id });
  assert.equal(list.supportsIndependentProbe, true);
  const row = list.profiles.find(item => item.id === 'fixture' && item.model === 'model');
  assert.equal(row.profileConfiguration.maxOutputTokens, 65536);
  assert.equal(row.nextTurnConfiguration.maxOutputTokens, 8192);
  assert.equal(list.currentTurnConfiguration.maxOutputTokens, 8192);
  const input = { threadId: thread.id, id: 'fixture', model: 'model', originalModel: 'model',
    apiFormat: 'openai_chat_completions', authentication: { mode: 'none' },
    endpoint: overload.baseUrl, contextWindowTokens: 1000000, maxOutputTokens: 65536,
    validateConnection: false, expectedRevision: list.revision };
  const saved = await rpc.request('runtime.providers.upsert', input);
  assert.equal(overload.requests.length, 0, 'saving must not contact the upstream API');
  const before = await readFile(resolve(profile, 'settings.json'), 'utf8');
  const failed = await rpc.request('runtime.providers.probe', {
    threadId: thread.id, id: 'fixture', model: 'model', expectedRevision: saved.savedRevision,
    expectedConfigurationRevision: saved.profiles.find(item => item.id === 'fixture').nextTurnConfiguration.revision,
  });
  assert.equal(failed.success, false);
  assert.equal(failed.errorType, 'overloaded');
  assert.equal(failed.revision, saved.savedRevision);
  assert.equal(await readFile(resolve(profile, 'settings.json'), 'utf8'), before);
  await assert.rejects(rpc.request('runtime.providers.probe', {
    threadId: thread.id, id: 'fixture', model: 'model', expectedRevision: 'stale-revision',
  }), /changed|reload|revision/i);
  assert.equal(overload.requests.length, 1, 'stale input must not issue a request');
  const clear = await rpc.request('runtime.providers.clearUserOverride', {
    threadId: thread.id, field: 'max_tokens', expectedRevision: saved.revision,
  });
  assert.equal(clear.profiles.find(item => item.id === 'fixture').nextTurnConfiguration.maxOutputTokens, 65536);
  assert.equal(clear.currentTurnConfiguration.maxOutputTokens, 8192, 'accepted session snapshot remains pinned');
  const connected = await rpc.request('runtime.providers.upsert', {
    ...input, endpoint: healthy.baseUrl, expectedRevision: clear.savedRevision,
  });
  const ok = await rpc.request('runtime.providers.probe', {
    threadId: thread.id, id: 'fixture', model: 'model', expectedRevision: connected.savedRevision,
  });
  assert.equal(ok.success, true);
  held = true;
  const offset = healthy.requests.length;
  const pending = rpc.request('runtime.providers.probe', {
    threadId: thread.id, id: 'fixture', model: 'model', expectedRevision: connected.revision,
  });
  // Install the rejection handler before mutating to avoid unhandled rejection.
  const rejected = assert.rejects(pending, /changed|refresh/i);
  await waitFor(() => healthy.requests.length > offset, 10000, 'held provider test request');
  const newer = await rpc.request('runtime.providers.upsert', {
    ...input, endpoint: healthy.baseUrl, maxOutputTokens: 32768,
    expectedRevision: connected.revision,
  });
  release = true;
  await rejected;
  assert.notEqual(newer.savedRevision, connected.revision);
  assert.equal(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')).providers.fixture.max_output_tokens, 32768);
  return { offlineSaveContacts: 0, overloadRetainedRevision: true, actualOutput: [65536, 8192],
    snapshotPreserved: true, staleProbeRejected: true, concurrentEditInvalidatesProbe: true };
});
