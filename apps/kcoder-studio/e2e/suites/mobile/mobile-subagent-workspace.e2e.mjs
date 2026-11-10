import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startSubagentModelFixture, subagentFixtureSettings, recordSubagentTestInputs } from '../../harness/subagent-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { exportMobileWeb } from '../../harness/mobile-web-export.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Model-independent: actual Mobile UI/Gateway/Engine receipts, source questions, paging and stop CAS.
// Fixed SSE triggers these protocol states; no inference about model behavior or native devices.
const inboxOnly = process.env.KCODER_E2E_MOBILE_INBOX_ONLY === '1';
await runE2E(import.meta.url, {
  testId: inboxOnly ? 'mobile-interaction-inbox-source-agent' : 'mobile-subagent-public-workspace-receipt-recovery',
  tier: 'full-integration',
  modelPolicy: inboxOnly
    ? 'model-independent real Mobile Web and Gateway; exact source-agent Inbox route, reply, authoritative resolved receipt and row removal; fixed protocol fixture; no public-output folding or recovery claim'
    : 'model-independent real Mobile Web and Gateway; malformed committed reply and original-ID recovery',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const fixture = await startSubagentModelFixture(context);
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const mobileWeb = await exportMobileWeb(context, {
    label: 'mobile-subagent-workspace-export',
    outputName: 'mobile-web-export',
  });
  const dist = mobileWeb.path;
  await recordSubagentTestInputs(context, binary, dist);
  await context.writeStateJson('config/settings.json', subagentFixtureSettings(fixture.baseUrl));
  const key = 'owned-mobile-subagent-fixture'; context.registerSecret(key);
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const gateway = await startGateway(context, { workspace, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: context.pathInState('config'), KCODER_STUDIO_WEB_ROOT: dist } });
  let thread, primary, stoppable;
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const steers = [], stops = [], questionResponses = [], sourceQuestionRequests = [], resolvedQuestions = [],
    interactionStatusReads = [], turnCompletions = [];
  let nextSocketId = 0, threadStartConnectionId = null, initializedAppServerId = null;
  let corruptNext = true, queries = 0, agents = [], livePhase = "", receipts;
  await page.routeWebSocket('**/rpc*', socket => {
    const connectionId = ++nextSocketId;
    const upstream = socket.connectToServer(), methods = new Map();
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.id !== undefined && frame.method) methods.set(frame.id, frame.method);
      if (frame.method === 'turn/start') { thread = frame.params.threadId; threadStartConnectionId = connectionId; }
      if (frame.method === 'agent/steer') steers.push(frame.params);
      if (frame.method === 'agent/stop') stops.push(frame.params);
      if (frame.method === 'interaction/status/read') interactionStatusReads.push({
        connectionId,
        requestId: frame.id,
        kind: frame.params?.kind ?? null,
        requestIdentity: frame.params?.requestId ?? null,
        interactionId: frame.params?.questionId ?? frame.params?.approvalId ?? null,
        threadId: frame.params?.threadId ?? null,
        turnId: frame.params?.turnId ?? null,
        appServerEpoch: frame.params?.appServerEpoch ?? null,
      });
      if (frame.result?.answers) questionResponses.push(frame);
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.method === 'question/request' && frame.params?.sourceAgent) {
        sourceQuestionRequests.push({
          connectionId,
          requestId: frame.id,
          questionId: frame.params.questionId ?? String(frame.id),
          serverId: frame.params.serverId ?? null,
          backendIdentityMatchesInitialize: frame.params.serverId === initializedAppServerId,
          threadId: frame.params.threadId ?? null,
          turnId: frame.params.turnId ?? null,
          appServerEpoch: frame.params.appServerEpoch ?? null,
          agentId: frame.params.sourceAgent.agentId ?? null,
          parentSessionId: frame.params.sourceAgent.parentSessionId ?? null,
          containsForegroundQuestion: JSON.stringify(frame.params.questions ?? []).includes('S03_ACTUAL_FOREGROUND_QUESTION'),
          containsActualQuestion: JSON.stringify(frame.params.questions ?? []).includes('S03_ACTUAL_AGENT_QUESTION'),
        });
      }
      if (frame.method === 'question/resolved') resolvedQuestions.push({
        connectionId,
        requestId: frame.params?.requestId ?? null,
        questionId: frame.params?.questionId ?? null,
        threadId: frame.params?.threadId ?? null,
        turnId: frame.params?.turnId ?? null,
        appServerEpoch: frame.params?.appServerEpoch ?? null,
      });
      if (frame.method === 'turn/completed') turnCompletions.push({
        connectionId,
        threadId: frame.params?.threadId ?? null,
        turnId: frame.params?.turnId ?? null,
        status: frame.params?.status ?? null,
      });
      if (methods.get(frame.id) === 'initialize' && frame.result) {
        initializedAppServerId = typeof frame.result.sessionId === 'string' && frame.result.sessionId.length
          ? `server-${frame.result.sessionId}` : null;
      }
      if (methods.get(frame.id) === 'agent/list' && frame.result) agents = frame.result.agents;
      if (methods.get(frame.id) === 'agent/live/read' && frame.result) livePhase = frame.result.phase || '';
      if (methods.get(frame.id) === 'agent/messages/list' && frame.result) receipts = frame.result;
      if (methods.get(frame.id) === 'agent/message/read') queries++;
      if (methods.get(frame.id) === 'interaction/status/read') interactionStatusReads.push({
        connectionId,
        requestId: frame.id,
        kind: frame.result?.kind ?? null,
        requestIdentity: frame.result?.requestId ?? null,
        interactionId: frame.result?.questionId ?? frame.result?.approvalId ?? null,
        threadId: frame.result?.threadId ?? null,
        turnId: frame.result?.turnId ?? null,
        appServerEpoch: frame.result?.appServerEpoch ?? null,
        status: frame.result?.status ?? null,
      });
      if (methods.get(frame.id) === 'agent/steer' && frame.result && corruptNext) {
        corruptNext = false;
        socket.send(JSON.stringify({ ...frame, result: { ...frame.result, clientMessageId: 'cmd:0:wrong-identity' } })); return;
      }
      socket.send(raw);
    });
  });
  try {
    await page.goto(gateway.baseUrl);
    await page.getByTestId('welcome-direct-connection').click();
    await page.getByTestId('gateway-endpoint').fill(gateway.baseUrl);
    await page.getByTestId('gateway-connect').click();
    await page.getByTestId('new-workspace').waitFor({ timeout: 30000 });
    await page.getByTestId('new-workspace').click();
    await page.getByTestId('new-workspace-prompt').fill('S03_START');
    await page.getByTestId('create-workspace').click();
    await waitFor(() => sourceQuestionRequests.find(row => row.containsForegroundQuestion),
      60000, 'source-agent question request');
    const foregroundSource = sourceQuestionRequests.find(row => row.containsForegroundQuestion);
    assert.ok(foregroundSource, 'the history worker source question must have an exact owner locator');
    assert.equal(foregroundSource.backendIdentityMatchesInitialize, true,
      'the request backend ID must match server-${initialize.sessionId}, independent of Gateway target ID');
    assert.equal(foregroundSource.threadId, thread, 'the request must belong to the current runtime thread');
    assert.equal(foregroundSource.parentSessionId, thread, 'the source agent must name the same parent session');
    await page.getByTestId('task-header').getByRole('button').first().click();
    const homeUrl = new URL(page.url());
    assert.match(homeUrl.pathname, /^\/h\/[^/]+\/?$/, 'the task header returns to profile Home before opening Inbox');
    await page.getByTestId('interaction-inbox').waitFor({ timeout: 15000 });
    await page.getByTestId('interaction-inbox').click();
    assert.match(new URL(page.url()).pathname, /^\/h\/[^/]+\/inbox$/, 'Home opens the profile-scoped Inbox route');
    const foregroundRow = page.getByTestId(`inbox-row-question-${foregroundSource.requestId}`);
    await foregroundRow.waitFor({ timeout: 15000 });
    if (inboxOnly) {
      await page.screenshot({ path: context.pathInArtifacts('interaction-inbox-390x844-zh.png'), fullPage: true });
      await page.setViewportSize({ width: 320, height: 844 });
      const inboxRowBox = await foregroundRow.boundingBox();
      assert.ok(inboxRowBox && inboxRowBox.x >= 0 && inboxRowBox.x + inboxRowBox.width <= 320,
        'the Inbox row must remain inside a 320px Mobile Web viewport');
      await page.screenshot({ path: context.pathInArtifacts('interaction-inbox-320x844-zh.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.getByTestId(`inbox-open-question-${foregroundSource.requestId}`).click();
    await page.waitForURL(url => url.pathname.includes('/task/') &&
      url.searchParams.get('requestId') === String(foregroundSource.requestId), { timeout: 15000 });
    const foregroundUrl = new URL(page.url());
    assert.equal(foregroundUrl.searchParams.get('kind'), 'question');
    assert.equal(foregroundUrl.searchParams.get('interactionId'), foregroundSource.questionId);
    assert.equal(foregroundUrl.searchParams.get('turnId'), foregroundSource.turnId);
    assert.equal(foregroundUrl.searchParams.get('appServerEpoch'), foregroundSource.appServerEpoch);
    assert.equal(foregroundUrl.searchParams.has('token'), false);
    assert.deepEqual([...foregroundUrl.searchParams.keys()].sort(),
      ['appServerEpoch', 'interactionId', 'kind', 'requestId', 'turnId'],
      'the URL carries only the exact non-secret interaction locator');
    const foreground = page.getByRole('dialog').getByTestId('question-card')
      .filter({ hasText: 'S03_ACTUAL_FOREGROUND_QUESTION' });
    await foreground.waitFor({ timeout: 30000 });
    if (inboxOnly) {
      await page.screenshot({ path: context.pathInArtifacts('interaction-inbox-source-agent-focus-390x844-zh.png'), fullPage: true });
      await page.setViewportSize({ width: 320, height: 844 });
      const focusedQuestionBox = await foreground.boundingBox();
      assert.ok(focusedQuestionBox && focusedQuestionBox.x >= 0 && focusedQuestionBox.x + focusedQuestionBox.width <= 320,
        'the exact source-agent question must remain inside a 320px Mobile Web viewport');
      await page.screenshot({ path: context.pathInArtifacts('interaction-inbox-source-agent-focus-320x844-zh.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await context.writeArtifactJson('interaction-inbox-route.json', {
        platform: 'Mobile Web Chromium', nativeDevice: false,
        homeToInboxToSourceAgent: true,
        locator: {
          kind: 'question', requestId: foregroundSource.requestId,
          interactionId: foregroundSource.questionId, turnId: foregroundSource.turnId,
          appServerEpoch: foregroundSource.appServerEpoch,
        },
        profileScopeSerialized: false, promptSerialized: false, answerSerialized: false,
        sourceAgentSelected: true,
      });
    }
    await foreground.getByRole('radio', { name: /Proceed/ }).click();
    await foreground.getByTestId('question-submit').click();
    await page.getByText('S03_PARENT_DONE', { exact: false }).waitFor({ timeout: 60000 });
    if (inboxOnly) {
      assert.ok(questionResponses.some(frame => frame.result.answers), 'the focused source-agent question was answered once');
      await waitFor(() => resolvedQuestions.some(row => row.requestId === foregroundSource.requestId &&
        row.questionId === foregroundSource.questionId && row.threadId === foregroundSource.threadId &&
        row.turnId === foregroundSource.turnId && row.appServerEpoch === foregroundSource.appServerEpoch),
      15000, 'authoritative resolution for the exact source-agent request');
      const subagentBack = page.getByRole('dialog').getByText('返回', { exact: true });
      if (await subagentBack.count()) await subagentBack.click();
      await page.getByTestId('task-header').getByRole('button').first().click();
      await page.waitForURL(url => url.pathname.endsWith('/inbox'), { timeout: 15000 });
      const resolvedRow = page.getByTestId(`inbox-row-question-${foregroundSource.requestId}`);
      await waitFor(async () => await resolvedRow.count() === 0, 15000, 'resolved request removed from Inbox');
      return {
        platform: 'Mobile Web Chromium', nativeDevice: false, homeToInboxToSourceAgent: true,
        exactLocatorRoute: true, sourceAgentAnswered: true, authoritativeResolutionObserved: true,
        inboxRowRemoved: true, viewportWidths: [320, 390],
      };
    }
    await page.getByTestId('message-input').fill('父任务中文草稿\n下一行');
    await page.getByTestId('mobile-subagents-open').click();
    await waitFor(() => agents.length === 6, 15000, 'authoritative Mobile agent list');
    primary = agents.find(row => row.presentation?.goal?.includes('S03_WORKER_primary'));
    stoppable = agents.find(row => row.presentation?.goal?.includes('S03_WORKER_stoppable'));
    assert.ok(primary && stoppable);
    await page.getByTestId(`mobile-subagent-${primary.agentId}`).click();
    assert.equal(await page.getByText('S03_LIVE_VISIBLE', { exact: false }).count(), 0, 'long public output is folded by default');
    await page.getByText('展开记录', { exact: true }).click();
    await page.getByText('S03_LIVE_VISIBLE', { exact: false }).waitFor({ timeout: 15000 });
    assert.equal(await page.getByText('S03_PRIVATE_THINKING', { exact: false }).count(), 0);
    await page.getByText('折叠记录', { exact: true }).click();
    fixture.release('primary-model');
    await waitFor(() => livePhase.includes('Running bash'), 15000, 'child checkpoint');
    await page.getByTestId('mobile-subagent-draft').fill('S03_ADJUST_ONE');
    await page.getByTestId('mobile-subagent-send').click();
    await page.getByTestId('mobile-subagent-query').waitFor();
    await page.getByText('结果可能未知', { exact: false }).waitFor();
    const id = steers[0].clientMessageId;
    const saved = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('kcoder.mobile.agent-intent.v1:')).map(key => localStorage.getItem(key)));
    assert.ok(saved.some(row => row.includes(id)));
    assert.ok(saved.every(row => !row.includes('S03_ADJUST_ONE')));
    await page.reload();
    await page.getByTestId('mobile-subagents-open').click();
    await page.getByTestId(`mobile-subagent-${primary.agentId}`).click();
    await page.getByTestId('mobile-subagent-query').waitFor();
    assert.equal(steers.length, 1, 'reload never resends unknown command');
    await page.getByTestId('mobile-subagent-query').click();
    await page.getByTestId('mobile-subagent-send').waitFor();
    assert.equal(queries, 1); assert.equal(steers.length, 1);
    await page.getByTestId('mobile-subagent-draft').fill('S03_ADJUST_TWO');
    await page.getByTestId('mobile-subagent-send').click();
    await waitFor(() => steers.length === 2, 10000, 'explicit second instruction');
    const card = page.getByRole('dialog').getByTestId('question-card').filter({ hasText: 'S03_ACTUAL_AGENT_QUESTION' });
    await card.waitFor({ timeout: 30000 });
    const sourceQuestion = sourceQuestionRequests.find(row => row.containsActualQuestion);
    assert.ok(sourceQuestion?.requestId && sourceQuestion.questionId && sourceQuestion.turnId && sourceQuestion.appServerEpoch,
      'the source question must have a complete request/epoch/turn locator');
    await page.getByRole('dialog').getByText('返回', { exact: true }).click();
    await page.getByRole('dialog').getByText('返回', { exact: true }).click();
    await page.getByTestId('task-header').getByRole('button').first().click();
    await page.getByTestId('interaction-inbox').waitFor({ timeout: 15000 });
    await page.getByTestId('interaction-inbox').click();
    const inboxRow = page.getByTestId(`inbox-row-question-${sourceQuestion.requestId}`);
    await inboxRow.waitFor({ timeout: 15000 });
    await page.screenshot({ path: context.pathInArtifacts('interaction-inbox-390x844-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 844 });
    const narrowRowBox = await inboxRow.boundingBox();
    assert.ok(narrowRowBox && narrowRowBox.x >= 0 && narrowRowBox.x + narrowRowBox.width <= 320,
      'the Inbox row must remain inside a 320px Mobile Web viewport');
    await page.screenshot({ path: context.pathInArtifacts('interaction-inbox-320x844-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId(`inbox-open-question-${sourceQuestion.requestId}`).click();
    await page.waitForURL(url => url.pathname.includes('/task/') &&
      url.searchParams.get('requestId') === String(sourceQuestion.requestId), { timeout: 15000 });
    const focusedUrl = new URL(page.url());
    assert.equal(focusedUrl.searchParams.get('kind'), 'question');
    assert.equal(focusedUrl.searchParams.get('interactionId'), sourceQuestion.questionId);
    assert.equal(focusedUrl.searchParams.get('turnId'), sourceQuestion.turnId);
    assert.equal(focusedUrl.searchParams.get('appServerEpoch'), sourceQuestion.appServerEpoch);
    assert.equal(focusedUrl.searchParams.has('token'), false);
    const routedCard = page.getByRole('dialog').getByTestId('question-card')
      .filter({ hasText: 'S03_ACTUAL_AGENT_QUESTION' });
    await routedCard.waitFor({ timeout: 30000 });
    await page.screenshot({ path: context.pathInArtifacts('interaction-inbox-source-agent-focus-390x844-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 844 });
    const narrowCardBox = await routedCard.boundingBox();
    assert.ok(narrowCardBox && narrowCardBox.x >= 0 && narrowCardBox.x + narrowCardBox.width <= 320,
      'the exact source-agent question must remain inside a 320px Mobile Web viewport');
    await page.screenshot({ path: context.pathInArtifacts('interaction-inbox-source-agent-focus-320x844-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await context.writeArtifactJson('interaction-inbox-route.json', {
      platform: 'Mobile Web Chromium', nativeDevice: false,
      locator: {
        kind: 'question', requestId: sourceQuestion.requestId, interactionId: sourceQuestion.questionId,
        turnId: sourceQuestion.turnId, appServerEpoch: sourceQuestion.appServerEpoch,
      },
      profileScopeSerialized: false, promptSerialized: false, answerSerialized: false,
      sourceAgentSelected: sourceQuestion.agentId === primary.agentId,
    });
    await routedCard.getByRole('radio', { name: /Proceed/ }).click();
    await routedCard.getByTestId('question-submit').click();
    const ignored = page.getByRole('dialog').getByTestId('question-card').filter({ hasText: 'S03_AGENT_IGNORE_QUESTION' });
    await ignored.waitFor({ timeout: 15000 });
    await ignored.getByTestId('question-cancel').click();
    await waitFor(() => fixture.observations.some(row => row.kind === 'source-ignore-confirmed'), 15000, 'actual source ignore consumed');
    await page.getByText('历史', { exact: true }).click();
    await page.getByText('下一页', { exact: true }).waitFor();
    await page.getByText('下一页', { exact: true }).click();
    await page.getByRole('dialog').getByText('返回', { exact: true }).click();
    await page.getByTestId(`mobile-subagent-${stoppable.agentId}`).click();
    await page.getByTestId('mobile-subagent-stop').click();
    await page.getByText('停止状态：stopped', { exact: true }).waitFor();
    assert.deepEqual(stops[0].expectedBackgroundRun, stoppable.backgroundRun);
    await page.getByRole('dialog').getByText('返回', { exact: true }).click();
    await page.getByRole('dialog').getByText('返回', { exact: true }).click();
    assert.equal(await page.getByTestId('message-input').inputValue(), '父任务中文草稿\n下一行');
    assert.ok(fixture.observations.some(row => row.kind === 'worker-request' && row.tag === 'primary' && row.commandOne && row.commandTwo));
    assert.equal(questionResponses.length, 3);
    assert.ok(questionResponses.some(frame => frame.result.annotations?.ignored === true));
    return { platform: 'Mobile Web Chromium', nativeDevice: false, originalIdRecovery: true, interactionInboxRoute: true,
      sourceAgentSelected: sourceQuestion.agentId === primary.agentId, explicitSteers: steers.length,
      sourceQuestions: questionResponses.length, pagedPublicOutput: true, stopRunCas: true, parentChineseDraft: true };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('mobile-subagent-failure.png') }).catch(() => {});
    await context.writeArtifactJson('mobile-subagent-failure.json', {
      fixture: fixture.observations,
      sourceQuestionLocators: sourceQuestionRequests,
      resolvedQuestions,
      interactionStatusReads,
      turnCompletions,
      parentThreadId: thread ?? null,
      threadStartConnectionId,
      listedAgents: agents.map(row => ({ agentId: row.agentId, status: row.status })),
      steers: steers.map(row => ({ agentId: row.agentId, clientMessageId: row.clientMessageId })), stops, queries,
    });
    throw error;
  } finally { await page.close(); }
});
