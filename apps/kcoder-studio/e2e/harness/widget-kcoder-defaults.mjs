import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '../../renderer/node_modules/@playwright/test/index.mjs';
import { startApprovalModelFixture } from './approval-model.mjs';
import { startGateway } from './gateway.mjs';
import { openOwnedPeerStudioPage } from './peer-studio-browser.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { repoRoot, requireExecutable, waitFor } from './run-context.mjs';
import { waitForSelectedModel } from './model-selector.mjs';

const enabledMarker = 'OWNED_KCODER_DEFAULT_MANAGED_CHART';
const disabledMarker = 'OWNED_KCODER_EXPLICIT_WIDGET_OFF_NEW_SESSION';
const chart = { type: 'bar', data: { labels: ['Owned A', 'Owned B'], datasets: [{ label: 'Owned values', data: [3, 7] }] },
  options: { animation: false } };
const managedSource = `<script type="application/json" data-kcoder-chart>${JSON.stringify(chart)}</script>`;
const toolNames = body => (body.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(Boolean);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** A dedicated registered variant: real model HTTP schema/tool round-trip and
 * production React host, without the older scroll/library acceptance matrix.
 */
export async function verifyOrdinaryKcoderWidgetDefaults(context) {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed ordinary KCoder widget Native');
  assert.match(process.env.KCODER_E2E_KCODER_BIN_SHA256 ?? '', /^[a-f0-9]{64}$/);
  const before = await lstat(binary), binarySha256 = digest(await readFile(binary)), after = await lstat(binary);
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  assert.ok(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs);
  const rendererRoot = process.env.KCODER_E2E_RENDERER_ROOT;
  assert.ok(rendererRoot && rendererRoot === resolve(rendererRoot));
  const rendererIndexSha256 = digest(await readFile(resolve(rendererRoot, 'index.html')));
  assert.equal(rendererIndexSha256, process.env.KCODER_E2E_RENDERER_INDEX_SHA256);
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'ordinary-kcoder-widget-defaults' });
  const providerFacts = [];
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body, requestNumber }) => {
    assert.ok(requestNumber <= 3, 'Only the two-call widget turn and one opted-out new-session turn are authorized');
    const names = toolNames(body), serialized = JSON.stringify(body.messages ?? []);
    const disabled = serialized.includes(disabledMarker);
    providerFacts.push({ requestNumber, scenario: disabled ? 'explicit-off-new-session' : 'ordinary-default',
      model: body.model, maxTokens: body.max_tokens, toolNames: names });
    if (disabled) {
      assert.equal(names.includes('show_widget'), false, 'An explicitly disabled new KCoder session must not expose show_widget');
      assert.equal((body.messages ?? []).some(message => message.role === 'tool'), false);
      return [{ delta: { role: 'assistant', content: 'OWNED_KCODER_WIDGET_DISABLED_DONE' } }, { finishReason: 'stop' }];
    }
    assert.ok(serialized.includes(enabledMarker));
    assert.ok(names.includes('show_widget'), 'Ordinary KCoder defaults must reach the actual Provider tool schema');
    const results = (body.messages ?? []).filter(message => message.role === 'tool');
    if (results.length) {
      assert.equal(results.length, 1);
      const text = typeof results[0].content === 'string' ? results[0].content : results[0].content.map(block => block.text ?? '').join('');
      const receipt = JSON.parse(text.split('\n')[0]);
      assert.equal(receipt.status, 'committed', 'A real ToolError must not be converted into a successful widget');
      assert.ok(receipt.widget_id && Number.isSafeInteger(receipt.revision));
      return [{ delta: { role: 'assistant', content: `OWNED_KCODER_WIDGET_DEFAULT_DONE\n\n::kcoder-widget{widget_id="${receipt.widget_id}" revision=${receipt.revision}}` } }, { finishReason: 'stop' }];
    }
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'ordinary-default-widget', type: 'function',
      function: { name: 'show_widget', arguments: JSON.stringify({ title: 'Ordinary KCoder managed chart',
        summary: 'Two owned deterministic values', format: 'html', libraries: ['chart_js'], widget_code: managedSource }) } }] } },
    { finishReason: 'tool_calls' }];
  } });
  // No tools/allowed/disabled override: the ordinary mode uses Native defaults.
  await context.writeStateJson('native-profile/settings.json', { active_provider: 'fixture', credential_store: 'file',
    permission_mode: 'ask', max_retries: 0, auto_memory_enabled: false, auto_tool_memory_enabled: false,
    session_memory: { enabled: false }, memory: { observer_mode: 'disabled', structured_enabled: false, legacy_prompt_enabled: false },
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'fixture', discover_models: false, no_proxy: true,
      context_window_tokens: 128000, max_output_tokens: 2048, output_headroom_tokens: 2048 } } });
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned ordinary KCoder widget',
    transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { auth: true, workspace, serversFile: servers, kcoderBin: binary,
    serversStore: context.pathInState('studio/servers.json'),
    ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}),
    env: { KCODER_CONFIG_DIR: context.pathInState('native-profile'), KCODER_HOME: context.pathInState('native-profile'),
      KCODER_STUDIO_DATA_DIR: context.pathInState('gateway-data') } });
  const { page } = await openOwnedPeerStudioPage(context, gateway, { label: 'ordinary-kcoder-widget-browser' });
  const requests = [], widgets = [], policySaves = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    const pending = new Map();
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (!['thread/start', 'turn/start', 'settings/tools/selection/save'].includes(frame.method)) return;
        const row = { method: frame.method, threadId: frame.params?.threadId,
          studioWorkMode: frame.params?.studioWorkMode,
          clientPresentation: frame.params?.clientPresentation };
        requests.push(row); pending.set(frame.id, row);
      } catch { /* Only exact public protocol facts are retained. */ }
    });
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload)), request = pending.get(frame.id);
        if (request) {
          request.replyObserved = true; request.errorCode = frame.error?.code;
          if (request.method === 'thread/start') request.createdThreadId = frame.result?.thread?.id;
          if (request.method === 'settings/tools/selection/save') policySaves.push({ errorCode: frame.error?.code,
            resultObserved: Object.hasOwn(frame, 'result') });
        }
        if (frame.method === 'item/completed' && frame.params?.item?.widgetRef)
          widgets.push(frame.params.item.widgetRef);
      } catch { /* Model text and unrelated messages do not create WidgetRefs. */ }
    });
  });
  let stage = 'ordinary-default-tool-request';
  try {
    await page.getByRole('button', { name: 'KCoder', exact: true }).click();
    await waitForSelectedModel(page, 'fixture');
    await page.getByTestId('chat-message-input').fill(enabledMarker);
    await page.getByTestId('send-message-button').click();
    const approval = page.getByTestId('request-user-input-card').filter({ hasText: 'show_widget' });
    await approval.waitFor({ timeout: 30000 });
    await approval.locator('[data-testid^="request-user-input-option-"]').filter({ hasText: /Allow once|仅允许这一次/ }).click();
    await approval.waitFor({ state: 'hidden', timeout: 10000 });
    await page.getByText('OWNED_KCODER_WIDGET_DEFAULT_DONE', { exact: true }).waitFor({ timeout: 45000 });
    await page.getByTestId('pause-response-button').waitFor({ state: 'hidden' });
    const firstThread = new URL(page.url()).searchParams.get('taskId'); assert.ok(firstThread?.startsWith('kcoder:local:'));
    const host = page.getByTestId('inline-widget').filter({ has: page.locator('[data-testid="inline-widget-frame"]') }).first();
    await host.waitFor({ timeout: 15000 });
    const handle = await host.getByTestId('inline-widget-frame').elementHandle();
    const frame = await handle.contentFrame(); assert.ok(frame);
    await frame.waitForFunction(() => { const canvas = document.querySelector('canvas'); return canvas && globalThis.Chart?.getChart(canvas); });
    const drawing = await frame.evaluate(() => {
      const canvas = document.querySelector('canvas'), chart = globalThis.Chart.getChart(canvas), box = canvas.getBoundingClientRect();
      const pixels = canvas.width && canvas.height ? canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data : [];
      return { version: globalThis.Chart.version, values: chart.data.datasets[0].data,
        width: canvas.width, height: canvas.height, cssWidth: box.width, cssHeight: box.height,
        painted: pixels.some((value, index) => index % 4 === 3 && value > 0) };
    });
    assert.deepEqual(drawing.values, [3, 7]); assert.equal(drawing.painted, true);
    assert.ok(drawing.width > 0 && drawing.height > 0 && drawing.cssWidth > 0 && drawing.cssHeight > 0);
    assert.ok(widgets.some(widget => widget.executionMode === 'managed'));
    await page.screenshot({ path: context.pathInArtifacts('ordinary-kcoder-default-managed-chart.png'), fullPage: true });
    stage = 'explicit-kcoder-tool-setting-off';
    await page.goto(`${gateway.baseUrl}/settings/tools`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('tool-selections-target')).toHaveValue('local', { timeout: 30000 });
    await page.getByTestId('tool-selections-mode-kcoder').click();
    await page.getByTestId('tool-selections-search').fill('show_widget');
    const toggle = page.getByTestId('tool-selection-show_widget');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const beforeSave = policySaves.length; await toggle.click();
    await waitFor(() => policySaves.slice(beforeSave).some(row => row.resultObserved && !row.errorCode), 15000, 'actual Native tool-selection save');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    stage = 'explicit-off-new-ordinary-session';
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible' });
    await page.getByText('新建任务', { exact: true }).first().click();
    await page.getByRole('button', { name: 'KCoder', exact: true }).click();
    await waitForSelectedModel(page, 'fixture');
    await page.getByTestId('chat-message-input').fill(disabledMarker);
    await page.getByTestId('send-message-button').click();
    await page.getByText('OWNED_KCODER_WIDGET_DISABLED_DONE', { exact: true }).waitFor({ timeout: 30000 });
    const secondThread = new URL(page.url()).searchParams.get('taskId');
    assert.ok(secondThread?.startsWith('kcoder:local:')); assert.notEqual(secondThread, firstThread);
    assert.equal(await page.getByTestId('inline-widget').count(), 0);
    assert.equal(model.requests.length, 3);
    const turns = requests.filter(row => row.method === 'turn/start'); assert.equal(turns.length, 2);
    assert.ok(turns.every(row => row.clientPresentation?.studioWorkMode === 'kcoder'), 'Both real turns must be ordinary KCoder');
    assert.ok(turns.every(row => row.clientPresentation?.inlineWidgets === true), 'Fresh ordinary KCoder must advertise its default inline rendering preference');
    assert.deepEqual(errors, []);
    await context.writeArtifactJson('ordinary-kcoder-widget-defaults-proof.json', { binary, binarySha256,
      rendererRoot, rendererIndexSha256, firstThread, secondThread, drawing, trustedNativeWidgets: widgets,
      providerFacts, requests, policySaves, defaultToolsUnmodifiedByFixture: true,
      realModelFees: 0, deterministicProviderCalls: 3, actualReactChromium: true, actualNativeTool: 'show_widget',
      nativeIsolatedHtmlOrWindowsClaim: false });
    return { ordinaryKcoderDefaultTool: true, actualManagedChart: true, explicitNewSessionOptOut: true,
      deterministicProviderCalls: model.requests.length, realModelFees: 0 };
  } catch (error) {
    await context.writeArtifactJson('ordinary-kcoder-widget-defaults-failure.json', { stage, providerFacts, requests, widgets, policySaves, errors });
    throw error;
  } finally {
    await page.screenshot({ path: context.pathInArtifacts('ordinary-kcoder-widget-defaults-final.png'), fullPage: true }).catch(() => {});
  }
}
