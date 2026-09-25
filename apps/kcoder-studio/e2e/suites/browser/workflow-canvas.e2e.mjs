import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  const restoredCanvasFits = async () => {
    await waitFor(async () => {
      const bounds = await page.getByTestId('workflow-canvas').boundingBox();
      const nodes = await Promise.all(['A','B'].map(id=>page.getByTestId(`workflow-node-${id}`).boundingBox()));
      return bounds && bounds.height >= 500 && nodes.every(node=>node && node.width >= 150 && node.x >= bounds.x && node.y >= bounds.y && node.x+node.width <= bounds.x+bounds.width+2 && node.y+node.height <= bounds.y+bounds.height+2);
    },10000,'restored readable canvas fills its pane and fits nodes');
  };
  let phase = 'open';
  try {
    await page.goto(gateway.baseUrl);
    await page.getByTestId('workflows-button').click();
    await page.getByTestId('workflow-workspace').waitFor();
    await page.getByTestId('workflow-create').click();
    await page.getByTestId('composer-workflow-mode').waitFor();
    await waitFor(async () => await page.getByTestId('composer-workflow-mode').getAttribute('aria-pressed') === 'true',10000,'workflow intent from library');
    await page.getByTestId('projects-create-button').click();
    await page.getByTestId('project-create-local-option').click();
    const picker = page.getByTestId('standalone-folder-project-dialog');
    await picker.getByTestId('device-folder-path-input').fill(workspace);
    await picker.getByTestId('device-folder-path-input').press('Enter');
    await page.waitForTimeout(300);
    await picker.getByTestId('confirm-device-folder-picker-button').click();
    await page.getByTestId('local-project-create-name-input').fill('Workflow UI project');
    await page.getByTestId('confirm-local-project-create-button').click();
    await page.getByTestId('local-project-create-dialog').waitFor({state:'detached'});
    const mode = page.getByTestId('composer-workflow-mode');
    await mode.waitFor();
    assert.equal(await mode.getAttribute('aria-pressed'),'true','choosing a project must preserve workflow intent');
    const editor = page.getByTestId('chat-message-input');
    await editor.click(); await page.keyboard.insertText('Build A, then B depending on A.');
    phase = 'generate-first-node';
    await page.getByTestId('send-message-button').click();
    await Promise.race([fixture.firstNode, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('No first-node protocol receipt')), 30000); timeout.unref(); })]);
    await page.getByTestId('workflow-node-A').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('workflow-conversation-canvas').waitFor();
    await page.getByTestId('message-user').filter({hasText:'Build A, then B depending on A.'}).waitFor();
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
    await page.getByTestId('message-assistant').filter({hasText:'WORKFLOW_GENERATION_DONE'}).waitFor({ timeout: 15000 });
    await page.reload();
    await page.getByTestId('workflow-conversation-canvas').waitFor();
    await page.getByTestId('workflow-node-B').waitFor();
    await restoredCanvasFits();
    phase = 'publish';
    await page.getByTestId('workflow-conversation-publish').click();
    await waitFor(async () => (await page.getByTestId('workflow-conversation-canvas').innerText()).includes('v1'), 10000, 'published version');
    assert.equal(fixture.observations.filter(item => item.kind === 'agent').length, 0, 'generation and publication cannot execute nodes');
    await page.screenshot({ path: context.pathInArtifacts('published-canvas.png') });
    const generatedConversationUrl = page.url();
    await page.goto(`${gateway.baseUrl}/settings`);
    await page.getByTestId('settings-nav-appearance').click();
    await page.getByTestId('appearance-mode-dark').click();
    await page.goto(generatedConversationUrl);
    await page.getByTestId('workflow-conversation-canvas').waitFor();
    await page.getByTestId('workflow-node-B').waitFor();
    await restoredCanvasFits();
    await page.screenshot({path:context.pathInArtifacts('conversation-canvas-dark.png')});

    phase = 'reuse';
    await page.getByTestId('workflows-button').click();
    await page.locator('button[data-testid^="workflow-library-"]').filter({hasText:'Build A, then B depending on A.'}).click();
    await page.getByTestId('workflow-run-settings-toggle').click();
    await page.getByTestId('workflow-execution-workspace').fill(workspace);
    await page.getByTestId('workflow-run').click();
    await waitFor(async () => (await page.getByTestId('chat-message-input').innerText()).includes('definition_id'), 10000, 'saved reference prefilled');
    assert.equal(fixture.observations.filter(item => item.kind === 'agent').length, 0, 'opening a reusable workflow cannot execute it');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('message-assistant').filter({ hasText: 'WORKFLOW_REUSE_DONE' }).waitFor({ timeout: 45000 });
    await waitFor(() => fixture.observations.filter(item => item.kind === 'agent').length >= 2, 10000, 'actual node agents');
    assert.equal(fixture.observations.filter(item => item.kind === 'error').length, 0, JSON.stringify(fixture.observations));
    assert.equal(fixture.observations.filter(item => item.kind === 'agent' && item.node === 'A').length, 1);
    assert.equal(fixture.observations.filter(item => item.kind === 'agent' && item.node === 'B').length, 1);
    assert.ok(fixture.observations.some(item => item.kind === 'saved-run' && item.version === 1));
    phase = 'reuse-in-existing-conversation';
    const existingUrl = page.url();
    const existingEditor = page.getByTestId('chat-message-input');
    await existingEditor.click(); await page.keyboard.insertText('Keep this requirement.');
    await page.getByTestId('workflow-reuse-open').click();
    const reuse = page.getByTestId('workflow-reuse-picker');
    await reuse.getByRole('button', {name:/Build A, then B depending on A/}).click();
    await page.getByTestId('workflow-reuse-insert').click();
    await waitFor(async () => (await existingEditor.innerText()).includes('definition_id'),10000,'inserted saved workflow');
    assert.ok((await existingEditor.innerText()).includes('Keep this requirement.'));
    assert.equal(page.url(),existingUrl,'reuse must stay in the existing conversation');
    assert.equal(fixture.observations.filter(item => item.kind==='agent').length,2,'inserting cannot execute');
    await page.screenshot({path:context.pathInArtifacts('reuse-existing-conversation.png')});
    await page.getByTestId('send-message-button').click();
    await waitFor(() => fixture.observations.filter(item => item.kind==='agent').length === 4,30000,'second execution in existing thread');
    await waitFor(async () => await page.getByTestId('message-assistant').filter({hasText:'WORKFLOW_REUSE_DONE'}).count() >= 2,15000,'second workflow result');
    assert.equal(page.url(),existingUrl,'sending reuse cannot create a new conversation');
    phase = 'run-observability';
    await page.getByTestId('workflows-button').click();
    await page.locator('button[data-testid^="workflow-library-"]').filter({hasText:'Build A, then B depending on A.'}).click();
    await page.getByTestId('workflow-run-history-toggle').click();
    await page.getByTestId('workflow-run-history').getByText('已完成', {exact:true}).first().waitFor({timeout:15000});
    await page.getByTestId('workflow-run-history').getByRole('button', {name:'查看输出'}).first().click();
    await page.getByTestId('workflow-run-history').locator('pre').filter({hasText:'WF_NODE_A_RESULT'}).waitFor();
    phase = 'immutable-version-and-portability';
    const actions = page.getByTestId('workflow-library-actions');
    await actions.getByRole('combobox').selectOption('1');
    await page.getByTestId('workflow-node-A').waitFor();
    assert.equal(await page.getByTestId('workflow-add-node').isDisabled(), true);
    await page.getByTestId('workflow-node-A').click();
    assert.equal(await page.getByTestId('workflow-node-editor').count(), 0);
    const downloadPromise = page.waitForEvent('download');
    await actions.getByRole('button', {name:'导出', exact:true}).click();
    const download = await downloadPromise;
    const exported = context.pathInState('exported-workflow.json');
    await download.saveAs(exported);
    await page.getByTestId('workflow-import-file').setInputFiles(exported);
    await page.getByTestId('workflow-node-A').waitFor();
    await waitFor(async () => (await page.getByTestId('workflow-revision').innerText()).includes('r1'),10000,'imported independent draft');
    assert.equal(await page.getByTestId('workflow-run').isDisabled(),true,'import never republishes a historical version');
    phase = 'semantic-node-colors';
    const portable = JSON.parse(await readFile(exported,'utf8'));
    const kinds = ['input','agent','template','condition','merge','loop','output'];
    const configs = {input:{pointer:'/input'},agent:{},template:{template:'{{/input}}'},condition:{condition:{op:'exists',pointer:'/input'}},merge:{mergePolicy:'all'},loop:{loop:{mode:'repeat',maxIterations:3}},output:{pointer:'/input'}};
    portable.title = 'Seven semantic node types';
    portable.nodes = kinds.map((kind,index)=>({id:kind,kind,title:kind,prompt:'Palette fixture',agentType:'general',maxTurns:5,dependsOn:index?[kinds[index-1]]:[],position:{x:index%3*260,y:Math.floor(index/3)*155},allowedWritePaths:[],acceptanceCriteria:[],expectedArtifacts:[],config:configs[kind]}));
    await context.writeStateJson('palette-workflow.json',portable);
    await page.getByTestId('workflow-import-file').setInputFiles(context.pathInState('palette-workflow.json'));
    await page.getByTestId('workflow-node-output').waitFor();
    await page.getByTestId('workflow-fit').click();
    await page.getByTestId('workflow-canvas').screenshot({path:context.pathInArtifacts('seven-node-types-dark.png')});
    await page.goto(`${gateway.baseUrl}/settings`);
    await page.getByTestId('settings-nav-appearance').click();
    await page.getByTestId('appearance-mode-light').click();
    await page.goto(`${gateway.baseUrl}/workflows`);
    await page.getByRole('button',{name:/Seven semantic node types/}).click();
    await page.getByTestId('workflow-node-output').waitFor();
    await page.getByTestId('workflow-fit').click();
    await page.getByTestId('workflow-canvas').screenshot({path:context.pathInArtifacts('seven-node-types-light.png')});
    await context.writeArtifactJson('workflow-observations.json', fixture.observations);
    return { incrementalNodes: true, canvasStayedOpen: true, publishedWithoutExecution: true, savedVersionReused: 1 };
  } catch (error) {
    await context.writeArtifactJson('failure.json', { phase, observations: fixture.observations, body: (await page.locator('body').innerText()).slice(0, 12000) });
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    throw error;
  }
});
