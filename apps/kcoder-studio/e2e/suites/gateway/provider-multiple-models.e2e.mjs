import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Fixed HTTP responses test configuration and transport identity, not model quality.
await runE2E(import.meta.url, {
  testId: 'provider-multiple-models-persistence-probe-and-routing',
  tier: 'full-integration',
  modelPolicy: 'model-independent loopback HTTP/SSE configuration and routing; no paid provider or model-quality assertions',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'provider-models' });
  const fixture = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'OK' });
  try {
  const configDir = context.pathInState('provider-home');
  const key = `fixture-only-${randomBytes(16).toString('hex')}`;
  context.registerSecret(key);
  await context.writeStateJson('provider-home/settings.json', {
    active_provider: 'shared', tools: { disabled: ['*'] }, max_retries: 0,
    providers: { shared: {
      api_format: 'openai_chat_completions', endpoint: fixture.baseUrl, default_model: 'model-A',
      context_window_tokens: 32000, max_output_tokens: 1024, output_headroom_tokens: 1024,
    } },
  });
  await context.writeStateJson('provider-home/credentials.json', { shared: { type: 'api', key } });
  const serversFile = await context.writeStateJson('servers.jsonc', [{
    id: 'models', label: 'Fixture models', transport: 'local', command: binary, workspace,
  }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_MAX_RETRIES: '0', KCODER_MAX_TOKENS: '128', KCODER_MAX_DURATION_SECS: '20' } });
  const token = await waitForGatewayRpcToken(context, gateway);
  let rpc;
  let sensitiveResponse = false;
  const connect = async () => {
    const client = await openRpc(gatewayRpcUrl(gateway, 'models', token));
    client.socket.addEventListener('message', event => { if (String(event.data).includes(key)) sensitiveResponse = true; });
    context.addCleanup('close provider models RPC', () => client.close());
    await initializeRpc(client, 'provider-models-protocol');
    return client;
  };
  const restart = async () => {
    const result = await rpc.request('gateway/app-server/restart', { confirm: true }, 30000);
    assert.equal(result.stopped, true);
    rpc.close();
    rpc = await connect();
  };
  const save = async (model, makeDefault, maxOutputTokens, modelExtraBody) => {
    const before = fixture.requests.length;
    const result = await rpc.request('runtime.providers.upsert', {
      id: 'shared', model, makeDefault, apiFormat: 'openai_chat_completions', endpoint: fixture.baseUrl,
      contextWindowTokens: 32000, maxOutputTokens, modelExtraBody,
    }, 30000);
    const probes = fixture.requests.slice(before);
    assert.equal(probes.length, 1, 'each save must validate exactly the candidate model');
    assert.equal(probes[0].model, model);
    return result;
  };
  const profileModels = response => response.profiles.filter(profile => profile.id === 'shared').map(profile => profile.model).sort();
  const turn = async (model, migrationExpectation) => {
    const selector = `shared::${model}`;
    const { thread } = await rpc.request('thread/start', { cwd: workspace, model: selector });
    assert.equal(thread.model, selector);
    const before = fixture.requests.length;
    const { turn } = await rpc.request('turn/start', { threadId: thread.id, model: selector, input: [{ type: 'text', text: 'Reply OK; do not use tools.' }] });
    const done = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.id
      && message.params?.threadId === thread.id, 30000, 'candidate model turn completion');
    assert.equal(done.params.turn.status, 'completed');
    assert.deepEqual(fixture.requests.slice(before).map(request => request.model), [model]);
    const sent = fixture.requests.at(-1);
    if (migrationExpectation) { assert.equal(sent.temperature, migrationExpectation.temperature); }
    else if (model === 'model-A') { assert.deepEqual(sent.thinking, { type: 'adaptive' }); assert.equal(sent.temperature, 0.2); }
    else { assert.equal(sent.thinking, undefined); assert.equal(sent.temperature, 0.7); }
    await rpc.request('thread/delete', { threadId: thread.id });
  };
  rpc = await connect();
  await save('model-A', true, 1024, { thinking: { type: 'adaptive' }, temperature: 0.2 });
  const afterB = await save('model-B', false, 2048, { temperature: 0.7 });
  assert.equal(afterB.supportsNewSessionReload, true);
  assert.equal(afterB.restartRequired, false);
  assert.deepEqual(profileModels(afterB), ['model-A', 'model-B']);
  assert.equal(afterB.profiles.find(profile => profile.id === 'shared' && profile.model === 'model-A').isDefault, true);
  await restart();
  const catalog = await rpc.request('runtime.models.list');
  const group = catalog.providers.filter(provider => provider.id === 'shared');
  assert.equal(group.length, 1);
  assert.deepEqual(group[0].data.map(model => model.id).sort(), ['shared::model-A', 'shared::model-B']);
  assert.equal(group[0].data.filter(model => model.isDefault).length, 1);
  await turn('model-A');
  await turn('model-B');
  await assert.rejects(rpc.request('runtime.providers.delete', { id: 'shared', model: 'model-B', confirm: true, removeCredentials: true }));
  const deleted = await rpc.request('runtime.providers.delete', { id: 'shared', model: 'model-B', confirm: true });
  assert.deepEqual(profileModels(deleted), ['model-A']);
  const credentials = JSON.parse(await readFile(context.pathInState('provider-home/credentials.json'), 'utf8'));
  assert.ok(credentials.shared?.key === key, 'single-model deletion must preserve the shared credential');
  await restart();
  const remaining = await rpc.request('runtime.models.list');
  assert.deepEqual(remaining.data.map(model => model.id), ['shared::model-A']);
  await turn('model-A');
  assert.equal(sensitiveResponse, false);
  assert.ok(fixture.requests.length <= 5, 'two probes and three foreground calls are the complete fixture budget');
  // M02: import a legacy shared body, then edit/create/clear independent model entries.
  const legacy = JSON.parse(await readFile(context.pathInState('provider-home/settings.json'), 'utf8'));
  const limits = { context_window_tokens: 32000, max_output_tokens: 1024, output_headroom_tokens: 1024 };
  legacy.providers.shared.extra_body = { temperature: 0.4 };
  legacy.providers.shared.models = { 'model-A': { ...limits }, 'model-B': { ...limits } };
  await writeFile(context.pathInState('provider-home/settings.json'), JSON.stringify(legacy), { mode: 0o600 });
  await save('model-A', true, 1024, { temperature: 0.8 });
  await turn('model-B', { temperature: 0.4 });
  await save('model-C', false, 1024, undefined);
  await turn('model-C', { temperature: undefined });
  await save('model-A', true, 1024, {});
  await restart();
  await turn('model-A', { temperature: undefined });
  await turn('model-B', { temperature: 0.4 });
  const migrated = JSON.parse(await readFile(context.pathInState('provider-home/settings.json'), 'utf8')).providers.shared;
  assert.deepEqual(migrated.extra_body, {});
  assert.deepEqual(migrated.models['model-A'].extra_body, {});
  assert.deepEqual(migrated.models['model-B'].extra_body, { temperature: 0.4 });
  assert.deepEqual(migrated.models['model-C'].extra_body, {});
  // M09 transport fault: discard the save reply before the RPC client's dispatcher.
  // The caller must time out, then discover the committed state through a fresh
  // connection. Repeating the same upsert must not create duplicate model entries.
  const pendingSave = {
    id: 'shared', model: 'model-D', makeDefault: false,
    apiFormat: 'openai_chat_completions', endpoint: fixture.baseUrl,
    contextWindowTokens: 32000, maxOutputTokens: 1024,
    modelExtraBody: { temperature: 0.6 },
  };
  const originalEmit = rpc.socket.emit.bind(rpc.socket);
  let discardedReply = false;
  let discardedReplySucceeded = false;
  rpc.socket.emit = (type, event) => {
    if (type === 'message') {
      const frame = JSON.parse(event.data);
      if (frame.id !== undefined && !discardedReply) {
        discardedReply = true;
        discardedReplySucceeded = !frame.error && Array.isArray(frame.result?.profiles);
        return;
      }
    }
    originalEmit(type, event);
  };
  await assert.rejects(rpc.request('runtime.providers.upsert', pendingSave, 3000), /timed out/);
  assert.equal(discardedReply, true, 'the fault must drop an actual reply, not merely race the request');
  assert.equal(discardedReplySucceeded, true, 'commit succeeded before the transport discarded the reply');
  rpc.close();
  rpc = await connect();
  const recovered = await rpc.request('runtime.providers.list');
  assert.deepEqual(profileModels(recovered), ['model-A', 'model-B', 'model-C', 'model-D']);
  const retried = await rpc.request('runtime.providers.upsert', pendingSave);
  assert.deepEqual(profileModels(retried), profileModels(recovered));
  await restart();
  await turn('model-D', { temperature: 0.6 });
  assert.equal(sensitiveResponse, false);
  return { lostSaveReplyRecovered: true, repeatedSaveWithoutDuplicate: true,
    legacySharedBodyMigration: true, candidateProbeModels: ['model-A', 'model-B'], sameProviderModelsPersisted: true,
    singleProviderCatalogGroup: true, turnModels: ['model-A', 'model-B', 'model-A'],
    sharedAccessPreserved: true, deletedModelAbsentAfterRestart: true,
    sensitiveResponse: false, fixtureRequests: fixture.requests.length };
  } finally {
    await context.writeArtifactJson('fixture-observations.json', {
      requests: fixture.requests.length,
      models: fixture.requests.slice(0, 16).map(request => ['model-A', 'model-B'].includes(request.model) ? request.model : 'unexpected'),
    });
  }
});
