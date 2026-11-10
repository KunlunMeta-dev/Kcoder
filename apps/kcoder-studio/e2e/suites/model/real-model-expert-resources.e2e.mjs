import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { startGateway } from '../../harness/gateway.mjs';
import { login } from '../../harness/http.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl } from '../../harness/rpc.mjs';
import { realModelPreflight, prepareIsolatedRealModelConfig } from '../../harness/real-model.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runE2E } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, {
  testId: 'real-model-expert-skill-and-reference-read', tier: 'manual-live',
  modelPolicy: 'Real provider and public SkillHub required. One owned task, at most six tool calls, 2048 output tokens per request, no retries, 150s turn budget. No personal task or platform connection is used.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_EXPERT_MARKET, '1', 'Explicit public skill download consent is required');
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || 'kunlunmeta');
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const isolated = await prepareIsolatedRealModelConfig(context, model);
  const original = JSON.parse(await readFile(isolated.settingsFile, 'utf8'));
  const settingsFile = await context.writeStateJson('expert-resource-settings.json', {
    ...original, tools: { profile: 'full', disabled: [] }, permission_mode: 'ask',
    allowed_tools: ['skill', 'read'], skills: { trust_external: false }, max_retries: 0, max_tokens: 2048,
    credential_store: 'file', session_memory: { enabled: false },
    memory: { structured_enabled: false, legacy_prompt_enabled: false, observer_mode: 'disabled' },
    sandbox: { enabled: true, allowed_paths: [workspace], denied_paths: [resolve(model.configDir, 'credentials.json'), resolve(isolated.configDir, 'credentials.json')] },
    integrations: { office: { enabled: true }, services: { enabled: true } },
    providers: { [model.provider]: { ...model.providerConfig, request_timeout_secs: 45, max_output_tokens: 2048,
      models: { [model.model]: { ...model.providerConfig.models?.[model.model], max_output_tokens: 2048,
        context_window_tokens: model.providerConfig.models?.[model.model]?.context_window_tokens ?? model.providerConfig.context_window_tokens ?? 128000 } } } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'expert-resources', label: 'Owned expert resources', transport: 'local', command: model.kcoderBin, workspace, settingsFile }]);
  const credentialEnv = Object.fromEntries(model.credentialEnv.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const gateway = await startGateway(context, { auth: true, workspace, serversFile, kcoderBin: model.kcoderBin,
    env: { KCODER_CONFIG_DIR: isolated.configDir, KCODER_MAX_TOKENS: '2048', KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '120', ...credentialEnv } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'expert-resources', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup('close owned expert resource RPC', () => closeRpcAndWait(rpc));
  const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'expert-resource-real-model', version: '1' },
    capabilities: { experimental: { integrationScopeV1: true, officeWorkspaceV1: true, agentDefinitionsV1: true, threadCreationReceiptsV1: true } } });
  assert.equal(initialized.capabilities.experimental.agentDefinitionsV1, true);
  const scope = await rpc.request('integrations/scope/read'); let sequence = 0;
  const office = async (method, payload, mutation = {}) => {
    const reply = await rpc.request('integrations/' + method, { contractVersion: 'parallel-v1', requestId: 'resource-' + ++sequence, scope, timeoutMs: 60000, payload, ...mutation }, 65000);
    assert.equal(reply.status, 'completed', JSON.stringify(reply.error)); return reply.result;
  };
  const title = '资源读取验收专家';
  const definition = { schemaVersion: 1, id: 'personal.owned-resource-read', scope: 'personal', title, description: 'Owned real-model resource acceptance', language: 'zh-CN',
    inputSchema: { type: 'object' }, instructions: '按用户要求核对真实工具结果；只进行资源读取验证，不开展开发任务。',
    modelSelection: { kind: 'inherit_current' }, allowedTools: ['skill', 'read'], outputKinds: ['document'], acceptanceCriteria: ['Actual original reference read'], externalSend: 'deny' };
  const created = (await office('assistant/saveDraft', { definition }, { operationId: 'create-resource-expert' })).draft;
  const installed = await office('assistant/skills/install', { id: definition.id, slug: 'dev-expert', language: 'zh-CN' }, { operationId: 'install-original-resource-skill', expectedRevision: String(created.revision) });
  assert.equal(installed.executionEnabled, false);
  const bundle = (await office('assistant/package/read', { id: definition.id })).package;
  const reference = bundle.files.find(file => file.path === 'skills/dev-expert/references/routing.md');
  assert.ok(reference, 'The public package must contain the original reference');
  if (process.env.KCODER_E2E_EXPECT_ROUTING_SHA256) assert.equal(reference.sha256, process.env.KCODER_E2E_EXPECT_ROUTING_SHA256, 'Downloaded reference must match the selected original package');
  const selected = installed.draft.definition; assert.equal(selected.skills.length, 1); selected.skills[0].enabled = true;
  const enabled = (await office('assistant/saveDraft', { definition: selected }, { operationId: 'enable-owned-resource-skill', expectedRevision: String(installed.draft.revision) })).draft;
  const saved = (await office('assistant/saveVersion', { id: definition.id, version: '1' }, { operationId: 'publish-owned-resource-expert', expectedRevision: String(enabled.revision) })).saved;
  const { thread } = await rpc.request('thread/start', { clientRequestId: 'owned-real-resource-task', agentDefinition: { id: definition.id, version: saved.version, definitionSha256: saved.definitionSha256 } });
  let turn;
  context.addCleanup('interrupt only the owned resource turn if still active', async () => {
    if (turn) await rpc.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
  });
  ({ turn } = await rpc.request('turn/start', { threadId: thread.id, clientMessageId: 'owned-real-resource-input', input: [{ type: 'text', text: '你是谁？先介绍当前专家身份。然后从当前技能目录找到 dev-expert 的精确注册名，用 skill 加载入口，再用 read 读取该技能真实基础目录下的 references/routing.md 前 30 行，最后报告读到的首个标题。此次只验证读取，不开展开发工作，不运行脚本、不修改文件、不加载其他参考文件；最多调用三次工具。' }] }));
  let timer;
  try {
    const budget = new Promise((_, reject) => { timer = setInterval(() => {
      const tools = rpc.messages().filter(message => message.method === 'item/started' && message.params?.threadId === thread.id && message.params?.item?.type === 'toolCall');
      if (tools.length > 6) reject(new Error('Owned resource turn exceeded tool budget'));
    }, 100); });
    const terminal = await Promise.race([budget, rpc.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, 150000, 'real resource read completion')]);
    assert.equal(terminal.params.turn.status, 'completed'); turn = undefined;
  } finally { clearInterval(timer); }
  const history = await rpc.request('thread/read', { threadId: thread.id });
  const events = rpc.messages().filter(message => message.params?.threadId === thread.id);
  await context.writeArtifactJson('expert-resource-history.json', history);
  await context.writeArtifactJson('expert-resource-events.json', events);
  const calls = events.filter(message => message.method === 'item/started' && message.params?.item?.type === 'toolCall').map(message => message.params.item);
  assert.ok(calls.some(item => item.name === 'skill'), 'The real model must load the original entry');
  assert.ok(calls.every(item => ['skill', 'read'].includes(item.name)), 'Only the explicitly allowed original tools may execute');
  const read = calls.find(item => item.name === 'read' && String(item.input?.file_path ?? '').replaceAll('\\', '/').endsWith('/dev-expert/references/routing.md'));
  assert.ok(read, 'The real model must read the reference through the original read tool');
  const path = read.input.file_path; assert.ok(isAbsolute(path) && resolve(path).startsWith(resolve(isolated.configDir) + '/'));
  const bytes = await readFile(path); assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
  const heading = bytes.toString('utf8').split('\n').find(line => /^#+\s/.test(line))?.replace(/^#+\s*/, '').trim(); assert.ok(heading);
  const serialized = JSON.stringify(history); assert.ok(serialized.includes(heading));
  const replies = history.messages.filter(message => message.role === 'assistant').map(message => message.content).join('\n');
  assert.ok(replies.includes(title), 'The real answer must identify the selected expert');
  assert.equal(thread.cwd, workspace);
  await context.writeArtifactJson('expert-resource-proof.json', { provider: model.provider, model: model.model, title, threadId: thread.id, routingSha256: reference.sha256,
    toolNames: calls.map(item => item.name), heading, projectCwdPreserved: true, trustExternal: false, platformConnectionUsed: false });
});
