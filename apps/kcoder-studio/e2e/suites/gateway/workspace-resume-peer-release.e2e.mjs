import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { login } from '../../harness/http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, isTurnCompletion, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'workspace-resume-after-idle-peer-disconnect',
  tier: 'full-integration',
  modelPolicy: 'Two real local app-server processes and one deterministic response to persist an owned thread; no live model.',
  retainSuccessEvidence: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'current KCoder app-server');
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'The owned thread is saved.' });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'duplicate-broker' });
  const config = context.pathInState('config');
  await context.writeStateJson('config/settings.json', {
    active_provider: 'owned-fixture', permission_mode: 'bypass', max_retries: 0,
    session_memory: { enabled: false },
    providers: { 'owned-fixture': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'owned-fixture', context_window_tokens: 128000,
      max_output_tokens: 4096, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } },
  });
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Owned local', transport: 'local', command: binary, workspace },
  ]);
  const gateway = await startGateway(context, {
    auth: true, workspace, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: config },
  });
  const cookie = await login(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' });
  const url = new URL(gatewayRpcUrl(gateway, 'local', token));
  url.searchParams.set('workspace', workspace);
  const connect = async label => {
    const rpc = await openRpc(url.toString(), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close ${label} RPC`, () => closeRpcAndWait(rpc, label));
    return rpc;
  };
  // The first connection holds an uninitialized broker. The second must use a
  // separate process until the first backend's sharing capability is known.
  const first = await connect('first');
  const second = await connect('second');
  await initializeRpc(second, 'owned-second');
  const threadId = (await second.request('thread/start', {})).thread.id;
  assert.ok(threadId);
  const { turn } = await second.request('turn/start', {
    threadId, input: [{ type: 'text', text: 'Persist the owned thread.' }],
  });
  const completed = await second.waitFor(message => isTurnCompletion(message, threadId, turn.id),
    45_000, 'the owned thread to be persisted');
  assert.equal(completed.params.turn.status, 'completed');
  assert.equal(model.requests.length, 1);
  await initializeRpc(first, 'owned-first');

  let nextId = 0;
  const resume = async () => {
    const id = `owned-resume-${++nextId}`;
    first.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'thread/resume', params: { threadId } }));
    return first.waitFor(message => message.id === id, 10_000, 'owned thread/resume response');
  };
  const whileOwned = await resume();
  assert.equal(whileOwned.error?.code, -32022);
  assert.match(whileOwned.error.message, /^session is already active in another app-server:/);
  assert.equal((await second.request('thread/goal/get', { threadId })).threadId, threadId,
    'an active peer must remain usable after the conflict');

  await closeRpcAndWait(second, 'second');
  let conflicts = 0;
  const resumed = await waitFor(async () => {
    const response = await resume();
    if (!response.error) return response.result;
    assert.equal(response.error.code, -32022);
    assert.match(response.error.message, /^session is already active in another app-server:/);
    conflicts += 1;
    return false;
  }, 15_000, 'the original thread to resume after its idle peer disconnects', 200, context.abortSignal);
  assert.equal(resumed.thread?.id, threadId);
  assert.equal((await first.request('thread/goal/get', { threadId })).threadId, threadId);
  await context.writeArtifactJson('peer-resume-evidence.json', {
    schemaVersion: 1, sameOriginalThread: true, activePeerProtected: true, conflicts,
    limitation: 'This fixture proves an idle local peer can exit; active work and remote transports require their own tests.',
  });
  return { sameOriginalThread: true, activePeerProtected: true };
});
