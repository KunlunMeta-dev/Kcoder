import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { delayWidgetContentReplies, observeWidgetWorkbenchScroll, sampleCompletedWidgetScroll } from '../../harness/widget-workbench-scroll.mjs';
import { productionLibrarySamples, observeProductionLibraries, verifyProductionLibraries } from '../../harness/widget-production-libraries.mjs';
import { verifyProductionWidgetLifecycle } from '../../harness/widget-production-lifecycle.mjs';
import { productionReadinessSamples, verifyProductionDrawingReadiness } from '../../harness/widget-production-readiness.mjs';
import { waitForSelectedModel } from '../../harness/model-selector.mjs';

const failedChart = process.argv.includes('--failed-chart');
const libraryCheck = process.argv.includes('--libraries');
const lifecycleCheck = process.argv.includes('--lifecycle');
const readinessCheck = process.argv.includes('--readiness');
const tallDiagram = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1800" viewBox="0 0 600 1800"><title>完整工作流程</title>' +
  Array.from({ length: 9 }, (_, index) => '<g><rect x="80" y="' + (20 + index * 195) + '" width="440" height="125" rx="14" fill="var(--background)" stroke="var(--border)"/><text x="115" y="' + (90 + index * 195) + '" fill="var(--foreground)">步骤 ' + (index + 1) + (index === 8 ? ' · 完整结果' : ' · 资料核对与处理') + '</text>' + (index < 8 ? '<path d="M300 ' + (145 + index * 195) + 'v60m-8-8 8 8 8-8" fill="none" stroke="var(--primary)"/>' : '') + '</g>').join('') + '</svg>';

