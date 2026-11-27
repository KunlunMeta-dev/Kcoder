import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { openOwnedPeerStudioPage } from '../../harness/peer-studio-browser.mjs';

process.umask(0o077);
await runE2E(import.meta.url, { testId: 'actual-react-native-startup-settings-recovery', tier: 'full-integration',
  modelPolicy: 'Actual no-scenario Native, formal HTTP Cookie login and system Chromium React. Invalid read-only JSON overlay fails with typed diagnostics; actual target editor removes only its reference and explicit Retry opens missing-model settings. Owned loopback counts every Provider request and must stay zero. No paid model, external endpoint, Windows or Electron claim.' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed startup Native');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256); await assertRendererBuildFresh();
  const productionRenderer = process.env.KCODER_E2E_EXPECT_PRODUCTION_RENDERER === '1';
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'startup-settings-react' });
  const providerRequests = [];
  const provider = createServer((request, response) => {
    providerRequests.push({ method: request.method, path: request.url });
    response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":{"message":"owned offline fixture"}}');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  context.registerPort('owned-startup-provider', provider.address().port);
  context.addCleanup('close owned startup Provider counter', () => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const profile = context.pathInState('startup-profile');
  await context.writeStateJson('startup-profile/settings.json', { active_provider: 'OwnedStartup', model: '', max_retries: 0,
    credential_store: 'file', auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
    providers: { OwnedStartup: { api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
      authentication: { mode: 'none' }, discover_models: false, no_proxy: true } } });
  const secret = 'OWNED_INLINE_VALUE_MUST_NEVER_ESCAPE_STARTUP'; context.registerSecret(secret);
  const overlay = context.pathInState('read-only-invalid-settings.json');
  await writeFile(overlay, `{"private_fixture":"${secret}", broken`, { mode: 0o400 });
  await chmod(overlay, 0o400);
  const overlayBefore = await readFile(overlay), overlaySha256 = createHash('sha256').update(overlayBefore).digest('hex');
  const serversStore = await context.writeStateJson('servers.json', [{ id: 'startup-owned', label: 'Owned startup target', runtime: 'kcoder',
    transport: 'local', command: binary, workspace, settingsFile: overlay }]);
  const gateway = await startGateway(context, { auth: true, workspace, serversStore, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: profile, KCODER_HOME: profile, KCODER_STUDIO_MOCK: '0', KCODER_STUDIO_SCENARIO: '', KCODER_INCLUDE_BUNDLED_PROFILES: '0' } });
  const { page } = await openOwnedPeerStudioPage(context, gateway, { label: 'actual-startup-recovery', waitForSidebar: false });
  const wire = [], requests = [], diagnostics = [];
  page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  page.on('websocket', socket => {
    socket.on('framesent', event => { try { const value = JSON.parse(String(event.payload)); if (value.method) wire.push({ method: value.method }); } catch {} });
    socket.on('framereceived', event => { try {
      const value = JSON.parse(String(event.payload)), diagnostic = value.params?.startupDiagnostic;
      if (diagnostic?.version === 1) diagnostics.push({ version: 1, code: diagnostic.code, phase: diagnostic.phase });
    } catch {} });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('local-runtime-error').filter({ hasText: /无法解析所选配置文件|selected settings file.*parsed/i }).waitFor({ timeout: 30_000 });
    if (productionRenderer) assert.equal(await page.evaluate(() => typeof window.__KCODER_STUDIO_E2E__), 'undefined');
    assert.equal(await page.getByTestId('desktop-sidebar').count(), 0, 'the failed Native cannot claim workbench readiness');
    assert.ok(diagnostics.some(row => row.code === 'settings_parse_failed'));
    assert.equal((await page.locator('body').innerText()).includes(secret), false);
    await page.screenshot({ path: context.pathInArtifacts('actual-typed-settings-startup-failure.png'), fullPage: true });
    const recoveryBegan = requests.length;
    await page.getByTestId('local-runtime-open-connection-settings').click();
    await page.getByTestId('startup-connection-recovery').waitFor();
    await page.getByTestId('runtime-target-edit-startup-owned').click();
    const advanced = page.getByTestId('runtime-target-advanced-toggle');
    if (!(await page.getByTestId('runtime-target-settings-file').isVisible())) await advanced.click();
    await page.getByTestId('runtime-target-settings-file').fill('');
    await page.getByTestId('runtime-target-save').click();
    await waitFor(async () => !JSON.parse(await readFile(serversStore, 'utf8'))[0].settingsFile, 10_000, 'original catalog acknowledges cleared overlay reference');
    assert.equal(requests.slice(recoveryBegan).some(row => row.path === '/api/servers/status' || row.path === '/api/servers/test'), false);
    assert.deepEqual(await readFile(overlay), overlayBefore, 'the original readonly overlay bytes remain unchanged');
    await page.getByTestId('startup-recovery-retry').click();
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 30_000 });
    await page.goto(`${gateway.baseUrl}/settings/model-settings`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('kcoder-provider-settings-page').waitFor({ timeout: 30_000 });
    if (productionRenderer) assert.equal(await page.evaluate(() => typeof window.__KCODER_STUDIO_E2E__), 'undefined');
    const target = page.getByTestId('provider-target'); await target.selectOption('startup-owned');
    await waitFor(() => page.getByTestId('provider-new').isEnabled(), 30_000, 'actual Native settings management without a model');
    await page.getByTestId('provider-new').click();
    assert.equal(await page.getByTestId('provider-model').inputValue(), '');
    assert.equal(await page.getByTestId('provider-apiKey').inputValue(), '');
    assert.equal(providerRequests.length, 0, 'startup and configuration access cannot dispatch Provider calls');
    assert.equal(wire.some(row => ['thread/start', 'turn/start'].includes(row.method)), false);
    assert.deepEqual(await readFile(overlay), overlayBefore);
    await page.screenshot({ path: context.pathInArtifacts('actual-settings-empty-model-recovered.png'), fullPage: true });
    await context.writeArtifactJson('actual-startup-recovery-assertions.json', { binarySha256, actualNative: true, noScenario: true,
      actualHttpCookieLogin: true, actualReactChromium: true, typedDiagnostic: diagnostics, originalOverlaySha256: overlaySha256,
      productionRenderer, ...(productionRenderer ? { normalPageAutomationBridgeAbsent: true } : {}),
      overlayBytesPreserved: true, onlyOverlayReferenceChanged: true, recoveryUsesCatalogWithoutHealthProbes: true,
      explicitRetryRequired: true, modelFieldRemainsEmpty: true, providerRequests, noFakeReady: true, noNewUserTurns: true,
      windowsHostProven: false });
    await verifyMissingProviderCreation(context, binary);
    return { actualTypedStartupRecovery: true, noProviderRequests: true, readonlyOverlayPreserved: true, missingProviderCreationRejected: true };
  } finally {
    await context.writeArtifactJson('startup-recovery-wire-methods.json', wire);
    await context.writeArtifactJson('startup-recovery-diagnostics.json', diagnostics);
    await context.writeArtifactJson('startup-recovery-provider-requests.json', providerRequests);
    await page.screenshot({ path: context.pathInArtifacts('startup-recovery-final.png'), fullPage: true }).catch(() => {});
  }
});

