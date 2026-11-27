import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { openOwnedPeerStudioPage } from '../../harness/peer-studio-browser.mjs';
import { observePeerStudioPage, seedPeerStudioPage } from '../../harness/peer-studio-ui.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { recordSubagentTestInputs } from '../../harness/subagent-model.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

const count = 192;
const profile = process.env.KCODER_E2E_SUBAGENT_STREAM_PROFILE ?? 'usage';
assert.ok(['burst', 'fast', 'paced', 'long', 'usage'].includes(profile), 'unsupported subagent stream profile');
const batchSize = profile === 'burst' ? 8 : 1;
const intervalMs = profile === 'burst' ? 32 : ['fast', 'usage'].includes(profile) ? 6 : 12;
const prefix = profile === 'long'
  ? Array.from({ length: 65 }, (_, i) => `### Section ${i + 1}\n\n${'检查结果和复现步骤 '.repeat(25)}\n\n- **Result** with \`inline code\`.\n\n`).join('')
  : '';
const token = (lane, i) => `${lane}${String(i).padStart(3, '0')}·`;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];

async function watchVisible(page, lane, selector) {
  await page.evaluate(({ lane, selector }) => {
    const observer = new MutationObserver(() => {
      const text = Array.from(document.querySelectorAll(selector), el => el.textContent).join('');
      const matches = [...text.matchAll(new RegExp(lane + '(\\d{3})·', 'g'))];
      if (matches.length <= samples.length) return;
      const now = Date.now();
      for (const match of matches.slice(samples.length)) samples.push({ index: Number(match[1]), at: now });
      mutations++;
    });
    const samples = [];
    let mutations = 0;
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    window.finishRateObservation = () => { observer.disconnect(); return { samples, mutations }; };
  }, { lane, selector });
}

