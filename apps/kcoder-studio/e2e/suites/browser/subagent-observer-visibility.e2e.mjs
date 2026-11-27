import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium, expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { createChromiumLauncher } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { freezeLargeHistoryRenderer } from '../../harness/migration-large-history.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { recordSubagentTestInputs, startSubagentModelFixture, subagentFixtureSettings } from '../../harness/subagent-model.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'subagent-observer-visibility', tier: 'full-integration',
  modelPolicy: 'Model-independent authenticated browser/Gateway/Native stream with bounded loopback SSE. Real background-tab visibility and owned sequence-gap/RPC failure injection; no live-provider, physical-device or packaged-host claim.',
}, async context => {
  assert.equal(process.platform, 'linux', 'UNMET_PREREQUISITE: owned Linux display');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit owned Native binary');
  const build = process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist');
  await assertRendererBuildFresh({ buildRoot: build });
  const renderer = await freezeLargeHistoryRenderer(context, build, context.pathInState('renderer'));
  await recordSubagentTestInputs(context, binary, renderer.root);
  const workspace = await materializeWorkspace(context, 'minimal');
  const fixture = await startSubagentModelFixture(context, { streamingInspection: true, compactHistory: true, progressInspection: true });
  const settings = await context.writeStateJson('profile/settings.json', subagentFixtureSettings(fixture.baseUrl));
  const key = 'owned-subagent-visibility-fixture'; context.registerSecret(key);
  await context.writeStateJson('profile/credentials.json', { fixture: { type: 'api', key } });
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned stream target',
    transport: 'local', command: binary, workspace: workspace.path, settingsFile: settings }]);
  const gateway = await startGateway(context, { auth: true, workspace: workspace.path, serversFile: servers, kcoderBin: binary,
    passEnv: ['KCODER_TARGET_DIR'],
    env: { KCODER_CONFIG_DIR: context.pathInState('profile'), KCODER_HOME: context.pathInState('profile'),
      KCODER_STUDIO_DATA_DIR: context.pathInState('gateway-data'), KCODER_STUDIO_WEB_ROOT: renderer.root } });
  const display = await startOwnedDisplay(context);
  const launch = createChromiumLauncher({ chromiumDriver: {
    connectOverCDP: (endpoint, options) => chromium.connectOverCDP(endpoint, { ...options, noDefaults: true }),
  } });
  const browser = await launch(context, { label: 'subagent-visibility-browser', headless: false, display: display.display,
    env: { XAUTHORITY: display.authority } });
  const page = await browser.newPersistentPage(); await page.setViewportSize({ width: 1280, height: 800 });
  const [cover] = await Promise.all([page.waitForEvent('popup'), page.evaluate(() => { window.open('about:blank', '_blank'); })]);
  const show = async visible => {
    await (visible ? page : cover).bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5000 }).toBe(visible ? 'visible' : 'hidden');
  };
  await show(true);
  let failedReads = false, stream, streamRequests = 0, acceptedStreams = 0, unsubscribeRequests = 0, turnStarts = 0;
  let commands = 0, workerStops = 0, socketCount = 0;
  let listRequests = 0, listReplies = 0;
  const progressByAgent = new Map();
  let secondDeltaReceived = false, terminalReceived = false;
  await page.routeWebSocket('**/rpc*', socket => {
    socketCount++;
    const upstream = socket.connectToServer(), subscriptions = new Map(), listIds = new Set();
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.method === 'turn/start') turnStarts++;
      if (frame.method === 'agent/steer') commands++;
      if (frame.method === 'agent/stop') workerStops++;
      if (frame.method === 'agent/list') { listRequests++; listIds.add(frame.id); }
      if (frame.method === 'agent/stream/unsubscribe') unsubscribeRequests++;
      if (frame.method === 'agent/stream/subscribe') {
        streamRequests++;
        if (failedReads) {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'owned stream read unavailable' } }));
          return;
        }
        subscriptions.set(frame.id, frame.params);
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw)), request = subscriptions.get(frame.id);
      if (listIds.delete(frame.id)) {
        assert.ok(frame.result, 'owned agent/list must receive a successful Native response');
        listReplies++;
      }
      if (frame.method === 'item/event' && frame.params?.event?.type === 'background_job_progress')
        progressByAgent.set(frame.params.event.id, (progressByAgent.get(frame.params.event.id) ?? 0) + 1);
      if (frame.method === 'agent/stream/event' && frame.params?.agentId === stream?.agentId) {
        if (JSON.stringify(frame.params).includes('S03_SECOND_LIVE_DELTA')) secondDeltaReceived = true;
        if (frame.params.method === 'turn/completed') terminalReceived = true;
      }
      if (request && frame.result) {
        subscriptions.delete(frame.id);
        acceptedStreams++;
        stream = { socket, ...request, ...frame.result };
      }
      socket.send(raw);
    });
  });
  const records = page.getByTestId('subagent-workspace-records');
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')),
      page.locator('button[type="submit"]').click()]);
    await page.getByTestId('desktop-sidebar').waitFor();
    await page.getByTestId('project-item').filter({ hasText: 'Owned stream target' }).first().waitFor();
    await page.getByTestId('project-new-conversation-button').click();
    await page.getByTestId('chat-message-input').fill('S03_START');
    await page.getByTestId('send-message-button').click();
    await page.locator('[data-status-item^="interaction:"] button[title*="S03_MAIN_QUESTION"]').click();
    await page.getByTestId('request-user-input-option-question-1-0').click();
    await page.getByTestId('message-assistant').filter({ hasText: 'S03_PARENT_DONE' }).waitFor({ timeout: 60000 });
    const primary = await waitFor(() => fixture.observations.find(row => row.kind === 'spawn' && row.tag === 'primary'),
      15000, 'owned child identity');
    await waitFor(() => progressByAgent.get(primary.agentId), 10000, 'actual Native worker progress notification');
    // Align this short progress window with a completed discovery poll, away from its next tick.
    const originalReplies = listReplies;
    await waitFor(() => listReplies > originalReplies && listReplies === listRequests, 20000, 'visible discovery response before progress replay');
    await page.waitForTimeout(500);
    const beforeProgress = listRequests;
    const unselectedNativeProgress = progressByAgent.get(primary.agentId);
    fixture.release('primary-stream-unselected');
    await waitFor(() => progressByAgent.get(primary.agentId) > unselectedNativeProgress, 10000, 'fresh Native progress for unopened worker');
    await page.waitForTimeout(500);
    const unselectedProgressReads = listRequests - beforeProgress;
    assert.equal(unselectedProgressReads, 0, 'unopened workers must not reread the directory for timestamp-only progress');
    await page.getByTestId('subagent-status-toggle-button').click();
    await page.locator(`[data-testid="subagent-status-item"][data-agent-id="${primary.agentId}"]`).getByTestId('subagent-detail-open').click();
    await expect(records).toContainText('S03_LIVE_VISIBLE', { timeout: 15000 });
    await waitFor(() => acceptedStreams === 1 && stream?.agentId === primary.agentId, 10000, 'actual Native observer snapshot');
    await waitFor(() => listReplies === listRequests, 10000, 'selected worker directory response');
    await page.waitForTimeout(500);
    const beforeSelectedProgress = listRequests;
    const selectedNativeProgress = progressByAgent.get(primary.agentId);
    fixture.release('primary-stream-selected');
    await waitFor(() => progressByAgent.get(primary.agentId) > selectedNativeProgress, 10000, 'fresh Native progress for selected worker');
    await expect(records).toContainText('S03_SELECTED_PROGRESS');
    await waitFor(() => listRequests > beforeSelectedProgress && listReplies === listRequests, 10000, 'selected worker progress detail refresh');
    const selectedProgressReads = listRequests - beforeSelectedProgress;
    assert.equal(selectedProgressReads, 1);

    await show(false);
    const healthyRequests = streamRequests, healthyUnsubscribes = unsubscribeRequests;
    fixture.release('primary-stream-second');
    await waitFor(() => secondDeltaReceived, 15000, 'actual stream delta reaches the background tab');
    await page.waitForTimeout(500);
    await expect(records).not.toContainText('S03_SECOND_LIVE_DELTA');
    await show(true);
    await expect(records).toContainText('S03_SECOND_LIVE_DELTA');
    assert.equal(streamRequests, healthyRequests);
    assert.equal(unsubscribeRequests, healthyUnsubscribes, 'hiding must preserve the healthy observer');
    await show(false);
    failedReads = true;
    stream.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'agent/stream/event', params: {
      threadId: stream.threadId, agentId: stream.agentId, subscriptionId: stream.subscriptionId,
      runId: stream.runId, sequence: stream.sequence + 100, method: 'item/delta',
      params: { itemId: 'owned-gap', delta: { text: 'UNTRUSTED_GAP_MUST_NOT_RENDER' } },
    } }));
    await waitFor(() => unsubscribeRequests > healthyUnsubscribes, 10000, 'gapped observer released without stopping the worker');
    const hiddenAt = performance.now(), beforeHidden = streamRequests;
    await page.waitForTimeout(12_000);
    const hiddenMs = Math.round(performance.now() - hiddenAt);
    const hiddenRetryRequests = streamRequests - beforeHidden;
    assert.equal(streamRequests, beforeHidden, 'background tab must not reopen a gapped/failed observer');
    assert.equal(beforeHidden, 1);
    await expect(records).not.toContainText('UNTRUSTED_GAP_MUST_NOT_RENDER');
    failedReads = false;
    await show(true);
    await waitFor(() => acceptedStreams === 2, 10000, 'one actual snapshot reconciliation on return');
    assert.equal(streamRequests, 2);
    await expect(records).toContainText('S03_SECOND_LIVE_DELTA');

    await show(false);
    fixture.release('primary-stream-third'); fixture.release('primary-model'); fixture.release('primary-guidance');
    await waitFor(() => fixture.observations.filter(row => row.kind === 'child-question-guidance' && row.tag === 'primary').length === 2,
      30000, 'actual child finishes tool protocol while its observer is hidden');
    await waitFor(() => terminalReceived, 15000, 'actual terminal stream event reaches the hidden tab');
    const terminalRequests = streamRequests;
    await show(true);
    await expect(records).toContainText('S03_AGENT_DONE', { timeout: 15000 });
    await expect(records.locator('.animate-spin')).toHaveCount(0);
    await page.waitForTimeout(1500);
    assert.equal(streamRequests, terminalRequests, 'a healthy terminal observer must not reconnect on return');
    assert.equal(turnStarts, 1); assert.equal(commands, 0); assert.equal(workerStops, 0);
    assert.ok(!fixture.observations.some(row => row.kind === 'error'));
    const result = { platform: 'Linux headed Chromium', nativePackage: false, realVisibility: true,
      hiddenMs, hiddenRetryRequests, streamRequests, acceptedStreams,
      freshNativeProgress: true, unselectedProgressReads, selectedProgressReads,
      healthyHiddenDelta: true, hiddenTextProjectionDeferred: true, hiddenTerminal: true, gapRejected: true, turnStarts, commands, workerStops, socketCount };
    await context.writeArtifactJson('observer-request-cost.json', result);
    await page.screenshot({ path: context.pathInArtifacts('subagent-observer-terminal.png') });
    return result;
  } catch (error) {
    await context.writeArtifactJson('observer-failure-counts.json', { streamRequests, acceptedStreams, unsubscribeRequests, turnStarts, commands, workerStops, socketCount, listRequests, listReplies, progressNotifications: [...progressByAgent.values()] });
    await page.screenshot({ path: context.pathInArtifacts('subagent-observer-failure.png') }).catch(() => {});
    throw error;
  } finally { await page.close(); }
});