async function verifyMissingProviderCreation(context, binary) {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'missing-provider-creation' });
  const profile = context.pathInState('missing-provider-profile');
  await context.writeStateJson('missing-provider-profile/settings.json', { providers: {} });
  const serversStore = await context.writeStateJson('missing-provider-gateway/servers.json', [{
    id: 'local', label: 'Missing Provider', runtime: 'kcoder', transport: 'local', command: binary, workspace,
  }]);
  const gateway = await startGateway(context, { label: 'missing-provider-gateway', auth: true, workspace, serversStore, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: profile, KCODER_HOME: profile, KCODER_STUDIO_MOCK: '0', KCODER_STUDIO_SCENARIO: '', KCODER_INCLUDE_BUNDLED_PROFILES: '0' } });
  const { page } = await openOwnedPeerStudioPage(context, gateway, { label: 'missing-provider-creation' });
  const wire = [];
  page.on('websocket', socket => {
    socket.on('framesent', event => { try {
      const value = JSON.parse(String(event.payload));
      if (value.method) wire.push({ method: value.method });
    } catch {} });
    socket.on('framereceived', event => { try {
      const value = JSON.parse(String(event.payload));
      if (value.error) wire.push({ errorCode: value.error.code });
    } catch {} });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible', timeout: 30_000 });
    const skip = page.getByTestId('migration-first-use-skip');
    await skip.waitFor({ state: 'visible', timeout: 30_000 });
    await skip.click();
    await page.getByTestId('runtime-chat-section-new-chat-button').click();
    const composer = page.getByTestId('chat-message-input');
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await composer.click();
    const draft = 'MISSING_PROVIDER_DRAFT_MUST_SURVIVE';
    await page.keyboard.insertText(draft);
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('chat-input-error').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await composer.innerText(), draft);
    assert.equal(await page.getByTestId('message-user').count(), 0);
    assert.equal(await page.locator('[data-testid^="runtime-task-creation-error-"]').count(), 0);
    assert.equal(wire.filter(row => row.method === 'thread/start').length, 1);
    assert.equal(wire.some(row => ['turn/start', 'thread/creation/read'].includes(row.method)), false);
    assert.ok(wire.some(row => row.errorCode === -32075));
    await page.screenshot({ path: context.pathInArtifacts('missing-provider-draft-retained.png'), fullPage: true });
    await page.getByTestId('chat-input-error').getByRole('button').click();
    await page.getByTestId('kcoder-provider-settings-page').waitFor({ timeout: 30_000 });
    assert.equal(new URL(page.url()).searchParams.get('target'), 'local');
    await waitFor(async () => await page.getByTestId('provider-target').inputValue() === 'local',
      30000, 'the requested settings target after catalog loading', 50, context.abortSignal);
    await context.writeArtifactJson('missing-provider-creation-assertions.json', {
      noScenario: true, realNativeGatewayAndReact: true, draftPreserved: true,
      noFailedSidebarTask: true, noTurnOrReceiptReplay: true, settingsTargetPreserved: true, wire,
    });
  } finally {
    await page.screenshot({ path: context.pathInArtifacts('missing-provider-final.png'), fullPage: true }).catch(() => {});
    await context.writeArtifactJson('missing-provider-wire.json', wire);
  }
}
