import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'skill-project-trust-revocation-live-registry', tier: 'full-integration',
  modelPolicy: 'model-independent skill activation and trust policy; fixed HTTP tool calls',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'skill-trust' });
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    const latest = body.messages.findLastIndex(message => message.role === 'user' && /SKILL_TRUST_(FIRST|REVOKED|RESTORED)/.test(JSON.stringify(message.content)));
    if (body.messages.slice(latest + 1).some(message => message.role === 'tool')) return [{ delta: { role: 'assistant', content: 'Fixture complete.' }, finishReason: 'stop' }];
    assert.ok(body.tools.some(tool => tool.function.name === 'skill'));
    return [{ delta: { role: 'assistant', tool_calls: ['project-fixture', 'plugin-fixture'].map((name, index) => ({ index, id: `skill-${index}`, type: 'function', function: { name: 'skill', arguments: JSON.stringify({ skill: name }) } })) }, finishReason: 'tool_calls' }];
  } });
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0, skills: { trust_external: true },
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true } } });
  await context.writeStateJson('config/credentials.json', {});
  await context.writeStateJson('config/trusted-folders.json', { trusted: [workspace], never: [] });
  const projectSkill = resolve(workspace, '.kcoder/skills/project-fixture');
  const pluginRoot = resolve(workspace, '.kcoder/plugins/demo');
  const pluginSkill = resolve(pluginRoot, 'skills/plugin-fixture');
  await mkdir(projectSkill, { recursive: true });
  await mkdir(pluginSkill, { recursive: true });
  await mkdir(resolve(pluginRoot, '.claude-plugin'), { recursive: true });
  await writeFile(resolve(pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0', skills: './skills' }));
  for (const [dir, name] of [[projectSkill, 'project-fixture'], [pluginSkill, 'plugin-fixture']]) {
    await writeFile(resolve(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Controlled trust fixture\n---\nSKILL_FIXTURE_BODY_${name}\n`);
  }
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Skill trust', transport: 'local', command: resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/full-profile-kcoder.mjs'), workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: context.pathInState('config'), KCODER_E2E_KCODER_BIN: binary } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close skill trust RPC', () => rpc.close());
  await initializeRpc(rpc, 'skill-project-trust');
  const { thread } = await rpc.request('thread/start', {});
  const run = async marker => {
    const before = new Set(rpc.messages());
    const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: marker }] });
    const terminal = await rpc.waitFor(message => !before.has(message) && message.method === 'turn/completed' && message.params?.turnId === turn.id, 45000, 'skill trust turn');
    await context.writeArtifactJson(`terminal-${marker}.json`, terminal.params);
    assert.ok(model.requests.length, 'turn must reach the owned model fixture');
    const body = model.requests.at(-1);
    const latest = body.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes(marker));
    const results = body.messages.slice(latest + 1).filter(message => message.role === 'tool');
    await context.writeArtifactJson(`skill-${marker}.json`, { turn: terminal.params.turn, toolNames: body.tools?.map(tool => tool.function?.name), roles: body.messages.map(message => message.role), requests: model.requests.length, frames: rpc.messages().filter(message => !before.has(message) && message.method) });
    assert.equal(results.length, 2);
    return results.map(result => JSON.stringify(result.content));
  };
  const first = await run('SKILL_TRUST_FIRST');
  assert.ok(first.every(value => value.includes('Activated skill')));
  await rpc.request('plugin/trust/set', { path: workspace, action: 'revoke' });
  const denied = await run('SKILL_TRUST_REVOKED');
  assert.ok(denied.every(value => value.includes('trust was revoked')));
  await rpc.request('plugin/trust/set', { path: workspace, action: 'trust' });
  const restored = await run('SKILL_TRUST_RESTORED');
  assert.ok(restored.every(value => value.includes('Skill already active')));
  await rpc.request('thread/delete', { threadId: thread.id });
  return { projectAndPluginSkills: true, revokedActivationDenied: true, originalThreadRestored: true };
});
