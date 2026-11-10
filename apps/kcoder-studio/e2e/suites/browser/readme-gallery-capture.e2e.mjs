import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startSourceDesktop } from '../../harness/source-desktop.mjs';
import { waitForSelectedModel } from '../../harness/model-selector.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';

import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { captureCurrentReadmeGallery } from './readme-current-gallery.mjs';

// Documentation captures use actual Electron/Gateway/Engine with isolated sample
// records. Fixed model replies populate the gallery, not model-quality evidence.
const settledOnly = process.env.KCODER_E2E_GALLERY_FOCUS === 'current-ui-settled';
const renameOnly = process.env.KCODER_E2E_GALLERY_FOCUS === 'sidebar-rename';
const readmeOnly = process.env.KCODER_E2E_GALLERY_FOCUS === 'readme';
const focused = readmeOnly || settledOnly || renameOnly || process.env.KCODER_E2E_GALLERY_FOCUS === 'current-ui';
const sourceText = '# 对话与工作流\n\n你可以在会话里描述任务、查看工具结果并追加指令。\n工作流可以保存版本，供其它会话复用。\n\n# Wiki与原文引用\n\nWiki 保存原始资料，并将知识页面与原文引用关联起来。';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'readme-current-product-gallery', tier: 'manual-live',
  modelPolicy: 'Interface captures with isolated demonstration data; no real-model quality claim',
  retainSuccessLogs: true,
}, async context => {
  let releaseAgent;
  const agentGate = new Promise(done => { releaseAgent = done; });
  context.addCleanup('release gallery agent', () => releaseAgent());
  let childCalls = 0;
  let modelRequests = 0;
  const wikiInputs = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'POST') modelRequests++;
      let text = ''; for await (const part of request) text += part;
      const body = JSON.parse(text);
      const message = body.messages.filter(item => item.role === 'user').at(-1);
      const userText = typeof message.content === 'string' ? message.content : message.content.map(block => block.text || '').join('');
      if (renameOnly) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ id: 'rename-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: '会话已准备好。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
        return;
      }
      if (!userText.trim().startsWith('{')) {
        const users = body.messages.filter(item => item.role === 'user').map(item => typeof item.content === 'string' ? item.content : item.content.map(block => block.text || '').join('')).join('\n');
        const child = users.includes('只读梳理示例项目目录与模块。');
        const finish = (delta, finishReason) => response.end('data: ' + JSON.stringify({ id: 'gallery-chat', choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\ndata: [DONE]\n\n');
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (child && ++childCalls === 1) return finish({ role: 'assistant', content: '我先读取目录，确认源码和测试的位置。', tool_calls: [{ index: 0, id: 'gallery-glob', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '**/*', limit: 30 }) } }] }, 'tool_calls');
        if (child) {
          response.write('data: ' + JSON.stringify({ id: 'gallery-chat', choices: [{ index: 0, delta: { role: 'assistant', content: '## 项目结构\n\n- `src/`：程序实现\n- `tests/`：测试入口\n- `README.md`：使用说明\n\n### 接下来\n\n我正在检查模块关系和测试边界。' }, finish_reason: null }] }) + '\n\n');
          await agentGate; return finish({}, 'stop');
        }
        if (body.messages.some(item => item.role === 'tool')) return finish({ role: 'assistant', content: '子代理已经开始梳理项目，可以打开它的会话查看进度。' }, 'stop');
        return finish({ role: 'assistant', tool_calls: [{ index: 0, id: 'gallery-agent', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ message: '只读梳理示例项目目录与模块。', agent_type: 'general', context_mode: 'none', run_in_background: true, max_turns: 6 }) } }] }, 'tool_calls');
      }
      const input = JSON.parse(userText);
      wikiInputs.push(input);
      let output;
      if (input.repairKind === 'source_support') {
        const placements = input.candidate.organizationProof.placements;
        output = { sourceCoverage: 'complete', units: input.units.map(unit => ({ pageId: unit.pageId, unit: unit.unit, verdict: 'supported', citationIndices: unit.allowedCitationIndices })),
          organizationUnits: input.organizationInventory.units.map(unit => ({ unitId: unit.id, verdict: 'supported', placementIndices: placements.flatMap((placement, index) => placement.unitId === unit.id ? [index] : []) })) };
      } else if (!input.analysis) {
        output = { summary: '示例资料说明了会话、工作流复用和 Wiki 原文引用。', queries: ['工作流', 'Wiki'], conflicts: [],
          organizationPlan: { binding: input.sourceInventory.binding, units: input.sourceInventory.units.map(unit => ({ unitId: unit.id, disposition: ['heading', 'table_header'].includes(unit.kind) ? 'context' : 'required', purposeAspectIds: ['heading', 'table_header'].includes(unit.kind) ? [] : input.sourceInventory.aspects.map(aspect => aspect.id), reason: ['heading', 'table_header'].includes(unit.kind) ? '资料中的原始章节标题。' : '' })) } };
      } else if (input.pipeline?.nodeId?.startsWith('topic-plan')) {
        const units = input.sourceInventory.units.filter(unit => !['heading', 'table_header'].includes(unit.kind));
        output = { topics: input.newPageIds.slice(0, 2).map((id, index) => ({
          pageId: id, kind: 'concept', title: index ? 'Wiki与原文引用' : '对话与工作流',
          unitIds: units.filter((_, at) => at === index).map(unit => unit.id),
        })), reviewNotes: [] };
      } else if (input.selectedTopic) {
        const topic = input.selectedTopic;
        const units = input.sourceInventory.units.filter(unit => topic.unitIds.includes(unit.id));
        const refs = [...new Set(units.flatMap(unit => [unit.reference, ...unit.contextRefs]))];
        output = { pages: [{ pageId: topic.pageId, expectedRevision: null, kind: topic.kind, title: topic.title,
          markdown: topic.title === '对话与工作流' ? sourceText.split('\n\n# Wiki')[0] : '# Wiki' + sourceText.split('\n\n# Wiki')[1],
          citations: refs.map(ref => ({ ref })), relatedPageIds: [] }], reviewNotes: [] };
      } else {
        const refs = input.citationSpans.map(span => ({ ref: span.ref }));
        output = { pages: input.newPageIds.slice(0, Math.min(2, input.outputPolicy?.maxNewTopicPages ?? 2)).map((id, index) => ({ pageId: id, expectedRevision: null, kind: 'concept', title: index ? 'Wiki与原文引用' : '对话与工作流', markdown: sourceText, citations: refs, relatedPageIds: [] })), reviewNotes: [] };
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ id: 'gallery', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch { response.writeHead(500); response.end('Gallery fixture could not construct a response'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  context.registerPort('gallery-model', server.address().port);
  context.addCleanup('close gallery model', async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const profile = context.pathInState('profile');
  const workspaceFixture = await materializeWorkspace(context, 'minimal', { instanceId: 'gallery' });
  const workspace = workspaceFixture.path;
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  await context.writeStateJson('profile/settings.json', {
    active_provider: 'gallery', ...(renameOnly || readmeOnly ? { model: '示例模型' } : {}), ...(focused ? {} : { permission_mode: 'bypass' }), max_retries: 0,
    ...(focused ? { integrations: { office: { enabled: true }, knowledge: { memory_center_enabled: true, publications_enabled: true, business_automation_enabled: true } } } : {}),
    tools: { profile: 'full' }, knowledge: { enabled: true, retrieval_enabled: true, organization_enabled: true },
    providers: { gallery: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: `http://127.0.0.1:${server.address().port}/v1`, default_model: '示例模型', context_window_tokens: 262144,
      max_output_tokens: 8192, output_headroom_tokens: 8192, no_proxy: true, discover_models: !focused } },
  });
  await context.writeStateJson('profile/credentials.json', {});
  const servers = await context.writeStateJson('servers.json', [
    { id: 'local', label: '当前计算机', transport: 'local', command: binary, workspace },
  ]);
  const desktop = await startSourceDesktop(context, { label: 'readme-gallery', profile, servers, workspace, kcoderBin: binary });
  const { page } = desktop;
  const pageErrors = [];
  page.on('pageerror', error => { pageErrors.push(error.stack || error.message); });
  const origin = new URL(page.url()).origin;
  const client = {
    async command(action, args = {}) {
      if (action === 'navigate') { await page.goto(new URL(args.value, origin).href); return; }
      if (action === 'resizeWindow') { await page.setViewportSize({ width: 1440, height: 1000 }); return; }
      const locator = args.text ? page.locator(args.selector).filter({ hasText: args.text }) : page.locator(args.selector);
      if (action === 'waitFor') {
        await locator.first().waitFor({ state: 'visible', timeout: args.timeoutMs ?? 30000 });
        if (args.text) await expect(locator.first()).toContainText(args.text);
        if (args.enabled) await expect(locator.first()).toBeEnabled();
        return;
      }
      if (action === 'click') return locator.click();
      if (action === 'fill') return locator.fill(args.value);
      if (action === 'getElementMetrics') return JSON.stringify(await locator.evaluateAll(elements => elements.map(element => {
        const { left, right, top, bottom } = element.getBoundingClientRect(); return { left, right, top, bottom };
      })));
      throw new Error('Unsupported gallery action');
    },
    capture: name => page.screenshot({ path: context.pathInArtifacts(name), animations: 'disabled' }),
    stop: () => desktop.stop(),
  };
  let detachGalleryObserver;
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await cmd('waitFor', 'desktop-sidebar');
    await client.command('resizeWindow');
    await cmd('waitFor', 'desktop-menu-bar');
    await cmd('waitFor', 'desktop-titlebar-sidebar-toggle');
    assert.equal(await page.getByTestId('desktop-app-switcher').count(), 0);
    await cmd('waitFor', 'model-selector-button', { enabled: true });
    await client.capture('studio-home.png');
    const token = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content');
    assert.ok(token); context.registerSecret(token);
    // Electron's persistent session is not Playwright's default browser context.
    const session = await page.context().newCDPSession(page);
    const { cookies } = await session.send('Network.getCookies', { urls: [origin] });
    await session.detach();
    const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
    assert.ok(cookie, 'the owned Electron session has its Gateway login cookie');
    context.registerSecret(cookie);
    const rpc = await openRpc(gatewayRpcUrl({ wsUrl: origin.replace(/^http/, 'ws') }, 'local', token), { headers: { Cookie: cookie, Origin: origin } });
    context.addCleanup('close gallery RPC', () => rpc.close());
    await initializeRpc(rpc, 'readme-gallery', readmeOnly ? {
      integrationScopeV1: true, officeWorkspaceV1: true, agentDefinitionsV1: true,
    } : undefined);
    if (renameOnly) {
      await waitForSelectedModel(page, '示例模型');
      await page.getByTestId('chat-message-input').fill('侧栏会话测试');
      await page.getByTestId('send-message-button').click();
      await page.getByText('会话已准备好。').waitFor({ state: 'visible', timeout: 30000 });
      await page.getByTestId('pause-response-button').waitFor({ state: 'hidden', timeout: 30000 });
      const row = page.locator('[data-testid^="runtime-local-task-row-kcoder:"]').filter({ hasText: '侧栏会话测试' }).first();
      await row.waitFor({ state: 'visible', timeout: 30000 });
      const threadId = (await row.getAttribute('data-testid')).replace('runtime-local-task-row-', '');
      const stableRow = page.getByTestId(`runtime-local-task-row-${threadId}`);
      const input = page.getByTestId(`rename-runtime-local-task-input-${threadId}`);
      await stableRow.dblclick();
      await expect(input).toHaveCount(0);
      await stableRow.click({ button: 'right' });
      await page.getByTestId(`runtime-local-task-menu-rename-${threadId}`).click();
      await input.fill('手动命名的会话');
      await page.getByTestId(`confirm-rename-runtime-local-task-${threadId}`).click();
      await expect(stableRow).toContainText('手动命名的会话', { timeout: 30000 });
      await context.writeArtifactJson('sidebar-rename.json', { doubleClickOpenedRename: false, contextMenuRenameSucceeded: true });
      return { doubleClickOpenedRename: false, contextMenuRenameSucceeded: true };
    }
    let graph = await rpc.request('workflow/create', { title: '资料研究与报告生成', description: '并行收集资料与建立提纲，合并后完成报告。' });
    const nodes = [
      { id: 'brief', kind: 'input', title: '任务目标', prompt: '描述交付内容、约束和可用资料。', dependsOn: [], position: { x: 0, y: 180 } },
      { id: 'research', kind: 'agent', title: '资料研究', prompt: '检索并整理与任务相关的资料。', maxTurns: 60, dependsOn: ['brief'], position: { x: 260, y: 45 } },
      { id: 'outline', kind: 'agent', title: '建立提纲', prompt: '依据任务目标提出报告结构。', maxTurns: 60, dependsOn: ['brief'], position: { x: 260, y: 320 } },
      { id: 'merge', kind: 'code', title: '整合资料', prompt: '将资料和提纲作为结构化输入传递给下一步。', config: { code: { source: 'return {research: nodes.research, outline: nodes.outline};', timeoutMs: 1000 } }, dependsOn: ['research', 'outline'], position: { x: 520, y: 180 } },
      { id: 'review', kind: 'agent', title: '核对与完善', prompt: '核对来源与报告提纲，保留待确认的问题。', maxTurns: 60, dependsOn: ['merge'], position: { x: 780, y: 180 } },
      { id: 'result', kind: 'output', title: '交付报告', dependsOn: ['review'], position: { x: 1040, y: 180 } },
    ];
    for (const node of nodes) graph = await rpc.request('workflow/upsertNode', { id: graph.id, expectedRevision: graph.revision, node });
    await rpc.request('workflow/save', { id: graph.id, expectedRevision: graph.revision });
    if (readmeOnly) {
      const images = await captureCurrentReadmeGallery({ context, page, rpc, origin, workspace, graph, sourceText });
      assert.equal(modelRequests, 0, 'Documentation captures must not invoke a model');
      assert.deepEqual(pageErrors, [], 'Navigation captures must have no uncaught renderer errors');
      await context.writeArtifactJson('readme-gallery-summary.json', {
        source: 'current source Electron/Gateway/Native', syntheticData: true,
        modelRequests, tasksExecuted: 0, workflowExecuted: false, wikiOrganized: false,
        channelCredentialsConfigured: false, images,
      });
      return;
    }
    if (!focused) {
    await client.command('navigate', { value: '/workflows' });
    await cmd('waitFor', `workflow-library-${graph.id}`);
    await cmd('click', `workflow-library-${graph.id}`);
    await cmd('waitFor', 'workflow-node-result');
    await cmd('click', 'workflow-fit');
    await waitFor(async () => { const [bounds] = JSON.parse(await cmd('getElementMetrics', 'workflow-node-result')); return bounds.right <= 1424 && bounds.left >= 460; }, 5000, 'whole sample graph fits the actual canvas');
    await client.capture('workflow-canvas.png');

    }

    if (focused) {
      const output = process.env.KCODER_E2E_GALLERY_COPY_DIR || resolve(repoRoot, 'tmp/current-ui-screenshots-20261029');
      await mkdir(output, { recursive: true });
      const images = [], terminalStates = [], rpcRows = [], pending = new Map();
      let network;
      if (settledOnly) {
        network = await page.context().newCDPSession(page);
        let detachPromise;
        detachGalleryObserver = () => detachPromise ??= network.detach();
        context.addCleanup('detach settled gallery observer', detachGalleryObserver);
        await network.send('Network.enable');
        network.on('Network.webSocketFrameSent', ({requestId,response}) => {try {const value=JSON.parse(response.payloadData);if(typeof value.method==='string'&&value.id!=null)pending.set(`${requestId}:${value.id}`,{method:value.method,started:Date.now()});}catch{}});
        network.on('Network.webSocketFrameReceived', ({requestId,response}) => {try {const value=JSON.parse(response.payloadData),key=`${requestId}:${value.id}`,request=pending.get(key);if(!request)return;pending.delete(key);const code=value.result?.error?.code??value.error?.message;rpcRows.push({method:request.method,elapsedMs:Date.now()-request.started,rpcCode:Number.isInteger(value.error?.code)?value.error.code:null,fixedCode:typeof code==='string'&&/^[A-Za-z][A-Za-z0-9_]{2,95}$/.test(code)?code:null});}catch{}});
      }
      const settle = async (label, selector) => {
        const started=Date.now(); let state='loading';
        try {
          await waitFor(async()=> {
            const root=page.locator(selector);
            if(await root.locator('[role="alert"]').filter({visible:true}).count()){state='error';return true;}
            const enable=root.getByTestId('knowledge-feature-enable');
            if(await enable.isVisible().catch(()=>false)){state='explicit-enable-or-reconnect';return true;}
            const loading=root.getByText(/^(正在读取(?:…|\.\.\.)|正在加载(?:…|\.\.\.))$/).filter({visible:true});
            const content=root.locator('[data-testid="memory-center"],[data-testid="knowledge-query"],[data-testid="subscription-form-toggle"],[data-testid="knowledge-library-picker"],[data-testid="wiki-content-pagination"],[data-testid="knowledge-feature-content"]');
            if(await content.filter({visible:true}).count()&&await loading.count()===0){state='content';return true;}
            const setup=root.getByTestId('knowledge-feature-setup');
            if(await setup.isVisible().catch(()=>false))return false;
            return false;
          },20000,`${label} actual terminal UI`);
        } catch {state='loading-after-20s';}
        const value={label,state,elapsedMs:Date.now()-started,methods:rpcRows.slice(-24),pendingMethods:[...pending.values()].map(value=>value.method)};
        terminalStates.push(value);return state;
      };
      const capture = async name => {
        await client.capture(name);
        await copyFile(context.pathInArtifacts(name), resolve(output, name));
        images.push(name);
        console.log(`CURRENT_UI_SCREENSHOT ${resolve(output, name)}`);
      };
      // Persist actual, unexecuted native records. Never manufacture running/completed states.
      for (const title of ['整理客户访谈要点', '核对月度费用表', '汇总本周项目进展']) {
        const started = await rpc.request('thread/start', { cwd: workspace });
        await rpc.request('thread/metadata/update', { threadId: started.thread.id, title });
      }
      const library = await rpc.request('knowledge/create', { idempotencyKey: 'ui-layout-library', name: '工作台使用资料（布局示例）', purpose: '截图用独立资料，不生成知识页面或启动整理任务。' });
      await rpc.request('knowledge/source/importText', { libraryId: library.id, idempotencyKey: 'ui-layout-source', title: '使用说明（布局示例）.md', text: sourceText });
      if (!settledOnly) {
      await client.command('navigate', { value: '/tasks' });
      await cmd('waitFor', 'task-board');
      await expect(page.getByTestId('task-board-card')).toHaveCount(3, { timeout: 30000 });
      await capture('new-ui-task-board.png');
      }
      await client.command('navigate', { value: '/knowledge' });
      await cmd('waitFor', 'wiki-workspace-tab-library');
      for (const tab of ['library', 'memory', 'shared']) {
        await cmd('click', `wiki-workspace-tab-${tab}`);
        await expect(page.getByTestId(`wiki-workspace-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
        const state=settledOnly?await settle(`wiki-${tab}`,`#wiki-workspace-panel-${tab}`):null;
        await capture(settledOnly?`new-ui-wiki-${tab}-${state==='loading-after-20s'?'loading-diagnostic':'settled'}.png`:`new-ui-wiki-${tab}.png`);
      }
      await client.command('navigate', { value: '/automations' });
      await cmd('waitFor', 'scheduled-tasks-panel');
      await page.getByTestId('scheduled-task-kind').selectOption('workflow');
      await cmd('waitFor', 'scheduled-workflow-choice');
      await expect(page.getByTestId('scheduled-workflow-choice').locator('option')).toHaveCount(2, { timeout: 30000 });
      const choice = await page.getByTestId('scheduled-workflow-choice').locator('option').nth(1).getAttribute('value');
      await page.getByTestId('scheduled-workflow-choice').selectOption(choice);
      const workflowState=settledOnly?await settle('scheduler-workflow','[data-testid=scheduled-workflow-tasks]'):null;
      await capture(settledOnly?`new-ui-scheduler-workflow-${workflowState==='loading-after-20s'?'loading-diagnostic':'settled'}.png`:'new-ui-scheduler-workflow.png');
      await cmd('waitFor', 'automation-tab-inbox', { enabled: true });
      await cmd('click', 'automation-tab-inbox');
      const inboxState=settledOnly?await settle('scheduler-inbox','[data-testid=scheduled-workflow-tasks]'):null;
      await capture(settledOnly?`new-ui-scheduler-inbox-${inboxState==='loading-after-20s'?'loading-diagnostic':'settled'}.png`:'new-ui-scheduler-inbox.png');
      if (!settledOnly) {
      await client.command('navigate', { value: '/office' });
      await cmd('waitFor', 'office-task-input-form', { timeoutMs: 60000 });
      for (const kind of ['docx', 'xlsx', 'pptx']) await expect(page.getByTestId(`office-output-${kind}`)).toBeVisible();
      await capture('new-ui-office-three-formats.png');
      }
      if(settledOnly)await context.writeArtifactJson('current-ui-settled-observations.json',{terminalStates,rpcRows});
      assert.equal(childCalls, 0); assert.equal(wikiInputs.length, 0);
      await context.writeArtifactJson('current-ui-gallery-summary.json', { layoutFixture: true, actualPersistentUnexecutedTasks: 3, workflowSaved: true, workflowExecuted: false, wikiSourceImported: true, wikiOrganized: false, schedulesCreated: 0, officeFilesGenerated: 0, childModelCalls: childCalls, wikiModelCalls: wikiInputs.length, images });
      return;
    }

    const library = await rpc.request('knowledge/create', { idempotencyKey: 'readme-demo-library', name: 'KCoder 使用指南', purpose: '整理示例资料中的会话、工作流与 Wiki 操作说明。' });
    const source = await rpc.request('knowledge/source/importText', { libraryId: library.id, idempotencyKey: 'readme-demo-source', title: '工作台入门.md', text: sourceText });
    await context.writeArtifactJson('gallery-source-shape.json', { libraryId: library.id, source });
    const job = await rpc.request('knowledge/job/start', { libraryId: library.id, sourceId: source.sourceId, revisionId: source.revisionId, idempotencyKey: 'readme-demo-organize', language: 'zh-CN' });
    await waitFor(async () => {
      const state = await rpc.request('knowledge/job/get', { libraryId: library.id, jobId: job.id });
      if (['failed', 'needs_review', 'paused'].includes(state.status)) {
        await context.writeArtifactJson('wiki-failure-state.json', state);
        await context.writeArtifactJson('wiki-fixture-inputs.json', wikiInputs);
        throw new Error('Gallery Wiki did not complete: ' + (state.error || state.status));
      }
      return state.status === 'completed';
    }, 30000, 'example Wiki publication');
    await client.command('navigate', { value: '/' });
    await cmd('waitFor', 'knowledge-button');
    await cmd('click', 'knowledge-button');
    await cmd('waitFor', 'wiki-search');
    await client.command('waitFor', { selector: '[data-testid^="wiki-page-row-"]', text: '对话与工作流' });
    await client.capture('wiki-library.png');
    await client.command('click', { selector: '[data-testid^="wiki-page-row-"][aria-label="Wiki与原文引用"]' });
    await cmd('waitFor', 'wiki-reader', { text: '原文引用' });
    await client.capture('wiki-reader.png');
    await mkdir(resolve(workspace, 'src'), { recursive: true });
    await mkdir(resolve(workspace, 'tests'), { recursive: true });
    await writeFile(resolve(workspace, 'README.md'), '# 示例项目\n源码位于 src，测试位于 tests。');
    await writeFile(resolve(workspace, 'src/lib.rs'), 'pub fn greet() -> &\'static str { "hello" }\n');
    await writeFile(resolve(workspace, 'tests/greet.rs'), '#[test] fn greet() { assert_eq!("hello", "hello"); }\n');
    await client.command('navigate', { value: '/' });
    await cmd('waitFor', 'project-new-conversation-button', { enabled: true });
    await cmd('click', 'project-new-conversation-button');
    await cmd('fill', 'chat-message-input', { value: '请让子代理分析项目结构，并提出改进建议。' });
    await cmd('waitFor', 'send-message-button', { enabled: true });
    await cmd('click', 'send-message-button');
    await cmd('waitFor', 'message-assistant', { text: '子代理已经开始梳理项目' });
    await cmd('waitFor', 'subagent-status-toggle-button');
    await cmd('click', 'subagent-status-toggle-button');
    await cmd('waitFor', 'subagent-detail-open');
    await cmd('click', 'subagent-detail-open');
    await cmd('waitFor', 'subagent-workspace-records', { text: '测试边界' });
    await cmd('fill', 'subagent-workspace-input', { value: '请重点检查 src 和 tests 之间的依赖关系。' });
    await client.capture('subagent-conversation.png');
    releaseAgent();
    await context.writeArtifactJson('gallery-summary.json', { version: JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf8')).version, native: true, host: 'linux-electron', windowsMenuBridgeEnabled: true, syntheticData: true, workflowSaved: true, workflowExecuted: false, wikiPublished: true });
  } catch (error) {
    await context.writeArtifactJson('gallery-page-errors.json', { errors: pageErrors });
    await client.capture('failure.png').catch(() => {}); throw error;
  } finally {
    try { if (detachGalleryObserver) await detachGalleryObserver(); }
    finally { await client.stop(); }
  }
});
