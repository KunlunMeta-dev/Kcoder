import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { prepareIsolatedRealModelConfig, realModelPreflight } from '../../harness/real-model.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc, isTurnCompletion } from '../../harness/rpc.mjs';
import { runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
// QA: install a real prompt plugin, expose its launcher, ask a real parent to
// delegate, and require the child transcript to prove actual file reading.
await runE2E(import.meta.url, { testId: 'real-model-plugin-agent-execution', tier: 'manual-live',
  modelPolicy: 'real-model-required; one parent turn, one child capped at 3 turns, at most 6 parent tool calls, 2048 output tokens per request and 150s total' }, async context => {
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || 'kunlunmeta');
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const isolated = await prepareIsolatedRealModelConfig(context, model);
  const base = JSON.parse(await readFile(isolated.settingsFile, 'utf8'));
  const settingsFile = await context.writeStateJson('plugin-settings.json', {
    ...base, tools: { profile: 'full', disabled: [] }, permission_mode: 'bypass', max_retries: 0,
    skills: { trust_external: true }, memory: { structured_enabled: false, legacy_prompt_enabled: false, observer_mode: 'disabled' },
    providers: { [model.provider]: { ...model.providerConfig, request_timeout_secs: 45, max_output_tokens: 2048, reasoning_effort: null,
      models: { [model.model]: { ...model.providerConfig.models?.[model.model], context_window_tokens: model.providerConfig.models?.[model.model]?.context_window_tokens ?? model.providerConfig.context_window_tokens ?? 128000, max_output_tokens: 2048, output_headroom_tokens: 2048, reasoning_effort: null } } } },
  });
  const marker = `PLUGIN_PROOF_${randomBytes(6).toString('hex')}`;
  await writeFile(resolve(workspace, 'evidence.txt'), marker);
  const source = context.pathInState('plugin');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true }); await mkdir(resolve(source, 'agents'));
  await writeFile(resolve(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'proof-plugin', version: '1.0.0' }));
  await writeFile(resolve(source, 'agents/reader.md'), '---\nname: evidence-reader\ndescription: Read evidence from the workspace\ntools: Read\nmaxTurns: 3\n---\nRead evidence.txt with the read tool and return its exact contents. Do not guess. Do not modify files.');
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'model', label: 'Model', transport: 'local', command: model.kcoderBin, workspace, settingsFile, profile: model.profile }]);
  const credentialEnv = Object.fromEntries(model.credentialEnv.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const gateway = await startGateway(context, { workspace, serversFile, env: { KCODER_CONFIG_DIR: isolated.configDir, KCODER_TRAINING_MODE: 'false', KCODER_MAX_TOKENS: '2048', KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '120', ...credentialEnv } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'model', token)); context.addCleanup('close plugin model RPC', () => rpc.close());
  await initializeRpc(rpc, 'plugin-prompt-model');
  const installed = await rpc.request('plugin/install', { path: source });
  const name = installed.plugin.components.find(value => value.kind === 'skill' && value.name.startsWith('plugin:'))?.name;
  assert.ok(name);
  const { thread } = await rpc.request('thread/start', {});
  const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: `请使用已安装的插件技能 ${name}：先调用 Skill 加载它，然后调用 spawn_agent，plugin_agent 填写这个精确名称，message 为“读取 evidence.txt 并返回原文”，context_mode=none。等待这个子代理完成，再返回它读到的原文。你自己不要读取文件，不要创建第二个子代理。` }] });
  let timer;
  try {
    const budget = new Promise((_, reject) => { timer = setInterval(() => {
      const calls = rpc.messages().filter(value => value.method === 'item/started' && value.params?.item?.type === 'toolCall');
      if (calls.length > 6) reject(new Error('Plugin model test exceeded tool budget'));
    }, 100); });
    const completion = await Promise.race([budget, rpc.waitFor(value => isTurnCompletion(value, thread.id, turn.id), 150000, 'plugin agent completed')]);
    assert.equal(completion.params?.turn?.status, 'completed');
  } finally { clearInterval(timer); }
  const agents = (await rpc.request('agent/list', { threadId: thread.id })).agents;
  await context.writeArtifactJson('plugin-parent-events.json', { agents, events: rpc.messages() });
  assert.equal(agents.length, 1);
  const transcript = await rpc.request('agent/artifact/read', { threadId: thread.id, agentId: agents[0].agentId, kind: 'transcript' });
  await context.writeArtifactJson('plugin-child-transcript.json', transcript);
  const output = await rpc.request('agent/artifact/read', { threadId: thread.id, agentId: agents[0].agentId, kind: 'output' });
  await context.writeArtifactJson('plugin-execution-evidence.json', { transcript, output });
  assert.ok(/"name"\s*:\s*"read"/.test(transcript.content), 'real child used read');
  assert.ok(transcript.content.includes(marker), 'child transcript includes actual file content');
  assert.ok(output.content.includes(marker), 'child result matches actual file');
  await context.writeArtifactJson('plugin-model-result.json', { provider: model.provider, model: model.model, plugin: installed.plugin.id, agentCount: agents.length, realChildRead: true, resultMatchesFile: true });
});
