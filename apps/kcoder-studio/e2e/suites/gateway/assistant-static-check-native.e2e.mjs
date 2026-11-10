import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { login } from '../../harness/http.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runE2E, requireExecutable } from '../../harness/run-context.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function census(root, path = root) {
  const entries = [];
  for (const name of (await readdir(path)).sort()) {
    const child = resolve(path, name), stat = await lstat(child);
    assert.equal(stat.isSymbolicLink(), false);
    entries.push(stat.isDirectory() ? { path: relative(root, child), directory: true }
      : { path: relative(root, child), bytes: stat.size, sha256: sha(await readFile(child)) });
    if (stat.isDirectory()) entries.push(...await census(root, child));
  }
  return entries;
}
await runE2E(import.meta.url, { testId: 'normal-first-use-static-assistant-check-no-model-or-store-write', tier: 'full-integration',
  modelPolicy: 'Actual normal CLI, authenticated Gateway, original builtin definition and current native model metadata. No model turn, business verifier, assistant adoption or fake native receipts. Optional real browser consumes the same normal entry; not native desktop or model quality.' },
async context => {
  const existingMain = process.env.KCODER_E2E_STATIC_CHECK_EXISTING_MAIN === '1';
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit frozen normal CLI');
  const binarySha256 = sha(await readFile(binary));
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'UNEXPECTED_GENERATION' });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'static-readiness' });
  const profile = context.pathInState('profile');
  const settingsFile = await context.writeStateJson('profile/settings.json', { active_provider: 'OwnedMetadata', model: 'metadata-only', max_retries: 0, credential_store: 'file',
    memory: { observer_mode: 'disabled', structured_enabled: false, legacy_prompt_enabled: false }, session_memory: { enabled: false },
    integrations: { office: { enabled: true }, ...(existingMain ? { connectivity: { enabled: true } } : {}) }, providers: { OwnedMetadata: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'metadata-only',
      discover_models: false, no_proxy: true, context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
      capabilities: { text: true, tools: true, vision: false } } } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned static readiness', transport: 'local', command: binary, workspace, settingsFile }]);
  const gateway = await startGateway(context, { auth: true, workspace, serversFile, kcoderBin: binary,
    ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}),
    env: { KCODER_CONFIG_DIR: profile } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup('close owned static readiness reader', () => closeRpcAndWait(rpc));
  const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-static-readiness', version: '1' },
    capabilities: { experimental: { integrationScopeV1: true, officeWorkspaceV1: true, ...(existingMain ? { connectivityV1: true } : {}) } } });
  assert.equal(initialized.capabilities.experimental.officeWorkspaceV1, true);
  const scope = await rpc.request('integrations/scope/read');
  let request = 0;
  const envelope = payload => ({ contractVersion: 'parallel-v1', requestId: `static-check-${++request}`, scope, timeoutMs: 10000, payload });
  const catalog = await rpc.request('integrations/assistant/list', envelope({ language: 'en', limit: 10 }));
  assert.equal(catalog.status, 'completed'); assert.equal(catalog.result.storageState, 'not_initialized');
  const definition = catalog.result.items[0].definition;
  const before = await census(profile);
  const checked = await rpc.request('integrations/assistant/validate', envelope({ definition }));
  await context.writeArtifactJson('actual-static-check-reply.json', checked);
  assert.equal(checked.status, 'completed', 'First-use checks must report missing observations without creating the Office store');
  assert.equal(checked.result.staticOnly, true); assert.equal(checked.result.definitionValid, true);
  assert.equal(checked.result.storageState, 'not_initialized'); assert.equal(checked.result.adoptable, false);
  assert.equal(checked.result.readiness.state, 'unknown');
  assert.equal(checked.result.model.model.modelId, 'metadata-only');
  assert.equal(checked.result.model.budget.reservationState, 'not_reserved');
  assert.equal(checked.result.model.budget.costKnown, false);
  assert.deepEqual(await census(profile), before, 'Static checking cannot write settings, create a namespace or persist a report');
  assert.equal(model.requests.length, 0);
  assert.equal((await rpc.request('thread/list', { limit: 10 })).threads.length, 0);
  if (existingMain) {
    assert.equal(initialized.capabilities.experimental.connectivityV1, true, 'actual Native Main capability required');
    const saved = await rpc.request('integrations/connectivity/prepareConnectionAction', { ...envelope({ action: 'save', connectionId: 'owned-readonly-main',
      kind: 'dingtalk', label: 'Owned static-check setup', configuration: { clientId: 'owned-inert-client' }, resourceGrants: [] }), operationId: 'explicit-owned-main-setup' });
    assert.equal(saved.status, 'completed'); assert.equal(saved.result.enabled, false); assert.equal(saved.result.state, 'authorization_required');
    const beforeReport = await rpc.request('integrations/connectivity/readReadiness', envelope({}));
    assert.equal(beforeReport.status, 'completed'); assert.equal(beforeReport.result.state, 'unobserved');
    const settingsBefore = sha(await readFile(settingsFile));
    const withMain = await rpc.request('integrations/assistant/validate', envelope({ definition }));
    await context.writeArtifactJson('existing-main-static-check-reply.json', withMain);
    assert.equal(withMain.status, 'completed'); assert.equal(withMain.result.storageState, 'not_initialized');
    assert.ok(withMain.result.readiness.observations.some(value => value.level === 'L0' && value.state === 'observed'), 'existing Main must supply its actual readonly observations');
    assert.ok(withMain.result.readiness.observations.some(value => value.level === 'L6' && value.state === 'unknown'));
    const afterReport = await rpc.request('integrations/connectivity/readReadiness', envelope({}));
    assert.equal(afterReport.status, 'completed');
    assert.equal(afterReport.result.observedAt, withMain.result.readiness.observedAt);
    assert.equal(afterReport.result.requestRevision, withMain.result.readiness.requestRevision);
    assert.deepEqual(afterReport.result.capabilities, withMain.result.readiness.capabilities);
    assert.equal(sha(await readFile(settingsFile)), settingsBefore);
    assert.equal(model.requests.length, 0); assert.equal((await rpc.request('thread/list', { limit: 10 })).threads.length, 0);
    await context.writeArtifactJson('existing-main-readonly-port-proof.json', { explicitSetupMutations: 1, setupStartedConnection: false,
      originalMainReportUnobservedBefore: true, sameNativeReportObservedAt: afterReport.result.observedAt,
      sameNativeRequestRevision: afterReport.result.requestRevision, actualHostObservation: true, businessState: 'unknown',
      modelCalls: 0, taskCount: 0, settingsUnchangedByCheck: true, officeStorageInitializedByCheck: false, noSubstituteMain: true });
  }
  if (process.env.KCODER_E2E_STATIC_CHECK_UI === '1') {
    const { assertRendererBuildFresh } = await import('../../harness/renderer-build.mjs');
    const { startChromium } = await import('../../harness/chromium.mjs');
    await assertRendererBuildFresh({ sourceRoot: resolve(process.env.KCODER_E2E_GATEWAY_ROOT || resolve(import.meta.dirname, '../../..'), 'renderer') });
    const browser = await startChromium(context); const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const methods = [];
    page.on('websocket', socket => socket.on('framesent', event => { try { const frame = JSON.parse(String(event.payload)); if (frame.method) methods.push(frame.method); } catch { /* Unrelated frame. */ } }));
    await page.goto(gateway.baseUrl); await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.goto(`${gateway.baseUrl}/office`);
    await page.getByRole('button', { name: /^(Use assistant|使用助手)$/ }).first().click();
    const beforeMethodCount = methods.length;
    const beforeUi = await census(profile);
    await page.getByRole('button', { name: /^(Check requirements|检查依赖)$/ }).click();
    await page.getByTestId('assistant-readiness-panel').waitFor();
    await page.screenshot({ path: context.pathInArtifacts('normal-static-check.png'), fullPage: true });
    assert.equal(await page.getByRole('button', { name: /^(Open application connections|打开应用连接)$/ }).isVisible(), true);
    assert.deepEqual(await census(profile), beforeUi);
    const checkMethods = methods.slice(beforeMethodCount);
    assert.ok(checkMethods.some(method => method === 'integrations/assistant/validate'));
    assert.equal(checkMethods.some(method => /assistant\/adopt|turn\/start|verifyCapability|submitDelivery/.test(method)), false);
    assert.equal(model.requests.length, 0);
    await page.getByRole('button', { name: /^(Open application connections|打开应用连接)$/ }).click();
    const applicationCatalog = page.getByTestId('application-configuration-catalog');
    await applicationCatalog.waitFor({ timeout: 30000 });
    assert.match(await applicationCatalog.innerText(), /declarations only|只是应用声明/);
    await applicationCatalog.getByRole('button', { name: 'Agent Mail', exact: true }).waitFor();
    await page.screenshot({ path: context.pathInArtifacts('normal-application-declaration-catalog.png'), fullPage: true });
    assert.deepEqual(await census(profile), beforeUi, 'Opening the declared catalog cannot initialize a connection or Office store');
    assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('normal-application-catalog-proof.json', { declarationVisible: true, realNormalRoute: '/connections',
      actualNativeCatalogEntry: 'agent_mail', sourceConfiguredOrInstalledIsNotCallable: true, modelCalls: 0, profileUnchanged: true });
  }
  await context.writeArtifactJson('static-check-proof.json', { binarySha256, originalDefinitionId: definition.id, firstUseNoNamespaceWrite: true,
    originalCurrentModel: checked.result.model.model.modelId, budgetReservationState: checked.result.model.budget.reservationState,
    readiness: checked.result.readiness.state, modelCalls: model.requests.length, businessCalls: 0, taskCount: 0,
    ui: process.env.KCODER_E2E_STATIC_CHECK_UI === '1', fakeNativeReply: false });
  return { staticOnly: true, modelCalls: 0, firstUseNoNamespaceWrite: true };
});
