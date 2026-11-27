import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, isTurnCompletion, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'task-workspace-actual-native-read', tier: 'full-integration',
  modelPolicy: 'Deterministic responses anchor real histories, a create_goal tool call and follow-ups; read-only task views do not call the model. No live model quality or native desktop claim.',
  retainSuccessEvidence: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'current KCoder app-server');
  const toolGoalMarker = 'OWNED_MODEL_GOAL_REQUEST';
  const toolCallId = 'owned-model-goal';
  let goalToolResultObserved = false;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hasGoalRequest = messages.some(message => message?.role === 'user' &&
      JSON.stringify(message.content).includes(toolGoalMarker));
    const hasGoalResult = messages.some(message => message?.role === 'tool' && message.tool_call_id === toolCallId);
    if (hasGoalRequest && !hasGoalResult) {
      assert.ok(body.tools?.some(tool => tool.function?.name === 'create_goal'), 'The native model request must include create_goal');
      return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: toolCallId, type: 'function',
        function: { name: 'create_goal', arguments: JSON.stringify({ objective: 'Finish the original model-created goal.' }) } }] } },
      { finishReason: 'tool_calls' }];
    }
    if (hasGoalResult) goalToolResultObserved = true;
    return [{ delta: { role: 'assistant', content: 'The original task conversation was saved.' } }, { finishReason: 'stop' }];
  } });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'actual-native-task-space' });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {
    active_provider: 'task-protocol', permission_mode: 'bypass', max_retries: 0, goal_max_auto_continuations: 0,
    session_memory: { enabled: false },
    providers: { 'task-protocol': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'task-protocol', context_window_tokens: 128000,
      max_output_tokens: 4096, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Native task fixture', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  const methods = [];
  const completedThreads = [];
  const resumeFailures = [];
  const nativeConversationReads = [];
  let lastSnapshot;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('websocket', socket => {
    const requests = new Map();
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.method) {
          requests.set(String(frame.id), frame.method); methods.push(frame.method);
          if (['thread/read', 'thread/resume'].includes(frame.method) && typeof frame.params?.threadId === 'string')
            nativeConversationReads.push({ method: frame.method, threadId: frame.params.threadId });
        }
      } catch { /* Only method names are retained; never raw authentication or frame bodies. */ }
    });
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.method === 'turn/completed' && typeof frame.params?.threadId === 'string')
          completedThreads.push(frame.params.threadId);
        const method = requests.get(String(frame.id));
        requests.delete(String(frame.id));
        if (method === 'thread/resume' && frame.error) {
          const message = typeof frame.error.message === 'string'
            ? context.redactText(frame.error.message).replaceAll(context.runRoot, '<test-run>').slice(0, 240)
            : '';
          resumeFailures.push({ code: frame.error.code, message });
        }
        if (method === 'integrations/tasks/readWorkspace' && frame.result?.status === 'completed')
          lastSnapshot = frame.result.result;
      } catch { /* Malformed frames are rejected by the real client. */ }
    });
  });
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    const csrf = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content');
    assert.ok(csrf); context.registerSecret(csrf);
    const cookie = (await page.context().cookies(gateway.baseUrl)).map(item => `${item.name}=${item.value}`).join('; ');
    context.registerSecret(cookie);
    await waitFor(() => methods.includes('thread/list'), 30_000, 'the workspace broker to finish initialization', 50, context.abortSignal);
    const seedUrl = new URL(gatewayRpcUrl(gateway, 'local', csrf));
    seedUrl.searchParams.set('workspace', workspace);
    const seed = await openRpc(seedUrl.toString(), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close original task seed RPC', () => closeRpcAndWait(seed));
    const initialized = await seed.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'actual-task-seed', version: '1' },
      capabilities: { experimental: { integrationScopeV1: true, taskWorkspaceV1: true, threadStreamContextV1: true, threadGoalStatusBatchV1: true } } });
    assert.equal(initialized.capabilities?.experimental?.taskWorkspaceV1, true);
    const { thread } = await seed.request('thread/start', { cwd: workspace });
    const { turn } = await seed.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Persist this original task conversation.' }] });
    const completed = await seed.waitFor(message => isTurnCompletion(message, thread.id, turn.id), 45_000, 'original native task turn');
    assert.equal(completed.params.turn.status, 'completed');
    const title = '原生任务空间验收';
    const objective = '核对原始任务、目标和成员；未知记录保持未知，查看时不重启任务。';
    await seed.request('thread/metadata/update', { threadId: thread.id, title });
    const { goal } = await seed.request('thread/goal/set', { threadId: thread.id, objective, mode: 'strict', verificationKind: 'answer', tokenBudget: 2000 });
    const ordinaryTitle = '普通会话验收';
    const { thread: ordinary } = await seed.request('thread/start', { cwd: workspace });
    await seed.request('thread/metadata/update', { threadId: ordinary.id, title: ordinaryTitle });
    const { turn: ordinaryTurn } = await seed.request('turn/start', { threadId: ordinary.id,
      input: [{ type: 'text', text: 'Complete a normal conversation without creating a goal.' }] });
    const ordinaryCompleted = await seed.waitFor(message => isTurnCompletion(message, ordinary.id, ordinaryTurn.id),
      45_000, 'ordinary native task turn');
    assert.equal(ordinaryCompleted.params.turn.status, 'completed');
    const toolTitle = '模型创建目标验收';
    const { thread: toolThread } = await seed.request('thread/start', { cwd: workspace });
    await seed.request('thread/metadata/update', { threadId: toolThread.id, title: toolTitle });
    const { turn: toolTurn } = await seed.request('turn/start', { threadId: toolThread.id,
      input: [{ type: 'text', text: toolGoalMarker }] });
    const toolCompleted = await seed.waitFor(message => isTurnCompletion(message, toolThread.id, toolTurn.id),
      45_000, 'model-created Goal turn');
    assert.equal(toolCompleted.params.turn.status, 'completed');
    assert.equal(goalToolResultObserved, true, 'The original model request must receive the native ToolResult');
    const { goal: toolGoal } = await seed.request('thread/goal/get', { threadId: toolThread.id });
    assert.equal(toolGoal.status, 'active');
    const { turn: toolFollowup } = await seed.request('turn/start', { threadId: toolThread.id,
      input: [{ type: 'text', text: 'Continue the model-created goal without completing it.' }] });
    const toolFollowupCompleted = await seed.waitFor(message => isTurnCompletion(message, toolThread.id, toolFollowup.id),
      45_000, 'model-created Goal follow-up');
    assert.equal(toolFollowupCompleted.params.turn.status, 'completed');
    const legacyList = await seed.request('thread/list', { limit: 100 });
    const legacyThread = legacyList.threads.find(item => item.id === thread.id);
    assert.ok(legacyThread);
    assert.equal(Object.hasOwn(legacyThread, 'goalStatusObservation'), false,
      'Legacy clients must not receive the opt-in Goal observation');
    await closeRpcAndWait(seed, 'original task seed RPC');
    const creationCalls = model.requests.length;
    assert.equal(creationCalls, 5);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('task-workspace-button').click();
    await page.waitForURL(url => url.pathname === '/tasks');
    const view = page.getByTestId('native-task-workspace');
    await view.waitFor({ timeout: 30_000 });
    const boardRow = page.getByTestId('task-board-list-row').filter({ hasText: title });
    await boardRow.waitFor({ timeout: 30_000 });
    const ordinaryRow = page.getByTestId('task-board-list-row').filter({ hasText: ordinaryTitle });
    await ordinaryRow.waitFor({ timeout: 30_000 });
    const toolRow = page.getByTestId('task-board-list-row').filter({ hasText: toolGoalMarker });
    await toolRow.waitFor({ timeout: 30_000 });
    const replyCompleted = await ordinaryRow.getByText('回复已完成', { exact: true }).count();
    const taskCompleted = await ordinaryRow.getByText('已完成', { exact: true }).count();
    assert.equal(replyCompleted + taskCompleted, 1, 'A completed ordinary reply must be recognizable without inventing a goal');
    assert.equal(await boardRow.getByText('已完成', { exact: true }).count(), 0,
      'A completed turn must not complete the task while its original goal is still active');
    assert.equal(await boardRow.getByText('目标未完成', { exact: true }).count(), 1,
      'The board must observe the original active Goal, not merely hide completion');
    assert.equal(await toolRow.getByText('状态未知', { exact: true }).count(), 1,
      'A partially observed business Work must not be represented as a confirmed outcome');
    assert.equal(await toolRow.getByText('已完成', { exact: true }).count(), 0);
    assert.ok(methods.includes('work/list'), 'The board must read actual target-owned Work records');
    await page.screenshot({ path: context.pathInArtifacts('continuous-work-board-fixture.png'), fullPage: true });
    assert.ok(methods.includes('thread/goal/status/readMany'), 'The board must use the negotiated batch observation');
    const readsStart = methods.length;
    await view.getByTestId('task-workspace-thread-select').locator('xpath=ancestor::details[1]/summary').click();
    await view.getByTestId('task-workspace-thread-select').selectOption({ label: title });
    await view.getByTestId('task-workspace-observation').waitFor({ timeout: 30_000 });
    assert.equal(await view.getByTestId('task-workspace-error').count(), 0);
    assert.ok((await view.innerText()).includes(objective));
    assert.equal(lastSnapshot.thread.reference.threadId, thread.id);
    assert.ok(lastSnapshot.entries.some(entry => entry.reference.kind === 'goal' && entry.reference.goalId === goal.goalId && entry.reference.revision === goal.revision));
    const agents = lastSnapshot.facets.find(facet => facet.kind === 'agents');
    if (agents.availability === 'available') assert.equal(agents.observedCount, 0);
    else if (agents.availability === 'partial') {
      assert.equal(agents.observedCount, 0);
      assert.equal(agents.reasonCode, 'HISTORICAL_AGENTS_SNAPSHOT');
    } else { assert.equal(agents.availability, 'unknown'); assert.equal(agents.observedCount, null); }
    assert.notEqual(lastSnapshot.thread.nativeStatus, 'completed');
    assert.notEqual(await view.getByTestId('task-workspace-root-status').innerText(), 'completed');
    await view.getByTestId('task-workspace-refresh').click();
    await view.getByTestId('task-workspace-observation').waitFor({ timeout: 30_000 });
    assert.equal(model.requests.length, creationCalls, 'Task observation and refresh must not call another model');
    assert.ok(!methods.slice(readsStart).some(method => ['thread/start', 'thread/resume', 'turn/start'].includes(method)), 'The read-only view must not create or resume an execution');
    const readOnlyMethods = methods.slice(readsStart);
    assert.deepEqual(pageErrors, []);
    await page.waitForFunction(() => document.querySelector('[data-testid="task-workspace-observation"]')?.getAttribute('aria-busy') === 'false');
    await page.screenshot({ path: context.pathInArtifacts('native-task-workspace-original-references.png'), fullPage: true });
    await view.getByTestId('task-workspace-observation').screenshot({ path: context.pathInArtifacts('native-task-workspace-observation-detail.png'), animations: 'disabled' });
    const navigationStart = methods.length;
    const nativeReadsStart = nativeConversationReads.length;
    await view.getByTestId('task-workspace-open-thread').click();
    await page.waitForURL(url => url.pathname === '/runtime-tasks');
    await page.waitForFunction(() => document.body.innerText.includes('The original task conversation was saved.'), null, { timeout: 30_000 });
    assert.ok(nativeConversationReads.slice(nativeReadsStart).some(read => read.threadId === thread.id), 'Opening the existing view must read the exact original native thread');
    assert.ok(!methods.slice(navigationStart).some(method => ['thread/start', 'turn/start'].includes(method)), 'Opening a task must not create or execute another task');
    const originalNavigationMethods = methods.slice(navigationStart);
    const originalNavigationReads = nativeConversationReads.slice(nativeReadsStart);
    assert.equal(model.requests.length, creationCalls, 'Opening the original conversation must not call another model');
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: context.pathInArtifacts('native-task-workspace-open-original-conversation.png'), fullPage: true });
    const completedBeforeFollowup = completedThreads.length;
    const failuresBeforeFollowup = resumeFailures.length;
    const composer = page.getByTestId('chat-message-input');
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await composer.fill('Continue the original task without finishing its goal.');
    await page.getByTestId('send-message-button').click();
    await waitFor(() => {
      if (completedThreads.slice(completedBeforeFollowup).includes(thread.id)) return true;
      if (resumeFailures.length - failuresBeforeFollowup >= 3)
        throw new Error(`repeated thread resume failures: ${JSON.stringify(resumeFailures.slice(-3))}`);
      return false;
    }, 45_000,
      'the original thread follow-up turn to finish', 50, context.abortSignal);
    assert.equal(model.requests.length, creationCalls + 1, 'The follow-up must use the original model once');
    await page.getByTestId('task-workspace-button').click();
    await page.waitForURL(url => url.pathname === '/tasks');
    await boardRow.waitFor({ timeout: 30_000 });
    await waitFor(async () => await boardRow.getByText('目标未完成', { exact: true }).count() === 1,
      10_000, 'the original unfinished Goal after a real follow-up', 50, context.abortSignal);
    assert.equal(await boardRow.getByText('已完成', { exact: true }).count(), 0,
      'A completed follow-up must not complete an active Goal');
    await page.screenshot({ path: context.pathInArtifacts('native-task-workspace-after-followup.png'), fullPage: true });
    await context.writeArtifactJson('native-task-workspace-evidence.json', {
      schemaVersion: 1, actualAuthenticatedGateway: true, actualNativePublishedThread: thread.id,
      actualGoalRef: { id: goal.goalId, revision: goal.revision }, additionalModelCallsForView: 0,
      ordinaryCompletedReply: true,
      modelCreatedGoalAfterFollowup: { threadId: toolThread.id, goalId: toolGoal.goalId, toolResultObserved: goalToolResultObserved },
      originalNativeTaskState: lastSnapshot.thread.nativeStatus,
      actualAgentObservation: lastSnapshot.facets.find(facet => facet.kind === 'agents'),
      readOnlyMethods,
      followupRetainsOriginalGoal: true,
      originalConversationNavigation: { nativeThreadId: thread.id, reads: originalNavigationReads, methods: originalNavigationMethods, additionalModelCalls: 0 },
      limitations: ['Deterministic creation response is not model quality.', 'This read-only slice does not prove collaboration controls or native desktop behavior.'],
    });
    return { originalNativeReferences: true, additionalModelCallsForView: 0, noExecutionCreatedByRead: true, originalConversationNavigation: true, followupRetainsOriginalGoal: true };
  } catch (error) {
    await context.writeArtifactJson('native-task-workspace-failure.json', { error: String(error.message), pageErrors,
      methods, resumeFailures, modelCalls: model.requests.length, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 12000) });
    await page.screenshot({ path: context.pathInArtifacts('native-task-workspace-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await page.close(); }
});
