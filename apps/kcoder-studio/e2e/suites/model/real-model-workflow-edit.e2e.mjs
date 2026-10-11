import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { prepareIsolatedRealModelConfig, realModelPreflight } from '../../harness/real-model.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc, isTurnCompletion } from '../../harness/rpc.mjs';
import { runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'real-model-existing-workflow-multi-branch-edit', tier: 'pr-smoke-credentialed',
  modelPolicy: 'real-model-required; one authoring turn, no node execution; 12 tool calls, 180s and 4096 output tokens per request',
}, async context => {
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || 'kunlunmeta');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'workflow-edit' });
  const isolated = await prepareIsolatedRealModelConfig(context, model);
  const base = JSON.parse(await readFile(isolated.settingsFile, 'utf8'));
  const settingsFile = await context.writeStateJson('workflow-settings.json', {
    ...base, tools: { profile: 'full', disabled: [] }, permission_mode: 'bypass', max_retries: 0,
    providers: { [model.provider]: { ...model.providerConfig, max_output_tokens: 4096, reasoning_effort: null,
      models: { [model.model]: { ...model.providerConfig.models?.[model.model], context_window_tokens: model.providerConfig.context_window_tokens, output_headroom_tokens: 4096, max_output_tokens: 4096, reasoning_effort: null } } } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'model', label: 'Model', transport: 'local', command: model.kcoderBin, workspace, settingsFile, profile: model.profile }]);
  const credentialEnv = Object.fromEntries(model.credentialEnv.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const gateway = await startGateway(context, { workspace, serversFile, env: { KCODER_CONFIG_DIR: isolated.configDir,
    KCODER_TRAINING_MODE: 'true', KCODER_MAX_TOKENS: '4096', KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '180', ...credentialEnv } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'model', token));
  context.addCleanup('close workflow authoring RPC', () => rpc.close());
  const initialized = await initializeRpc(rpc, 'workflow-edit-live');
  await context.writeArtifactJson('model-identity.json', {selected: initialized.model, configured: model.model});
  let draft = await rpc.request('workflow/create', { title: 'Report workflow', description: 'Existing report workflow' });
  draft = await rpc.request('workflow/upsertNode', { id: draft.id, expectedRevision: draft.revision,
    node: { id: 'report', title: 'Report', prompt: 'Prepare the requested report' } });
  const original = await rpc.request('workflow/save', { id: draft.id, expectedRevision: draft.revision });
  const thread = await rpc.request('thread/start', { sessionMode: 'workflow_draft', workflowDefinitionId: draft.id });
  const turn = await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text:
    '修改当前已有工作流，不要新建副本，不执行任何节点。保留 report 节点及其内容作为入口。按输入 route 新增三个互斥分支：a、b、以及其他值的默认分支，每个分支一个 Agent；三个分支之后用 any 汇合，再接最终 Output。请先读取当前定义，使用批量原子编辑一次完成改线，保存为下一版本，最后简述修改。' }] });
  let budgetTimer;
  const budget = new Promise((_, reject) => {
    budgetTimer = setInterval(() => {
      const calls = rpc.messages().filter(message => message.method === 'item/started' && message.params?.item?.type === 'toolCall');
      if (calls.length > 12) reject(new Error('Workflow authoring exceeded 12 tool calls'));
    }, 100);
  });
  let completed;
  try {
    completed = await Promise.race([budget, rpc.waitFor(message => isTurnCompletion(message, thread.thread.id, turn.turn.id), 190_000, 'workflow edit completed')]);
  } finally { clearInterval(budgetTimer); }
  assert.equal(completed.params?.turn?.status, 'completed');
  const updated = await rpc.request('workflow/read', { id: draft.id });
  assert.equal(updated.id, original.id);
  assert.equal(updated.savedVersion, 2);
  assert.equal(updated.status, 'saved');
  assert.deepEqual(updated.nodes.find(node => node.id === 'report'), original.nodes[0]);
  const namedRouter = updated.nodes.find(node => node.kind === 'switch' && node.config?.switch?.cases?.length >= 2 && typeof node.config.switch.default === 'string');
  assert.ok(namedRouter || updated.nodes.filter(node => node.kind === 'condition').length >= 3);
  assert.ok(updated.nodes.filter(node => node.runIf).length >= 3);
  assert.ok(updated.nodes.some(node => node.kind === 'merge' && node.config?.mergePolicy === 'any' && node.dependsOn.length >= 3));
  assert.ok(updated.nodes.some(node => node.kind === 'output'));
  const old = await rpc.request('workflow/export', { id: draft.id, version: 1 });
  assert.deepEqual(old, original);
  return { provider: model.provider, model: model.model, nodeCount: updated.nodes.length, version: updated.savedVersion, preservedOriginal: true };
});
