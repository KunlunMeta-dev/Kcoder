import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApprovalModelFixture } from '../../e2e/harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../e2e/harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../e2e/harness/rpc.mjs';
import { repoRoot, requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';

// Protocol and persistence evidence only: bounded loopback Provider fixtures,
// actual Gateway/app-server requests, no model quality or paid inference claim.
await runIntegration(import.meta.url, {
  testId: 'provider-independent-save-revision-and-effective-values',
  tier: 'full-integration',
  modelPolicy: 'model-independent loopback HTTP/SSE, offline save and CAS',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const suiteSource = await readFile(fileURLToPath(import.meta.url));
  const suiteSourceSha256 = createHash('sha256').update(suiteSource).digest('hex');
  await writeFile(context.pathInArtifacts('executed-e2e-source.mjs'), suiteSource, { flag: 'wx', mode: 0o600 });
  await context.writeArtifactJson('executed-e2e-source.json', {
    source: 'apps/kcoder-studio/integration/gateway/provider-independent-save.integration.mjs',
    sha256: suiteSourceSha256,
    snapshot: 'executed-e2e-source.mjs',
  });
  const gatewayTemp = context.pathInState('gateway-tmp');
  await mkdir(gatewayTemp, { mode: 0o700 });
  context.registerTemporaryDirectory('owned Gateway TMPDIR', gatewayTemp);
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'independent-save' });
  const overload = await startApprovalModelFixture(context, {
    httpErrorPrompt: 'Reply only OK.', httpErrorStatus: 529, httpErrorCode: 'overloaded_error',
  });
  let held = false;
  let release = false;
  const loadedModelMetadata = [{
    model: 'model', name: 'model', digest: 'fixture-model-digest', context_length: 4096,
  }];
  const healthy = await startApprovalModelFixture(context, { responseSteps: () => [
    { ready: () => !held || release, delta: { role: 'assistant', content: 'OK' } },
    { finishReason: 'stop' },
  ], ollamaModels: loadedModelMetadata });
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
  const gatewayStartedAtMs = Date.now();
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, startTimeoutMs: 180000,
    env: { KCODER_CONFIG_DIR: profile, TMPDIR: gatewayTemp, TMP: gatewayTemp, TEMP: gatewayTemp } });
  const gatewayStartupElapsedMs = Date.now() - gatewayStartedAtMs;
  const token = await waitForGatewayRpcToken(context, gateway);
  const readinessStartedAtMs = Date.now();
  const readinessObservations = [];
  let readinessStatus = 'unavailable';
  const writeReadinessArtifact = async status => context.writeArtifactJson('gateway-target-readiness.json', {
    id: 'local', status, elapsedMs: Date.now() - readinessStartedAtMs,
    observations: readinessObservations,
  });
  try {
    await waitFor(async () => {
      const probeStartedAtMs = Date.now();
      let status = 'unavailable';
      let latencyMs = 0;
      try {
        const response = await fetch(`${gateway.baseUrl}/api/servers/status`, {
          method: 'GET', cache: 'no-store', headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          const body = await response.json();
          const local = Array.isArray(body?.statuses) ? body.statuses.find(row => row?.id === 'local') : undefined;
          status = local?.status === 'online' || local?.status === 'offline' ? local.status : 'unavailable';
          latencyMs = Number.isSafeInteger(local?.latencyMs) && local.latencyMs >= 0
            ? local.latencyMs : Date.now() - probeStartedAtMs;
        } else latencyMs = Date.now() - probeStartedAtMs;
      } catch {
        latencyMs = Date.now() - probeStartedAtMs;
      }
      readinessStatus = status;
      readinessObservations.push({ id: 'local', status, latencyMs, elapsedMs: Date.now() - readinessStartedAtMs });
      return status === 'online';
    }, 60_000, 'local app-server health readiness', 500, context.abortSignal);
  } catch (error) {
    if (!context.abortSignal.aborted) await writeReadinessArtifact('timeout');
    throw error;
  }
  await writeReadinessArtifact('online');
  assert.equal(readinessStatus, 'online');
  assert.equal(overload.requests.length, 0, 'server readiness must not generate a fixture response');
  assert.equal(healthy.requests.length, 0, 'server readiness must not generate a fixture response');
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close independent provider RPC', () => rpc.close());
  await initializeRpc(rpc, 'provider-independent-save');
  const templates = await rpc.request('runtime.providers.templates', {});
  assert.equal(templates.supportsOllamaContextProbe, true, 'the app-server advertises the read-only Ollama context probe');
  const unscoped = await rpc.request('runtime.providers.list', {});
  assert.equal(unscoped.currentTurnConfiguration, undefined, 'bootstrap Engine is not a conversation snapshot');
  assert.equal(overload.requests.length, 0, 'no fixture generation request is permitted before thread startup');
  assert.equal(healthy.requests.length, 0, 'no fixture generation request is permitted before thread startup');
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
  const connectedSettings = JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8'));
  assert.equal(connectedSettings.providers.fixture.endpoint, healthy.baseUrl);
  assert.equal(new URL(connectedSettings.providers.fixture.endpoint).pathname, '/v1');
  const normalProbeParams = {
    threadId: thread.id, id: 'fixture', model: 'model', expectedRevision: connected.savedRevision,
  };
  const ok = await rpc.request('runtime.providers.probe', normalProbeParams);
  assert.equal(ok.success, true);
  assert.equal(ok.ollamaContextWindow, undefined, 'the ordinary connection probe keeps its existing result shape');
  assert.equal(healthy.ollamaRequests.length, 0, 'the ordinary connection probe does not read Ollama metadata');

  const settingsBeforeOllamaProbe = await readFile(resolve(profile, 'settings.json'), 'utf8');
  const generatedRequestsBeforeOllamaProbe = healthy.requests.length;
  await assert.rejects(rpc.request('runtime.providers.probe', {
    ...normalProbeParams, expectedRevision: 'stale-revision', checkOllamaContextWindow: true,
  }), /changed|reload|revision/i);
  assert.equal(healthy.ollamaRequests.length, 0, 'a stale window probe is rejected before the metadata request');
  assert.equal(healthy.requests.length, generatedRequestsBeforeOllamaProbe, 'a stale window probe does not generate a response');
  assert.equal(await readFile(resolve(profile, 'settings.json'), 'utf8'), settingsBeforeOllamaProbe);

  const windowProbeParams = { ...normalProbeParams, checkOllamaContextWindow: true };
  const observedWindow = await rpc.request('runtime.providers.probe', windowProbeParams);
  assert.equal(observedWindow.success, true, 'window probe success means runtime metadata was read');
  assert.deepEqual(observedWindow.ollamaContextWindow, {
    configuredTokens: 1000000,
    observedTokens: 4096,
  });
  assert.equal(observedWindow.errorType, undefined);
  assert.equal(healthy.requests.length, generatedRequestsBeforeOllamaProbe, 'metadata probing does not generate a response');
  assert.deepEqual(healthy.ollamaRequests, [
    { path: '/api/ps', authorizationPresent: false },
  ]);
  assert.equal(await readFile(resolve(profile, 'settings.json'), 'utf8'), settingsBeforeOllamaProbe,
    'reading runtime metadata leaves saved settings byte-for-byte unchanged');

  loadedModelMetadata.splice(0, loadedModelMetadata.length);
  const noLoadedModel = await rpc.request('runtime.providers.probe', windowProbeParams);
  assert.equal(noLoadedModel.success, false, 'an empty loaded-model snapshot is not a successful observation');
  assert.deepEqual(noLoadedModel.ollamaContextWindow, { configuredTokens: 1000000 });
  assert.equal(noLoadedModel.errorType, undefined, 'an unavailable observation is not a connection error');
  assert.equal(healthy.requests.length, generatedRequestsBeforeOllamaProbe, 'an empty metadata snapshot still does not generate a response');
  assert.deepEqual(healthy.ollamaRequests, [
    { path: '/api/ps', authorizationPresent: false },
    { path: '/api/ps', authorizationPresent: false },
  ]);
  assert.equal(await readFile(resolve(profile, 'settings.json'), 'utf8'), settingsBeforeOllamaProbe);
  const ollamaWindowEvidence = {
    configuredTokens: observedWindow.ollamaContextWindow.configuredTokens,
    observedTokens: observedWindow.ollamaContextWindow.observedTokens,
    metadataGetCount: healthy.ollamaRequests.length,
    generationPostCount: healthy.requests.length - generatedRequestsBeforeOllamaProbe,
    settingsUnchanged: await readFile(resolve(profile, 'settings.json'), 'utf8') === settingsBeforeOllamaProbe,
    authorizationAbsent: healthy.ollamaRequests.every(request => request.authorizationPresent === false),
    emptyModelUnknown: noLoadedModel.success === false
      && Number.isSafeInteger(noLoadedModel.ollamaContextWindow?.configuredTokens)
      && noLoadedModel.ollamaContextWindow?.observedTokens === undefined
      && noLoadedModel.errorType === undefined,
  };
  assert.deepEqual(ollamaWindowEvidence, {
    configuredTokens: 1000000,
    observedTokens: 4096,
    metadataGetCount: 2,
    generationPostCount: 0,
    settingsUnchanged: true,
    authorizationAbsent: true,
    emptyModelUnknown: true,
  });

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
  const gatewayStartupEvents = [];
  for (const line of (await readFile(gateway.logPath, 'utf8')).split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.event === 'gateway-startup'
        && typeof event.phase === 'string'
        && ['started', 'completed', 'failed'].includes(event.status)
        && Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0) {
      gatewayStartupEvents.push({ phase: event.phase, status: event.status, elapsedMs: event.elapsedMs });
    }
  }
  await context.writeArtifactJson('gateway-startup-events.json', gatewayStartupEvents);
  return { offlineSaveContacts: 0, overloadRetainedRevision: true, actualOutput: [65536, 8192],
    snapshotPreserved: true, staleProbeRejected: true, concurrentEditInvalidatesProbe: true,
    ollamaWindowEvidence, gatewayStartupElapsedMs };
});
