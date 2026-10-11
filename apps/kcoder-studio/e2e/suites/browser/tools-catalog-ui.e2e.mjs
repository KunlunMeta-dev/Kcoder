import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startToolsCatalogModelFixture, toolsCatalogMcpServer } from '../../harness/tools-catalog-fixture.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// QA: real browser/Gateway/Engine tool dispatch and metadata rendering. The
// fixed tool choice tests the wire/UI contract, not model selection quality.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'tools-catalog-real-session-rendering', tier: 'full-integration',
  modelPolicy: 'model-independent real HTTP tool dispatch and metadata UI',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'catalog-ui' });
  const model = await startToolsCatalogModelFixture(context);
  const settingsFile = await context.writeStateJson('catalog-settings.json', {
    active_provider: 'catalog-fixture', permission_mode: 'yolo',
    mcp_servers: [toolsCatalogMcpServer()],
    providers: { 'catalog-fixture': {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'catalog-fixture', context_window_tokens: 512000,
      output_headroom_tokens: 8192, max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true,
    } },
  });
  await context.writeStateJson('config/settings.json', {});
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local', label: 'Catalog fixture', transport: 'local',
    command: resolve(repoRoot, 'target/debug/kcoder'), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    workspace, serversFile, env: { KCODER_CONFIG_DIR: context.pathInState('config') },
  });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  const runtimeEvents = [];
  let catalog = null;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    try {
      const frame = JSON.parse(String(payload));
      if (frame.method) runtimeEvents.push({ method: frame.method,
        itemType: frame.params?.item?.type, itemId: frame.params?.item?.id,
        toolName: frame.params?.item?.name, turnId: frame.params?.turnId,
        eventType: frame.params?.event?.type });
      if (frame.result?.cachePolicy === 'no-store' && frame.result?.scope === 'thread') catalog = frame.result;
    } catch { /* Ignore non-JSON frames; protocol errors are tested separately. */ }
  }));
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 30000 });
    const project = page.getByTestId('project-item').filter({ hasText: 'Catalog fixture' }).first();
    await project.waitFor({ timeout: 30000 });
    await project.hover();
    await project.getByTestId('project-new-conversation-button').click();
    await page.getByTestId('chat-message-input').click();
    await page.keyboard.insertText('Verify the configured tool catalog.');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('message-assistant').getByText('CATALOG_UI_DONE', { exact: true }).last().waitFor({ timeout: 45000 });
    await waitFor(() => catalog?.tools?.some(tool => tool.name === 'TaskList'), 15000, 'thread catalog response', 100, context.abortSignal);
    const tool = catalog.tools.find(tool => tool.name === 'TaskList');
    assert.equal(catalog.truncated, true);
    assert.equal(catalog.tools.length, 512);
    assert.ok(catalog.total >= 520);
    const notice = page.getByTestId('tools-catalog-truncation');
    await notice.waitFor({ timeout: 15000 });
    assert.equal(await notice.count(), 1);
    assert.ok((await notice.innerText()).includes(`512 / ${catalog.total}`));
    const finalToggle = page.getByTestId('message-assistant').last().getByTestId('final-processing-toggle');
    await finalToggle.waitFor({ timeout: 15000 });
    if (await finalToggle.getAttribute('aria-expanded') !== 'true') await finalToggle.click();
    const toggle = page.getByTestId('processing-summary-toggle').last();
    if (await toggle.count() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const row = page.getByTestId('message-assistant').last().locator('[data-processing-block-id]').filter({ hasText: tool.displayName }).first();
    await row.waitFor({ timeout: 15000 });
    await row.locator(`[data-tool-group="${tool.group}"]`).waitFor({ timeout: 15000 });
    await finalToggle.click();
    assert.equal(await finalToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await row.count(), 0, 'completed tools are unmounted inside the collapsed final summary');
    await finalToggle.click();
    await row.waitFor({ timeout: 15000 });
    assert.ok(model.requests.some(request => request.messages?.some(message => message.role === 'tool')), 'real tool result must return to the provider');
    for (const definition of model.requests[0].tools ?? []) {
      const shape = definition.function ?? definition;
      for (const field of ['displayName', 'group', 'icon']) assert.equal(Object.hasOwn(shape, field), false);
    }
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: context.pathInArtifacts('catalog-ui.png'), fullPage: true });
    return { realToolExecuted: true, sessionMetadataRendered: true, modelSchemaUnchanged: true,
      catalogTruncationVisible: true, catalogTotal: catalog.total, catalogShown: catalog.tools.length,
      successScreenshotReason: 'critical tool catalog metadata rendered from a resident session' };
  } catch (error) {
    await context.writeArtifactJson('catalog-ui-failure.json', { error: String(error), pageErrors,
      body: (await page.locator('body').innerText()).slice(0, 12000), catalogReceived: Boolean(catalog),
      runtimeEvents,
      finalProcessing: await page.getByTestId('final-processing-toggle').evaluateAll(nodes => nodes.map(node => ({ expanded: node.getAttribute('aria-expanded'), text: node.textContent }))),
      processingHtml: await page.getByTestId('processing-summary-header').evaluateAll(nodes => nodes.map(node => node.outerHTML)),
      requests: model.requests.map(request => ({
        hasTools: Boolean(request.tools?.length),
        hasTaskList: request.tools?.some(tool => (tool.function ?? tool).name === 'TaskList'),
        roles: request.messages?.map(message => message.role),
      })),
    });
    await page.screenshot({ path: context.pathInArtifacts('catalog-ui-failed.png'), fullPage: true }).catch(() => {});
    throw error;
  }
});
