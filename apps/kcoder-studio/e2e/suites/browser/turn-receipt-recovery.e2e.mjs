import { waitForSelectedModel } from '../../harness/model-selector.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { fillComposerText, readComposerDiagnostics } from '../../harness/composer-input.mjs';

await assertRendererBuildFresh();

for (const dropTurn of [1, 2]) {
await runE2E(import.meta.url, {
  testId: 'renderer-queries-accepted-turn-after-lost-response', tier: 'full-integration',
  modelPolicy: 'model-independent loopback response; real Gateway and acceptance persistence',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'receipt' });
  const sideEffects = resolve(workspace, 'receipt-side-effects.txt');
  const sideEffectCommand = `printf x >> '${sideEffects.replaceAll("'", "'\\''")}'`;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body, requestNumber }) => {
    if (body.messages.at(-1)?.role === 'tool') return [
      { delta: { role: 'assistant', content: 'RECEIPT_RESPONSE' } }, { finishReason: 'stop' },
    ];
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `receipt-tool-${requestNumber}`,
      type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: sideEffectCommand }) } }] } },
      { finishReason: 'tool_calls' }];
  } });
  const home = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', max_retries: 0, permission_mode: 'yolo',
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'fixture-model', context_window_tokens: 128000, output_headroom_tokens: 1024,
      max_output_tokens: 1024, no_proxy: true } } });
  const key = 'synthetic-receipt-test-key'; context.registerSecret(key);
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'));
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: home } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const composerEvents = [];
  page.on('console', async message => {
    if (composerEvents.length >= 100 || !message.text().startsWith('[KCoder Studio] Composer submit flow')) return;
    composerEvents.push(await message.args()[1]?.jsonValue().catch(() => null));
  });
  await page.addInitScript(dropTurn => {
    localStorage.setItem('kcoder:debug-composer', '1');
    const NativeSocket = window.WebSocket;
    const probe = window.__turnReceiptProbe = { starts: 0, queries: 0, receipts: [], submits: [], invalid: [], clicks: [], dropped: false, targetTurn: null };
    document.addEventListener('submit', event => probe.submits.push({ form: event.target.dataset.testid ?? null }), true);
    document.addEventListener('invalid', event => probe.invalid.push({ tag: event.target.tagName, type: event.target.type }), true);
    document.addEventListener('click', event => {
      const button = event.target.closest?.('[data-testid="send-message-button"]');
      if (button) probe.clicks.push({ form: button.form?.dataset.testid ?? null, type: button.type, disabled: button.disabled });
    }, true);
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.targetRequest = null;
        this.receiptRequests = new Set();
        super.addEventListener('message', event => {
          let message; try { message = JSON.parse(event.data); } catch { return; }
          if (this.receiptRequests.delete(message.id)) probe.receipts.push({
            status: message.result?.receipt?.status ?? null, errorCode: message.error?.code ?? null,
          });
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
          if (message.method === 'turn/receipt/read') { probe.queries += 1; this.receiptRequests.add(message.id); }
        } catch { /* binary frames are unrelated */ }
        return super.send(data);
      }
    };
  }, dropTurn);
  await page.goto(`${gateway.baseUrl}/?e2e=1`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('chat-message-input').waitFor({ timeout: 30000 });
  await waitForSelectedModel(page,'fixture-model');
  const send = async prompt => {
    await fillComposerText(page, prompt);
    await page.getByTestId('send-message-button').click();
  };
  try {
  await send('RECEIPT_FIRST');
  await page.getByText('RECEIPT_RESPONSE', { exact: true }).first().waitFor({ timeout: 30000 });
  await send('RECEIPT_SECOND');
  await page.waitForFunction(() => window.__turnReceiptProbe.queries >= 1, undefined, { timeout: 30000 });
  // Metadata-only model requests do not execute task tools. Silence may also
  // legitimately require more than one read before a terminal receipt exists.
  const taskRequests = () => model.requests.filter(body => body.tools?.length > 0).length;
  await waitFor(() => taskRequests() === 4, 10000, 'two intended turns each execute one tool and continue once');
  assert.equal(await readFile(sideEffects, 'utf8'), 'xx', 'accepted work is never executed again after response loss');
  const probe = await page.evaluate(() => window.__turnReceiptProbe);
  assert.equal(probe.starts, 2);
  assert.equal(probe.dropped, true);
  assert.ok(probe.queries >= 1);
  assert.ok(probe.receipts.some(receipt => receipt.status === 'completed' && receipt.errorCode === null));
  await page.getByText('RECEIPT_RESPONSE', { exact: true }).nth(1).waitFor({ timeout: 15000 });
  assert.equal(await page.getByTestId('assistant-error-card').count(), 0);
  await page.screenshot({ path: context.pathInArtifacts('receipt-reconciled.png') });
  return { droppedTurn: dropTurn, turnStarts: probe.starts, receiptQueries: probe.queries,
    taskProviderRequests: taskRequests(), providerRequests: model.requests.length };
  } catch (error) {
    await context.writeArtifactJson('receipt-failure.json', {text:await page.locator('body').innerText(),probe:await page.evaluate(()=>window.__turnReceiptProbe),providerRequests:model.requests.length,
      composer: await readComposerDiagnostics(page),
      composerEvents,
      providerCalls: model.requests.map(body => ({
        model: body.model, lastRole: body.messages.at(-1)?.role,
        tools: body.tools?.length ?? 0, maxTokens: body.max_tokens,
        toolOutcome: body.messages.at(-1)?.role === 'tool' ? String(body.messages.at(-1).content).slice(0, 600) : null,
        prompt: ['RECEIPT_FIRST', 'RECEIPT_SECOND'].find(marker => body.messages.some(message =>
          typeof message.content === 'string' && message.content.includes(marker))) ?? 'other',
      })) });
    await page.screenshot({path:context.pathInArtifacts('receipt-failure.png')});
    throw error;
  }
});

}
