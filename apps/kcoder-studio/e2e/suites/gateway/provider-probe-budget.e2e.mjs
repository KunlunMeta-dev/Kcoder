import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// M07/M08: actual save -> strict Anthropic endpoint -> persisted profile -> turn.
// Invalid candidates preserve files and never reach HTTP. No paid model requests.
await runE2E(import.meta.url, {
  testId: 'provider-probe-budget-and-production-parameters',
  tier: 'full-integration',
  modelPolicy: 'model-independent loopback Anthropic HTTP/SSE, configuration and persistence',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'probe-budget' });
  const fixture = await startApprovalModelFixture(context, { protocol: 'anthropic', textOnlyResponse: 'BUDGET_OK' });
  const endpoint = new URL(fixture.baseUrl).origin;
  const profile = context.pathInState('profile');
  const key = `fixture-${randomBytes(16).toString('hex')}`;
  context.registerSecret(key);
  await context.writeStateJson('profile/settings.json', {
    active_provider: 'budget', tools: { disabled: ['*'] }, max_retries: 0,
    providers: { budget: { api_format: 'anthropic_messages', endpoint, default_model: 'model-A',
      context_window_tokens: 100000, output_headroom_tokens: 32768, max_output_tokens: 32768, no_proxy: true } },
  });
  await context.writeStateJson('profile/credentials.json', { budget: { type: 'api', key } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'budget', label: 'Budget fixture', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: profile } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const connect = async () => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'budget', token));
    context.addCleanup('close budget RPC', () => rpc.close());
    await initializeRpc(rpc, 'probe-budget');
    return rpc;
  };
  let rpc = await connect();
  const body = { thinking: { type: 'enabled', budget_tokens: 16000 }, max_tokens: 32768 };
  const params = { id: 'budget', model: 'model-A', makeDefault: true, apiFormat: 'anthropic_messages', endpoint,
    contextWindowTokens: 100000, maxOutputTokens: 32768, modelExtraBody: body };
  await rpc.request('runtime.providers.upsert', params, 30000);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].max_tokens, 8192);
  assert.equal(fixture.requests[0].thinking.budget_tokens, 8191);
  const snapshot = async () => Promise.all(['settings.json', 'credentials.json'].map(name => readFile(resolve(profile, name), 'utf8')));
  const saved = await snapshot();
  assert.deepEqual(JSON.parse(saved[0]).providers.budget.models['model-A'].extra_body, body);
  for (const invalid of [{ messages: [] }, { vendor: 'x'.repeat(65536) }, { thinking: { type: 'enabled', budget_tokens: 32768 } }]) {
    await assert.rejects(rpc.request('runtime.providers.upsert', { ...params, modelExtraBody: invalid }, 30000));
    assert.deepEqual(await snapshot(), saved);
    assert.equal(fixture.requests.length, 1, 'invalid input must not reach the endpoint');
  }
  await rpc.request('gateway/app-server/restart', { confirm: true }, 30000);
  rpc.close();
  rpc = await connect();
  const turn = async () => {
    const { thread } = await rpc.request('thread/start', { cwd: workspace, model: 'budget::model-A' });
    const { turn } = await rpc.request('turn/start', { threadId: thread.id, model: 'budget::model-A', input: [{ type: 'text', text: 'Reply OK.' }] });
    const done = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.id && message.params?.threadId === thread.id, 30000, 'budget turn');
    assert.equal(done.params.turn.status, 'completed');
    await rpc.request('thread/delete', { threadId: thread.id });
  };
  await turn();
  assert.equal(fixture.requests.at(-1).max_tokens, 32768);
  assert.deepEqual(fixture.requests.at(-1).thinking, body.thinking);
  await rpc.request('runtime.providers.upsert', { ...params, modelExtraBody: {} }, 30000);
  assert.equal(fixture.requests.at(-1).max_tokens, 256);
  assert.equal(fixture.requests.at(-1).thinking, undefined);
  await turn();
  assert.equal(fixture.requests.at(-1).thinking, undefined);
  assert.equal(fixture.requests.length, 4);
  return { probeOutput: 8192, probeThinking: 8191, productionOutput: 32768, productionThinking: 16000,
    rejectedCandidatesPreserveFiles: true, restartPreservesProductionParameters: true, clearDoesNotResurrect: true, requests: fixture.requests.length };
});
