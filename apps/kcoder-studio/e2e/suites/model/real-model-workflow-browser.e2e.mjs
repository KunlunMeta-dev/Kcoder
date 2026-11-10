import assert from 'node:assert/strict';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startLiveModelObserver } from '../../harness/live-model-observer.mjs';
import { prepareIsolatedRealModelConfig, realModelPreflight } from '../../harness/real-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, {
  testId: 'real-workflow-browser-author-publish-restart-execute', tier: 'credentialed-integration',
  retainSuccessLogs: true,
  modelPolicy: 'Real model through the normal composer; one authoring turn, two executions, 24 requests, 4096 output tokens/request, no retries, 180s/turn. Private state only.',
}, async context => {
  await assertRendererBuildFresh();
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || 'kunlunmeta');
  const isolated = await prepareIsolatedRealModelConfig(context, model);
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'workflow-browser' });
  let releaseGeneration, heldGeneration, generationRequests = 0;
  const generationGate = new Promise(resolve => { releaseGeneration = resolve; });
  const generationHeld = new Promise(resolve => { heldGeneration = resolve; });
  const observer = await startLiveModelObserver(context, model.providerConfig.endpoint, 24, {
    beforeForward: async metadata => {
      if (!metadata.exposedToolNames.includes('WorkflowDraft')) return;
      assert.ok(++generationRequests <= 14, 'Real authoring request budget');
      if (generationRequests !== 2) return;
      heldGeneration();
      let timer;
      try { await Promise.race([generationGate, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Browser did not release the real authoring request')), 45000);
      })]); } finally { clearTimeout(timer); }
    },
  });
  context.addCleanup('release held real authoring request', () => releaseGeneration());
  const settings = await context.writeStateJson('workflow-settings.json', {
    active_provider: model.provider, model: model.model, tools: { profile: 'full', disabled: [] },
    permission_mode: 'bypass', max_retries: 0, max_duration_secs: 180,
    providers: { [model.provider]: { ...model.providerConfig, endpoint: observer.endpoint, no_proxy: true,
      default_model: model.model, discover_models: false, max_output_tokens: 4096,
      models: { [model.model]: { ...model.providerConfig.models?.[model.model], max_output_tokens: 4096 } } } },
    session_memory: { enabled: false },
  }, 0o400);
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Workflow acceptance',
    transport: 'local', command: model.kcoderBin, workspace, settingsFile: settings, profile: model.profile }]);
  const credentialEnv = Object.fromEntries(model.credentialEnv.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const gatewayOptions = { workspace, serversFile, kcoderBin: model.kcoderBin, auth: true,
    env: { KCODER_CONFIG_DIR: isolated.configDir,
      KCODER_STUDIO_DATA_DIR: context.pathInState('studio-data'), ...credentialEnv } };
  let gateway = await startGateway(context, gatewayOptions);
  const browser = await startChromium(context);
  const page = await browser.newPersistentPage();
  await page.setViewportSize({ width: 1560, height: 1000 });
  context.addCleanup('close workflow acceptance page', () => page.close());
  const pageErrors = [], wire = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', event => {
    try { const frame = JSON.parse(String(event.payload)); if (frame.method)
      wire.push({ method: frame.method, threadId: frame.params?.threadId }); } catch { /* No raw frames are retained. */ }
  }));
  const control = (method, params = {}) => page.evaluate(({ method, params }) =>
    window.__KCODER_STUDIO_E2E__.invokeRuntimeCommand('local_executor_request', { method, params }), { method, params });
  const workflow = (method, params = {}) => control('runtime.workflows.request', { serverId: 'local', workspacePath: workspace, method, params });
  const open = async url => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).pathname === '/login') {
      await page.locator('input[name="token"]').fill(gateway.authToken);
      await Promise.all([page.waitForURL(value => value.pathname !== '/login'), page.locator('button[type="submit"]').click()]);
    }
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 30000 });
  };
  const send = async text => {
    const editor = page.getByTestId('chat-message-input');
    await editor.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text);
    await page.getByTestId('send-message-button').click();
  };
  let phase = 'setup-project', draftId, authoringTaskId;
  const runs = [];
  try {
    await open(gateway.baseUrl);
    assert.equal(await page.evaluate(() => typeof window.__KCODER_STUDIO_E2E__?.invokeRuntimeCommand), 'function');
    await control('runtime.projects.upsert_local', { deviceId: 'local', projectKey: 'workflow-acceptance', name: 'Workflow acceptance', roots: [workspace] });
    await page.reload();
    const project = page.getByTestId('project-item').filter({ hasText: 'Workflow acceptance' }).first();
    await project.getByTestId('project-new-conversation-button').click();
    await page.getByTestId('composer-workflow-mode').click();
    phase = 'real-authoring';
    await send('创建“资料研究与报告生成”工作流草稿。只设计，不保存版本、不执行节点、不联网。恰好两个 Code 节点，ID 为 A 和 B，B 依赖 A。输入 JSON Schema 的 records 为数组，每项包含 label:string 和 value:number；默认值为 [{"label":"甲","value":3},{"label":"乙","value":4}]。A 读取 input.records，返回 total（value 之和）和 count。B 读取 nodes.A，返回 total 及 report（包含“资料报告”和实际合计数字的 Markdown 字符串）。B 配置 resultCheck，要求 total 与 nodes.A.total 相等、report 为包含该数字的字符串。使用当前绑定的原草稿，保留数值类型。完成草稿后停止，交给页面保存。');
    let generationTimer;
    try {
      await Promise.race([generationHeld, new Promise((_, reject) => {
        generationTimer = setTimeout(() => reject(Error('Real model did not enter the authoring tool loop')), 90000);
      })]);
    } finally { clearTimeout(generationTimer); }
    authoringTaskId = await waitFor(() => new URL(page.url()).searchParams.get('taskId'), 10000, 'original authoring task');
    const authoringUrl = page.url();
    const peer = await browser.newPersistentPage();
    try {
      await peer.goto(authoringUrl);
      await peer.getByTestId('desktop-sidebar').waitFor({ timeout: 20000 });
      await waitFor(async () => (await control('runtime.tasks.lifetime.read', { taskId: authoringTaskId })).attachedClients >= 2,
        15000, 'peer attached before navigation');
      await page.goto(`${gateway.baseUrl}/workflows`);
      await page.waitForTimeout(4200);
      await open(authoringUrl);
      await waitFor(async () => (await control('runtime.tasks.lifetime.read', { taskId: authoringTaskId })).attachedClients >= 2,
        15000, 'restored real authoring view and peer both attached');
    } finally { await peer.close(); releaseGeneration(); }
    phase = 'generated-canvas';
    await page.getByTestId('workflow-node-A').waitFor({ timeout: 180000 });
    await page.getByTestId('workflow-node-B').waitFor({ timeout: 180000 });
    await waitFor(async () => !(await page.getByTestId('pause-response-button').count()), 180000, 'original authoring turn settles');
    const listed = await workflow('workflow/list');
    const drafts = listed.items;
    assert.equal(drafts.length, 1, 'One user authoring request creates one draft');
    draftId = drafts[0].id;
    const draft = await workflow('workflow/read', { id: draftId });
    assert.deepEqual(draft.nodes.map(node => node.id).sort(), ['A', 'B']);
    assert.ok(draft.nodes.every(node => node.kind === 'code'));
    assert.deepEqual(draft.nodes.find(node => node.id === 'B').dependsOn, ['A']);
    assert.equal(new URL(page.url()).searchParams.get('taskId'), authoringTaskId);
    assert.equal((await workflow('workflow/runs/list', { definitionId: draftId })).items.length, 0, 'Authoring cannot execute nodes');
    await page.screenshot({ path: context.pathInArtifacts('real-generated-canvas.png') });
    phase = 'publish-and-restart';
    await page.getByTestId('workflow-conversation-publish').click();
    const saved = await waitFor(async () => {
      const value = await workflow('workflow/read', { id: draftId }); return value.savedVersion === 1 ? value : null;
    }, 15000, 'immutable saved version');
    assert.equal(saved.nodes.find(node => node.id === 'B').config.resultCheck?.source?.length > 0, true);
    const route = new URL(authoringUrl);
    await context.stopOwned('gateway');
    gateway = await startGateway(context, { ...gatewayOptions, label: 'gateway-restored' });
    await open(gateway.baseUrl + route.pathname + route.search);
    await page.getByTestId('workflow-node-B').waitFor({ timeout: 30000 });
    assert.equal(new URL(page.url()).searchParams.get('taskId'), authoringTaskId);
    assert.deepEqual((await workflow('workflow/read', { id: draftId })).nodes, saved.nodes);
    await page.screenshot({ path: context.pathInArtifacts('real-canvas-after-backend-restart.png') });
    phase = 'execute-saved-version';
    await page.locator('[data-status-item="workflows"] > button[aria-expanded="false"]').click();
    await page.getByTestId('workflow-card-use').click();
    let executionTaskId;
    for (const [values, expected] of [[[3, 4], 7], [[5, 6], 11]]) {
      const before = new Set((await workflow('workflow/runs/list', { definitionId: draftId })).items.map(run => run.runId));
      await send(`执行保存的工作流，不修改定义；等待原运行完成并返回结果。${JSON.stringify({ definition_id: draftId, version: 1,
        args: { records: values.map((value, index) => ({ label: String(index), value })) } })}`);
      const run = await waitFor(async () => {
        const list = await workflow('workflow/runs/list', { definitionId: draftId });
        const item = list.items.find(value => !before.has(value.runId));
        if (!item) return null;
        const value = await workflow('workflow/runs/read', { runId: item.runId });
        assert.ok(!['failed', 'cancelled'].includes(value.status), JSON.stringify({ status: value.status, error: value.error }));
        return value.status === 'completed' ? value : null;
      }, 180000, 'real selected version completes');
      const output = JSON.parse(run.nodeStates.find(node => node.nodeId === 'B').outputPreview);
      assert.equal(output.total, expected); assert.match(output.report, /资料报告/); assert.ok(output.report.includes(String(expected)));
      const evidence = await workflow('workflow/verification/read', { id: draftId, version: 1 });
      const receipt = evidence.runs.find(value => value.runId === run.runId);
      assert.equal(receipt.executionStatus, 'completed'); assert.equal(receipt.checkStatus, 'passed');
      await waitFor(async () => !(await page.getByTestId('pause-response-button').count()), 60000, 'parent turn settles');
      const currentTaskId = new URL(page.url()).searchParams.get('taskId');
      if (executionTaskId) assert.equal(currentTaskId, executionTaskId); else executionTaskId = currentTaskId;
      assert.notEqual(currentTaskId, authoringTaskId);
      runs.push({ runId: run.runId, total: output.total, checkStatus: receipt.checkStatus });
      await page.reload(); await page.getByTestId('workflow-execution-canvas').waitFor({ timeout: 30000 });
      await page.screenshot({ path: context.pathInArtifacts(`real-run-total-${expected}.png`) });
    }
    assert.equal((await workflow('workflow/read', { id: draftId })).savedVersion, 1);
    assert.deepEqual(pageErrors, []);
    assert.ok(observer.observations.length > 0 && observer.observations.every(value => value.status === 200));
    await context.writeArtifactJson('workflow-browser-acceptance.json', { realModel: true, model: model.model,
      authoringTaskId, executionTaskId, draftId, runs, generationViewHandoff: true, backendRestart: true,
      immutableVersion: 1, requests: observer.observations, noImplicitInterrupt: !wire.some(value => value.method === 'turn/interrupt'),
      scope: 'Actual Linux browser, Gateway, Native and real model; not Windows/Electron installed-package acceptance.' });
    assert.ok(!wire.some(value => value.method === 'turn/interrupt'));
    return { realModel: model.model, runs, restoredOriginalTask: true };
  } catch (error) {
    releaseGeneration();
    await context.writeArtifactJson('workflow-browser-failure.json', { phase, error: error.message, draftId, authoringTaskId,
      pageErrors, requests: observer.observations, wire, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 12000) });
    await page.screenshot({ path: context.pathInArtifacts('workflow-browser-failure.png') }).catch(() => {});
    throw error;
  }
});
