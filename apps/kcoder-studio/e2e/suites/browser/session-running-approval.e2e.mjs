import assert from 'node:assert/strict';
import { stat, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'session-list-stays-active-through-silent-tool-and-approval', tier: 'full-integration',
  modelPolicy: 'model-independent command approval and long-running tool lifecycle; real Bash and Gateway' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'active-approval' });
  let finishNewTurn = false;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ requestNumber }) => {
    if (requestNumber > 3) return [{ ready: () => finishNewTurn, delta: { role: 'assistant', content: 'NEW_RUN_FINISHED' } }, { finishReason: 'stop' }];
    if (requestNumber > 2) return [{ delta: { role: 'assistant', content: 'SESSION_FINISHED' } }, { finishReason: 'stop' }];
    const command = requestNumber === 1
      ? 'printf active > active-tool; while [ ! -f release-tool ]; do sleep 0.05; done; printf done > long-tool-finished'
      : 'printf approved > approval-finished';
    return [{ delta: { role: 'assistant', content: requestNumber === 1 ? 'SESSION_STARTED' : 'TOOL_FINISHED_WAITING_APPROVAL' } },
      { delta: { tool_calls: [{ index: 0, id: `session-tool-${requestNumber}`, type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command }) } }] } }, { finishReason: 'tool_calls' }];
  } });
  const home = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', permission_mode: 'ask', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024, no_proxy: true } } });
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: home } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const probe = window.__lateRunProbe = { reply: null, completed: null, socket: null, interruptReply: null, events: [] };
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        super.addEventListener('message', event => {
          let message; try { message = JSON.parse(event.data); } catch { return; }
          if (message.method?.includes('approval') || message.method?.includes('requestApproval')) probe.events.push({ method: message.method, id: message.id, params: message.params });
          if (message.method === 'turn/completed' && !probe.completed) { probe.completed = message; probe.socket = this; }
          if (message.id === 'stale-interrupt-probe') probe.interruptReply = message;
        });
      }
      send(data) {
        try { const message = JSON.parse(data);
          if (!message.method && message.result?.decision && !probe.reply) probe.reply = { socket: this, data };
        } catch { /* unrelated frame */ }
        return super.send(data);
      }
    };
  });
  try {
  await page.goto(gateway.baseUrl);
  await page.getByTestId('chat-message-input').fill('SESSION_LIFECYCLE');
  await page.getByTestId('send-message-button').click();
  const spinner = page.locator('[data-testid^="runtime-local-task-running-"]:visible');
  const card = page.getByTestId('request-user-input-card');
  await card.waitFor({ timeout: 30000 }); await spinner.waitFor();
  await page.locator('[data-testid^="runtime-task-activity-"][data-activity="waiting_approval"]:visible').waitFor({ timeout: 15000 });
  await card.locator('[data-testid^="request-user-input-option-"]').first().click();
  await waitFor(() => stat(resolve(workspace, 'active-tool')).then(() => true, () => false), 15000, 'silent tool actually running');
  assert.equal(await spinner.count(), 1, 'no output from the tool must not clear list activity');
  await page.getByTestId('plugins-button').click();
  await page.getByTestId('plugins-add-marketplace-button').waitFor();
  assert.equal(await spinner.count(), 1, 'switching away must keep active task visible');
  await page.locator('[data-testid^="runtime-local-task-row-"]:visible').first().click();
  await page.getByTestId('chat-message-input').waitFor();
  assert.equal(await spinner.count(), 1);
  await writeFile(resolve(workspace, 'release-tool'), 'release');
  await card.waitFor({ timeout: 30000 });
  assert.equal(await spinner.count(), 1, 'pending approval is still active work');
  assert.equal(await readFile(resolve(workspace, 'long-tool-finished'), 'utf8'), 'done');
  assert.ok(await page.evaluate(() => {
    const reply = window.__lateRunProbe.reply; if (!reply) return false;
    reply.socket.send(reply.data); return true;
  }), 'recorded first approval response is replayed against the real broker');
  assert.equal(await stat(resolve(workspace, 'approval-finished')).then(() => true, () => false), false,
    'old approval response must not approve the new interaction');
  await card.waitFor();
  await card.locator('[data-testid^="request-user-input-option-"]').first().click();
  await page.getByText('SESSION_FINISHED', { exact: true }).waitFor({ timeout: 30000 });
  await spinner.waitFor({ state: 'detached', timeout: 15000 });
  assert.equal(await readFile(resolve(workspace, 'approval-finished'), 'utf8'), 'approved');
  assert.equal(model.requests.length, 3);
  await page.getByTestId('chat-message-input').fill('NEW_RUN_WITH_LATE_OLD_TERMINAL');
  await page.getByTestId('send-message-button').click();
  await waitFor(() => model.requests.length === 4, 15000, 'new run is active');
  await spinner.waitFor();
  await page.evaluate(() => {
    const probe = window.__lateRunProbe;
    probe.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(probe.completed) }));
    probe.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'stale-interrupt-probe', method: 'turn/interrupt',
      params: { threadId: probe.completed.params.threadId, turnId: probe.completed.params.turnId } }));
  });
  await page.waitForFunction(() => window.__lateRunProbe.interruptReply !== null);
  assert.ok(await page.evaluate(() => Boolean(window.__lateRunProbe.interruptReply.error) || window.__lateRunProbe.interruptReply.result?.interrupted === false), 'old interrupt is rejected');
  assert.equal(await spinner.count(), 1, 'late old terminal cannot stop the new run');
  finishNewTurn = true;
  await page.getByText('NEW_RUN_FINISHED', { exact: true }).waitFor({ timeout: 15000 });
  await spinner.waitFor({ state: 'detached', timeout: 15000 });
  await page.screenshot({ path: context.pathInArtifacts('session-finished.png') });
  return { silentToolActive: true, pendingApprovalActive: true, navigateAwayPreserved: true, terminalStoppedSpinner: true, modelRequests: 4, duplicateOldApprovalRejected: true, oldInterruptRejected: true, lateTerminalPreservedNewRun: true };
  } catch (error) {
    await context.writeArtifactJson('interaction-diagnostic.json', await page.evaluate(() => window.__lateRunProbe.events));
    await page.screenshot({ path: context.pathInArtifacts('interaction-failure.png') });
    throw error;
  }
});
