import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startSubagentModelFixture, subagentFixtureSettings, recordSubagentTestInputs } from '../../harness/subagent-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Model-independent: actual Mobile UI/Gateway/Engine receipts, source questions, paging and stop CAS.
// Fixed SSE triggers these protocol states; no inference about model behavior or native devices.
await runE2E(import.meta.url, {
  testId: 'mobile-subagent-public-workspace-receipt-recovery', tier: 'full-integration',
  modelPolicy: 'model-independent real Mobile Web and Gateway; malformed committed reply and original-ID recovery',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const fixture = await startSubagentModelFixture(context);
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const dist = process.env.KCODER_E2E_MOBILE_ROOT || resolve(appRoot, 'mobile/dist');
  await recordSubagentTestInputs(context, binary, dist);
  await context.writeStateJson('config/settings.json', subagentFixtureSettings(fixture.baseUrl));
  const key = 'owned-mobile-subagent-fixture'; context.registerSecret(key);
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const gateway = await startGateway(context, { workspace, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: context.pathInState('config'), KCODER_STUDIO_WEB_ROOT: dist } });
  let thread, primary, stoppable;
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const steers = [], stops = [], questionResponses = [];
  let corruptNext = true, queries = 0, agents = [], livePhase = "", receipts;
  await page.routeWebSocket('**/rpc*', socket => {
    const upstream = socket.connectToServer(), methods = new Map();
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.id !== undefined && frame.method) methods.set(frame.id, frame.method);
      if (frame.method === 'turn/start') thread = frame.params.threadId;
      if (frame.method === 'agent/steer') steers.push(frame.params);
      if (frame.method === 'agent/stop') stops.push(frame.params);
      if (frame.result?.answers) questionResponses.push(frame);
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (methods.get(frame.id) === 'agent/list' && frame.result) agents = frame.result.agents;
      if (methods.get(frame.id) === 'agent/live/read' && frame.result) livePhase = frame.result.phase || '';
      if (methods.get(frame.id) === 'agent/messages/list' && frame.result) receipts = frame.result;
      if (methods.get(frame.id) === 'agent/message/read') queries++;
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
    const foreground = page.getByTestId('question-card').filter({ hasText: 'S03_ACTUAL_FOREGROUND_QUESTION' });
    await foreground.waitFor({ timeout: 30000 });
    await foreground.getByRole('radio', { name: /Proceed/ }).click();
    await foreground.getByTestId('question-submit').click();
    await page.getByText('S03_PARENT_DONE', { exact: false }).waitFor({ timeout: 60000 });
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
    await card.getByRole('radio', { name: /Proceed/ }).click();
    await card.getByTestId('question-submit').click();
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
    return { platform: 'Mobile Web Chromium', nativeDevice: false, originalIdRecovery: true, explicitSteers: steers.length, sourceQuestions: questionResponses.length, pagedPublicOutput: true, stopRunCas: true, parentChineseDraft: true };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('mobile-subagent-failure.png') }).catch(() => {});
    await context.writeArtifactJson('mobile-subagent-failure.json', { fixture: fixture.observations, steers: steers.map(row => ({ agentId: row.agentId, clientMessageId: row.clientMessageId })), stops, queries });
    throw error;
  } finally { await page.close(); }
});
