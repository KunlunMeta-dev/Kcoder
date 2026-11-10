import { openWorkflowTaskCreator } from '../../harness/automation-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { openPageGatewayRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { nativeOfficeSpawnEnvironment, prepareNativeOfficeLaunch } from '../../../src/integrations/office/resource-host.mjs';
import { claimSpecification, discoveryCall, documentCall, discoveryResult, toolResult, toolSteps } from '../office/native-download-model.mjs';
import { enableNativeOfficeInPage } from '../office/native-setup-flow.mjs';

async function fileSha256(path) {
  const digest = createHash('sha256');
  for await (const block of createReadStream(path)) digest.update(block);
  return digest.digest('hex');
}

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'automation-native-office-original-claim-through-normal-studio', tier: 'full-integration',
  modelPolicy: 'model-independent bounded HTTP tool protocol through normal scheduler/Core/Office/Studio; files and receipts are native, no live model quality claim',
  retainSuccessEvidence: true, retainSuccessLogs: true,
}, async context => {
  assert.equal(process.platform, 'linux');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'normal KCoder app-server');
  const binarySha256 = await fileSha256(binary);
  if (process.env.KCODER_E2E_KCODER_SHA256) assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_SHA256);
  assert.ok(process.env.KCODER_OFFICE_NATIVE_NODE_LAUNCH, 'Explicit sealed native Office Node input required');
  const observation = JSON.parse(await readFile(process.env.KCODER_OFFICE_NATIVE_NODE_LAUNCH, 'utf8'));
  assert.equal(observation.runtime?.mode, 'standalone_node');
  const launch = await prepareNativeOfficeLaunch({ componentRoot: observation.componentRoot,
    expectedManifestSha256: observation.manifestSha256, expectedMode: 'standalone_node' });
  await context.writeArtifactJson('normal-native-inputs.json', { binary, binarySha256,
    officeManifestSha256: observation.manifestSha256, officeRuntimeMode: 'standalone_node',
    normalGatewayAndAppServer: true, libtest: false, debugTickOrCoreRpc: false });
  const specification = { ...claimSpecification(context.seed), title: `Original scheduled Office ${context.seed}` };
  const protocol = [], protocolErrors = [];
  let generated;
  const model = await startApprovalModelFixture(context, {
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    responseSteps({ body, requestNumber }) {
      try {
        assert.ok(requestNumber <= 3, 'Only original discovery, native generation and final response');
        const result = toolResult(body, requestNumber === 2 ? discoveryCall : documentCall);
        const codes = [...new Set(JSON.stringify(result ?? {}).match(/\b(?:NATIVE|OFFICE|AUTOMATION|RUNTIME|INTEGRATION|MODEL|KNOWLEDGE|TASK)_[A-Z0-9_]+\b/g) ?? [])].slice(0, 16);
        protocol.push({ requestNumber, model: body.model, toolResultPresent: result !== null,
          errorFlag: Boolean(result?.is_error || result?.isError || codes.length), codes,
          resultSha256: createHash('sha256').update(JSON.stringify(result ?? null)).digest('hex') });
        if (requestNumber === 1) {
          assert.ok(body.tools.some(tool => tool.function?.name === 'tool_search'));
          return toolSteps(discoveryCall, 'tool_search', { query: 'OfficeDocument', limit: 1 });
        }
        if (requestNumber === 2) {
          assert.equal(discoveryResult(body).tools[0].name, 'OfficeDocument');
          return toolSteps(documentCall, 'tool_execute', { tool_name: 'OfficeDocument', arguments: { specification, sourceRefs: [] } });
        }
        assert.equal(result?.format, 'docx', 'Original native Office tool result must succeed');
        assert.match(result.sha256, /^[a-f0-9]{64}$/);
        assert.ok(result.artifactRef?.id);
        assert.ok(!JSON.stringify(body.messages).includes(specification.paragraphs[1].text), 'Native canonical source projection must replace the saved body');
        generated = result;
        return [{ delta: { content: '{"verified":true,"actualOfficeArtifact":true}' } }, { finishReason: 'stop' }];
      } catch (error) {
        protocolErrors.push({ requestNumber, code: error.code ?? error.name, message: error.message });
        // A missing receipt never authorizes replaying the Office side effect.
        return [{ delta: { content: 'OWNED_AUTOMATION_OFFICE_RESULT_UNCONFIRMED' } }, { finishReason: 'stop' }];
      }
    },
  });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'original-automation-office-claim' });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {
    active_provider: 'office-protocol', permission_mode: 'bypass', max_tokens: 262144, max_retries: 0,
    allowed_tools: ['Workflow', 'AutomationSourceRead', 'OfficeDocument', 'tool_search', 'tool_execute'],
    auto_memory_enabled: false, memory: { observer_mode: 'disabled', structured_enabled: false },
    session_memory: { enabled: false }, knowledge: { enabled: true },
    integrations: { office: { enabled: false }, knowledge: { business_automation_enabled: true } },
    providers: { 'office-protocol': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'office-protocol', context_window_tokens: 1048576,
      max_output_tokens: 262144, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Original automation Office fixture', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true,
    env: { KCODER_CONFIG_DIR: profile, RUST_LOG: 'warn', ...nativeOfficeSpawnEnvironment(launch) } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const pageErrors = [], wire = [], artifactReads = [], exports = [], acknowledgements = [];
  let originalRun, originalManifest, rpc, scope;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('websocket', socket => {
    const pending = new Map();
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (!frame.method) return;
        pending.set(String(frame.id), { method: frame.method, payload: frame.params?.payload });
        wire.push({ method: frame.method, ...(frame.method === 'attachment/read/chunk' ? { offset: frame.params?.offset, length: frame.params?.length } : {}) });
      } catch { /* Authentication and raw frames are excluded from evidence. */ }
    });
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        const request = pending.get(String(frame.id));
        if (!request) return;
        pending.delete(String(frame.id));
        if (request.method === 'integrations/artifact/read') artifactReads.push({ reference: request.payload?.reference, reply: frame.result });
        if (request.method === 'integrations/artifact/export') exports.push({ task: request.payload?.task ?? null, reply: frame.result });
        if (request.method === 'integrations/artifact/acknowledgeExport') acknowledgements.push(frame.result);
      } catch { /* Retain typed artifact and claim metadata only. */ }
    });
  });
  const call = async (domain, method, payload = {}) => {
    const reply = await rpc.request(`integrations/${domain}/${method}`, { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 30000, payload });
    assert.equal(reply.status, 'completed', `${method}: ${reply.error?.code}`);
    return reply.result;
  };
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await enableNativeOfficeInPage(context, page, gateway.baseUrl);
    assert.equal(model.requests.length, 0);
    rpc = await openPageGatewayRpc(context, page, gateway, 'close original automation Office observation RPC');
    await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'original-automation-office-observer', version: '1' },
      capabilities: { experimental: { integrationScopeV1: true, automationTemplatesV1: true, integrationOperationReceiptsV1: true,
        workflowCanvasV1: true, workflowGraphV2: true, workflowRunsV1: true, studioWorkModesV1: true,
        officeWorkspaceV1: true, officeExportAcknowledgementV1: true } } });
    scope = await rpc.request('integrations/scope/read');
    let workflow = await rpc.request('workflow/create', { title: specification.title, description: 'Original scheduler/Office child; no main model turn.' });
    workflow = await rpc.request('workflow/upsertNode', { id: workflow.id, expectedRevision: workflow.revision,
      node: { id: 'document', title: 'Generate original Office document', kind: 'agent', agentType: 'general', maxTurns: 3,
        prompt: 'Discover OfficeDocument with tool_search, use tool_execute exactly once for the explicit bounded document, then report completion.' } });
    workflow = await rpc.request('workflow/save', { id: workflow.id, expectedRevision: workflow.revision });
    assert.equal(workflow.savedVersion, 1);
    assert.equal(model.requests.length, 0);
    await page.goto(`${gateway.baseUrl}/context`, { waitUntil: 'domcontentloaded' });
    await openWorkflowTaskCreator(page);
    const choice = `${workflow.id}@1`;
    await page.getByTestId('subscription-workflow').locator(`option[value="${choice}"]`).waitFor({ state: 'attached' });
    await page.getByTestId('subscription-workflow').selectOption(choice);
    await page.getByTestId('subscription-title').fill(specification.title);
    await page.getByTestId('subscription-schedule-mode').selectOption('once');
    const at = new Date(Date.now() + 20000);
    await page.getByTestId('subscription-datetime').fill(new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 19));
    await page.getByTestId('subscription-tokens').fill('1000000');
    await page.getByTestId('subscription-preview').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="subscription-consent"]')?.disabled === false);
    await page.getByTestId('subscription-consent').check();
    await page.getByTestId('subscription-save').click();
    await page.getByTestId('subscription-row').filter({ hasText: specification.title }).waitFor({ timeout: 15000 });
    const subscription = (await call('automation', 'listSubscriptions')).page.items.find(item => item.draft.title === specification.title);
    assert.ok(subscription);
    originalRun = await waitFor(async () => {
      const runs = (await call('automation', 'listAutomationRuns')).page.items.filter(item => item.subscriptionId === subscription.draft.id);
      assert.ok(runs.length <= 1, 'Original scheduler must not duplicate the subscription run');
      if (runs[0]) originalRun = runs[0];
      if (runs[0] && ['failed', 'cancelled'].includes(runs[0].status)) throw new Error(`Original automation failed: ${runs[0].errorCode}`);
      return runs[0]?.status === 'completed' ? runs[0] : null;
    }, 150000, 'normal original scheduler/Core/Office completion', 300, context.abortSignal);
    assert.deepEqual(protocolErrors, []);
    assert.equal(model.requests.length, 3);
    assert.ok(generated);
    const refs = (await call('automation', 'readAutomationArtifacts', { id: originalRun.id })).artifactRefs;
    assert.deepEqual(refs, [{ kind: 'artifact', id: generated.artifactRef.id, revision: String(generated.artifactRef.revision) }]);
    assert.equal((await call('automation', 'readAutomationClaims', { id: originalRun.id })).page.items.length, 0);
    originalManifest = (await call('artifact', 'read', { reference: generated.artifactRef })).manifest;
    assert.equal(originalManifest.task.runId, originalRun.nativeTaskId);
    assert.notEqual(originalManifest.task.threadId, originalRun.nativeThreadId);
    await page.getByTestId('business-subscriptions').getByTestId('knowledge-refresh').last().click();
    const row = page.getByTestId('automation-run').filter({ hasText: specification.title });
    await row.waitFor({ timeout: 15000 });
    await row.locator('summary').first().click();
    await row.getByTestId('automation-open-artifacts').click();
    const viewer = page.getByTestId('task-artifact-viewer');
    await viewer.getByRole('heading', { name: specification.title, exact: true }).waitFor({ timeout: 30000 });
    const downloaded = page.waitForEvent('download', { timeout: 30000 });
    void downloaded.catch(() => {});
    await viewer.locator('li[data-office-kind="document"]').getByRole('button', { name: /^(?:下载|Download)$/ }).click();
    const download = await downloaded;
    const claimedFile = context.pathInArtifacts('original-automation-claimed.docx');
    await download.saveAs(claimedFile);
    const receipt = exports.at(-1)?.reply?.result?.export;
    assert.ok(receipt);
    const bytes = await readFile(claimedFile);
    assert.equal(bytes.length, receipt.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
    assert.deepEqual([...bytes.subarray(0, 2)], [80, 75]);
    assert.ok(wire.some(item => item.method === 'attachment/read/chunk'));
    assert.equal(exports.at(-1).task, null, 'Never overwrite managed proof with an ordinary parent task');
    await waitFor(() => acknowledgements.find(reply => reply?.status === 'completed'), 15000, 'original native acknowledgement', 50, context.abortSignal);
    const claims = (await call('automation', 'readAutomationClaims', { id: originalRun.id })).page.items;
    assert.equal(claims.length, 1);
    assert.equal(claims[0].exportId, receipt.exportId);
    assert.equal(claims[0].sha256, receipt.sha256);
    assert.equal(claims[0].bytes, receipt.bytes);
    assert.equal(model.requests.length, 3);
    assert.ok(!wire.some(item => item.method === 'turn/start'), 'No synthetic main model turn');
    assert.deepEqual((await call('automation', 'readAutomationClaims', { id: originalRun.id })).page.items, claims);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: context.pathInArtifacts('original-automation-office-download.png'), fullPage: true });
    await context.writeArtifactJson('original-automation-office-claim.json', { workflowId: workflow.id, savedVersion: 1,
      subscriptionId: subscription.draft.id, run: originalRun, manifest: originalManifest, export: receipt, claims,
      protocol, wire, providerCalls: model.requests.length, paidCalls: 0, browserSavedFullBytes: true,
      normalScheduler: true, libtest: false, rawArtifactStoreWrites: false });
    return { originalNormalSchedulerCoreOfficeUiClaim: true, bytes: receipt.bytes, sha256: receipt.sha256, paidCalls: 0 };
  } catch (error) {
    let workflow, operation;
    if (rpc && originalRun?.nativeOperationId) operation = (await call('operation', 'read', { operationId: originalRun.nativeOperationId }).catch(() => null))?.receipt;
    // This original-operation lookup is diagnostic only, never a viewer grant.
    const observedTaskId = originalRun?.nativeTaskId ?? operation?.runtimeAcceptance?.taskId;
    if (rpc && observedTaskId) workflow = await rpc.request('workflow/runs/read', { runId: observedTaskId }).catch(() => null);
    await context.writeArtifactJson('original-automation-office-failure.json', { error: error.message, protocol, protocolErrors,
      pageErrors, wire, run: originalRun ?? null, manifest: originalManifest ?? null, workflow, operation,
      artifactReads, exports, acknowledgements, providerCalls: model.requests.length, paidCalls: 0,
      body: (await page.locator('body').innerText().catch(() => '')).slice(0, 14000) });
    await page.screenshot({ path: context.pathInArtifacts('original-automation-office-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (rpc) await closeRpcAndWait(rpc);
    await page.close();
  }
});
