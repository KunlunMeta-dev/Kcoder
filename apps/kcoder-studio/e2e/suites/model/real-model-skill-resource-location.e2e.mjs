import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { startGateway } from '../../harness/gateway.mjs';
import { login } from '../../harness/http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from '../../harness/rpc.mjs';
import { prepareIsolatedRealModelConfig, realModelPreflight } from '../../harness/real-model.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runE2E } from '../../harness/run-context.mjs';
import { registerOriginalCarrierCleanup } from '../../harness/native-systemd-carrier.mjs';

await runE2E(import.meta.url, {
  testId: 'real-model-builtin-skill-resource-location', tier: 'manual-live',
  cleanupTimeoutMs: 60000,
  modelPolicy: 'Explicit candidate acceptance: one isolated expert task, one real-model turn, at most three skill/read calls, 2048 output tokens per request, no retry and 120-second total budget. No platform connection, personal task, skill installation or production configuration change.',
}, async context => {
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE);
  assert.equal(process.platform, 'linux');
  assert.ok(process.getuid() > 0);
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const isolated = await prepareIsolatedRealModelConfig(context, model);
  const original = JSON.parse(await readFile(isolated.settingsFile, 'utf8'));
  const settingsFile = await context.writeStateJson('real-model-config/settings.json', {
    ...original, tools: { profile: 'full', disabled: [] }, allowed_tools: ['skill', 'read'],
    permission_mode: 'ask', max_retries: 0, max_tokens: 2048, credential_store: 'file',
    sandbox: { enabled: true, allowed_paths: [workspace, resolve(isolated.configDir, 'skills')] },
    skills: { trust_external: false }, integrations: { office: { enabled: true } },
    session_memory: { enabled: false }, memory: { structured_enabled: false, legacy_prompt_enabled: false, observer_mode: 'disabled' },
    providers: { [model.provider]: { ...model.providerConfig, request_timeout_secs: 40, max_output_tokens: 2048,
      models: { [model.model]: { ...model.providerConfig.models?.[model.model], max_output_tokens: 2048,
        context_window_tokens: model.providerConfig.models?.[model.model]?.context_window_tokens ?? model.providerConfig.context_window_tokens ?? 128000 } } } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'resources', label: 'Owned resource validation', transport: 'local', command: model.kcoderBin, workspace, settingsFile }]);
  const credentialEnv = Object.fromEntries(model.credentialEnv.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const runtime = `/run/user/${process.getuid()}`;
  const nativeEnv = { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
  const fixture = { uid: process.getuid(), gid: process.getgid(), profile: isolated.configDir, workspace,
    env: context.isolatedEnvironment({ ...nativeEnv, KCODER_CONFIG_DIR: isolated.configDir }), activeManagers: new Set() };
  registerOriginalCarrierCleanup(context, fixture, 'owned-resource-location-host');
  const gateway = await startGateway(context, { auth: true, workspace, serversFile, kcoderBin: model.kcoderBin,
    env: { ...nativeEnv, KCODER_CONFIG_DIR: isolated.configDir, KCODER_MAX_TOKENS: '2048', KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '110', ...credentialEnv } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'resources', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup('close owned resource model RPC', () => closeRpcAndWait(rpc));
  await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'skill-location-real-model', version: '1' },
    capabilities: { experimental: { integrationScopeV1: true, officeWorkspaceV1: true, agentDefinitionsV1: true, threadCreationReceiptsV1: true } } });
  const scope = await rpc.request('integrations/scope/read'); let sequence = 0;
  const office = async (method, payload, mutation = {}) => {
    const reply = await rpc.request(`integrations/${method}`, { contractVersion: 'parallel-v1', requestId: `location-${++sequence}`, scope, timeoutMs: 30000, payload, ...mutation }, 40000);
    assert.equal(reply.status, 'completed', reply.error?.code); return reply.result;
  };
  const definition = { schemaVersion: 1, id: 'personal.owned-location', scope: 'personal', title: '技能定位验收专家', language: 'zh-CN',
    description: 'Owned read-only resource validation', inputSchema: { type: 'object' }, instructions: '只做用户要求的技能读取验证，不执行脚本或生成文件。',
    modelSelection: { kind: 'inherit_current' }, allowedTools: ['skill', 'read'], outputKinds: ['document'], acceptanceCriteria: ['Actual file read'], externalSend: 'deny' };
  const { draft } = await office('assistant/saveDraft', { definition }, { operationId: 'location-create' });
  const { saved } = await office('assistant/saveVersion', { id: definition.id, version: '1' }, { operationId: 'location-save', expectedRevision: String(draft.revision) });
  const { thread } = await rpc.request('thread/start', { clientRequestId: 'location-owned-task', agentDefinition: { id: definition.id, version: saved.version, definitionSha256: saved.definitionSha256 } });
  let running;
  context.addCleanup('settle only owned skill-location turn', async () => {
    if (running) await rpc.request('turn/interrupt', { threadId: thread.id, turnId: running.id });
  });
  ({ turn: running } = await rpc.request('turn/start', { threadId: thread.id, clientMessageId: 'location-owned-input', input: [{ type: 'text', text: '先用 skill 加载已注册的 docx。只根据加载结果给出的准确入口路径，用 read 读取原始 SKILL.md 前 8 行，最后报告读到的标题或 frontmatter 名称。最多三次工具调用，只允许在参数错误时修正一次；不找目录、不运行脚本、不修改文件。此次只验证路径与读取，简短回答。' }] }));
  let timer;
  try {
    const budget = new Promise((_, reject) => { timer = setInterval(() => {
      const calls = rpc.messages().filter(event => event.method === 'item/started' && event.params?.threadId === thread.id && event.params?.item?.type === 'toolCall');
      if (calls.length > 3 || calls.some(event => !['skill', 'read'].includes(event.params.item.name))) reject(new Error('Resource validation exceeded its read-only tool budget'));
    }, 100); });
    const completed = await Promise.race([budget, rpc.waitFor(event => event.method === 'turn/completed' && event.params?.threadId === thread.id && event.params?.turnId === running.id, 120000, 'real resource read')]);
    assert.equal(completed.params.turn.status, 'completed'); running = undefined;
  } finally { clearInterval(timer); }
  const events = rpc.messages().filter(event => event.params?.threadId === thread.id);
  const history = await rpc.request('thread/read', { threadId: thread.id });
  await context.writeArtifactJson('resource-events.json', events);
  await context.writeArtifactJson('resource-history.json', history);
  const calls = events.filter(event => event.method === 'item/started' && event.params?.item?.type === 'toolCall').map(event => event.params.item);
  assert.ok(calls.some(call => call.name === 'skill' && call.input.skill === 'docx'));
  const successful = new Set(events.filter(event => event.method === 'item/completed' && event.params?.item?.status === 'completed').map(event => event.params.item.id));
  const actualRead = calls.find(call => call.name === 'read' && successful.has(call.id));
  assert.ok(actualRead, 'Activation alone cannot pass actual file-read acceptance');
  const file = actualRead.input.file_path;
  assert.ok(isAbsolute(file) && resolve(file).startsWith(resolve(isolated.configDir, 'skills') + '/'));
  assert.ok(file.endsWith('/docx/SKILL.md'));
  const bytes = await readFile(file), firstLine = bytes.toString('utf8').split('\n').slice(0, 8).join('\n');
  const projects = resolve(isolated.configDir, 'projects'); let logsDir;
  for (const project of await readdir(projects)) {
    const candidate = resolve(projects, project, thread.id, 'llm-requests');
    if (await readdir(candidate).catch(() => null)) { assert.ok(!logsDir); logsDir = candidate; }
  }
  assert.ok(logsDir);
  const exchanges = await Promise.all((await readdir(logsDir)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(resolve(logsDir, name), 'utf8'))));
  const messages = exchanges.flatMap(exchange => exchange.request.messages).flatMap(message => message.content ?? []);
  assert.ok(messages.some(block => block.type === 'text' && block.text.includes('Skill entry file:') && block.text.includes(JSON.stringify(file))), 'The model must receive the actual entry from runtime metadata');
  assert.ok(messages.some(block => block.type === 'tool_result' && block.tool_use_id === actualRead.id && !block.is_error && JSON.stringify(block.content).includes('docx')), 'The original read result must reach the model successfully');
  await context.writeArtifactJson('resource-request-context.json', exchanges.map(exchange => ({ model: exchange.request.model,
    tools: exchange.request.tools?.map(tool => tool.name), systemChars: exchange.request.system?.length,
    resourceContexts: exchange.request.messages.flatMap(message => message.content ?? []).flatMap(block =>
      block.type === 'text' ? block.text.match(/<skill_resource_context>[\s\S]*?<\/skill_resource_context>/g) ?? [] : []),
    readResults: exchange.request.messages.flatMap(message => message.content ?? []).filter(block => block.type === 'tool_result' && block.tool_use_id === actualRead.id),
  })));
  await context.writeArtifactJson('resource-location-proof.json', { provider: model.provider, model: model.model, threadId: thread.id, tools: calls.map(call => call.name),
    file, sha256: createHash('sha256').update(bytes).digest('hex'), firstLines: firstLine, actualRequestCount: exchanges.length, projectCwdPreserved: thread.cwd === workspace,
    correctedReadInputs: calls.filter(call => call.name === 'read' && !successful.has(call.id)).length,
    trustExternal: false, platformConnectionUsed: false, isolatedProfile: true });
});
