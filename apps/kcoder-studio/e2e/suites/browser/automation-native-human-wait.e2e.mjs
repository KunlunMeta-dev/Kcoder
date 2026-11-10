import { openWorkflowTaskCreator } from '../../harness/automation-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { openPageGatewayRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'automation-native-human-decision-waits-without-model-or-timeout-consent', tier: 'full-integration',
  modelPolicy: 'model-independent native Workflow Human/decision/timeout protocol through the normal scheduler; no model requests or new tool authority',
  retainSuccessEvidence: true, retainSuccessLogs: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'normal KCoder app-server');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  if (process.env.KCODER_E2E_KCODER_SHA256) assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_SHA256);
  const model = await startApprovalModelFixture(context, { responseSteps() { throw new Error('Human and pure Code must not call a model'); } });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'original-automation-human' });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {
    active_provider: 'unused-protocol', permission_mode: 'ask', max_retries: 0,
    allowed_tools: ['Workflow', 'AutomationSourceRead'], auto_memory_enabled: false,
    memory: { observer_mode: 'disabled', structured_enabled: false }, session_memory: { enabled: false },
    integrations: { knowledge: { business_automation_enabled: true } },
    providers: { 'unused-protocol': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'unused-protocol', context_window_tokens: 1048576,
      max_output_tokens: 262144, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Original Human decision fixture', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true,
    env: { KCODER_CONFIG_DIR: profile, RUST_LOG: 'warn' } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [], methods = [], cases = [], cancellations = [], runObservations = [];
  let rpc, scope, originalRun;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('websocket', socket => {
    const pending = new Map();
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.method) methods.push(frame.method);
        if (frame.method === 'integrations/automation/cancelAutomationRun') pending.set(String(frame.id), { operationId: frame.params?.operationId, runId: frame.params?.payload?.runId });
      } catch { /* No credentials or raw frames retained. */ }
    });
    socket.on('framereceived', event => {
      try { const frame = JSON.parse(String(event.payload)), original = pending.get(String(frame.id));
        if (original) { pending.delete(String(frame.id)); cancellations.push({ ...original, reply: frame.result ?? frame.error }); }
      } catch { /* Keep typed original cancellation receipts only. */ }
    });
  });
  const call = async (method, payload = {}) => {
    const reply = await rpc.request(`integrations/automation/${method}`, { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 30000, payload });
    assert.equal(reply.status, 'completed', `${method}: ${reply.error?.code}`);
    return reply.result;
  };
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    const worker = page.getByRole('button', { name: 'KWorker', exact: true });
    if (await worker.count()) await worker.click();
    rpc = await openPageGatewayRpc(context, page, gateway, 'close original Human observation RPC');
    await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'original-automation-human-observer', version: '1' },
      capabilities: { experimental: { integrationScopeV1: true, automationTemplatesV1: true, integrationOperationReceiptsV1: true,
        workflowCanvasV1: true, workflowGraphV2: true, workflowRunsV1: true, workflowInteractionsV1: true, threadPresenceReadV1: true, studioWorkModesV1: true } } });
    scope = await rpc.request('integrations/scope/read');
    const scenarios = [{ id: 'explicit-response', timeoutMs: 30000, respond: true }, { id: 'unanswered-timeout', timeoutMs: 4000, respond: false }, { id: 'stop-original-run', timeoutMs: 60000, respond: false, stop: true }];
    const selectedCase = process.env.KCODER_E2E_AUTOMATION_HUMAN_CASE;
    if (selectedCase) assert.ok(scenarios.some(item => item.id === selectedCase), 'Only a declared original case may be selected');
    for (const scenario of scenarios.filter(item => !selectedCase || item.id === selectedCase)) {
      const title = `${scenario.id} ${context.seed}`;
      let workflow = await rpc.request('workflow/create', { title, description: 'Original Human decision, followed only by pure Code. No new tool or source authority.' });
      workflow = await rpc.request('workflow/upsertNode', { id: workflow.id, expectedRevision: workflow.revision,
        node: { id: 'approval', title: 'Explicit decision', kind: 'human', config: { human: { prompt: 'Approve the bounded pure calculation?', responseSchema: { type: 'boolean' }, timeoutMs: scenario.timeoutMs } } } });
      workflow = await rpc.request('workflow/upsertNode', { id: workflow.id, expectedRevision: workflow.revision,
        node: { id: 'calculate', title: 'Pure calculation after decision', kind: 'code', dependsOn: ['approval'],
          config: { code: { source: 'if (nodes.approval !== true) throw new Error("Decision required"); return {verified:true, explicitDecision:true};' } } } });
      workflow = await rpc.request('workflow/save', { id: workflow.id, expectedRevision: workflow.revision });
      await page.goto(`${gateway.baseUrl}/context`, { waitUntil: 'domcontentloaded' });
      await openWorkflowTaskCreator(page);
      const choice = `${workflow.id}@1`;
      await page.getByTestId('subscription-workflow').locator(`option[value="${choice}"]`).waitFor({ state: 'attached' });
      await page.getByTestId('subscription-workflow').selectOption(choice);
      await page.getByTestId('subscription-title').fill(title);
      await page.getByTestId('subscription-schedule-mode').selectOption('once');
      const at = new Date(Date.now() + 15000);
      await page.getByTestId('subscription-datetime').fill(new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 19));
      await page.getByTestId('subscription-tokens').fill('1000');
      await page.getByTestId('subscription-preview').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="subscription-consent"]')?.disabled === false);
      await page.getByTestId('subscription-consent').check();
      await page.getByTestId('subscription-save').click();
      await page.getByTestId('subscription-row').filter({ hasText: title }).waitFor({ timeout: 15000 });
      const subscription = (await call('listSubscriptions')).page.items.find(item => item.draft.title === title);
      assert.ok(subscription);
      originalRun = await waitFor(async () => {
        const runs = (await call('listAutomationRuns')).page.items.filter(item => item.subscriptionId === subscription.draft.id);
        assert.ok(runs.length <= 1, 'Original timer must not duplicate execution');
        if (runs[0]) originalRun = runs[0];
        if (runs[0] && ['failed', 'cancelled', 'completed'].includes(runs[0].status)) throw new Error(`Original Human run did not wait: ${runs[0].status}/${runs[0].errorCode}`);
        return runs[0]?.status === 'waiting' ? runs[0] : null;
      }, 60000, 'normal original scheduler/Core Human waiting', 150, context.abortSignal);
      assert.ok(originalRun.nativeTaskId);
      assert.ok(originalRun.nativeTurnId == null);
      const pending = await rpc.request('workflow/runs/requests', { runId: originalRun.nativeTaskId });
      assert.equal(pending.requests.length, 1);
      assert.equal(pending.requests[0].nodeId, 'approval');
      const before = await rpc.request('workflow/runs/read', { runId: originalRun.nativeTaskId });
      assert.ok(!before.nodeStates.some(node => node.nodeId === 'calculate' && node.status === 'completed'));
      await page.getByTestId('business-subscriptions').getByTestId('knowledge-refresh').last().click();
      const row = page.getByTestId('automation-run').filter({ hasText: title });
      await row.locator('summary').first().click();
      if (scenario.respond) {
        await page.getByTestId('subscription-row').filter({ hasText: title }).getByTestId('subscription-toggle').click();
        await waitFor(async () => (await call('listSubscriptions')).page.items.find(item => item.draft.id === subscription.draft.id)?.enabled === false,
          10000, 'explicit pause stops future triggers', 100, context.abortSignal);
        assert.equal((await call('readAutomationRun', { runId: originalRun.id })).run.status, 'waiting', 'Pausing the subscription must not cancel its active run');
        await row.getByTestId('automation-open-native-task').click();
        const decision = page.getByTestId('workflow-pending-approval');
        await decision.getByTestId('workflow-reuse-args').fill('true');
        await decision.getByTestId('workflow-submit-response').click();
      } else if (scenario.stop) {
        await row.getByTestId('automation-cancel-run').click();
      } else {
        await row.getByTestId('automation-hide-run').click();
        await waitFor(async () => !(await call('listAutomationRuns')).page.items.some(item => item.id === originalRun.id),
          10000, 'hide only original run projection', 100, context.abortSignal);
      }
      const finished = await waitFor(async () => {
        const run = (await call('readAutomationRun', { runId: originalRun.id })).run;
        const last = runObservations.at(-1);
        if (last?.id !== run.id || last.status !== run.status || last.errorCode !== run.errorCode) runObservations.push({ id: run.id, status: run.status, errorCode: run.errorCode, nativeTaskId: run.nativeTaskId });
        return ['completed', 'failed', 'cancelled'].includes(run.status) ? run : null;
      }, 30000, 'original Human response or timeout terminal outcome', 150, context.abortSignal);
      assert.equal(finished.status, scenario.stop ? 'cancelled' : scenario.respond ? 'completed' : 'failed');
      assert.equal((await call('listSubscriptions')).page.items.find(item => item.draft.id === subscription.draft.id).enabled, !scenario.respond,
        'Task stop and history hiding must not substitute for pausing the subscription');
      const final = await rpc.request('workflow/runs/read', { runId: originalRun.nativeTaskId });
      assert.equal(final.nodeStates.some(node => node.nodeId === 'calculate' && node.status === 'completed'), scenario.respond);
      if (!scenario.respond) await assert.rejects(() => rpc.request('workflow/runs/respond', { runId: originalRun.nativeTaskId, requestId: pending.requests[0].requestId, value: true }));
      assert.equal(model.requests.length, 0);
      cases.push({ scenario: scenario.id, subscriptionId: subscription.draft.id, waiting: originalRun, pending, final: finished, workflow: final });
      await context.writeArtifactJson(`original-human-${scenario.id}.json`, { cases, binarySha256, modelCalls: 0, paidCalls: 0 });
    }
    assert.deepEqual(pageErrors, []);
    assert.ok(!methods.includes('turn/start'));
    await page.screenshot({ path: context.pathInArtifacts('original-human-decision.png'), fullPage: true });
    return { originalHumanWaiting: true, selectedCases: cases.map(item => item.scenario), explicitResponseCompletes: cases.some(item => item.scenario === 'explicit-response'), timeoutNeverConsents: cases.some(item => item.scenario === 'unanswered-timeout'), originalTaskStopped: cases.some(item => item.scenario === 'stop-original-run'), modelCalls: 0, paidCalls: 0 };
  } catch (error) {
    let operation, workflow, presence, cancellationOperation;
    if (originalRun) {
      const readOperation = async operationId => rpc.request('integrations/operation/read', { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 30000, payload: { operationId } }).catch(error => ({ error: error.message }));
      operation = await readOperation(originalRun.nativeOperationId);
      if (cancellations.at(-1)?.operationId) cancellationOperation = await readOperation(cancellations.at(-1).operationId);
      if (originalRun.nativeTaskId) workflow = await rpc.request('workflow/runs/read', { runId: originalRun.nativeTaskId }).catch(error => ({ error: error.message }));
      if (originalRun.nativeThreadId) presence = await rpc.request('thread/presence/read', { threadId: originalRun.nativeThreadId }).catch(error => ({ error: error.message }));
    }
    await context.writeArtifactJson('original-human-failure.json', { error: error.message, binarySha256, run: originalRun ?? null, cases,
      methods, pageErrors, cancellations, runObservations, operation, cancellationOperation, workflow, presence, modelCalls: model.requests.length, paidCalls: 0 });
    await page.screenshot({ path: context.pathInArtifacts('original-human-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (rpc) await closeRpcAndWait(rpc);
    await page.close();
  }
});