await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: `completed-widgets-production-workbench-external-scroll${failedChart ? '-failed-chart' : ''}${libraryCheck ? '-libraries' : ''}${lifecycleCheck ? '-lifecycle' : ''}${readinessCheck ? '-readiness' : ''}`, tier: 'full-integration',
  modelPolicy: 'model-independent deterministic Provider tool calls through actual Gateway/Rust and production Workbench/PaneLayout; no paid models',
  retainSuccessEvidence: true, evidenceReason: 'Production external scroll owner and browser-native iframe layout require geometry and call-stack evidence' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'widget-completed-scroll' });
  await context.writeArtifactJson('production-source-identity.json', {
    ownerSelector: '[data-testid="desktop-workbench-content"]', artifactLatencyMs: 450, failedChart, libraryCheck,
    rendererResourceRoot: process.env.KCODER_E2E_RENDERER_ROOT || resolve(repoRoot, 'apps/kcoder-studio/renderer/dist'),
    gatewayResourceRoot: process.env.KCODER_E2E_GATEWAY_ROOT || resolve(repoRoot, 'apps/kcoder-studio'),
    files: await Promise.all([
      'components/layout/workbench/PaneLayout.tsx', 'components/chat/MessageList.tsx',
      'components/chat/ScrollableMessageArea.tsx', 'features/widgets/InlineWidgetHost.tsx',
    ].map(async file => ({ file, sha256: createHash('sha256').update(await readFile(resolve(repoRoot, 'apps/kcoder-studio/renderer/src', file))).digest('hex') }))),
  });
  const count = readinessCheck ? productionReadinessSamples.length : lifecycleCheck ? 1 : libraryCheck ? productionLibrarySamples.length : 12;
  let finalReleased = !lifecycleCheck;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    const results = (body.messages ?? []).filter(message => message.role === 'tool');
    if (results.length) {
      const receipts = results.map(message => {
        const text = typeof message.content === 'string' ? message.content : message.content.map(block => block.text ?? '').join('');
        // Engine feedback follows the tool's JSON receipt on another line.
        const receipt = JSON.parse(text.split('\n')[0]);
        return receipt;
      });
      const widgets = receipts.filter(receipt => receipt.status === 'committed');
      assert.equal(widgets.length, count);
      if (readinessCheck && receipts.length === count) return [{ delta: { role: 'assistant', tool_calls: widgets.map((widget, index) => ({ index, id: `read-widget-${index}`, type: 'function', function: { name: 'show_widget', arguments: JSON.stringify({ action: 'read', widget_id: widget.widget_id }) } })) } }, { finishReason: 'tool_calls' }];
      return [...(lifecycleCheck ? [{ delta: { role: 'assistant', content: 'WIDGET_FINAL_IS_HELD\n\n' } }] : []), { ready: () => finalReleased, delta: { role: 'assistant', content: '# Completed widget history\n\n' + widgets.map((widget, index) =>
        `Completed panel ${index + 1}.\n\n::kcoder-widget{widget_id="${widget.widget_id}" revision=${widget.revision}}`).join('\n\n') + '\n\nCOMPLETED_WIDGET_HISTORY_END' } }, { finishReason: 'stop' }];
    }
    return [{ delta: { role: 'assistant', tool_calls: Array.from({ length: count }, (_, index) => ({
      index, id: `completed-widget-${index}`, type: 'function', function: { name: 'show_widget', arguments: JSON.stringify({
        title: `Completed panel ${index + 1}`, summary: `Stable readable visualization ${index + 1}`,
        ...(readinessCheck ? productionReadinessSamples[index] : libraryCheck ? productionLibrarySamples[index] : failedChart ? { format: 'html', libraries: ['chart_js'],
          widget_code: '<script type="application/json" data-kcoder-chart>' + JSON.stringify({ type: 'mixed', data: { labels: ['A', 'B'], datasets: [{ label: 'Rejected type', data: [10, 12] }] } }) + '</script>',
        } : { format: 'svg', widget_code: index === 0 ? tallDiagram : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 ${[160, 340, 520][index % 3]}"><rect width="600" height="600" fill="#e6f0ff"/><text x="30" y="70">COMPLETED PANEL ${index + 1}</text></svg>` }),
      }) },
    })) } }, { finishReason: 'tool_calls' }];
  } });
  const settings = await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', model: 'fixture', history_enabled: true, history_directory: context.pathInState('profile/history'), permission_mode: 'bypass', session_memory: { enabled: false },
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl, authentication: { mode: 'none' },
      default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192, max_retries: 0, no_proxy: true } },
    tools: { profile: 'full' } });
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Completed widget scroll', transport: 'local', command: resolve(repoRoot, 'target/debug/kcoder'), workspace, settingsFile: settings }]);
  const gateway = await startGateway(context, { workspace, serversFile: servers, serversStore: context.pathInState('studio/servers.json'), ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}), env: { KCODER_CONFIG_DIR: context.pathInState('profile') } });
  await waitForGatewayRpcToken(context, gateway);
  const browser = await startChromium(context, { executablePath: process.env.KCODER_E2E_CHROMIUM_BIN });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await observeWidgetWorkbenchScroll(page);
  const libraryErrors = libraryCheck ? await observeProductionLibraries(page) : [];
  const delayedReads = await delayWidgetContentReplies(context, page, 450, { transcriptDelayMs: lifecycleCheck ? 1000 : 0 });
  try {
    await page.goto(gateway.baseUrl);
    await page.getByRole('button', { name: 'KWorker', exact: true }).click();
    const editor = page.getByTestId('chat-message-input');
    await editor.waitFor({ timeout: 45000 });
    await waitForSelectedModel(page, 'fixture');
    await editor.click(); await page.keyboard.insertText('Generate the completed widget history fixture.');
    await page.getByTestId('send-message-button').click();
    if (lifecycleCheck) return await verifyProductionWidgetLifecycle(context, page, () => { finalReleased = true; });
    await page.getByText('COMPLETED_WIDGET_HISTORY_END', { exact: true }).waitFor({ timeout: 90000 });
    await page.getByTestId('pause-response-button').waitFor({ state: 'hidden' });
    await page.waitForFunction(({ expected, failed }) => {
      const widgets = [...document.querySelectorAll('[data-testid="inline-widget"]')];
      return failed ? new Set(widgets.map(node => node.dataset.widgetId)).size === expected : widgets.length === expected;
    }, { expected: count, failed: failedChart || libraryCheck || readinessCheck }, { timeout: 20000 });
    if (readinessCheck) return await verifyProductionDrawingReadiness(context, page, model);
    if (libraryCheck) return await verifyProductionLibraries(context, page, libraryErrors);
    if (failedChart) await page.locator('[data-testid="inline-widget"][data-widget-status="error"]').first().waitFor();
    else await page.getByTestId('inline-widget-frame').first().waitFor();
    await page.waitForTimeout(600);
    await context.writeArtifactJson('completed-initial.json', await sampleCompletedWidgetScroll(page, 90));
    const owner = page.getByTestId('desktop-workbench-content');
    const rect = await owner.boundingBox(); assert.ok(rect);
    if (!failedChart) {
    const iframePoint = await page.evaluate(() => {
      const viewport = document.querySelector('[data-testid="desktop-workbench-content"]').getBoundingClientRect();
      for (const iframe of document.querySelectorAll('[data-testid="inline-widget-frame"]')) {
        const box = iframe.getBoundingClientRect();
        const top = Math.max(box.top, viewport.top + 48), bottom = Math.min(box.bottom, viewport.bottom - 180);
        if (bottom - top > 30) return { x: box.left + box.width / 2, y: (top + bottom) / 2 };
      }
      return null;
    });
    assert.ok(iframePoint, 'A real completed opaque iframe must be visible for scroll chaining');
    await page.mouse.move(iframePoint.x, iframePoint.y);
    await page.mouse.wheel(0, -650);
    await page.waitForTimeout(200);
    const iframeEvidence = await sampleCompletedWidgetScroll(page, 150);
    await context.writeArtifactJson('completed-wheel-over-real-iframe.json', iframeEvidence);
    const iframeSettled = iframeEvidence.samples.slice(10);
    const iframeDrift = Math.max(...iframeSettled.map(sample => sample.top)) - Math.min(...iframeSettled.map(sample => sample.top));
    assert.ok(iframeDrift <= 3, `Completed production iframe scroll chaining drifted ${iframeDrift}px`);
    assert.ok(iframeSettled.every(sample => sample.height - sample.viewport - sample.top > 80), 'Opaque iframe scrolling was pulled back to the bottom');
    await page.mouse.move(rect.x + 30, rect.y + rect.height / 2);
    for (const delta of [-750, -750, -750, 350]) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(200);
      const evidence = await sampleCompletedWidgetScroll(page, 150);
      await context.writeArtifactJson(`completed-wheel-${delta}-${evidence.samples[0].time}.json`, evidence);
      const settled = evidence.samples.slice(30);
      const drift = Math.max(...settled.map(sample => sample.top)) - Math.min(...settled.map(sample => sample.top));
      assert.ok(drift <= 3, `Completed production conversation drifted ${drift}px after the wheel stopped`);
      assert.ok(settled.every(sample => sample.height - sample.viewport - sample.top > 80), 'Completed history was pulled back to the bottom');
    }
    }
    delayedReads.enabled = true;
    await context.writeArtifactJson('before-reload-storage.json', { profileFiles: await readdir(context.pathInState('profile'), { recursive: true }), threadLists: delayedReads.threadLists });
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.reload();
    await page.getByText('COMPLETED_WIDGET_HISTORY_END', { exact: true }).waitFor({ timeout: 45000 });
    await page.waitForFunction(({ expected, failed }) => {
      const widgets = [...document.querySelectorAll('[data-testid="inline-widget"]')];
      return failed ? new Set(widgets.map(node => node.dataset.widgetId)).size === expected : widgets.length === expected;
    }, { expected: count, failed: failedChart });
    if (failedChart) await page.locator('[data-testid="inline-widget"][data-widget-status="error"]').first().waitFor();
    else await page.getByTestId('inline-widget-frame').first().waitFor();
    await page.waitForTimeout(600);
    await context.writeArtifactJson('completed-restored-before-scroll.json', await sampleCompletedWidgetScroll(page, 90));
    const restored = await owner.boundingBox(); assert.ok(restored);
    await page.mouse.move(restored.x + 30, restored.y + restored.height / 2);
    for (let index = 0; index < 12; index++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(250);
      const evidence = await sampleCompletedWidgetScroll(page, 60);
      await context.writeArtifactJson(`completed-restored-late-content-${index}.json`, { ...evidence, artifactLatencyMs: 450, delayedReplies: delayedReads.delayed });
      const drift = Math.max(...evidence.samples.map(sample => sample.top)) - Math.min(...evidence.samples.map(sample => sample.top));
      assert.ok(drift <= 3, `Restored production conversation drifted ${drift}px after scrolling stopped`);
      assert.ok(evidence.samples.every(sample => sample.widgets.filter(widget => widget.iframe).length <= 3), 'A pane must retain its three-frame execution budget');
    }
    await page.getByTestId('scroll-to-bottom-button').click();
    await page.waitForFunction(() => {
      const scroll = document.querySelector('[data-testid="desktop-workbench-content"]');
      return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 3;
    });
    await editor.click(); await page.keyboard.insertText('COMPOSER_STAYS_EDITABLE');
    assert.match(await editor.innerText(), /COMPOSER_STAYS_EDITABLE/);
    if (!failedChart) {
      await owner.evaluate(node => { node.scrollTop = 0; });
      const first = page.getByTestId('inline-widget').first();
      const tallFrame = first.getByTestId('inline-widget-frame');
      await tallFrame.waitFor({ timeout: 20000 });
      await page.waitForFunction(() => document.querySelector('[data-testid="inline-widget"] iframe')?.clientHeight > 1200);
      const geometry = await tallFrame.boundingBox();
      assert.ok(geometry.height > 1200, 'The production host must show the full tall visualization');
      await context.writeArtifactJson('full-height-production-widget.json', { height: geometry.height, externalOwner: 'desktop-workbench-content', capped: false });
      await page.setViewportSize({ width: 1280, height: Math.ceil(geometry.height) + 500 });
      await owner.evaluate(node => { node.scrollTop = 0; });
      await page.waitForTimeout(200);
      await page.screenshot({ path: context.pathInArtifacts('full-height-production-widget.png'), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 820 });
    }
    assert.equal(model.requests.length, 2);
    return { externalProductionOwner: true, completedWidgets: count, failedChart, modelCalls: 0, providerRequests: model.requests.length };
  } catch (error) {
    await context.writeArtifactJson('restore-observation.json', { profileFiles: await readdir(context.pathInState('profile'), { recursive: true }).catch(() => []), threadLists: delayedReads.threadLists, pageText: (await page.locator('body').innerText().catch(() => '')).slice(0, 20000) });
    await context.writeArtifactJson('provider-observed.json', { requests: model.requests.length,
      toolResults: (model.requests.at(-1)?.messages ?? []).filter(message => message.role === 'tool').map(message => ({ content: JSON.stringify(message.content).slice(0, 1600) })) });
    await context.writeArtifactJson('production-failure.json', await sampleCompletedWidgetScroll(page, 30).catch(() => ({ unavailable: true })));
    await page.screenshot({ path: context.pathInArtifacts('production-failure.png') }).catch(() => {});
    throw error;
  } finally { await page.close(); }
});
