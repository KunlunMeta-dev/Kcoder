import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { startPackagedDesktop } from '../../harness/packaged-desktop.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { openPageGatewayRpc } from '../../harness/rpc.mjs';
import { serviceRequest } from '../../harness/native-code-service.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'macos-installed-electron-native-feishu-sdk', tier: 'manual-live',
  modelPolicy: 'Actual installed Electron/Gateway/app-server, sealed Node and official Feishu SDK. Isolated profile, connection only; no model, task binding or test message.',
}, async context => {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.env.KCODER_E2E_LIVE_FEISHU, '1');
  assert.ok(process.env.KCODER_E2E_PACKAGED_DIR);
  const root = resolve(process.env.KCODER_E2E_PACKAGED_DIR);
  const resources = resolve(root, 'Contents/Resources');
  const cli = await requireExecutable(resolve(resources, 'bin/kcoder'), 'installed CLI');
  const env = parseEnv(await readFile(process.env.KCODER_E2E_FEISHU_ENV_FILE || `${repoRoot}/.env`, 'utf8'));
  const appId = env.KCODER_TEST_FEISHU_APP_ID, appSecret = env.KCODER_TEST_FEISHU_APP_SECRET;
  assert.ok(appId && appSecret);
  context.registerSecret(appSecret);
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'macos-feishu' });
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Mac Feishu fixture',
    transport: 'local', command: cli, workspace: workspace.path }]);
  // The installed app is on Data while the source checkout may be a separate APFS volume.
  const profileScratch = await context.createOwnedScratchDirectory('installed-mac-feishu-home', {
    baseDirectory: await realpath('/var/tmp'),
  });
  const home = context.pathInScratch(profileScratch, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(resolve(home, 'settings.json'), JSON.stringify({ providers: {}, tools: { profile: 'none' },
    credential_store: 'file', integrations: { connectivity: { enabled: true }, services: { enabled: true } } }), { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(home, 'credentials.json'), '{}', { mode: 0o600, flag: 'wx' });
  const desktop = await startPackagedDesktop(context, { root: resolve(root, 'Contents/MacOS'),
    label: 'installed-macos-feishu', servers, workspace: workspace.path, profileScratch });
  await context.writeArtifactJson('installed-desktop-ready.json', { ready: true });
  const baseUrl = new URL(desktop.page.url()).origin;
  const gateway = { baseUrl, wsUrl: baseUrl.replace(/^http/, 'ws') };
  const ui = await openPageGatewayRpc(context, desktop.page, gateway, 'installed Feishu RPC');
  await context.writeArtifactJson('installed-rpc-ready.json', { connected: true });
  const initialized = await ui.request('initialize', { protocolVersion: '2026-07-27',
    clientInfo: { name: 'installed-macos-feishu', version: '1' }, capabilities: { experimental: {
      integrationScopeV1: true, integrationTaskStateV1: true, connectivityV1: true,
      connectivityCredentialInputV1: true, nativeChannelServicesV1: true, integrationOperationReceiptsV1: true,
    } } });
  assert.equal(initialized.capabilities.experimental.nativeChannelServicesV1, true);
  const scope = await ui.request('integrations/scope/read', {});
  async function call(method, payload, options = {}) {
    const reply = await ui.request(`integrations/connectivity/${method}`, serviceRequest(scope, payload, options), 60000);
    assert.equal(reply.status, 'completed', `${method}: ${reply.error?.code}`);
    return reply.result;
  }
  const connectionId = `installed-mac-feishu-${context.seed}`;
  const saved = await call('prepareConnectionAction', { action: 'save', connectionId, kind: 'feishu',
    label: 'Owned Mac SDK acceptance', configuration: { appId, routingMode: 'task_binding_v1' }, resourceGrants: [] },
  { operationId: `installed-save-${context.seed}` });
  const requestId = `installed-credential-${context.seed}`;
  const prepared = await ui.request('integrations/connectivity/credentials/prepare', { requestId, scope,
    connectionRef: { id: connectionId, revision: saved.revision }, expiresInMs: 3600000 });
  assert.equal(prepared.phase, 'prepared');
  const bound = await ui.request('integrations/connectivity/credentials/set', { requestId, scope,
    credentialRef: prepared.credentialRef, values: { platform: 'feishu', values: { appSecret } } });
  assert.equal(bound.phase, 'active');
  const started = await call('prepareConnectionAction', { action: 'start', connectionId },
    { operationId: `installed-start-${context.seed}`, expectedRevision: bound.currentConnectionRef.revision });
  assert.equal(started.state, 'connected');
  const observed = await call('readConnection', { connectionId });
  assert.equal(observed.state, 'connected');
  assert.equal(observed.hasCredential, true);
  const stopped = await call('prepareConnectionAction', { action: 'stop', connectionId },
    { operationId: `installed-stop-${context.seed}`, expectedRevision: observed.revision });
  assert.equal(stopped.state, 'stopped');
  await context.writeArtifactJson('installed-feishu-sdk.json', { installedElectron: true, nativeChannelCapability: true,
    realSdkConnected: true, stopped: true, testMessagesSent: 0, modelCalls: 0, realUserInboundTested: false });
  ui.close();
  await desktop.stop();
});
