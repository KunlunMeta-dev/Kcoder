import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from './approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { login } from './http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from './rpc.mjs';
import { repoRoot, requireExecutable } from './run-context.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';

export async function verifyNativePluginSourceLeases(context) {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit immutable normal Native CLI');
  const before = await stat(binary), binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_SHA256 ?? process.env.KCODER_E2E_KCODER_BIN_SHA256); assert.equal(before.nlink, 1);
  context.addCleanup('verify Native plugin lease immutable binary', async () => { const after = await stat(binary); assert.deepEqual([after.dev, after.ino, after.size, after.nlink], [before.dev, before.ino, before.size, 1]); assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), binarySha256); });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'native-plugin-leases' });
  const source = context.pathInState('native-plugin-source'), peer = context.pathInState('native-plugin-peer');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true, mode: 0o700 }); await mkdir(peer, { mode: 0o700 });
  await copyFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/native-plugin-lease/server.py'), resolve(source, 'server.py'));
  const version = async number => {
    await writeFile(resolve(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'native-lease-proof', version: `${number}.0.0`, mcpServers: { peer: { command: 'python3', args: ['${CLAUDE_PLUGIN_ROOT}/server.py', peer] } } }));
    await writeFile(resolve(source, 'version.txt'), String(number));
  };
  const calls = async () => (await readFile(resolve(peer, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(value => JSON.parse(value));
  let phase = 'initial', requestedField;
  const protocol = [];
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    assert.ok(model.requests.length <= 24, 'The Native plugin lease protocol has a bounded HTTP budget');
    if (body.messages.at(-1)?.role === 'tool') return [{ delta: { content: 'OWNED_NATIVE_PLUGIN_RESULT_OBSERVED' }, finishReason: 'stop' }];
    const tool = body.tools?.find(value => value.function?.name.includes('lease_read'));
    if (!tool) { protocol.push({ phase, toolMissing: true }); return [{ delta: { content: 'OWNED_NATIVE_PLUGIN_TOOL_UNAVAILABLE' }, finishReason: 'stop' }]; }
    const field = tool.function.parameters.required[0];
    protocol.push({ phase, toolName: tool.function.name, schemaField: field, requestedField: requestedField ?? field });
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `lease-${phase}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ [requestedField ?? field]: phase }) } }] }, finishReason: 'tool_calls' }];
  } });
  await context.writeStateJson('native-profile/settings.json', { active_provider: 'OwnedLease', model: 'owned-lease', credential_store: 'file', permission_mode: 'bypass', max_retries: 0,
    memory: { observer_mode: 'disabled', structured_enabled: false, legacy_prompt_enabled: false }, session_memory: { enabled: false },
    providers: { OwnedLease: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'owned-lease', discover_models: false, no_proxy: true, context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024 } } });
  await context.writeStateJson('native-profile/trusted-folders.json', { trusted: [workspace], never: [] });
  const serversFile = await context.writeStateJson('native-servers.json', [{ id: 'local', label: 'Native old plugin owner', transport: 'local', command: binary, workspace }, { id: 'writer', label: 'Native independent plugin writer', transport: 'local', command: binary, workspace }]);
  await mkdir(context.pathInState('native-gateway-tmp'), { mode: 0o700 });
  const gateway = await startGateway(context, { label: 'native-plugin-lease-gateway', auth: true, workspace, serversFile, kcoderBin: binary, gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT,
    env: { KCODER_CONFIG_DIR: context.pathInState('native-profile'), TMPDIR: context.pathInState('native-gateway-tmp') } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' });
  const open = async target => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, target, token), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close original Native plugin ${target} RPC`, () => closeRpcAndWait(rpc));
    await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: `native-plugin-lease-${target}`, version: '1' }, capabilities: { experimental: { integrationScopeV1: true, taskSourcesV1: true, taskSourceChoicesV1: true, studioWorkModesV1: true } } }, 60000);
    return rpc;
  };
  const rpc = await open('local'), writer = await open('writer'), threads = [];
  context.addCleanup('delete only owned Native plugin threads', async () => { for (const id of threads.splice(0).reverse()) await rpc.request('thread/delete', { threadId: id }); });
  const start = async () => { const result = await rpc.request('thread/start', { cwd: workspace, studioWorkMode: 'kcoder' }, 45000); threads.push(result.thread.id); return result.thread.id; };
  const scope = await rpc.request('integrations/scope/read', {}); let serial = 0;
  const read = async (method, tuple) => {
    const value = await rpc.request(`integrations/tasks/${method}`, { contractVersion: 'parallel-v1', requestId: `native-lease-${++serial}`, scope, timeoutMs: 15000,
      payload: method === 'listTaskSourceChoices' ? { target: { initialAttempt: tuple } } : { target: { initialAttempt: tuple }, params: { threadId: tuple.threadId } } });
    assert.equal(value.status, 'completed', value.error?.code); return value.result;
  };
  const results = [];
  const run = async (threadId, name, expectedVersion, wrongField) => {
    phase = name; requestedField = wrongField;
    const boundary = new Set(rpc.messages()), previous = (await calls()).length;
    const accepted = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: `OWNED_NATIVE_PLUGIN_PHASE:${name}` }], clientPresentation: { version: 1, studioWorkMode: 'kcoder' } }, 45000);
    const terminal = await rpc.waitFor(value => !boundary.has(value) && value.method === 'turn/completed' && value.params?.threadId === threadId && value.params?.turnId === accepted.turn.id, 45000, `original Native lease ${name}`);
    const started = rpc.messages().find(value => !boundary.has(value) && value.method === 'turn/started' && value.params?.threadId === threadId && (value.params?.turnId ?? value.params?.turn?.id) === accepted.turn.id);
    const tuple = { threadId, turnId: accepted.turn.id, attemptId: started?.params?.attemptId ?? started?.params?.turn?.attemptId };
    assert.ok(tuple.attemptId, 'The original Native accepted attempt must be observed');
    const observed = (await calls()).slice(previous);
    if (expectedVersion) { assert.equal(terminal.params.turn.status, 'completed'); assert.deepEqual(observed.map(value => [value.version, value.phase]), [[String(expectedVersion), name]]); }
    else assert.deepEqual(observed, [], 'The real MCP peer must receive no invocation after current denial');
    results.push({ name, tuple, status: terminal.params.turn.status, calls: observed }); return tuple;
  };
  await version(1); const first = await writer.request('plugin/install', { path: source });
  const a = await start(), original = await run(a, 'a-version-one', 1), originalSources = await read('readTaskSources', original);
  await version(2); const second = await writer.request('plugin/install', { path: source }); assert.notEqual(first.plugin.root, second.plugin.root);
  const b = await start(), current = await run(b, 'b-version-two', 2), currentSources = await read('readTaskSources', current);
  const retained = await run(a, 'a-retained-one', 1), retainedSources = await read('readTaskSources', retained), retainedCatalog = await read('listTaskSourceChoices', retained);
  assert.deepEqual(retainedSources.effectiveSources, originalSources.effectiveSources); assert.notDeepEqual(currentSources.effectiveSources, originalSources.effectiveSources);
  assert.ok(retainedCatalog.items.some(value => value.reasonCode === 'NATIVE_SOURCE_RETAINED_PLUGIN_VERSION' && value.state === 'ready'));
  await run(b, 'b-old-schema-refused', null, 'version_1');
  await writer.request('plugin/disable', { pluginId: second.plugin.id }); await run(a, 'a-current-disabled', null);
  await writer.request('plugin/enable', { pluginId: second.plugin.id }); await run(a, 'a-enabled-original', 1);
  await writer.request('plugin/uninstall', { pluginId: second.plugin.id, purgeData: false });
  assert.ok(await stat(first.plugin.root)); await run(a, 'a-current-uninstalled', null);
  assert.deepEqual((await calls()).map(value => value.version), ['1', '2', '1', '1']);
  await context.writeArtifactJson('actual-native-plugin-source-lease-proof.json', { binarySha256, original, originalSources, currentSources, retainedSources, retainedCatalog, results, protocol, actualCalls: await calls(), paidModelCalls: 0, providerRequests: model.requests.length,
    limitations: ['Actual owned local plugin installation, versioned files, MCP/Native SourceGuard and original task calls; no external platform/account/model quality claim.', 'This Linux native acceptance does not prove Windows or Electron host behavior.'] });
  return { originalLeaseRetained: true, differentCurrentVersion: true, currentDisableAndUninstallDeny: true, currentSchemaRejectsOldArguments: true, actualMcpCalls: 4, paidModelCalls: 0 };
}