await runE2E(import.meta.url, {
  testId: 'parent-and-owned-subagent-stream-visible-latency', tier: 'full-integration',
  modelPolicy: 'Chromium, Gateway and native Engine render individually paced loopback SSE, including running usage by default. Measures Native, WebSocket and DOM latency.',
}, async context => {
  const rendererRoot = process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist');
  await assertRendererBuildFresh({ buildRoot: rendererRoot });
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  await recordSubagentTestInputs(context, binary, rendererRoot);
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const starts = { M: 0, C: 0 }, sent = { M: [], C: [] }, wire = { M: [], C: [] };
  let requests = 0, resets = 0, sourceThreadId;
  const finished = {};
  function* paced(lane) {
    yield { delta: { role: 'assistant', content: `${prefix}RATE_READY_${lane}\n\n` } };
    for (let i = 0; i < count; i++) {
      yield {
        delayMs: batchSize === 1 && i > 0 ? intervalMs : 0,
        ready() {
          if (!starts[lane] || batchSize > 1 && Date.now() < starts[lane] + Math.floor(i / batchSize) * intervalMs) return false;
          sent[lane][i] = Date.now();
          return true;
        },
        delta: { content: token(lane, i) },
        ...(profile === 'usage' && { usage: { prompt_tokens: 8, completion_tokens: i + 1, total_tokens: i + 9 } }),
      };
    }
    yield { finishReason: 'stop' };
  }
  const fixture = await startApprovalModelFixture(context, { textOnly: true, responseSteps: ({ body }) => {
    assert.ok(++requests <= 8, 'bounded flow');
    const users = body.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join('\n');
    if (users.includes('RATE_FIXTURE_CHILD_TASK')) return paced('C');
    if (users.includes('RATE_FIXTURE_PARENT_TASK')) {
      if (body.messages.some(m => m.role === 'tool')) return sent.M.length ? [{ delta: { content: 'RATE_ACK' }, finishReason: 'stop' }] : paced('M');
      return [{ delta: { tool_calls: [{ index: 0, id: 'owned-rate-spawn', type: 'function', function: {
        name: 'spawn_agent', arguments: JSON.stringify({ message: 'RATE_FIXTURE_CHILD_TASK', agent_type: 'general', context_mode: 'none', run_in_background: true }),
      } }] }, finishReason: 'tool_calls' }];
    }
    return [{ delta: { content: 'READY' }, finishReason: 'stop' }];
  } });
  const settings = await context.writeStateJson('config/settings.json', {
    active_provider: 'owned', permission_mode: 'yolo', max_retries: 0, credential_store: 'file',
    auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
    providers: { owned: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: fixture.baseUrl, default_model: 'owned-model', discover_models: false, no_proxy: true,
      context_window_tokens: 128000, max_output_tokens: 4096, output_headroom_tokens: 4096 } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Stream rate',
    transport: 'local', runtime: 'kcoder', workspace, command: binary, settingsFile: settings }]);
  const gateway = await startGateway(context, { kcoderBin: binary, workspace, serversFile, auth: true,
    env: { KCODER_CONFIG_DIR: context.pathInState('config'), KCODER_TARGET_DIR: process.env.KCODER_TARGET_DIR } });
  const { page } = await openOwnedPeerStudioPage(context, gateway, { label: 'stream-rate' });
  const discovery = observePeerStudioPage(page);
  const observedChild = { started: 0, snapshots: [], readyOnWire: false };
  page.on('websocket', socket => {
    const subscribeIds = new Set();
    socket.on('framesent', ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.method === 'agent/stream/subscribe') subscribeIds.add(frame.id);
    });
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(String(payload)), child = frame.method === 'agent/stream/event';
      if (subscribeIds.delete(frame.id)) {
        const messages = frame.result?.messages ?? [];
        observedChild.snapshots.push({ messages: messages.length, ready: JSON.stringify(messages).includes('RATE_READY_C'),
          error: frame.error?.code ?? null });
      }
      if (frame.method === 'agent/stream/reset' && starts.C && frame.params?.threadId === sourceThreadId) resets++;
      const params = child ? frame.params?.params : frame.params, lane = child ? 'C' : 'M';
      if (child && frame.params?.method === 'item/started') observedChild.started++;
      if ((child ? frame.params?.method : frame.method) === 'turn/completed' &&
          sourceThreadId && frame.params?.threadId === sourceThreadId && starts[lane]) finished[lane] ??= Date.now();
      if ((child ? frame.params?.method : frame.method) !== 'item/delta' || typeof params?.delta?.text !== 'string') return;
      if (child && params.delta.text.includes('RATE_READY_C')) observedChild.readyOnWire = true;
      for (const match of params.delta.text.matchAll(new RegExp(lane + '(\\d{3})·', 'g'))) {
        const i = Number(match[1]);
        wire[lane][i] ??= { at: Date.now(), occurred: child ? frame.params.occurredAtMs : params.occurredAtMs };
      }
    });
  });
  const results = {};
  try {
    const source = await seedPeerStudioPage(page, discovery, { marker: 'RATE_FIXTURE_PARENT_TASK', ready: 'RATE_READY_M', serverId: 'local' });
    sourceThreadId = source.threadId;
    for (const lane of ['M', 'C']) {
      if (lane === 'C') {
        const detail = page.getByTestId('subagent-detail-open');
        if (!await detail.isVisible()) await page.getByTestId('subagent-status-toggle-button').click();
        await detail.click();
      }
      const selector = (lane === 'C' ? '[data-testid="subagent-workspace-records"] ' : '') + '[data-testid="message-assistant"]';
      const message = page.locator(selector).filter({ hasText: `RATE_READY_${lane}` });
      await message.waitFor({ timeout: 30000 });
      await watchVisible(page, lane, selector);
      starts[lane] = Date.now();
      await message.filter({ hasText: token(lane, count - 1) }).waitFor({ timeout: 10000 });
      const { samples, mutations } = await page.evaluate(() => window.finishRateObservation());
      assert.deepEqual(samples.map(s => s.index), Array.from({ length: count }, (_, i) => i), 'all displayed markers are ordered');
      await waitFor(() => wire[lane].filter(Boolean).length === count, 2500, 'all marker deltas on the browser WebSocket');
      await waitFor(() => finished[lane], 5000, 'terminal frame for the same visible task');
      const visible = samples.map(s => s.at - sent[lane][s.index]);
      const fromNative = samples.map(s => s.at - wire[lane][s.index].occurred).filter(Number.isFinite);
      assert.equal(fromNative.length, count, 'every received marker has a native event timestamp');
      results[lane] = { deltas: count, domUpdates: mutations, streamMs: sent[lane].at(-1) - sent[lane][0],
        visibleP50Ms: percentile(visible, .50), visibleP95Ms: percentile(visible, .95),
        firstQuarterP50Ms: percentile(visible.slice(0, count / 4), .50),
        lastQuarterP50Ms: percentile(visible.slice(-count / 4), .50), lastDeltaVisibleMs: visible.at(-1),
        nativeToDomP95Ms: percentile(fromNative, .95),
        fixtureToNativeP95Ms: percentile(wire[lane].map((s, i) => s.occurred - sent[lane][i]), .95),
        nativeToWireP95Ms: percentile(wire[lane].map(s => s.at - s.occurred), .95),
        wireToDomP95Ms: percentile(samples.map(s => s.at - wire[lane][s.index].at), .95),
        displayTailAfterTerminalMs: Math.max(0, samples.at(-1).at - finished[lane]) };
      assert.ok(mutations > 1, 'UI publishes before completion');
      if (profile === 'burst') assert.ok(mutations < count, 'burst updates must be batched');
      if (profile === 'usage') {
        assert.ok(results[lane].fixtureToNativeP95Ms < 300, 'running usage must not stall native output');
        assert.ok(results[lane].wireToDomP95Ms < 350, 'running usage must not stall visible output');
      }
      assert.ok(results[lane].lastQuarterP50Ms < results[lane].firstQuarterP50Ms + 300, 'display lag must not accumulate');
      assert.ok(visible.at(-1) < 750, 'terminal output must catch up with the provider');
    }
    assert.equal(resets, 0, 'the measured child burst arrived without a snapshot reset');
    await context.writeArtifactJson('stream-rate.json', { profile, count, batchSize, intervalMs, resets, main: results.M, child: results.C });
    return { main: results.M, child: results.C, resets };
  } catch (error) {
    await context.writeArtifactJson('stream-rate-failure.json', { profile, results, requests, resets,
      sent: [sent.M.length, sent.C.length], wire: [wire.M.filter(Boolean).length, wire.C.filter(Boolean).length],
      observedChild,
      childText: (await page.getByTestId('subagent-workspace-records').allInnerTexts()).join('\n').slice(-1500),
      pageText: (await page.locator('main').allInnerTexts()).join('\n').slice(-1500) });
    throw error;
  } finally { await page.close(); }
});
