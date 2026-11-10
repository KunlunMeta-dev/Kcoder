import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { rename } from 'node:fs/promises';
import { startGateway } from '../../harness/gateway.mjs';
import { login } from '../../harness/http.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { repoRoot, runE2E, requireExecutable } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'expert-luna-baseline-native-rpc-compatibility', tier: 'full-integration',
  modelPolicy: 'Actual Gateway/app-server settings RPC in an owned profile. No task creation, model, marketplace or platform requests.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'candidate app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'expert-luna-baseline' });
  const settings = {
    active_provider: 'offline', max_retries: 0, history_enabled: true,
    tools: { profile: 'full', luna: { allowed: ['read', 'UnlistedTool'] }, studio: { kcoder: ['bash'], kworker: [] } },
    providers: { offline: { api_format: 'openai_chat_completions', endpoint: 'http://127.0.0.1:1/v1',
      default_model: 'no-model-request', authentication: { mode: 'none' }, discover_models: false,
      context_window_tokens: 32768, output_headroom_tokens: 1024, max_output_tokens: 128 } },
    session_memory: { enabled: false },
  };
  await context.writeStateJson('profile/settings.json', settings);
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned Luna settings', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { auth: true, workspace, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: context.pathInState('profile') } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const client = await openRpc(gatewayRpcUrl(gateway, 'local', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup('close owned Luna settings RPC', () => closeRpcAndWait(client));
  const initialized = await client.request('initialize', { protocolVersion: '2026-07-27',
    clientInfo: { name: 'expert-luna-compatibility', version: '1' },
    capabilities: { experimental: { toolSelectionsV1: true, lunaToolSelectionsV1: true } } });
  assert.equal(initialized.capabilities.experimental.lunaToolSelectionsV1, true);
  const legacy = await client.request('settings/tools/selection/read', {});
  assert.equal(Object.hasOwn(legacy, 'lunaAllowedTools'), false, 'Legacy strict clients keep the original response');
  const explicit = await client.request('settings/tools/selection/read', { includeLunaBaseline: true });
  assert.deepEqual(explicit.lunaAllowedTools, ['read', 'UnlistedTool']);
  assert.deepEqual(explicit.modes.find(mode => mode.mode === 'kcoder').allowedTools, ['bash']);
  assert.ok(explicit.tools.find(tool => tool.name === 'read').available);
  assert.equal(explicit.revision, legacy.revision);
  const declined = await client.request('settings/tools/selection/read', { includeLunaBaseline: false });
  assert.deepEqual(declined, legacy);
  const saved = await client.request('settings/tools/selection/save', { mode: 'kcoder', allowedTools: [], expectedRevision: legacy.revision });
  assert.equal(Object.hasOwn(saved, 'lunaAllowedTools'), false, 'Legacy saves retain the original response');
  assert.notEqual(saved.revision, legacy.revision);
  const afterSave = await client.request('settings/tools/selection/read', { includeLunaBaseline: true });
  assert.deepEqual(afterSave.lunaAllowedTools, ['read', 'UnlistedTool'], 'Studio saves do not rewrite the Luna baseline');
  assert.deepEqual(afterSave.modes.find(mode => mode.mode === 'kcoder').allowedTools, []);
  // Change only the run-owned config to prove an explicit empty baseline never falls back.
  settings.tools.luna.allowed = [];
  settings.tools.studio.kcoder = ['bash'];
  const emptySettingsFile = await context.writeStateJson('profile/settings-empty.json', settings);
  await rename(emptySettingsFile, context.pathInState('profile/settings.json'));
  const empty = await client.request('settings/tools/selection/read', { includeLunaBaseline: true });
  assert.deepEqual(empty.lunaAllowedTools, []);
  assert.deepEqual(empty.modes.find(mode => mode.mode === 'kcoder').allowedTools, ['bash']);
  const threads = await client.request('thread/list', { limit: 10 });
  assert.deepEqual(threads.threads, [], 'Reading or saving expert defaults cannot create tasks');
  await context.writeArtifactJson('luna-baseline-rpc.json', {
    capability: true, legacyFieldOmitted: true, baseline: explicit.lunaAllowedTools,
    studioDefault: explicit.modes.find(mode => mode.mode === 'kcoder').allowedTools,
    emptyBaseline: empty.lunaAllowedTools, noTaskCreation: true,
  });
  return { actualNativeRpc: true, legacyCompatibility: true, distinctLunaBaseline: true,
    explicitEmptyBaseline: true, noTaskCreation: true, modelCalls: 0, platformMessages: 0 };
});
