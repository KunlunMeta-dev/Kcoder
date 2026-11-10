import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, isTurnCompletion, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { toolResult, toolSteps } from '../office/native-download-model.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'task-workflow-original-run-readonly-browser', tier: 'full-integration',
  modelPolicy: 'Bounded deterministic Provider chooses actual fixed-version Workflow execution. Native QuickJS and human-request records are real. The viewer performs reads only; no model-quality or desktop claim.', retainSuccessEvidence: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'current Native workflow');
  const observedRuns = new Map(), errors = [], protocolErrors = [], wire = [], snapshots = [];
  let definitionId;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body, requestNumber }) => {
    try {
      assert.ok(requestNumber <= 10, 'Bounded deterministic workflow protocol');
      const history = JSON.stringify(body.messages ?? []); const stage = history.includes('FIXED_WORKFLOW_READONLY_THREE') ? 3 : history.includes('FIXED_WORKFLOW_READONLY_TWO') ? 2 : 1;
      const callId = `fixed-workflow-native-${stage}`;
      let result = toolResult(body, callId);
      if (result?.text) { try { result = JSON.parse(result.text); } catch { /* Require a genuine structured receipt below. */ } }
      if (result) {
        assert.ok(typeof result.run_id === 'string', 'Native Workflow must publish its real run ID');
        assert.equal(result.definition_id, definitionId);
        assert.equal(result.version, stage);
        observedRuns.set(stage, result.run_id);
        return [{ delta: { content: `FIXED_WORKFLOW_${stage}_ACCEPTED` } }, { finishReason: 'stop' }];
      }
      const names = (body.tools ?? []).map(value => value.function?.name ?? value.name);
      assert.ok(names.includes('Workflow'), 'Actual registered Workflow tool required');
      return toolSteps(callId, 'Workflow', { definition_id: definitionId, version: stage, args: {}, timeout_seconds: 180, max_agent_turns: 2 });
    } catch (error) { protocolErrors.push(error.message); return [{ delta: { content: 'FIXED_WORKFLOW_PROTOCOL_FAILURE' } }, { finishReason: 'stop' }]; }
  } });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'fixed-workflow-reader' });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', { active_provider: 'workflow-protocol', model: 'workflow-protocol', permission_mode: 'bypass', max_retries: 0,
    session_memory: { enabled: false }, providers: { 'workflow-protocol': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'workflow-protocol', context_window_tokens: 128000, max_output_tokens: 4096, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Original workflow Native', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true,
    ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}), env: { KCODER_CONFIG_DIR: profile } });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    const pending = new Map();
    socket.on('framesent', event => { try { const frame = JSON.parse(String(event.payload)); if (frame.method) { pending.set(String(frame.id), frame.method); wire.push({ method: frame.method, ...(frame.method.startsWith('workflow/') ? { runId: frame.params?.runId } : {}) }); } } catch { /* No raw frames or credentials are retained. */ } });
    socket.on('framereceived', event => { try { const frame = JSON.parse(String(event.payload)); const method = pending.get(String(frame.id)); pending.delete(String(frame.id)); if (method === 'integrations/tasks/readWorkspace' && frame.result?.status === 'completed') snapshots.push(frame.result.result); } catch { /* Non-JSON frames are outside this evidence. */ } });
  });
  let seed;
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    const csrf = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content'); assert.ok(csrf); context.registerSecret(csrf);
    const cookie = (await page.context().cookies(gateway.baseUrl)).map(value => `${value.name}=${value.value}`).join('; '); context.registerSecret(cookie);
    seed = await openRpc(gatewayRpcUrl(gateway, 'local', csrf), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close actual fixed Workflow seed RPC', () => closeRpcAndWait(seed));
    const initialized = await seed.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'actual-fixed-workflow-seed', version: '1' },
      capabilities: { experimental: { workflowCanvasV1: true, workflowGraphV2: true, workflowRunsV1: true, workflowInteractionsV1: true, studioWorkModesV1: true, taskWorkspaceV1: true } } });
    assert.equal(initialized.capabilities?.experimental?.workflowRunsV1, true);
    assert.equal((await seed.request('thread/list', { limit: 10 })).threads.length, 0);
    let definition = await seed.request('workflow/create', { title: 'Exact workflow record', description: 'Native Code and human records only.' }); definitionId = definition.id;
    const node = { id: 'derive', title: 'Native Code record', kind: 'code', prompt: '', agentType: 'general', maxTurns: 2, dependsOn: [], position: { x: 0, y: 0 }, allowedWritePaths: [], acceptanceCriteria: [], expectedArtifacts: [],
      config: { code: { source: 'return {marker:"ACTUAL_FIXED_WORKFLOW_OUTPUT"};' }, resultCheck: { source: 'return result.marker === "ACTUAL_FIXED_WORKFLOW_OUTPUT";' } } };
    definition = await seed.request('workflow/upsertNode', { id: definition.id, expectedRevision: definition.revision, node });
    definition = await seed.request('workflow/save', { id: definition.id, expectedRevision: definition.revision }); assert.equal(definition.savedVersion, 1);
    assert.equal(model.requests.length, 0, 'Preparing a definition must not execute it');
    const { thread } = await seed.request('thread/start', { cwd: workspace, studioWorkMode: 'kworker' });
    const start = async (stage) => {
      const { turn } = await seed.request('turn/start', { threadId: thread.id, clientPresentation: { version: 1, studioWorkMode: 'kworker', inlineWidgets: false }, input: [{ type: 'text', text: `FIXED_WORKFLOW_READONLY_${stage === 1 ? 'ONE' : stage === 2 ? 'TWO' : 'THREE'}: explicitly execute saved workflow ${definitionId} version ${stage} for this owned protocol test.` }] });
      await seed.waitFor(message => isTurnCompletion(message, thread.id, turn.id), 60000, 'actual fixed workflow parent turn');
      assert.deepEqual(protocolErrors, []);
      return await waitFor(() => observedRuns.get(stage), 15000, 'actual native workflow run receipt');
    };
    const firstRun = await start(1);
    const completed = await waitFor(async () => { const run = await seed.request('workflow/runs/read', { runId: firstRun }); return run.status === 'completed' ? run : null; }, 30000, 'actual native QuickJS completion');
    assert.equal(completed.version, 1);
    definition = await seed.request('workflow/upsertNode', { id: definition.id, expectedRevision: definition.revision,
      node: { ...node, id: 'review', title: 'Actual pending human', kind: 'human', dependsOn: ['derive'], config: { human: { prompt: 'Review the exact original workflow record.', responseSchema: { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' } } }, timeoutMs: 120000 } } } });
    definition = await seed.request('workflow/save', { id: definition.id, expectedRevision: definition.revision }); assert.equal(definition.savedVersion, 2);
    const secondRun = await start(2);
    const pending = await waitFor(async () => { const value = await seed.request('workflow/runs/requests', { runId: secondRun }); return value.requests?.find(item => item.status === 'pending') || null; }, 30000, 'real original human request');
    await seed.request('thread/metadata/update', { threadId: thread.id, title: 'Original fixed workflow task' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('task-workspace-button').click(); await page.waitForURL(url => url.pathname === '/tasks');
    const tasks = page.getByTestId('native-task-workspace');
    const selectOriginal = async () => { const select = tasks.getByTestId('task-workspace-thread-select'); await select.waitFor(); const value = await waitFor(() => select.locator('option').evaluateAll((values, id) => values.find(value => { try { return JSON.parse(value.value)[0] === id; } catch { return false; } })?.value, thread.id), 30000, 'actual original workflow task indexed'); await select.selectOption(value); await tasks.getByTestId('task-workspace-observation').waitFor(); };
    const openRun = async runId => { await selectOriginal(); const snapshot = snapshots.at(-1); const index = snapshot.entries.findIndex(value => value.reference.kind === 'workflow_run' && value.reference.runId === runId); assert.ok(index >= 0); await tasks.getByTestId(`task-workspace-open-reference-${index}`).click(); const view = page.getByTestId('task-workflow-viewer'); await view.waitFor(); return view; };
    const beforeModel = model.requests.length, beforeWire = wire.length;
    let view = await openRun(firstRun);
    await view.getByRole('button', { name: /查看输出|Node output|View output|Read output/i }).first().click();
    await waitFor(async () => (await view.innerText()).includes('ACTUAL_FIXED_WORKFLOW_OUTPUT'), 15000, 'original native node output');
    assert.ok((await view.innerText()).includes(firstRun)); assert.ok(!(await view.innerText()).includes(secondRun));
    assert.equal(await view.locator('[data-testid="workflow-resume-run"], [data-testid="workflow-run-archive-open"], [data-testid="workflow-submit-response"]').count(), 0);
    await page.screenshot({ path: context.pathInArtifacts('native-task-workflow-original-output.png'), fullPage: true });
    await view.getByRole('button', { name: '返回', exact: true }).click();
    view = await openRun(secondRun);
    await view.getByText('Review the exact original workflow record.', { exact: true }).waitFor();
    assert.equal(await view.getByTestId('workflow-submit-response').count(), 0); assert.equal(await view.getByRole('textbox').count(), 0);
    assert.ok(!wire.slice(beforeWire).some(value => ['workflow/runs/list', 'workflow/runs/respond', 'workflow/runs/archive', 'turn/start'].includes(value.method)));
    assert.equal(model.requests.length, beforeModel, 'Run viewing and pending details must not call a model');
    await page.screenshot({ path: context.pathInArtifacts('native-task-workflow-pending-readonly.png'), fullPage: true });
    // The explicit owned test driver settles its actual pending run for cleanup.
    // The read-only browser never submits this response.
    await seed.request('workflow/runs/respond', { runId: secondRun, requestId: pending.requestId, value: { approved: true } });
    await waitFor(async () => (await seed.request('workflow/runs/read', { runId: secondRun })).status === 'completed', 30000, 'owned pending fixture completion');
    await view.getByRole('button', { name: '返回', exact: true }).click();
    definition = await seed.request('workflow/upsertNode', { id: definition.id, expectedRevision: definition.revision,
      node: { ...node, config: { code: { source: 'throw new Error("ACTUAL_ORIGINAL_RECOVERY_FAILURE");' } } } });
    definition = await seed.request('workflow/save', { id: definition.id, expectedRevision: definition.revision }); assert.equal(definition.savedVersion, 3);
    const failedRun = await start(3);
    await waitFor(async () => (await seed.request('workflow/runs/read', { runId: failedRun })).status === 'failed', 30000, 'actual failed original workflow');
    view = await openRun(failedRun);
    await view.getByTestId('task-workflow-prepare-recovery').waitFor({ timeout: 15000 });
    const beforeRecoveryModel = model.requests.length, beforeRecoveryWire = wire.length;
    await page.evaluate(() => { window.__observedWorkflowRecovery = null; window.addEventListener('kcoder:workflow-composer-intent', event => { window.__observedWorkflowRecovery = event.detail; }, { once: true }); });
    await closeRpcAndWait(seed, 'actual fixed Workflow seed RPC');
    await view.getByTestId('task-workflow-prepare-recovery').click(); await page.waitForURL(url => url.pathname === '/runtime-tasks');
    const recoveryIntent = await page.evaluate(() => window.__observedWorkflowRecovery);
    assert.deepEqual(recoveryIntent, { active: false, recovery: { runId: failedRun, threadId: thread.id, deviceId: 'local', definitionId } });
    assert.equal(model.requests.length, beforeRecoveryModel, 'Preparing recovery cannot execute another model turn');
    assert.ok(!wire.slice(beforeRecoveryWire).some(value => ['workflow/create','workflow/save','turn/start'].includes(value.method)), 'Recovery navigation cannot execute or replace the original run');
    await context.writeArtifactJson('native-task-workflow-recovery-evidence.json', { failedRun, originalThread: thread.id, recoveryIntent, noModelDuringPreparation: true, noImplicitTaskStart: true });
    await page.screenshot({ path: context.pathInArtifacts('native-task-workflow-original-recovery-composer.png'), fullPage: true });
    assert.deepEqual(protocolErrors, []); assert.deepEqual(errors, []);
    await context.writeArtifactJson('native-task-workflow-evidence.json', { originalThreadId: thread.id, originalRunId: firstRun, originalVersion: 1, newerRunId: secondRun, newerVersion: 2,
      actualNativeCodeOutput: true, realHumanRequest: pending.requestId, readonlyBrowserNoResponses: true, exactOriginalRunStayedFixed: true, originalParentNavigation: true, originalFailedRecoveryPrepared: true, providerCalls: model.requests.length,
      limits: ['Deterministic tool selection proves protocol composition only.', 'The explicit external test driver, not the viewer, completed the actual human request.', 'No paid model or Windows/Electron acceptance is claimed.'] });
    return { exactOriginalWorkflow: true, actualNativeOutput: true, realReadonlyPending: true, explicitOriginalParent: true };
  } catch (error) {
    await context.writeArtifactJson('native-task-workflow-failure.json', { error: error.message, errors, protocolErrors, observedRuns: [...observedRuns], wire, providerCalls: model.requests.length,
      body: (await page.locator('body').innerText().catch(() => '')).slice(0, 12000) });
    await page.screenshot({ path: context.pathInArtifacts('native-task-workflow-failure.png'), fullPage: true }).catch(() => {}); throw error;
  } finally { await page.close(); }
});
