import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'background-work-survives-parent-terminal-and-delivers-once', tier: 'full-integration',
  modelPolicy: 'model-independent real agent lifecycle, background gate and parent delivery' }, async context => {
  let releaseChild = false; let parentAnswered = false;
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'background-state' });
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body, requestNumber }) => {
    const user = [...body.messages].reverse().find(message => message.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    if (text.includes('CHILD_SCOPE_PROBE')) return [{ ready: () => releaseChild,
      delta: { role: 'assistant', content: 'CHILD_RESULT_COMPLETE' } }, { finishReason: 'stop' }];
    if (requestNumber === 1) return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'background-owner',
      type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ agent_type: 'general',
        message: 'CHILD_SCOPE_PROBE: return the fixture result', max_turns: 2, run_in_background: true }) } }] } }, { finishReason: 'tool_calls' }];
    const answer = parentAnswered ? 'PARENT_SUMMARY_COMPLETE' : 'PARENT_MAIN_COMPLETE'; parentAnswered = true;
    return [{ delta: { role: 'assistant', content: answer } }, { finishReason: 'stop' }];
  } });
  const home = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024, no_proxy: true } } });
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: home } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const secret = 'PRIVATE_BACKGROUND_DIAGNOSTIC_SENTINEL'; context.registerSecret(secret);
  const diagnostics = []; let duplicatedTerminals = 0;
  page.on('console', async message => {
    if (message.text().startsWith('[kcoder-background-run]')) diagnostics.push(await message.args()[1].jsonValue());
  });
  await page.routeWebSocket('**/rpc**', route => {
    const upstream = route.connectToServer();
    upstream.onMessage(raw => {
      let frame; try { frame = JSON.parse(String(raw)); } catch { route.send(raw); return; }
      if (frame.method === 'item/event' && ['background_job_completed','background_job_failed'].includes(frame.params?.event?.type)) {
        frame.params.event.error = secret; frame.params.event.reason = secret;
        frame.params.event.tool_input = { Authorization: secret };
        frame.params.response = secret; frame.params.headers = { Authorization: secret };
        const encoded = JSON.stringify(frame); route.send(encoded); route.send(encoded); duplicatedTerminals++;
      } else route.send(raw);
    });
  });
  await page.addInitScript(() => {
    const Native = window.WebSocket; window.__backgroundCompleted = 0;
    window.WebSocket = class extends Native { constructor(...args) { super(...args);
      this.addEventListener('message', event => { try { const message = JSON.parse(event.data);
        if (message.method === 'turn/completed' && message.params?.turn?.status === 'completed') window.__backgroundCompleted++;
      } catch {} });
    } };
  });
  try {
  await page.goto(gateway.baseUrl);
  await waitFor(async () => (await page.getByTestId('model-selector-button').innerText()).includes('fixture'), 15000, 'model catalog ready');
  await page.getByTestId('chat-message-input').fill('BACKGROUND_SCOPE_PARENT');
  await waitFor(() => page.getByTestId('send-message-button').isEnabled(), 15000, 'composer ready');
  await page.getByTestId('send-message-button').click();
  await page.getByText('PARENT_MAIN_COMPLETE', { exact: true }).waitFor({ timeout: 30000 });
  const spinner = page.locator('[data-testid^="runtime-local-task-running-"]:visible');
  assert.equal(await spinner.count(), 1, 'parent completion must not hide a live background agent');
  await page.locator('[data-testid^="runtime-task-activity-"][data-activity="background"]:visible').waitFor({ timeout: 15000 });
  releaseChild = true;
  await page.getByText('PARENT_SUMMARY_COMPLETE', { exact: true }).waitFor({ timeout: 30000 });
  await spinner.waitFor({ state: 'detached', timeout: 15000 });
  assert.equal(await page.getByText('PARENT_SUMMARY_COMPLETE', { exact: true }).count(), 1);
  const deliveries = model.requests.filter(body => body.messages.some(message => message.role === 'user'
    && typeof message.content === 'string' && message.content.startsWith('<subagent_notification ')));
  const notifications = deliveries.flatMap(body => body.messages.filter(message => message.role === 'user'
    && typeof message.content === 'string' && message.content.startsWith('<subagent_notification ')));
  assert.equal(notifications.length, 1, 'a completed run is injected once');
  const output = notifications[0].content.match(/output_file="([^"]+)"/)?.[1];
  assert.ok(output?.startsWith(context.stateDir + '/'), 'notification points to owned immutable output');
  assert.ok((await readFile(output, 'utf8')).includes('CHILD_RESULT_COMPLETE'));
  await context.writeArtifactJson('delivery-observation.json', { notifications: notifications.length,
    runId: notifications[0].content.match(/run_id="([^"]+)"/)?.[1], immutableOutputVerified: true });
  assert.equal(deliveries.length, 1, 'one parent model invocation receives the child completion');
  await waitFor(() => diagnostics.some(row => row.phase === 'background-terminal'), 5000, 'safe background terminal metadata');
  const runId = notifications[0].content.match(/run_id="([^"]+)"/)?.[1];
  const linked = diagnostics.filter(row => row.runId === runId);
  await context.writeArtifactJson('safe-background-diagnostics.json',{records:diagnostics,duplicatedTerminals});
  assert.ok(duplicatedTerminals > 0, 'actual server terminal was replayed');
  assert.equal(linked.filter(row=>row.phase==='background-terminal').length,1,'replayed terminal is logged once');
  assert.equal(linked.filter(row=>row.phase==='background-start').length,1);
  for (const row of linked) {
    assert.match(row.connectionId,/^rpc-\d+-\d+$/); assert.equal(row.targetId,'local');
    assert.match(row.threadId,/^(?:[A-Za-z0-9]{5}|[a-f0-9-]{36}|[a-f0-9]{32}-[a-f0-9]{8}-[a-f0-9]{16})$/); assert.ok(row.attemptId);
    assert.equal(row.attemptScope,'parent_turn');
    assert.deepEqual(Object.keys(row).sort(),['attemptId','attemptScope','code','connectionId','phase','runId','status','targetId','threadId'].sort());
  }
  assert.equal(linked[0].attemptId,linked[1].attemptId);
  assert.equal(linked[0].threadId,linked[1].threadId);
  assert.ok(!JSON.stringify(diagnostics).includes(secret));

  await page.waitForFunction(() => window.__backgroundCompleted >= 2, undefined, { timeout: 15000 });
  await page.reload();
  await page.getByText('PARENT_SUMMARY_COMPLETE', { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(model.requests.filter(body => body.messages.some(message => message.role === 'user'
    && typeof message.content === 'string' && message.content.startsWith('<subagent_notification '))).length, 1, 'history reload cannot redeliver');
  await page.screenshot({ path: context.pathInArtifacts('background-delivered.png') });
  return { parentTerminalKeptBackgroundActive: true, deliveryRequests: deliveries.length, providerRequests: model.requests.length };
  } catch (error) {
    await context.writeArtifactJson('background-diagnostic.json', { requests: model.requests.length, text: await page.locator('body').innerText() });
    await page.screenshot({ path: context.pathInArtifacts('background-failure.png') }); throw error;
  }
});
