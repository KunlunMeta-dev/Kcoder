import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Real Native/HTTP health observations; fixed responses do not measure model quality.
await runE2E(import.meta.url, {
  testId: 'model-health-native-http-and-fresh-selection-boundaries',
  tier: 'full-integration',
  modelPolicy: 'Three explicit ordinary native turns use bounded loopback HTTP fixtures. Metadata never generates output. No paid provider, model-quality, same-run fallback, or organization-budget claim.',
}, async context => {
  const binary = await requireExecutable(
    process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    'current native app-server',
  );
  const transient = await startApprovalModelFixture(context, {
    textOnly: true, httpErrorPrompt: 'OWNED_HEALTH_TRANSIENT', httpErrorStatus: 503,
    httpErrorCode: 'overloaded_error', httpErrorMessage: 'private-transient-diagnostic',
  });
  const authentication = await startApprovalModelFixture(context, {
    textOnly: true, httpErrorPrompt: 'OWNED_HEALTH_AUTH', httpErrorStatus: 401,
    httpErrorCode: 'authentication_error', httpErrorMessage: 'private-auth-diagnostic',
  });
  context.registerSecret('private-transient-diagnostic');
  context.registerSecret('private-auth-diagnostic');
  const healthy = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'HEALTHY_OWNED_RESULT' });
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const provider = endpoint => ({
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint,
    default_model: 'one', discover_models: false, no_proxy: true,
    context_window_tokens: 128000, max_output_tokens: 128, output_headroom_tokens: 128,
    capabilities: { text: true, tools: true, vision: false, reasoning: false, structured_output: true },
  });
  const settingsFile = await context.writeStateJson('profile/settings.json', {
    active_provider: 'Healthy', model: 'one', max_retries: 0, max_tokens: 128,
    session_memory: { enabled: false },
    memory: { observer_mode: 'disabled', structured_enabled: false, legacy_prompt_enabled: false },
    providers: { Transient: provider(transient.baseUrl), Authentication: provider(authentication.baseUrl), Healthy: provider(healthy.baseUrl) },
    integrations: { core: { modelPolicies: [
      { id: 'transient-pool', title: 'Transient then healthy', candidates: [{ provider: 'Transient', model: 'one' }, { provider: 'Healthy', model: 'one' }] },
      { id: 'authentication-pool', title: 'Authentication cannot rotate', candidates: [{ provider: 'Authentication', model: 'one' }, { provider: 'Healthy', model: 'one' }] },
    ] } },
  });
  const invalidSettingsFile = await context.writeStateJson('invalid-profile/settings.json', { owned_unknown_setting: true });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'health', label: 'Owned health target', transport: 'local', command: binary, workspace, settingsFile,
  }, {
    id: 'invalid', label: 'Owned invalid settings target', transport: 'local', command: binary, workspace, settingsFile: invalidSettingsFile,
  }]);
  const gateway = await startGateway(context, {
    workspace, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: context.pathInState('profile'), KCODER_TRAINING_MODE: 'true' },
  });
  const token = await waitForGatewayRpcToken(context, gateway);
  const initialize = client => client.request('initialize', {
    protocolVersion: '2026-07-27', clientInfo: { name: 'owned-health-boundaries', version: '1' },
    capabilities: { experimental: { integrationScopeV1: true, modelPoliciesV1: true, modelHealthV1: true } },
  });
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'health', token));
  context.addCleanup('close model health RPC', () => closeRpcAndWait(rpc));
  await initialize(rpc);
  const scope = await rpc.request('integrations/scope/read');
  const envelope = payload => ({ contractVersion: 'parallel-v1', requestId: 'owned-health-read', scope, timeoutMs: 10000, payload });
  const catalog = await rpc.request('integrations/models/readPolicies', envelope({}));
  assert.equal(catalog.status, 'completed');
  const references = Object.fromEntries(catalog.result.policies.map(policy => [policy.reference.id, policy.reference]));
  const health = async id => {
    const result = await rpc.request('integrations/models/readHealth', envelope(references[id]));
    assert.equal(result.status, 'completed');
    return result.result.observations;
  };
  const preview = id => rpc.request('integrations/models/resolveSelection', envelope({
    selection: { kind: 'auto_policy', ...references[id] }, requirements: { inputTokens: 100, outputTokens: 128 },
  }));
  const turn = async (providerId, prompt, status) => {
    const model = `${providerId}::one`;
    const created = await rpc.request('thread/start', { cwd: workspace, model });
    assert.equal(created.thread.model, model);
    const started = await rpc.request('turn/start', { threadId: created.thread.id, model, input: [{ type: 'text', text: prompt }] });
    const done = await rpc.waitFor(message => message.method === 'turn/completed'
      && message.params?.threadId === created.thread.id && message.params?.turnId === started.turn.id, 30000, `${providerId} original turn terminal`);
    assert.equal(done.params.turn.status, status);
    return { threadId: created.thread.id, turnId: started.turn.id, status };
  };
  assert.ok((await health('transient-pool')).every(item => item.state === 'unknown'));
  assert.equal((await preview('transient-pool')).result.model.providerId, 'Transient');
  assert.equal(transient.requests.length + authentication.requests.length + healthy.requests.length, 0);
  const failedTransient = await turn('Transient', 'OWNED_HEALTH_TRANSIENT', 'failed');
  const observations = await health('transient-pool');
  const failure = observations.find(item => item.provider === 'Transient');
  assert.equal(failure.state, 'cooling_down');
  assert.equal(failure.failure.retryable, true);
  const next = await preview('transient-pool');
  assert.equal(next.result.model.providerId, 'Healthy');
  assert.equal(transient.requests.length, 1);
  assert.equal(healthy.requests.length, 0, 'A preview never dispatches its fallback candidate');
  const failedAuthentication = await turn('Authentication', 'OWNED_HEALTH_AUTH', 'failed');
  const authFailure = (await health('authentication-pool')).find(item => item.provider === 'Authentication');
  assert.equal(authFailure.state, 'needs_configuration');
  assert.equal(authFailure.failure.retryable, false);
  await assert.rejects(preview('authentication-pool'), /MODEL_AUTO_CONFIGURATION_BLOCKED/);
  assert.equal(healthy.requests.length, 0, 'Authentication failure must not rotate providers');
  const completed = await turn('Healthy', 'OWNED_HEALTH_SUCCESS', 'completed');
  assert.equal((await health('transient-pool')).find(item => item.provider === 'Healthy').state, 'healthy');
  assert.deepEqual([transient.requests.length, authentication.requests.length, healthy.requests.length], [1, 1, 1]);
  const projected = JSON.stringify({ observations, authFailure });
  assert.ok(!projected.includes('private-transient-diagnostic') && !projected.includes('private-auth-diagnostic'));
  const restarted = await rpc.request('gateway/app-server/restart', { confirm: true });
  assert.equal(restarted.stopped, true);
  await closeRpcAndWait(rpc);
  const fresh = await openRpc(gatewayRpcUrl(gateway, 'health', token));
  context.addCleanup('close restarted model health RPC', () => closeRpcAndWait(fresh));
  await initialize(fresh);
  const freshScope = await fresh.request('integrations/scope/read');
  const reset = await fresh.request('integrations/models/readHealth', {
    ...envelope(references['transient-pool']), scope: freshScope,
  });
  assert.equal(reset.status, 'completed');
  assert.ok(reset.result.observations.every(item => item.state === 'unknown'), 'A new runtime must not invent persisted health or reuse stale failures');
  assert.deepEqual([transient.requests.length, authentication.requests.length, healthy.requests.length], [1, 1, 1], 'Restart and health reads do not probe providers');
  const invalid = await openRpc(gatewayRpcUrl(gateway, 'invalid', token));
  context.addCleanup('close invalid settings RPC', () => closeRpcAndWait(invalid));
  const rejectedAt = Date.now();
  await assert.rejects(initialize(invalid), /connection closed; upstream outcome is unknown/);
  assert.ok(Date.now() - rejectedAt < 5000, 'An actual pre-initialize Native exit must settle its original caller promptly');
  await context.writeArtifactJson('model-health-native-boundaries.json', {
    actualNativeAndHttp: true, turns: [failedTransient, failedAuthentication, completed], observations,
    authFailure, nextCandidateProvider: next.result.model.providerId,
    actualProviderRequests: 3, metadataProviderRequests: 0, externalProviderRequests: 0,
    restartObservations: reset.result.observations,
    invalidSettingsExitSettled: true,
    sameRunFallbackClaim: false, modelQualityClaim: false,
  });
  return { actualNativeHttp: true, providerRequests: 3, metadataProviderRequests: 0 };
});
