import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, lstat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { openPageGatewayRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { startMigrationNoInferenceFixture, assertNoMigrationInference } from '../../harness/migration-no-inference.mjs';
import { requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Existing registered automation suite: actual Code/Core execution, never a model or synthetic run. */
export async function exerciseUnifiedCodeSchedule(context) {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'frozen ordinary KCoder');
  const binarySha256 = await fileHash(binary);
  assert.match(process.env.KCODER_E2E_KCODER_BIN_SHA256 || '', /^[a-f0-9]{64}$/);
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const noInference = await startMigrationNoInferenceFixture(context);
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'unified-code-schedule' });
  const profile = context.pathInState('profile');
  const settingsFile = await context.writeStateJson('profile/settings.json', {
    active_provider: 'unused-owned', permission_mode: 'ask', max_retries: 0,
    allowed_tools: ['Workflow', 'AutomationSourceRead'], auto_memory_enabled: false,
    memory: { observer_mode: 'disabled', structured_enabled: false }, session_memory: { enabled: false },
    integrations: { knowledge: { business_automation_enabled: false } },
    providers: { 'unused-owned': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: noInference.baseUrl, default_model: 'never-called', discover_models: false,
      context_window_tokens: 1048576, max_output_tokens: 262144, output_headroom_tokens: 8192, no_proxy: true } },
  });
  // Isolate the auth store before startup. Select a different fresh owned directory,
  // never a different mutex for one directory and never another owner's listener.
  let serversStore;
  const storeCandidates = [];
  for (let index = 0; index < 4; index++) {
    const directory = context.pathInState(`gateway-auth-${index}`);
    const root = context.pathInState(`gateway-auth-${index}/mobile-device-auth`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    assert.equal(info.isSymbolicLink(), false); assert.equal(info.mode & 0o077, 0); assert.equal(info.uid, process.getuid());
    const identity = `local-file:${info.dev}:${info.ino}`;
    const port = 49152 + (parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 8), 16) % 16384);
    const probe = createServer(socket => socket.destroy());
    context.addCleanup(`close owned auth mutex preflight ${index}`, async () => {
      if (probe.listening) await new Promise((done, reject) => probe.close(error => error ? reject(error) : done()));
    });
    try {
      await new Promise((done, reject) => { probe.once('error', reject); probe.listen({ host: '127.0.0.1', port, exclusive: true }, done); });
      context.registerPort(`owned-auth-mutex-${index}`, port);
      await new Promise((done, reject) => probe.close(error => error ? reject(error) : done()));
      serversStore = `${directory}/servers.json`;
      storeCandidates.push({ index, port, available: true, probeReleased: true });
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      storeCandidates.push({ index, port, available: false, code: 'EADDRINUSE' });
    }
  }
  await context.writeArtifactJson('owned-auth-store-mutex-precondition.json', { candidates: storeCandidates, selected: serversStore ? storeCandidates.at(-1).index : null, privateUniqueRunContext: true });
  assert.ok(serversStore, 'UNMET_PREREQUISITE: no fresh owned auth store has its original mutex port available');
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned unified scheduled Code', transport: 'local', command: binary, workspace, settingsFile }]);
  const gateway = await startGateway(context, { ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}), workspace, serversFile, serversStore, kcoderBin: binary, auth: true,
    env: { KCODER_CONFIG_DIR: profile, KCODER_TRAINING_MODE: 'false' } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  const methods = [], mutations = [], pageErrors = [], responseShapes = [], observations = [];
  let rpc, scope, subscription, originalRun, removalAttempted = false, workflow, saveRequest;
  const token = `OWNED_CODE_V1_${context.seed}`;
  const digest = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
  const observe = async label => {
    const dom = await page.evaluate(() => {
      const choice = document.querySelector('[data-testid="scheduled-workflow-choice"]');
      const ids = ['knowledge-feature-setup','knowledge-feature-enable','native-knowledge-content','business-subscriptions','workflow-arguments','workflow-arg-value','subscription-form-toggle'];
      return { pathname: location.pathname, selectedValue: choice?.value ?? null, disabled: choice?.disabled ?? null,
        optionCount: choice?.options?.length ?? null, counts: Object.fromEntries(ids.map(id => [id, document.querySelectorAll(`[data-testid="${id}"]`).length])),
        setupText: document.querySelector('[data-testid="knowledge-feature-setup"]')?.textContent?.slice(0, 600) ?? null,
        alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent?.slice(0, 400)).slice(0, 4) };
    });
    const descriptor = await page.evaluate(async () => {
      const response = await fetch('/api/servers', { cache: 'no-store' });
      if (!response.ok) return { status: response.status };
      const server = (await response.json()).servers?.find(item => item.id === 'local');
      if (!server) return { status: response.status, found: false };
      return { status: response.status, found: true, fields: [server.id,server.transport,server.host,server.port,server.user,server.command,server.workspacePath,server.profile,server.settingsFile,server.security?.identity?.mode,server.authorityId,server.accountIdentity?.principalId] };
    });
    observations.push({ label, dom: { ...dom, setupText: context.redactText(dom.setupText ?? ''), alerts: dom.alerts.map(value => context.redactText(value ?? '')) },
      descriptor: { status: descriptor.status, found: descriptor.found, fingerprint: descriptor.fields ? digest(descriptor.fields) : null,
        present: descriptor.fields?.map(value => value != null) } });
  };

  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('websocket', socket => {
    const pending = new Map();
    socket.on('framereceived', event => {
      try { const frame = JSON.parse(String(event.payload)), method = pending.get(String(frame.id));
        if (!method) return; pending.delete(String(frame.id));
        const value = frame.result;
        const shape = { method, resultPresent: value != null, errorCode: frame.error?.code ?? null };
        if (['integrations/automation/previewSubscription','integrations/automation/saveSubscription'].includes(method)) shape.originalReply = { status: value?.status ?? null, fixedCode: value?.error?.code ?? (/^[A-Z][A-Z0-9_]{1,120}$/.test(frame.error?.message ?? '') ? frame.error.message : null), recovery: value?.error?.recovery ?? null, requestId: value?.requestId ?? null, operationId: value?.operationId ?? null, bodySha256: digest(value ?? frame.error) };
        if (method === 'integrations/scope/read' && value) shape.scope = Object.fromEntries(['accountId','targetId','workspaceId','identityGeneration','targetRevision'].map(key => [key, { present: value[key] != null, digest: digest(value[key]) }]));
        if (method === 'workflow/export' && value) shape.definition = { keys: Object.keys(value).sort().slice(0, 32), ownedId: value.id === workflow?.id, savedVersion: value.savedVersion, status: value.status, schemaPresent: value.inputSchema != null, schemaType: value.inputSchema?.type, valueRequired: value.inputSchema?.required?.includes('value') ?? false };
        if (method.startsWith('settings/integrations/knowledge/') && value) shape.settings = { persisted: value.persisted, effective: value.effective, connection: value.connection, restartRequired: value.restartRequired };
        if (method === 'gateway/app-server/restart' && value) shape.restart = { restarted: value.restarted, requiresConfirmation: value.requiresConfirmation, activeTaskCount: value.activeTaskCount };
        responseShapes.push(shape);
      } catch { /* Keep only closed response projections. */ }
    });
    socket.on('framesent', event => {
    try {
      const frame = JSON.parse(String(event.payload));
      if (frame.method) methods.push(frame.method);
      if (['integrations/scope/read','workflow/export','settings/integrations/knowledge/read','settings/integrations/knowledge/save','gateway/app-server/restart','integrations/automation/previewSubscription','integrations/automation/saveSubscription'].includes(frame.method)) pending.set(String(frame.id), frame.method);
      if (frame.method === 'integrations/automation/saveSubscription') {
        saveRequest = { requestId: frame.params.requestId, operationId: frame.params.operationId, draftId: frame.params.payload.draft.id };
        mutations.push({ method: frame.method, ...saveRequest });
      }
      if (frame.method === 'integrations/automation/removeSubscription') mutations.push({ method: frame.method, operationId: frame.params.operationId, id: frame.params.payload.id });
    } catch { /* Keep finite method/operation references, never credentials or raw frames. */ }
    });
  });
  const initialize = async label => {
    rpc = await openPageGatewayRpc(context, page, gateway, label);
    const result = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-unified-code-observer', version: '1' }, capabilities: { experimental: {
      integrationScopeV1: true, integrationOperationReceiptsV1: true, knowledgeSettingsV1: true,
      automationTemplatesV1: true, workflowCanvasV1: true, workflowGraphV2: true, workflowRunsV1: true,
    } } });
    scope = await rpc.request('integrations/scope/read', {});
    return result;
  };
  const call = async (method, payload = {}, mutation) => {
    const request = { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 15_000, payload,
      ...(mutation ? { operationId: mutation.operationId, expectedRevision: mutation.revision === undefined ? undefined : String(mutation.revision) } : {}) };
    const reply = await rpc.request(`integrations/automation/${method}`, request);
    assert.equal(reply.status, 'completed', `${method}: ${reply.error?.code}`);
    return reply.result;
  };
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    const worker = page.getByRole('button', { name: 'KWorker', exact: true });
    if (await worker.count()) await worker.click();
    await observe('before-authoring');
    const first = await initialize('close original pre-enable authoring RPC');
    assert.equal(first.capabilities.experimental.knowledgeSettingsV1, true, 'the pinned ordinary binary must support explicit feature setup');
    assert.equal(first.capabilities.experimental.workflowCanvasV1, true);
    assert.notEqual(first.capabilities.experimental.automationTemplatesV1, true);
    workflow = await rpc.request('workflow/create', { title: `Original Code v1 ${context.seed}` });
    workflow = await rpc.request('workflow/update', { id: workflow.id, expectedRevision: workflow.revision,
      title: workflow.title, description: 'Owned pure Code with an actual input schema.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'integer', title: 'Value', minimum: 1, maximum: 100, default: 7 } } } });
    workflow = await rpc.request('workflow/upsertNode', { id: workflow.id, expectedRevision: workflow.revision,
      node: { id: 'calculate', title: 'Original pure Code', kind: 'code', config: { code: { source: `return {marker:${JSON.stringify(token)},total:input.value*6};`, timeoutMs: 500 } } } });
    const saved = await rpc.request('workflow/save', { id: workflow.id, expectedRevision: workflow.revision });
    assert.equal(saved.savedVersion, 1);
    const original = await rpc.request('workflow/export', { id: saved.id, version: 1 });
    workflow = await rpc.request('workflow/upsertNode', { id: saved.id, expectedRevision: saved.revision,
      node: { id: 'calculate', title: 'Unsubmitted draft must not run', kind: 'code', config: { code: { source: 'return {marker:"UNSAVED_DRAFT_MUST_NOT_RUN",total:-1};', timeoutMs: 500 } } } });
    assert.equal(workflow.status, 'draft');
    assert.deepEqual(await rpc.request('workflow/export', { id: saved.id, version: 1 }), original);
    await closeRpcAndWait(rpc, 'close authoring before explicit UI reconnection');
    await page.getByTestId('automations-button').click();
    await page.getByTestId('scheduled-task-kind').selectOption('workflow');
    const choice = page.getByTestId('scheduled-workflow-choice');
    const selected = JSON.stringify([saved.id, 1]);
    await choice.locator(`option[value='${selected}']`).waitFor({ state: 'attached' });
    assert.equal(await choice.isEnabled(), true, 'feature-off must not hide existing saved versions');
    await choice.selectOption(selected);
    await observe('selected-before-enable');
    await page.getByTestId('knowledge-feature-enable').click();
    await observe('enable-dispatched');
    await page.getByTestId('workflow-arg-value').waitFor();
    await observe('after-enable-parameters-visible');
    const initialized = await initialize('close original post-enable observer RPC');
    assert.equal(initialized.capabilities.experimental.automationTemplatesV1, true);
    const currentSettings = await rpc.request('settings/integrations/knowledge/read', {});
    assert.equal(currentSettings.effective.businessAutomationEnabled, true);
    assert.equal(currentSettings.connection.businessAutomationEnabled, true);
    assert.equal(currentSettings.effective.publicationsEnabled, false);
    assert.equal((await call('listSubscriptions')).page.items.length, 0);
    const title = `Unified Code schedule ${context.seed}`;
    await page.getByTestId('subscription-title').fill(title);
    await page.getByTestId('workflow-arg-value').fill('7');
    await page.getByTestId('subscription-schedule-mode').selectOption('once');
    const fireAt = await page.evaluate(() => {
      const at = new Date(Date.now() + 25_000); at.setMilliseconds(0);
      const p = value => String(value).padStart(2, '0');
      return { local: `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`, iso: at.toISOString() };
    });
    await page.locator('input[type="datetime-local"]').fill(fireAt.local);
    await page.getByTestId('subscription-preview').click();
    const previewShape = await waitFor(() => responseShapes.find(item => item.method === 'integrations/automation/previewSubscription'), 15_000, 'original preview wire receipt', 50, context.abortSignal);
    await context.writeArtifactJson('unified-original-preview-receipt-shape.json', previewShape);
    await page.waitForFunction(() => document.querySelector('[data-testid="subscription-consent"]')?.disabled === false);
    assert.equal((await call('listSubscriptions')).page.items.length, 0, 'preview is not a creation intent');
    assert.equal((await call('listAutomationRuns')).page.items.length, 0);
    // Exact-ID cleanup is registered before the one UI creation intent; an unknown delete is never replayed.
    context.addCleanup('cancel only an active owned unified Code run', async () => {
      if (!saveRequest) return;
      const runs = (await call('listAutomationRuns')).page.items.filter(run => run.subscriptionId === saveRequest.draftId);
      for (const run of runs) if (['preparing', 'accepted', 'running', 'waiting', 'unknown'].includes(run.status)) {
        await call('cancelAutomationRun', { runId: run.id }, { operationId: randomUUID() });
        await waitFor(async () => !['preparing', 'accepted', 'running', 'waiting', 'unknown'].includes((await call('readAutomationRun', { runId: run.id })).run.status), 10_000, 'owned original Code cancellation');
      }
    });
    context.addCleanup('remove only the original UI-created unified schedule', async () => {
      if (!saveRequest) return;
      const found = (await call('listSubscriptions')).page.items.find(item => item.draft.id === saveRequest.draftId);
      if (!found) return;
      assert.equal(removalAttempted, false, 'unknown original UI removal must be reconciled, never replayed');
      removalAttempted = true;
      await call('removeSubscription', { id: found.draft.id }, { operationId: randomUUID(), revision: found.revision });
    });
    await page.getByTestId('subscription-consent').check();
    await page.getByTestId('subscription-save').click();
    const saveShape = await waitFor(() => responseShapes.find(item => item.method === 'integrations/automation/saveSubscription'), 15_000, 'original one UI save wire receipt', 50, context.abortSignal);
    await context.writeArtifactJson('unified-original-save-receipt-shape.json', { originalRequest: saveRequest, response: saveShape });
    assert.ok(['accepted', 'completed'].includes(saveShape.originalReply?.status), `Original UI save ${saveShape.originalReply?.status}/${saveShape.originalReply?.fixedCode ?? saveShape.errorCode}`);
    subscription = await waitFor(async () => (await call('listSubscriptions')).page.items.find(item => item.draft.id === saveRequest?.draftId), 10_000, 'original UI-created schedule');
    assert.equal(subscription.draft.workflowId, saved.id); assert.equal(subscription.draft.workflowVersion, 1);
    assert.deepEqual(subscription.draft.inputs, { value: 7 });
    assert.equal(subscription.draft.schedule.at, fireAt.iso);
    originalRun = await waitFor(async () => {
      const runs = (await call('listAutomationRuns')).page.items.filter(run => run.subscriptionId === subscription.draft.id);
      assert.ok(runs.length <= 1, 'the one original trigger must never be replayed');
      const run = runs[0];
      if (run && ['failed', 'cancelled'].includes(run.status)) throw new Error(`Original Code run failed: ${run.status}/${run.errorCode}`);
      return run?.status === 'completed' ? run : null;
    }, 65_000, 'original scheduler and Core completion', 150, context.abortSignal);
    assert.ok(originalRun.nativeTaskId); assert.ok(originalRun.nativeThreadId);
    const core = await rpc.request('workflow/runs/read', { runId: originalRun.nativeTaskId });
    assert.ok(core.nodeStates.some(node => node.nodeId === 'calculate' && node.status === 'completed'));
    const output = await rpc.request('workflow/runs/output', { runId: originalRun.nativeTaskId, nodeId: 'calculate', offset: 0, limit: 16384 });
    assert.ok(output.text.includes(token)); assert.ok(output.text.includes('42'));
    assert.ok(!String(originalRun.output).includes('UNSAVED_DRAFT_MUST_NOT_RUN'));
    await page.getByTestId('automation-tab-inbox').click();
    const row = page.getByTestId('automation-run').filter({ hasText: title });
    await row.waitFor();
    await row.locator('summary').click();
    assert.ok((await row.innerText()).includes(token)); assert.ok((await row.innerText()).includes('42'));
    await context.writeArtifactJson('unified-code-schedule-original-proof.json', { binarySha256, saved, editedDraft: workflow,
      originalDefinition: original, settings: currentSettings, subscription, run: originalRun, core, output,
      methods, mutations, observations, responseShapes, modelAudit: assertNoMigrationInference(noInference.requests), paidCalls: 0 });
    await page.getByTestId('automation-tab-history').click();
    const createdRow = page.getByTestId('subscription-row').filter({ hasText: title });
    await createdRow.waitFor(); await createdRow.getByTestId('subscription-remove-open').click();
    removalAttempted = true;
    await page.getByTestId('subscription-remove-dialog-confirm').click();
    await waitFor(async () => !(await call('listSubscriptions')).page.items.some(item => item.draft.id === subscription.draft.id), 10_000, 'exact original schedule removal');
    assert.equal((await call('readAutomationRun', { runId: originalRun.id })).run.id, originalRun.id, 'schedule removal preserves the original run');
    assert.equal((await rpc.request('workflow/export', { id: saved.id, version: 1 })).id, saved.id);
    assert.deepEqual(pageErrors, []);
    assert.equal(mutations.filter(item => item.method === 'integrations/automation/saveSubscription').length, 1);
    assert.ok(!methods.includes('integrations/automation/triggerApprovedSubscription'));
    assertNoMigrationInference(noInference.requests);
    assert.equal(await fileHash(binary), binarySha256);
    return { unifiedScheduledCodeActual: true, savedV1RemainsAfterDraftEdit: true, explicitEnableReconnect: true,
      uiCreatedOriginalSchedule: subscription.draft.id, actualCoreRun: originalRun.nativeTaskId,
      originalOutputInInbox: true, exactScheduleRemoved: true, originalRunPreserved: true, modelCalls: 0, paidCalls: 0, binarySha256 };
  } catch (error) {
    await observe('failure').catch(diagnostic => observations.push({ label: 'failure-observation-unavailable', error: context.redactText(diagnostic.message) }));
    await context.writeArtifactJson('unified-code-schedule-owned-observations.json', { observations, responseShapes });
    await context.writeArtifactJson('unified-code-schedule-failure.json', { error: error.message, binarySha256, methods, mutations,
      subscription: subscription ?? null, originalRun: originalRun ?? null, modelAudit: noInference.requests, paidCalls: 0 });
    throw error;
  } finally { await page.close(); }
}
