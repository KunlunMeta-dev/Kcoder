import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'stream-overflow-reloads-authoritative-history-before-late-snapshot', tier: 'full-integration',
  modelPolicy: 'model-independent real transport event burst and delayed snapshot response' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'stream-reset' });
  const expected = 'RESET_BEGIN_' + 'x'.repeat(620) + '_RESET_END';
  const model = await startApprovalModelFixture(context, { textOnly: true,
    textOnlyChunks: ['RESET_BEGIN_', ...Array(620).fill('x'), '_RESET_END'], textOnlyChunkDelayMs: 2 });
  const home = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', max_retries: 0, providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
    default_model: 'fixture', context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024, no_proxy: true,
  } } });
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: home } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const probe = window.__streamGapProbe = { reads: 0, held: 0, released: 0, deltas: 0, started: false, readAtDeltas: [] };
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args); this.historyIds = new Set();
        super.addEventListener('message', event => {
          if (event.__replayed) return;
          let message; try { message = JSON.parse(event.data); } catch { return; }
          if (message.method === 'item/delta' && probe.started) probe.deltas++;
          if (this.historyIds.has(message.id) && probe.held === 0) {
            probe.held++; event.stopImmediatePropagation();
            setTimeout(() => { const delayed = new MessageEvent('message', { data: event.data });
              delayed.__replayed = true; probe.released++; this.dispatchEvent(delayed); }, 4500);
          }
        });
      }
      send(data) {
        try { const message = JSON.parse(data);
          if (message.method === 'turn/start') probe.started = true;
          if (probe.started && ['thread/read', 'thread/read/indexed'].includes(message.method)) {
            probe.reads++; probe.readAtDeltas.push(probe.deltas); this.historyIds.add(message.id);
          }
        } catch { /* unrelated binary frame */ }
        return super.send(data);
      }
    };
  });
  await page.goto(gateway.baseUrl);
  await page.getByTestId('chat-message-input').fill('STREAM_RESET_CHECK');
  await page.getByTestId('send-message-button').click();
  await page.getByText(expected, { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__streamGapProbe.released), 0,
    'a new turn must begin before the old snapshot arrives');
  await page.getByTestId('chat-message-input').fill('STREAM_RESET_SECOND_TURN');
  await page.getByTestId('send-message-button').click();
  await page.getByText(expected, { exact: true }).nth(1).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => window.__streamGapProbe.released === 1, undefined, { timeout: 30000 });
  const probe = await page.evaluate(() => window.__streamGapProbe);
  assert.ok(probe.deltas > 512, 'actually exercise the buffering bound');
  await context.writeArtifactJson('overflow-observation.json', probe);
  assert.ok(probe.reads >= 2, 'overflow must obtain a fresh authoritative snapshot');
  assert.equal(model.requests.length, 2, 'history recovery never resubmits model work');
  assert.equal(await page.getByText(expected, { exact: true }).count(), 2);
  await page.screenshot({ path: context.pathInArtifacts('stream-reset.png') });
  return { ...probe, providerRequests: model.requests.length, eachTurnTextExactlyOnce: true, lateSnapshotAfterNewTurn: true };
});
