import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

// Documentation captures use actual Tauri/Gateway/Engine with isolated sample
// records. Fixed model replies populate the gallery, not model-quality evidence.
const sourceText = '# 对话与工作流\n\n你可以在会话里描述任务、查看工具结果并追加指令。\n工作流可以保存版本，供其它会话复用。\n\n# Wiki与原文引用\n\nWiki 保存原始资料，并将知识页面与原文引用关联起来。';
await runE2E(import.meta.url, {
  testId: 'readme-current-product-gallery', tier: 'manual-live',
  modelPolicy: 'Interface captures with isolated demonstration data; no real-model quality claim',
  retainSuccessLogs: true,
}, async context => {
  let releaseAgent;
  const agentGate = new Promise(done => { releaseAgent = done; });
  context.addCleanup('release gallery agent', () => releaseAgent());
  let childCalls = 0;
  const server = createServer(async (request, response) => {
    try {
      let text = ''; for await (const part of request) text += part;
      const body = JSON.parse(text);
      const message = body.messages.filter(item => item.role === 'user').at(-1);
      const userText = typeof message.content === 'string' ? message.content : message.content.map(block => block.text || '').join('');
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
      let output;
      if (input.repairKind === 'source_support') {
        const placements = input.candidate.organizationProof.placements;
        output = { sourceCoverage: 'complete', units: input.units.map(unit => ({ pageId: unit.pageId, unit: unit.unit, verdict: 'supported', citationIndices: unit.allowedCitationIndices })),
          organizationUnits: input.organizationInventory.units.map(unit => ({ unitId: unit.id, verdict: 'supported', placementIndices: placements.flatMap((placement, index) => placement.unitId === unit.id ? [index] : []) })) };
      } else if (!input.analysis) {
        output = { summary: '示例资料说明了会话、工作流复用和 Wiki 原文引用。', queries: ['工作流', 'Wiki'], conflicts: [],
          organizationPlan: { binding: input.sourceInventory.binding, units: input.sourceInventory.units.map(unit => ({ unitId: unit.id, disposition: ['heading', 'table_header'].includes(unit.kind) ? 'context' : 'required', purposeAspectIds: ['heading', 'table_header'].includes(unit.kind) ? [] : input.sourceInventory.aspects.map(aspect => aspect.id), reason: ['heading', 'table_header'].includes(unit.kind) ? '资料中的原始章节标题。' : '' })) } };
      } else {
        const refs = input.citationSpans.map(span => ({ ref: span.ref }));
        output = { pages: input.newPageIds.slice(0, Math.min(2, input.outputPolicy.maxNewTopicPages)).map((id, index) => ({ pageId: id, expectedRevision: null, kind: 'concept', title: index ? 'Wiki与原文引用' : '对话与工作流', markdown: sourceText, citations: refs, relatedPageIds: [] })), reviewNotes: [] };
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ id: 'gallery', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch { response.writeHead(500); response.end('Gallery fixture could not construct a response'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  context.registerPort('gallery-model', server.address().port);
  context.addCleanup('close gallery model', async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const client = await startOwnedAiVerify(context, {
    tauriBin: resolve(appRoot, 'renderer/src-tauri/target/debug/app'),
    kcoderBin: resolve(repoRoot, 'target/release/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await cmd('waitFor', 'desktop-sidebar');
    await client.command('resizeWindow', { value: '1280x900' });
    await writeFile(client.settingsPath, JSON.stringify({ active_provider: 'gallery', permission_mode: 'bypass', max_retries: 0, tools: { profile: 'full' }, knowledge: { enabled: true, retrieval_enabled: true, organization_enabled: true },
      providers: { gallery: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: `http://127.0.0.1:${server.address().port}/v1`, default_model: '示例模型', context_window_tokens: 262144, max_output_tokens: 8192, output_headroom_tokens: 8192, no_proxy: true } } }), { mode: 0o600 });
    await client.command('navigate', { value: '/settings/personal/models' });
    await client.command('waitFor', { selector: '[data-testid^="provider-edit-gallery::"]' });
    await client.command('navigate', { value: '/' });
    await cmd('waitFor', 'model-selector-button', { enabled: true });
    await client.capture('studio-home.png');
    const profile = dirname(client.settingsPath);
    const gateway = await startGateway(context, { label: 'gallery-gateway', workspace: resolve(profile, '../workspaces/tauri-verification'), kcoderBin: resolve(repoRoot, 'target/release/kcoder'), env: { KCODER_CONFIG_DIR: profile } });
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
    context.addCleanup('close gallery RPC', () => rpc.close());
    await initializeRpc(rpc, 'readme-gallery');
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
    await client.command('navigate', { value: '/workflows' });
    await cmd('waitFor', `workflow-library-${graph.id}`);
    await cmd('click', `workflow-library-${graph.id}`);
    await cmd('waitFor', 'workflow-node-result');
    await cmd('click', 'workflow-fit');
    await waitFor(async () => { const [bounds] = JSON.parse(await cmd('getElementMetrics', 'workflow-node-result')); return bounds.right <= 1265 && bounds.left >= 510; }, 5000, 'whole sample graph fits the actual canvas');
    await client.capture('workflow-canvas.png');

    const library = await rpc.request('knowledge/create', { idempotencyKey: 'readme-demo-library', name: 'KCoder 使用指南', purpose: '整理示例资料中的会话、工作流与 Wiki 操作说明。' });
    const source = await rpc.request('knowledge/source/importText', { libraryId: library.id, idempotencyKey: 'readme-demo-source', title: '工作台入门.md', text: sourceText });
    await context.writeArtifactJson('gallery-source-shape.json', { libraryId: library.id, source });
    const job = await rpc.request('knowledge/job/start', { libraryId: library.id, sourceId: source.sourceId, revisionId: source.revisionId, idempotencyKey: 'readme-demo-organize', language: 'zh-CN' });
    await waitFor(async () => {
      const state = await rpc.request('knowledge/job/get', { libraryId: library.id, jobId: job.id });
      if (['failed', 'needs_review', 'paused'].includes(state.status)) throw new Error('Gallery Wiki did not complete: ' + (state.error || state.status));
      return state.status === 'completed';
    }, 30000, 'example Wiki publication');
    await client.command('navigate', { value: '/' });
    await cmd('waitFor', 'knowledge-button');
    await cmd('click', 'knowledge-button');
    await cmd('waitFor', 'knowledge-library-picker', { text: 'KCoder 使用指南' });
    await cmd('waitFor', 'wiki-search');
    await client.command('waitFor', { selector: '[data-testid^="wiki-page-row-"]', text: '对话与工作流' });
    await client.capture('wiki-library.png');
    await client.command('click', { selector: '[data-testid^="wiki-page-row-"][aria-label="Wiki与原文引用"]' });
    await cmd('waitFor', 'wiki-reader', { text: '原文引用' });
    await client.capture('wiki-reader.png');
    const workspace = resolve(profile, '../workspaces/tauri-verification');
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
    await context.writeArtifactJson('gallery-summary.json', { version: '0.3.8', native: true, syntheticData: true, workflowSaved: true, workflowExecuted: false, wikiPublished: true });
  } catch (error) {
    client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error;
  } finally { await client.stop(); }
});
