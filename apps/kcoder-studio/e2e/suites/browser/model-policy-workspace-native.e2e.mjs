import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'model-policy-actual-native-workspace', tier: 'full-integration',
  modelPolicy: 'Model-independent actual authenticated Gateway/native profile CAS and original receipt recovery. Metadata stays at zero generation calls; one separate ordinary controlled user turn reports fixed actual HTTP usage. This does not assess model quality, same-run failover, or Electron/Windows behavior.',
  retainSuccessEvidence: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'current native model-policy app-server');
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'MODEL_POLICY_CONTROLLED_USER_USAGE_RESPONSE', usage: { prompt_tokens: 111, completion_tokens: 23, total_tokens: 134, prompt_tokens_details: { cached_tokens: 0 } } });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'model-policies-native' });
  const { path: peerWorkspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'model-policies-peer' });
  const provider = name => ({ api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: name, context_window_tokens: 128000, max_output_tokens: 4096, output_headroom_tokens: 8192, no_proxy: true, discover_models: false });
  const settings = { active_provider: 'ConfiguredAlpha', model: 'alpha', max_retries: 0, session_memory: { enabled: false }, providers: { ConfiguredAlpha: provider('alpha'), ConfiguredBeta: provider('beta') }, integrations: { core: { modelPolicies: [] } } };
  const settingsFile = await context.writeStateJson('profile/settings.json', settings);
  const peerSettingsFile = await context.writeStateJson('peer-profile/settings.json', settings);
  // Different settings overlays alone do not select different user profiles.
  // This owned fixture launcher only supplies the native profile directory.
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const peerLauncher = context.pathInState('peer-kcoder');
  await writeFile(peerLauncher, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(context.pathInState('peer-profile'))}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });

  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Model policy target A', transport: 'local', command: binary, workspace, settingsFile },
    { id: 'peer', label: 'Model policy target B', transport: 'local', command: peerLauncher, workspace: peerWorkspace, settingsFile: peerSettingsFile },
  ]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true,
    ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}),
    env: { KCODER_CONFIG_DIR: context.pathInState('profile') } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1400, height: 1050 } });
  const wire = [], saved = [], pageErrors = [], completedTurns = [], consoleErrors = [], failedResources = [], ownedRoutes = new Set();
  const fault = { dropSave: false, dropped: [] };
  // All bytes/results come from the actual target. The owned transport may
  // discard one confirmed save ACK; it never manufactures a native receipt.
  await page.routeWebSocket('**/rpc?**', route => {
    const serverId = new URL(route.url()).searchParams.get('server');
    const upstream = route.connectToServer(); const pending = new Map(); ownedRoutes.add(route);
    route.onMessage(message => {
      try { const frame = JSON.parse(String(message)); if (typeof frame.method === 'string') { pending.set(String(frame.id), frame.method); wire.push({ serverId, method: frame.method }); } } catch { /* Preserve opaque protocol bytes. */ }
      upstream.send(message);
    });
    upstream.onMessage(message => {
      let frame, method;
      try { frame = JSON.parse(String(message)); method = pending.get(String(frame.id)); pending.delete(String(frame.id)); } catch { /* The actual client validates malformed data. */ }
      if (frame?.method === 'turn/completed') completedTurns.push({ threadId: frame.params?.threadId ?? frame.params?.turn?.threadId, turnId: frame.params?.turnId ?? frame.params?.turn?.id, status: frame.params?.turn?.status });
      if (method === 'integrations/models/settings/save' && frame?.result?.result?.operation) {
        const receipt = frame.result.result.operation;
        saved.push({ serverId, operationId: receipt.operationId, phase: receipt.phase, revision: receipt.entityRef?.revision ?? null });
        if (fault.dropSave && receipt.phase === 'completed') {
          fault.dropSave = false; fault.dropped.push({ operationId: receipt.operationId, phase: receipt.phase });
          route.close({ code: 1011, reason: 'owned native model policy save ACK loss' }); upstream.close(); return;
        }
      }
      route.send(message);
    });
  });
  context.addCleanup('close owned model policy browser fault routes', () => { for (const route of ownedRoutes) { try { route.close(); } catch { /* Already closed. */ } } ownedRoutes.clear(); });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if(message.type()==='error') consoleErrors.push(context.redactText(message.text()).slice(0,1200)); });
  page.on('requestfailed', request => { const url = new URL(request.url()); failedResources.push({path:url.pathname,type:request.resourceType(),error:request.failure()?.errorText}); });
  let reader; const cases = [];
  const text = (en, zh) => new RegExp(`^(?:${en}|${zh})$`);
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    const csrf = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content'); assert.ok(csrf); context.registerSecret(csrf);
    const cookie = (await page.context().cookies(gateway.baseUrl)).map(item => `${item.name}=${item.value}`).join('; '); context.registerSecret(cookie);
    reader = await openRpc(gatewayRpcUrl(gateway, 'local', csrf), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close native model policy verification RPC', () => closeRpcAndWait(reader));
    const init = await reader.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'model-policy-native-reader', version: '1' }, capabilities: { experimental: { integrationScopeV1: true, modelPoliciesV1: true, modelHealthV1: true, modelUsageV1: true, modelPolicySettingsV1: true } } });
    for (const capability of ['integrationScopeV1', 'modelPoliciesV1', 'modelHealthV1', 'modelUsageV1', 'modelPolicySettingsV1']) assert.equal(init.capabilities?.experimental?.[capability], true);
    const scope = await reader.request('integrations/scope/read', {});
    const envelope = (payload, mutation = {}) => ({ contractVersion: 'parallel-v1', requestId: `model-policy-e2e-${context.seed}`, scope, timeoutMs: 10000, payload, ...mutation });
    assert.equal((await reader.request('thread/list', { limit: 10 })).threads.length, 0);
    await page.goto(`${gateway.baseUrl}/settings/personal/models`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('root')?.childElementCount), {timeout:60000});
    await page.getByTestId('provider-target').selectOption('local');
    const panel = page.getByTestId('native-model-policies'); await panel.waitFor({ timeout: 30000 });
    const editor = panel.getByTestId('model-policy-settings');
    await editor.getByRole('button', { name: text('Add pool', '添加候选池') }).waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await panel.getByRole('combobox', { name: text('Choose a policy', '选择策略') }).inputValue(), '');
    await editor.getByRole('button', { name: text('Add pool', '添加候选池') }).click();
    await editor.getByRole('textbox', { name: text('Pool name', '候选池名称') }).fill(`原生模型候选-${context.seed}`);
    await editor.getByRole('button', { name: text('Add candidate', '添加候选模型') }).click();
    let candidates = editor.getByRole('combobox', { name: text('Configured provider and model', '已配置的 Provider 和模型') });
    assert.equal(await candidates.nth(0).inputValue(), '["",""]');
    await candidates.nth(0).selectOption('["ConfiguredAlpha","alpha"]');
    await editor.getByRole('button', { name: text('Add candidate', '添加候选模型') }).click();
    await candidates.nth(1).selectOption('["ConfiguredBeta","beta"]');
    await editor.getByRole('button', { name: text('Move earlier', '向前移动') }).nth(1).click();
    await editor.getByRole('button', { name: text('Save pools', '保存候选池') }).click();
    await editor.getByText(text('The original save receipt confirms this configuration was saved\\.', '原保存回执已确认此配置保存成功。')).waitFor({ timeout: 30000 });
    const snapshot = await reader.request('integrations/models/settings/read', envelope({}));
    assert.equal(snapshot.status, 'completed'); assert.equal(snapshot.result.policies.length, 1);
    assert.deepEqual(snapshot.result.policies[0].candidates.map(candidate => candidate.provider), ['ConfiguredBeta', 'ConfiguredAlpha']);
    const catalog = await reader.request('integrations/models/readPolicies', envelope({})); const reference = catalog.result.policies[0].reference;
    const chooser = panel.getByRole('combobox', { name: text('Choose a policy', '选择策略') });
    await chooser.selectOption(JSON.stringify([reference.id, reference.version]));
    await panel.getByRole('button', { name: text('Preview candidate', '预检候选模型') }).click();
    await panel.getByText(/ConfiguredBeta \/ beta/).first().waitFor({ timeout: 30000 });
    await panel.getByRole('button', { name: text('Read observations', '读取观察记录') }).click();
    await panel.getByText(text('Not observed / awaiting a new probe', '尚未观察或等待重新探测')).first().waitFor({ timeout: 30000 });
    await panel.getByRole('button', { name: text('Read reported usage', '读取已报告用量') }).click();
    await panel.getByText(text('Last reported provider usage', '上次模型服务报告的用量')).waitFor({ timeout: 30000 });
    await panel.getByText(text('Partial or unknown report', '部分报告或尚未确认')).first().waitFor({ timeout: 30000 });
    assert.ok((await panel.innerText()).includes('未知') || (await panel.innerText()).includes('Unknown'), 'Missing actual reported usage must remain unknown');

    cases.push({ id: 'native-empty-pool-create-order-cas-preview-health', configuredOrder: ['ConfiguredBeta', 'ConfiguredAlpha'], observedState: 'unknown', executionCreated: false });
    await page.emulateMedia({ colorScheme: 'light' }); await panel.screenshot({ path: context.pathInArtifacts('model-policy-workspace-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' }); await panel.screenshot({ path: context.pathInArtifacts('model-policy-workspace-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });

    // Discard a real completed mutation ACK, then make a distinct real peer edit.
    fault.dropSave = true;
    await editor.getByRole('textbox', { name: text('Pool name', '候选池名称') }).fill(`失回执模型策略-${context.seed}`);
    await editor.getByRole('button', { name: text('Save pools', '保存候选池') }).click();
    await waitFor(() => fault.dropped.length === 1, 30000, 'actual committed save ACK discarded');
    const originalId = fault.dropped[0].operationId;
    const original = await reader.request('integrations/models/settings/readOperation', envelope({ operationId: originalId }));
    assert.equal(original.result.receipt.phase, 'completed');
    const current = await reader.request('integrations/models/settings/read', envelope({}));
    const peerPolicies = structuredClone(current.result.policies); peerPolicies[0].title = `原生同行后续修改-${context.seed}`;
    const peerSaved = await reader.request('integrations/models/settings/save', envelope({ policies: peerPolicies }, { operationId: `model-policy-peer-${context.seed}`, expectedRevision: current.result.revision }));
    assert.equal(peerSaved.result.operation.phase, 'completed');
    const reconcile = editor.getByRole('button', { name: text('Check original save', '核对原保存记录') });
    await reconcile.waitFor({ state: 'visible', timeout: 30000 }); await reconcile.click();
    await editor.getByText(text('The original save completed, and the configuration has since changed\\.', '原保存已完成，当前配置此后又发生了修改。')).waitFor({ timeout: 30000 });
    assert.equal(await editor.getByRole('textbox', { name: text('Pool name', '候选池名称') }).inputValue(), peerPolicies[0].title);
    assert.equal(wire.filter(entry => entry.serverId === 'local' && entry.method === 'integrations/models/settings/save').length, 2, 'The browser must not replay its lost-ACK save');
    cases.push({ id: 'original-save-receipt-and-later-peer-config-are-distinct', originalOperationId: originalId, originalConfirmed: true, peerCurrent: true, repeatedSave: false });

    await page.setViewportSize({ width: 480, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'The real settings page must contain narrow policy controls');
    await page.screenshot({ path: context.pathInArtifacts('model-policy-workspace-narrow.png') });
    await page.setViewportSize({ width: 1400, height: 1050 });
    await page.getByTestId('provider-target').selectOption('peer');
    const peerPanel = page.getByTestId('native-model-policies');
    await peerPanel.getByRole('button', { name: text('Add pool', '添加候选池') }).waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await peerPanel.getByRole('combobox', { name: text('Choose a policy', '选择策略') }).inputValue(), '');
    assert.equal(await peerPanel.getByRole('textbox', { name: text('Pool name', '候选池名称') }).count(), 0);
    cases.push({ id: 'explicit-target-change-keeps-personal-policy-scope', foreignPoolCopied: false });
    assert.equal(model.requests.length, 0, 'Metadata/configuration flows must never generate model output');
    assert.ok(!wire.some(entry => ['thread/start', 'thread/resume', 'turn/start'].includes(entry.method)), 'Policy configuration must not invent a conversation');
    assert.equal((await reader.request('thread/list', { limit: 10 })).threads.length, 0);
    // The metadata phase above must stay entirely generation-free. Only this
    // separate explicit ordinary user turn may call the bounded protocol fixture.
    await page.getByTestId('provider-target').selectOption('local');
    const localPanel = page.getByTestId('native-model-policies');
    await localPanel.getByRole('combobox', { name: text('Choose a policy', '选择策略') }).waitFor({ timeout: 30000 });
    const created = await page.evaluate(async params => {
      const invoke = window.__ELECTRON_INTERNALS__?.invoke;
      if (typeof invoke !== 'function') throw new Error('Actual LocalExecutor IPC unavailable');
      return await invoke('local_executor_request', { method: 'runtime.tasks.create', params });
    }, { deviceId: 'local', taskId: `model-usage-controlled-${context.seed}`, workspacePath: workspace, studioWorkMode: 'kcoder', clientMessageId: `model-usage-message-${context.seed}`, executionRequest: { prompt: 'MODEL_USAGE_ONE_CONTROLLED_USER_TURN: reply once using the configured local protocol fixture.' } });
    const threadId = created?.runtimeHandle?.threadId ?? created?.threadId;
    assert.ok(typeof threadId === 'string' && threadId, 'The real native thread/start must return an original thread id');
    await waitFor(() => completedTurns.some(turn => turn.threadId === threadId && turn.status === 'completed'), 30000, 'actual one controlled native user turn completed');
    assert.equal(model.requests.length, 1, 'The explicit user stage owns exactly one generation request');
    const actualCatalog = await reader.request('integrations/models/readPolicies', envelope({}));
    const actualRef = actualCatalog.result.policies[0].reference;
    await localPanel.getByRole('combobox', { name: text('Choose a policy', '选择策略') }).selectOption(JSON.stringify([actualRef.id, actualRef.version]));
    await localPanel.getByRole('button', { name: text('Read reported usage', '读取已报告用量') }).click();
    await localPanel.getByText(/(?:Input tokens|输入 tokens): 111 · (?:Output tokens|输出 tokens): 23/).waitFor({ timeout: 30000 });
    await localPanel.getByText(/(?:Total tokens|合计 tokens): 134 · (?:Cache-read input tokens|缓存读取输入 tokens): 0/).waitFor({ timeout: 30000 });
    assert.ok((await localPanel.innerText()).includes('部分报告') || (await localPanel.innerText()).includes('Partial or unknown'), 'Normalized usage without raw presence must stay partial');
    cases.push({ id: 'actual-http-native-read-usage-to-page-counters', controlledThreadId: threadId, generationRequests: 1, input: 111, output: 23, total: 134, cacheRead: 0, complete: false, cost: 'unknown' });
    await localPanel.screenshot({ path: context.pathInArtifacts('model-policy-reported-usage.png') });
    assert.deepEqual(pageErrors, []);
    await context.writeArtifactJson('model-policy-workspace-native-evidence.json', { schemaVersion: 1, actualAuthenticatedGateway: true, actualNativeProfileTransactions: true, cases, methods: wire, originalSaves: saved, metadataModelCalls: 0, metadataGhostThreads: 0, controlledUserModelCalls: model.requests.length, screenshots: ['model-policy-workspace-light.png', 'model-policy-workspace-dark.png', 'model-policy-workspace-narrow.png'], limitations: ['Browser protocol/metadata/configuration only; no paid-model quality, same-run model failover, native Electron or Windows claim.'] });
    return { actualNativeProfileCas: true, originalReceiptRecovery: true, metadataModelCalls: 0, controlledUserModelCalls: model.requests.length, cases: cases.length };
  } catch (error) {
    await context.writeArtifactJson('model-policy-workspace-native-failure.json', { error: String(error.message), pageErrors, consoleErrors, failedResources, methods: wire, originalSaves: saved, modelCalls: model.requests.length, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 12000) });
    await page.screenshot({ path: context.pathInArtifacts('model-policy-workspace-native-failure.png'), fullPage: true }).catch(() => {}); throw error;
  } finally { await closeRpcAndWait(reader); await page.close(); }
});
