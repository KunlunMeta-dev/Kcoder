import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { login } from '../../harness/http.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl, isTurnCompletion } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { toolResult } from '../office/native-download-model.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function receipt(body, id) {
  const result = toolResult(body, id);
  assert.ok(result, 'original native tool receipt must reach the next actual HTTP request');
  const text = result.text;
  assert.equal(typeof text, 'string');
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'bounded actual discovery JSON receipt required');
  return JSON.parse(match[1]);
}
await runE2E(import.meta.url, { testId: 'normal-discovery-catalog-facts-and-original-request-prefix', tier: 'full-integration',
  modelPolicy: 'Three bounded deterministic loopback Provider requests through one normal KWorker turn. Actual native tool_search only; no matched tool execution, app installation, external account, paid provider or model-quality/cache-hit claim.' },
async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit frozen normal CLI');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  let prefix, system; const reports = [], failures = [];
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body, requestNumber }) => {
    try {
      assert.ok(requestNumber <= 3);
      const tools = digest(body.tools), systemPrefix = digest(body.messages.filter(message => message.role === 'system'));
      prefix ??= tools; system ??= systemPrefix;
      assert.equal(tools, prefix, 'native top-level schemas and order stay fixed');
      assert.equal(systemPrefix, system, 'original system prefix stays fixed');
      assert.ok(body.tools.some(tool => tool.function?.name === 'tool_search'));
      if (requestNumber === 2) {
        const actual = receipt(body, 'native-discovery-attached');
        assert.equal(actual.catalog_kind, 'registered_deferred_tools');
        assert.equal(actual.empty_reason, 'matching_tools_already_attached');
        assert.ok(actual.directly_available_matches > 0); assert.deepEqual(actual.tools, []); reports.push(actual);
      }
      if (requestNumber === 3) {
        const actual = receipt(body, 'native-discovery-no-match');
        assert.equal(actual.catalog_kind, 'registered_deferred_tools');
        assert.ok(['no_permitted_deferred_tools', 'no_keyword_match'].includes(actual.empty_reason));
        assert.deepEqual(actual.tools, []); assert.equal(actual.mcpConfigured, undefined); assert.equal(actual.applicationInstalled, undefined); reports.push(actual);
      }
    } catch (error) { failures.push(String(error.message)); }
    if (requestNumber >= 3 || failures.length) return [{ delta: { content: 'NATIVE_DISCOVERY_OBSERVATIONS_ONLY' }, finishReason: 'stop' }];
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0,
      id: requestNumber === 1 ? 'native-discovery-attached' : 'native-discovery-no-match', type: 'function', function: {
        name: 'tool_search', arguments: JSON.stringify({ query: requestNumber === 1 ? 'read' : 'mcp__unknown__not_registered', limit: 1 }),
      } }] }, finishReason: 'tool_calls' }];
  } });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'discovery-catalog' });
  const settingsFile = await context.writeStateJson('profile/settings.json', { permission_mode: 'yolo', active_provider: 'OwnedDiscovery', model: 'metadata', max_retries: 0,
    memory: { observer_mode: 'disabled', structured_enabled: false, legacy_prompt_enabled: false }, session_memory: { enabled: false },
    mcp_servers: [], integrations: { office: { enabled: false } }, providers: { OwnedDiscovery: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'metadata', discover_models: false,
      no_proxy: true, context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024, capabilities: { text: true, tools: true } } } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned discovery', transport: 'local', command: binary, workspace, settingsFile }]);
  const gateway = await startGateway(context, { auth: true, workspace, serversFile, kcoderBin: binary,
    ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}), env: { KCODER_CONFIG_DIR: context.pathInState('profile') } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup('close original discovery owner', () => closeRpcAndWait(rpc));
  await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'native-discovery-catalog', version: '1' },
    capabilities: { experimental: { studioWorkModesV1: true } } });
  const thread = await rpc.request('thread/start', { studioWorkMode: 'kworker' });
  const threadId = thread.thread.id;
  const turn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'RDY03_NATIVE_DISCOVERY: inspect only tool discovery metadata' }],
    clientPresentation: { version: 1, studioWorkMode: 'kworker' } });
  const completed = await rpc.waitFor(message => isTurnCompletion(message, threadId, turn.turn.id), 30000, 'one ordinary native discovery turn');
  await context.writeArtifactJson('actual-discovery-catalog-proof.json', { binarySha256, reports, failures, nativeToolPrefixSha256: prefix,
    originalSystemPrefixSha256: system, controlledProviderRequests: model.requests.length, paidProviderRequests: 0,
    discoveryDoesNotExecuteMatchedTools: true, appCatalogLoadedAsToolSchemas: false });
  assert.deepEqual(failures, []); assert.equal(completed.params.turn.status, 'completed'); assert.equal(model.requests.length, 3);
  return { nativeToolPrefixStable: true, originalSystemPrefixStable: true, providerRequests: 3, modelQualityTest: false };
});
