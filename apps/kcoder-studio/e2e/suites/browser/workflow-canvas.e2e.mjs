import assert from 'node:assert/strict';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startWorkflowModelFixture } from '../../harness/workflow-model.mjs';

// QA: real browser/HTTP provider/tool/store/quickjs protocol; the deterministic
// fixture is not evidence of model planning quality. All state is run-owned.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'workflow-canvas-incremental-generation-publish-and-saved-version-reuse',
  tier: 'full-integration', modelPolicy: 'model-independent real tool and UI protocol with a gated loopback provider',
  retainSuccessLogs: true,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const fixture = await startWorkflowModelFixture(context);
  context.registerSecret('workflow-local-fixture');
  await context.writeStateJson('config/settings.json', {
    active_provider: 'workflow-ui', max_retries: 0, permission_mode: 'bypass', tools: { profile: 'full' },
    providers: { 'workflow-ui': { api_format: 'openai_chat_completions', endpoint: fixture.baseUrl,
      default_model: 'workflow-ui', context_window_tokens: 128000, max_output_tokens: 4096,
      output_headroom_tokens: 8192, request_timeout_secs: 60, no_proxy: true } },
  });
  await context.writeStateJson('config/credentials.json', { 'workflow-ui': { type: 'api', key: 'workflow-local-fixture' } });
  const gateway = await startGateway(context, { workspace, env: { KCODER_CONFIG_DIR: context.pathInState('config') } });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
  let phase = 'open';
  try {
    await page.goto(gateway.baseUrl);
    await page.getByTestId('workflows-button').click();
    await page.getByTestId('workflow-workspace').waitFor();
    await page.getByTestId('workflow-new-title').fill('Workflow UI fixture');
    await page.getByTestId('workflow-create').click();
    phase = 'invalid-draft-recovery';
    await page.getByTestId('workflow-execution-workspace').fill(workspace);
    assert.equal(await page.getByTestId('workflow-run').isDisabled(), true);
    await page.getByTestId('workflow-add-node').click();
    await page.getByTestId('workflow-node-editor').waitFor();
    await page.getByTestId('workflow-publish').click();
    await page.getByTestId('workflow-error').waitFor();
    assert.equal(await page.getByTestId('workflow-run').isDisabled(), true);
    assert.ok(!(await page.getByTestId('workflow-revision').innerText()).includes('v1'));
    await page.getByTestId('workflow-node-delete').click();
    await page.getByTestId('workflow-node-delete-confirm').click();
    await page.getByTestId('workflow-node-editor').waitFor({ state: 'hidden' });
    await page.getByTestId('workflow-requirement').fill('Build A, then B depending on A.');
    await page.getByTestId('workflow-execution-workspace').fill(workspace);
    phase = 'generate-first-node';
    await page.getByTestId('workflow-generate').click();
    await Promise.race([fixture.firstNode, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('No first-node protocol receipt')), 30000); timeout.unref(); })]);
    await page.getByTestId('workflow-node-A').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(new URL(page.url()).pathname, '/workflows', 'generation must keep the canvas open');
    assert.equal(await page.getByTestId('workflow-node-B').count(), 0);
    await page.screenshot({ path: context.pathInArtifacts('first-node-before-second.png') });
    fixture.releaseSecondNode();
    phase = 'second-node';
    await page.getByTestId('workflow-node-B').waitFor({ state: 'visible', timeout: 30000 });
    await waitFor(async () => await page.getByTestId('workflow-edge').count() === 1, 10000, 'dependency edge');
    await page.getByTestId('workflow-fit').click();
    const bounds = await page.getByTestId('workflow-canvas').boundingBox();
    for (const id of ['A', 'B']) {
      const node = await page.getByTestId(`workflow-node-${id}`).boundingBox();
      assert.ok(node && bounds && node.x >= bounds.x && node.y >= bounds.y && node.x + node.width <= bounds.x + bounds.width + 2 && node.y + node.height <= bounds.y + bounds.height + 2);
    }
    await page.getByTestId('workflow-generation-status').filter({ hasText: '生成已完成' }).waitFor({ timeout: 15000 });
    phase = 'publish';
    await page.getByTestId('workflow-publish').click();
    await waitFor(async () => (await page.getByTestId('workflow-revision').innerText()).includes('v1'), 10000, 'published version');
    assert.equal(fixture.observations.filter(item => item.kind === 'agent').length, 0, 'generation and publication cannot execute nodes');
    await page.screenshot({ path: context.pathInArtifacts('published-canvas.png') });
    phase = 'reuse';
    await page.reload();
    await page.getByRole('button', { name: /Workflow UI fixture/ }).click();
    await page.getByTestId('workflow-execution-workspace').fill(workspace);
    await page.getByTestId('workflow-run').click();
    await page.getByTestId('message-assistant').filter({ hasText: 'WORKFLOW_REUSE_DONE' }).waitFor({ timeout: 45000 });
    await waitFor(() => fixture.observations.filter(item => item.kind === 'agent').length >= 2, 10000, 'actual node agents');
    assert.equal(fixture.observations.filter(item => item.kind === 'error').length, 0, JSON.stringify(fixture.observations));
    assert.equal(fixture.observations.filter(item => item.kind === 'agent' && item.node === 'A').length, 1);
    assert.equal(fixture.observations.filter(item => item.kind === 'agent' && item.node === 'B').length, 1);
    assert.ok(fixture.observations.some(item => item.kind === 'saved-run' && item.version === 1));
    await context.writeArtifactJson('workflow-observations.json', fixture.observations);
    return { incrementalNodes: true, canvasStayedOpen: true, publishedWithoutExecution: true, savedVersionReused: 1 };
  } catch (error) {
    await context.writeArtifactJson('failure.json', { phase, observations: fixture.observations, body: (await page.locator('body').innerText()).slice(0, 12000) });
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    throw error;
  }
});
