import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { login } from '../../harness/http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'deployed-expert-conversation-context-audit', tier: 'manual-live',
  modelPolicy: 'Explicit deployed target audit. At most two owned tasks and six short real-model turns, 90 seconds and six tool calls per turn. Resource-only mode uses one owned task and one turn. Never edit existing experts, grant permissions, install skills or send platform messages. Archive only owned tasks; retain original request log paths.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_EXPERT_CHAT, '1');
  assert.equal(process.env.KCODER_E2E_REAL_MODEL, '1');
  const base = new URL(process.env.KCODER_E2E_DEPLOYED_RPC_BASE_URL);
  assert.equal(base.protocol, 'http:');
  assert.equal(base.hostname, '127.0.0.1');
  assert.ok(!base.search && !base.hash && !base.username && !base.password);
  const serverId = process.env.KCODER_E2E_DEPLOYED_SERVER_ID;
  const workspace = process.env.KCODER_E2E_DEPLOYED_WORKSPACE;
  const projectHistory = process.env.KCODER_E2E_DEPLOYED_PROJECT_HISTORY;
  assert.ok(serverId && workspace && projectHistory);
  assert.equal(resolve(projectHistory), projectHistory);
  const secretFile = process.env.KCODER_E2E_DEPLOYED_ENV_FILE;
  const info = await lstat(secretFile);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const line = (await readFile(secretFile, 'utf8')).split(/\r?\n/).find(value => value.startsWith('KCODER_STUDIO_AUTH_TOKEN='));
  assert.ok(line);
  const token = line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, '');
  context.registerSecret(token);
  const cookie = await login(base.origin, token);
  context.registerSecret(cookie);
  const url = new URL(gatewayRpcUrl({ wsUrl: base.origin.replace('http:', 'ws:') }, serverId, 'cookie-auth'));
  url.searchParams.set('workspace', workspace);
  const rpc = await openRpc(url.href, { headers: { Cookie: cookie, Origin: base.origin } });
  context.addCleanup('close owned expert conversation RPC', () => closeRpcAndWait(rpc));
  await initializeRpc(rpc, 'deployed-expert-conversation-audit', {
    taskSourcesV1: true, interactionBindingV1: true, threadRuntimeHandoffV1: true,
    threadCreationReceiptsV1: true, turnReceiptsV1: true, turnSubmissionV1: true,
    integrationScopeV1: true, officeWorkspaceV1: true, agentDefinitionsV1: true,
    agentTurnConfigurationV1: true,
  });
  const scope = await rpc.request('integrations/scope/read');
  let sequence = 0;
  const officeRead = async (method, payload) => {
    assert.ok(['assistant/list', 'assistant/read', 'assistant/versions'].includes(method));
    const reply = await rpc.request(`integrations/${method}`, {
      contractVersion: 'parallel-v1', requestId: `expert-audit-${++sequence}`, scope, timeoutMs: 30000, payload,
    }, 45000);
    assert.equal(reply.status, 'completed', reply.error?.code);
    return reply.result;
  };
  const ids = (process.env.KCODER_E2E_DEPLOYED_EXPERT_IDS ?? '').split(',').filter(Boolean);
  assert.equal(ids.length, 2, 'Explicitly select two existing experts');
  const resourceOnly = process.env.KCODER_E2E_DEPLOYED_EXPERT_RESOURCE_READ === '1';
  const catalog = await officeRead('assistant/list', { limit: 10, personalOnly: true, language: 'zh-CN' });
  const originalTasks = new Set((await rpc.request('thread/list', { limit: 100 })).threads.map(task => task.id));
  const tasks = [], conversations = [];
  context.addCleanup('archive only owned expert audit tasks after reconciling receipts', async () => {
    for (const task of tasks) {
      if (!task.id) {
        const receipt = await rpc.request('thread/creation/read', { clientRequestId: task.creationId });
        task.id = receipt.receipt?.threadId;
      }
      if (!task.id) continue;
      assert.ok(!originalTasks.has(task.id));
      for (const clientMessageId of task.inputs) {
        const { receipt } = await rpc.request('turn/receipt/read', { threadId: task.id, clientMessageId });
        assert.notEqual(receipt?.status, 'unknown', 'Never replay an unknown input');
        if (receipt?.status === 'running') {
          await rpc.request('turn/interrupt', { threadId: task.id, turnId: receipt.turnId });
          await rpc.waitFor(event => event.method === 'turn/completed' && event.params?.threadId === task.id && event.params?.turnId === receipt.turnId, 15000, 'owned interrupted turn');
        }
      }
      await rpc.request('thread/metadata/update', { threadId: task.id, archivedAt: new Date().toISOString() });
    }
  });
  for (const [index, id] of ids.entries()) {
    if (resourceOnly && index === 0) continue;
    const listed = catalog.items.find(item => item.definition.id === id);
    assert.ok(listed, 'The requested existing expert must be visible');
    const { draft } = await officeRead('assistant/read', { id });
    const versions = await officeRead('assistant/versions', { id, limit: 10 });
    const saved = versions.items.find(item => !item.archived && item.definition.id === id);
    assert.ok(saved, 'Use an existing saved version; do not publish a draft for this test');
    const task = { creationId: `expert-audit-${randomUUID()}`, inputs: [] };
    tasks.push(task);
    const { thread } = await rpc.request('thread/start', {
      clientRequestId: task.creationId, cwd: workspace,
      agentDefinition: { id, version: saved.version, definitionSha256: saved.definitionSha256 },
    });
    task.id = thread.id;
    assert.ok(!originalTasks.has(task.id));
    await rpc.request('thread/metadata/update', { threadId: task.id, title: `专家对话审计：${draft.definition.title}` });
    const record = { expertId: id, title: draft.definition.title, draftRevision: draft.revision,
      version: saved.version, threadId: task.id, definitionSha256: saved.definitionSha256,
      instructions: draft.definition.instructions, allowedTools: draft.definition.allowedTools ?? null,
      skills: (draft.definition.skills ?? []).map(skill => ({ slug: skill.slug, enabled: skill.enabled })), turns: [] };
    conversations.push(record);
    const prompts = resourceOnly ? [
      '这是只读技能验收：请先介绍当前专家身份，然后用 skill 加载当前已注册的 docx 技能入口。根据工具给出的准确基础目录，用 read 读取该入口正文实际引用的一份 Markdown 参考文件的前 8 行，报告文件名和首个标题。最多三次工具调用；不创建文档、不运行脚本、不修改任何文件、不安装技能。若入口没有 Markdown 引用，只读取其原始 SKILL.md 前 8 行并如实说明。不要凭空编造路径。',
    ] : [
      '你是谁？请用两句话介绍你的名称、擅长的工作和当前能做的事。不要调用工具。',
      index === 0
        ? '这是小型测试设计题：函数 clamp(x,min,max) 要求把 x 限制在闭区间 [min,max]，min>max 时抛出异常。给出 6 条用例，包含输入、预期和覆盖目的。只回答本题，200字以内；不要创建文件、执行代码、调用工具或宣称已经执行测试。'
        : '请把这段原始记录整理成简短会议纪要和行动项：周一产品会，李明提出周五发布；张华认为支付回归未完成；最终决定延期，新的发布日期和负责人尚未确定。只用这些事实，不生成文件、不调用工具，180字以内。',
      '刚才你提到或配置的配套技能是真实可调用的吗？只用一次 DiscoverSkills 查询当前可发现技能，核实后区分已安装与仅在提示词里提及；不要下载、安装、修改文件或宣称未验证的能力，180字以内。',
    ];
    let resourceRead;
    for (const [turnIndex, prompt] of prompts.entries()) {
      const clientMessageId = `expert-audit-input-${randomUUID()}`;
      task.inputs.push(clientMessageId);
      const beforeEvents = rpc.messages().length;
      const { turn } = await rpc.request('turn/start', { threadId: task.id, clientMessageId, input: [{ type: 'text', text: prompt }] });
      let timer;
      try {
        const budget = new Promise((_, reject) => {
          timer = setInterval(() => {
            const events = rpc.messages().slice(beforeEvents).filter(event => event.params?.threadId === task.id);
            const calls = events.filter(event => event.method === 'item/started' && event.params?.item?.type === 'toolCall');
            if (calls.length > (resourceOnly ? 3 : 6)) reject(new Error('Expert audit exceeded its tool budget'));
            if (resourceOnly && calls.some(event => !['skill', 'read'].includes(event.params.item.name)))
              reject(new Error('Resource lookup did not use the skill base directory and original read tool'));
            if (events.some(event => /(?:requestApproval|requestUserInput|userQuestion\/created)/i.test(event.method ?? '')))
              reject(new Error('Expert audit unexpectedly requires user interaction; no authority was granted'));
          }, 100);
        });
        const completed = await Promise.race([budget, rpc.waitFor(event => event.method === 'turn/completed' && event.params?.threadId === task.id && event.params?.turnId === turn.id, 90000, 'real expert completion')]);
        const events = rpc.messages().slice(beforeEvents).filter(event => event.params?.threadId === task.id);
        const history = await rpc.request('thread/read', { threadId: task.id });
        const assistant = history.messages.filter(message => message.role === 'assistant').map(message => message.content);
        record.turns.push({ index: turnIndex, prompt, turnId: turn.id, status: completed.params.turn.status,
          answer: assistant.at(-1), tools: events.filter(event => event.method === 'item/started' && event.params?.item?.type === 'toolCall').map(event => event.params.item) });
        await context.writeArtifactJson(`expert-${index}-turn-${turnIndex}-conversation.json`, record.turns.at(-1));
        await context.writeArtifactJson(`expert-${index}-turn-${turnIndex}-events.json`, events);
        assert.equal(completed.params.turn.status, 'completed');
        if (resourceOnly) {
          const calls = record.turns.at(-1).tools;
          assert.ok(calls.some(call => call.name === 'skill'));
          const successful = new Set(events.filter(event => event.method === 'item/completed'
            && event.params?.item?.status === 'completed').map(event => event.params.item.id));
          resourceRead = calls.find(call => call.name === 'read' && successful.has(call.id));
          assert.ok(resourceRead, 'Require the original successful read receipt, not a read attempt');
          assert.ok(isAbsolute(resourceRead.input.file_path));
        }
      } catch (error) {
        const logsDir = resolve(projectHistory, task.id, 'llm-requests');
        const requestLogs = (await readdir(logsDir).catch(() => []))
          .filter(name => name.endsWith('.json')).map(name => resolve(logsDir, name));
        await context.writeArtifactJson(`expert-${index}-turn-${turnIndex}-failure.json`, {
          threadId: task.id, turnId: turn.id, reason: String(error), requestLogs,
          events: rpc.messages().slice(beforeEvents).filter(event => event.params?.threadId === task.id),
        });
        throw error;
      } finally { clearInterval(timer); }
    }
    const logsDir = resolve(projectHistory, task.id, 'llm-requests');
    const logs = [], resourceContexts = [], readResults = [];
    for (const name of (await readdir(logsDir)).filter(name => name.endsWith('.json')).sort()) {
      const path = resolve(logsDir, name);
      const exchange = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(exchange.session_id, task.id);
      const request = exchange.request, system = request.system ?? '';
      const systemText = typeof system === 'string' ? system : JSON.stringify(system);
      if (resourceOnly) for (const message of request.messages) {
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === 'text') resourceContexts.push(...(block.text.match(/<skill_resource_context>[\s\S]*?<\/skill_resource_context>/g) ?? []));
          if (block.type === 'tool_result' && block.tool_use_id === resourceRead.id && !block.is_error)
            readResults.push(block);
        }
      }
      logs.push({ path, model: request.model, maxTokens: request.max_tokens,
        systemChars: systemText.length, systemSha256: createHash('sha256').update(systemText).digest('hex'),
        systemHead: systemText.slice(0, 1100), headings: systemText.split('\n').filter(line => /^#{1,3}\s/.test(line)),
        selectedIdentity: systemText.startsWith('Your current conversational role is the selected expert'),
        legacyHostIdentity: /^You are (?:KCoder|KWorker),/.test(systemText),
        selectedExpertSections: systemText.split('## Selected expert').length - 1,
        expertInstructionsIncluded: systemText.includes(draft.definition.instructions),
        unattendedChannelPolicy: systemText.includes('This is an unattended channel input'),
        toolNames: (request.tools ?? []).map(tool => tool.name),
        messages: request.messages.map(message => ({ role: message.role, chars: JSON.stringify(message.content).length })),
        responseError: exchange.response.error ?? null, usage: exchange.response.usage ?? null });
    }
    record.requestLogs = logs;
    if (resourceOnly) {
      const entries = resourceContexts.flatMap(text => {
        const match = text.match(/^Skill entry file: ("(?:\\.|[^"\\])*")$/m);
        return match ? [JSON.parse(match[1])] : [];
      });
      const file = resolve(resourceRead.input.file_path);
      assert.ok(entries.some(entry => isAbsolute(entry) && (file === resolve(entry)
        || file.startsWith(dirname(resolve(entry)) + sep))), 'Read must resolve inside the registered skill resource directory');
      assert.ok(readResults.length > 0, 'The successful original read result must reach the actual model request');
      const bytes = await readFile(file);
      record.resourceRead = { file, sha256: createHash('sha256').update(bytes).digest('hex'),
        firstLines: bytes.toString('utf8').split('\n').slice(0, 8).join('\n'),
        projectCwdPreserved: thread.cwd === workspace, originalReadResultDelivered: true };
      await context.writeArtifactJson(`expert-${index}-resource-context.json`, { resourceContexts, readResults });
    }
    record.expertSelection = await rpc.request('thread/expert', { threadId: task.id });
    await context.writeArtifactJson(`expert-${index}-context.json`, record);
    assert.ok(logs.length >= prompts.length, 'Use actual persisted model request artifacts');
  }
  await context.writeArtifactJson('expert-audit-proof.json', { timestamp: new Date().toISOString(), conversations,
    existingExpertsEdited: false, platformMessages: 0, modelTurns: conversations.reduce((sum, record) => sum + record.turns.length, 0) });
  return { threadIds: tasks.map(task => task.id), modelTurns: conversations.reduce((sum, record) => sum + record.turns.length, 0), expertCount: conversations.length, requestLogsRead: true };
});
