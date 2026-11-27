import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireExecutable, runIntegration } from '../../e2e/harness/run-context.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';
import { startGateway } from '../../e2e/harness/gateway.mjs';
import { login } from '../../e2e/harness/http.mjs';
import { openRpc, initializeRpc, gatewayRpcUrl, closeRpcAndWait } from '../../e2e/harness/rpc.mjs';

await runIntegration(import.meta.url, { testId: 'shared-mobile-idle-model-selection', tier: 'full-integration',
  modelPolicy: 'Actual fixed Native binary and independent Gateway runtime connections. No user turn or paid model. An idle Mobile viewer selects a persisted model while the original controller stays attached; unrelated metadata and unjoined connections remain rejected.' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed Native binary');
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'shared-model-selection' });
  const config = context.pathInState('profile'), web = context.pathInState('web');
  await Promise.all([mkdir(config), mkdir(web)]);
  const settings = await context.writeStateJson('models.json', { active_provider: 'fixture', credential_store: 'file',
    permission_mode: 'ask', max_retries: 0, mcp_servers: [], session_memory: { enabled: false },
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: 'http://127.0.0.1:1/v1', authentication: { mode: 'none' },
      default_model: 'first', context_window_tokens: 128000, output_headroom_tokens: 4096, max_output_tokens: 1024,
      no_proxy: true, discover_models: false, models: {
        first: { context_window_tokens: 128000, output_headroom_tokens: 4096, max_output_tokens: 1024 },
        second: { context_window_tokens: 128000, output_headroom_tokens: 4096, max_output_tokens: 1024 },
      } } } });
  const targets = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned Native', transport: 'local', command: binary,
    workspace: workspace.path, settingsFile: settings }]);
  const gateway = await startGateway(context, { auth: true, workspace: workspace.path, serversFile: targets, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: config, KCODER_HOME: config, KCODER_STUDIO_WEB_ROOT: web } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const connect = async label => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close ${label}`, () => closeRpcAndWait(rpc, label));
    const initialized = await initializeRpc(rpc, label, { gatewaySharedThreadsV1: true });
    assert.equal(initialized.capabilities.experimental.residentThreads, true);
    return rpc;
  };
  const owner = await connect('desktop-model-owner'), mobile = await connect('mobile-model-viewer'), stranger = await connect('unjoined-model-viewer');
  const thread = (await owner.request('thread/start', { cwd: workspace.path })).thread;
  await owner.request('thread/resume', { threadId: thread.id });
  await mobile.request('thread/resume', { threadId: thread.id });
  const saved = await mobile.request('thread/metadata/update', { threadId: thread.id, model: 'fixture::second' });
  assert.equal(saved.thread.id, thread.id);
  const read = await owner.request('thread/read', { threadId: thread.id, limit: 1 });
  assert.ok([read.thread.model, read.thread.selectedModel?.model].some(value => value === 'fixture::second' || value === 'second'));
  const scoped = await mobile.request('runtime.providers.list', { threadId: thread.id });
  assert.ok(scoped.profiles.some(profile => profile.id === 'fixture' && profile.model === 'second'));
  const configured = await mobile.request('runtime.providers.upsert', { threadId: thread.id,
    expectedRevision: scoped.revision, id: 'fixture', originalModel: 'second', model: 'second',
    apiFormat: 'openai_chat_completions', endpoint: 'http://127.0.0.1:1/v1', authentication: { mode: 'none' },
    contextWindowTokens: 128000, maxOutputTokens: 1024, makeDefault: false, validateConnection: false });
  assert.ok(configured.profiles.some(profile => profile.id === 'fixture' && profile.model === 'second'));
  await assert.rejects(stranger.request('runtime.providers.list', { threadId: thread.id }), /another Gateway client/);
  await assert.rejects(stranger.request('runtime.providers.upsert', { threadId: thread.id, id: 'fixture' }), /another Gateway client/);
  await assert.rejects(stranger.request('thread/metadata/update', { threadId: thread.id, model: 'fixture::first' }), /another Gateway client/);
  await assert.rejects(mobile.request('thread/metadata/update', { threadId: thread.id, model: 'fixture::first', title: 'not-permitted' }), /another Gateway client/);
  await owner.request('thread/metadata/update', { threadId: thread.id, title: 'Owner remains attached' });
  await context.writeArtifactJson('shared-model-selection.json', { mobileSelectionSaved: true, desktopReadConfirmed: true,
    originalControllerRetained: true, unjoinedWriteRejected: true, unrelatedFieldRejected: true,
    scopedProviderRead: true, scopedProviderSave: true, unjoinedProviderAccessRejected: true, turnsSubmitted: 0 });
});
