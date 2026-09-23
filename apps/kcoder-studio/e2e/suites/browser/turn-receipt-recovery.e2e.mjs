import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

for (const dropTurn of [1, 2]) {
await runE2E(import.meta.url, {
  testId: 'renderer-queries-accepted-turn-after-lost-response', tier: 'full-integration',
  modelPolicy: 'model-independent loopback response; real Gateway and acceptance persistence',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'receipt' });
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body, requestNumber }) => {
    if (body.messages.at(-1)?.role === 'tool') return [
      { delta: { role: 'assistant', content: 'RECEIPT_RESPONSE' } }, { finishReason: 'stop' },
    ];
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `receipt-tool-${requestNumber}`,
      type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf x >> receipt-side-effects.txt' }) } }] } },
      { finishReason: 'tool_calls' }];
  } });
  const home = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', max_retries: 0, permission_mode: 'yolo',
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'fixture-model', context_window_tokens: 64000, output_headroom_tokens: 1024,
      max_output_tokens: 1024, no_proxy: true } } });
  const key = 'synthetic-receipt-test-key'; context.registerSecret(key);
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'));
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: home } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(dropTurn => {
    const NativeSocket = window.WebSocket;
    const probe = window.__turnReceiptProbe = { starts: 0, queries: 0, dropped: false, targetTurn: null };
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.targetRequest = null;
        super.addEventListener('message', event => {
          let message; try { message = JSON.parse(event.data); } catch { return; }
          if (this.targetRequest !== null && message.id === this.targetRequest && message.result?.turn?.id) {
            probe.targetTurn = message.result.turn.id;
            probe.dropped = true;
            event.stopImmediatePropagation();
            return;
          }
          if (probe.dropped && message.method === 'turn/completed' && message.params?.turnId === probe.targetTurn) {
            // Keep the committed work, lose its acceptance reply, then fail the transport.
            setTimeout(() => this.close(), 0);
          }
        });
      }
      send(data) {
        try {
          const message = JSON.parse(data);
          if (message.method === 'turn/start' && ++probe.starts === dropTurn) this.targetRequest = message.id;
          if (message.method === 'turn/receipt/read') probe.queries += 1;
        } catch { /* binary frames are unrelated */ }
        return super.send(data);
      }
    };
  }, dropTurn);
  await page.goto(`${gateway.baseUrl}/?e2e=1`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('chat-message-input').waitFor({ timeout: 30000 });
  const send = async prompt => {
    await page.getByTestId('chat-message-input').click();
    await page.keyboard.insertText(prompt);
    await page.getByTestId('send-message-button').click();
  };
  await send('RECEIPT_FIRST');
  await page.getByText('RECEIPT_RESPONSE', { exact: true }).first().waitFor({ timeout: 30000 });
  await send('RECEIPT_SECOND');
  await page.waitForFunction(() => window.__turnReceiptProbe.queries === 1, undefined, { timeout: 30000 });
  await waitFor(() => model.requests.length === 4, 10000, 'two intended turns each execute one tool and continue once');
  assert.equal(await readFile(resolve(workspace, 'receipt-side-effects.txt'), 'utf8'), 'xx', 'accepted work is never executed again after response loss');
  const probe = await page.evaluate(() => window.__turnReceiptProbe);
  assert.equal(probe.starts, 2);
  assert.equal(probe.dropped, true);
  assert.equal(probe.queries, 1);
  await page.getByText('RECEIPT_RESPONSE', { exact: true }).nth(1).waitFor({ timeout: 15000 });
  assert.equal(await page.getByTestId('assistant-error-card').count(), 0);
  await page.screenshot({ path: context.pathInArtifacts('receipt-reconciled.png') });
  return { droppedTurn: dropTurn, turnStarts: probe.starts, receiptQueries: probe.queries, providerRequests: model.requests.length };
});

}
