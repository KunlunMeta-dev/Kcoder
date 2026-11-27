import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from './approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { login } from './http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from './rpc.mjs';
import { repoRoot, requireExecutable, waitFor } from './run-context.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';

/** Correlate native observations; synthetic oracle tests do not prove Native acceptance. */
export function assertNativePluginLeaseEvidence(value) {
  const { name, tuple, version, invocation, terminal, frames, calls, sourceSnapshot, sourceCatalog, expectedServer, positive, denial, wrongField } = value;
  assert.ok(invocation && invocation.phase === name, 'An exposed invocation is required');
  const field = `version_${version}`;
  assert.deepEqual(invocation.schema.required, [field], 'Exact version schema is required');
  assert.deepEqual(Object.keys(invocation.schema.properties), [field], 'Exact version schema properties are required');
  assert.equal(invocation.schema.type, 'object'); assert.equal(invocation.schema.additionalProperties, false);
  assert.equal(invocation.schema.properties[field].type, 'string'); assert.equal(invocation.schema.properties[field].maxLength, 64);
  assert.deepEqual(invocation.input, { [wrongField ?? field]: name }, 'The attempted input must match the observed version schema');
  assert.equal(sourceSnapshot.threadId, tuple.threadId);
  assert.equal(sourceSnapshot.effectiveSources.length, 1, 'One exact positive source must be bound');
  const sourceChoice = sourceSnapshot.effectiveSources[0];
  if (positive) {
    assert.equal(positive.outcome, 'peer_completed', 'The positive control must have completed at the real peer');
    assert.deepEqual(sourceChoice, positive.sourceChoice, 'The positive source must remain bound');
    assert.equal(invocation.toolName, positive.invocation.toolName, 'The exact positive tool must be exposed');
    assert.deepEqual(invocation.schema, positive.invocation.schema, 'The exact positive schema must be exposed');
  }
  const descriptors = sourceCatalog.items.filter(item => item.sourceRef.id === sourceChoice.sourceRef.id && item.sourceRef.revision === sourceChoice.sourceRef.revision);
  assert.equal(descriptors.length, 1, 'The exact positive source must be independently observed');
  const descriptor = descriptors[0];
  assert.deepEqual(descriptor.accountRef, sourceChoice.accountRef); assert.equal(descriptor.kind, 'plugin_mcp');
  assert.equal(descriptor.displayName, expectedServer); assert.equal(descriptor.state, 'ready'); assert.ok(descriptor.capabilities.includes('tools'));
  const currentFrames = frames.filter(frame => frame.params?.threadId === tuple.threadId && frame.params?.turnId === tuple.turnId);
  const starts = currentFrames.filter(frame => frame.method === 'item/started' && frame.params.item?.type === 'toolCall' && frame.params.item?.id === invocation.toolCallId && frame.params.item?.name === invocation.toolName);
  assert.equal(starts.length, 1, 'One exact native tool start must be observed');
  assert.equal(starts[0].params.item.inputTruncated, false); assert.deepEqual(starts[0].params.item.input, invocation.input, 'The native tool input must match the exposed invocation');
  const outputs = currentFrames.filter(frame => frame.method === 'item/completed' && frame.params.attemptId === tuple.attemptId && frame.params.item?.type === 'toolCall' && frame.params.item?.id === invocation.toolCallId && frame.params.item?.name === invocation.toolName);
  assert.equal(outputs.length, 1, 'One exact native tool result must be observed');
  const toolResult = outputs[0].params.item;
  assert.equal(toolResult.outputTruncated, false, 'Truncated output cannot establish provenance');
  assert.equal(terminal.method, 'turn/completed'); assert.equal(terminal.params.threadId, tuple.threadId); assert.equal(terminal.params.turnId, tuple.turnId); assert.equal(terminal.params.turn.id, tuple.turnId);
  const denials = currentFrames.filter(frame => frame.method === 'item/event' && frame.params.event?.type === 'tool_denied' && frame.params.event?.id === invocation.toolCallId && frame.params.event?.name === invocation.toolName);
  let outcome;
  if (denial) {
    assert.ok(positive, 'Revocation requires a successful original invocation');
    assert.deepEqual(calls, [], 'There must be no peer invocation after revocation');
    assert.equal(toolResult.status, 'failed'); assert.equal(toolResult.output, 'NATIVE_TASK_AUTHORITY_UNAVAILABLE', 'The native result must identify revoked-source authority unavailability');
    assert.equal(denials.length, 1, 'One authority-denied event must identify the invocation');
    assert.equal(denials[0].params.event.reason, 'NATIVE_TASK_AUTHORITY_UNAVAILABLE', 'The authority-denied event must identify the revoked-source boundary');
    // The next provider admission also fails closed for the revoked selected source.
    assert.equal(terminal.params.turn.status, 'failed', 'The revoked turn terminal must be checked');
    assert.equal(terminal.params.error?.message, 'NATIVE_TASK_AUTHORITY_UNAVAILABLE', 'The revoked turn error must identify source authority');
    const review = terminal.params.reviewEvidence;
    assert.ok(review && review.version === 1 && review.state === 'settled', 'Native settled review evidence is required');
    assert.deepEqual([review.threadId, review.turnId, review.attemptId], [tuple.threadId, tuple.turnId, tuple.attemptId], 'Native review evidence must identify the exact attempt');
    assert.equal(review.omittedCount, 0, 'Revocation review evidence must be complete');
    const observations = review.observations.filter(item => item.toolCallId === invocation.toolCallId && item.toolName === invocation.toolName);
    assert.equal(observations.length, 1, 'One exact native revocation review observation is required');
    assert.equal(observations[0].outcome, 'denied', 'The original native review must classify the tool outcome as denied');
    assert.equal(observations[0].outputPreview, 'NATIVE_TASK_AUTHORITY_UNAVAILABLE');
    assert.equal(observations[0].detailsTruncated, false);
    assert.deepEqual(denial.sourceSnapshot.effectiveSources, sourceSnapshot.effectiveSources);
    assert.equal(denial.guardDiagnostic?.stage, 'tool', 'The exact owned Native tool guard diagnostic is required');
    assert.equal(denial.guardDiagnostic.code, denial.action === 'disabled' ? 'NATIVE_PLUGIN_GLOBALLY_DISABLED' : 'PLUGIN_VERSION_UNINSTALLED', 'The owned diagnostic must identify the exact plugin revocation boundary');
    if (denial.action === 'disabled') {
      assert.ok(!denial.sourceCatalog.items.some(item => item.state === 'ready' && item.sourceRef.id === sourceChoice.sourceRef.id && item.sourceRef.revision === sourceChoice.sourceRef.revision), 'The original source must no longer be ready');
    } else {
      const reply = denial.sourceCatalogReply;
      assert.ok(reply && reply.contractVersion === 'parallel-v1', 'The original unavailable source-catalog envelope is required');
      assert.equal(reply.status, 'unavailable'); assert.equal(reply.result, null);
      assert.deepEqual(reply.error, { code: 'TASK_CAPABILITY_SOURCE_CHOICES_UNAVAILABLE', messageKey: 'integrations.tasks.sourceChoicesUnavailable', recovery: 'retry_read' });
      assert.equal(denial.sourceCatalog, undefined, 'An unavailable catalog must not be replaced by fabricated items');
    }
    const before = denial.before.plugins.filter(plugin => plugin.id === denial.pluginId);
    assert.equal(before.length, 1); assert.equal(before[0].root, denial.currentRoot); assert.equal(before[0].enabled, true);
    const after = denial.after.plugins.filter(plugin => plugin.id === denial.pluginId);
    if (denial.action === 'disabled') {
      assert.equal(after.length, 1, 'Exact disabled plugin readback is required');
      assert.equal(after[0].root, denial.currentRoot); assert.equal(after[0].enabled, false, 'Exact disabled plugin readback is required');
    } else { assert.equal(denial.action, 'uninstalled'); assert.deepEqual(after, [], 'Exact uninstalled plugin readback is required'); }
    outcome = 'revoked_source_authority_unavailable';
  } else {
    assert.equal(terminal.params.turn.status, 'completed', 'A completed turn is required');
    assert.ok(terminal.params.error === undefined || terminal.params.error === null, 'A completed turn must not carry an error');
    assert.deepEqual(denials, [], 'Schema validation and success must not be relabeled as authority denial');
    if (wrongField) {
      assert.ok(positive, 'Schema rejection requires a successful current-schema control'); assert.notEqual(wrongField, field);
      assert.deepEqual(calls, [], 'There must be no peer invocation for the old schema'); assert.equal(toolResult.status, 'failed');
      assert.ok(toolResult.output.startsWith(`Tool \`${invocation.toolName}\` input validation failed.\nDetails: $.${field}: missing required field. Expected field \`${field}\` to be present.\nThe tool was not executed.`), 'The native schema rejection must identify the exact required field');
      outcome = 'schema_rejected';
    } else {
      assert.equal(toolResult.status, 'completed'); assert.equal(calls.length, 1);
      assert.deepEqual([calls[0].version, calls[0].phase], [String(version), name]);
      assert.ok(Number.isInteger(calls[0].pid) && calls[0].pid > 0);
      assert.deepEqual(JSON.parse(toolResult.output), calls[0], 'The native result must match the independently recorded peer invocation');
      outcome = 'peer_completed';
    }
  }
  return { name, tuple, status: terminal.params.turn.status, outcome, invocation, sourceChoice, sourceSnapshot, sourceCatalog, calls, toolResult, denial, denialEvent: denials[0]?.params.event };
}

export async function settleNativePluginLeaseThreads(rpc, activeTurns, threads) {
  for (const [threadId, turnId] of activeTurns) {
    await rpc.request('turn/interrupt', { threadId, turnId });
    await rpc.waitFor(frame => frame.method === 'turn/completed' && frame.params?.threadId === threadId && frame.params?.turnId === turnId,
      15000, 'original owned Native plugin terminal before deletion');
    activeTurns.delete(threadId);
  }
  for (const id of [...threads].reverse()) {
    await rpc.request('thread/delete', { threadId: id });
    threads.splice(threads.indexOf(id), 1);
  }
}

export async function verifyNativePluginSourceLeases(context) {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit immutable normal Native CLI');
  const before = await stat(binary), binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_SHA256 ?? process.env.KCODER_E2E_KCODER_BIN_SHA256); assert.equal(before.nlink, 1);
  context.addCleanup('verify Native plugin lease immutable binary', async () => { const after = await stat(binary); assert.deepEqual([after.dev, after.ino, after.size, after.nlink], [before.dev, before.ino, before.size, 1]); assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), binarySha256); });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'native-plugin-leases' });
  const { path: writerWorkspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'native-plugin-writer' });
  const source = context.pathInState('native-plugin-source'), peer = context.pathInState('native-plugin-peer');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true, mode: 0o700 }); await mkdir(peer, { mode: 0o700 });
  await copyFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/native-plugin-lease/server.py'), resolve(source, 'server.py'));
  const version = async number => {
    await writeFile(resolve(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'native-lease-proof', version: `${number}.0.0`, mcpServers: { peer: { command: 'python3', args: ['${CLAUDE_PLUGIN_ROOT}/server.py', peer] } } }));
    await writeFile(resolve(source, 'version.txt'), String(number));
  };
  const calls = async () => (await readFile(resolve(peer, 'calls.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(value => JSON.parse(value));
  let phase;
  const protocol = [];
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    assert.ok(model.requests.length <= 24, 'The Native plugin lease protocol has a bounded HTTP budget');
    if (body.messages.at(-1)?.role === 'tool') return [{ delta: { content: 'OWNED_NATIVE_PLUGIN_RESULT_OBSERVED' }, finishReason: 'stop' }];
    const active = phase, tools = body.tools?.filter(value => value.function?.name.includes('lease_read')) ?? [];
    assert.equal(tools.length, 1, 'The exact registered plugin reader must be exposed before its boundary');
    assert.ok(!active.invocation, 'Only one invocation is issued per owned phase');
    const tool = tools[0].function;
    assert.ok(tool.description.startsWith(`[MCP: ${active.expectedServer}::lease_read]`), 'The exposed reader must belong to the installed plugin server');
    active.invocation = { phase: active.name, toolName: tool.name, toolCallId: `lease-${active.name}`, schema: structuredClone(tool.parameters), input: { [active.wrongField ?? `version_${active.version}`]: active.name } };
    protocol.push(active.invocation);
    return [{ ready: () => active.released, delta: { role: 'assistant', tool_calls: [{ index: 0, id: active.invocation.toolCallId, type: 'function', function: { name: tool.name, arguments: JSON.stringify(active.invocation.input) } }] }, finishReason: 'tool_calls' }];
  } });
  await context.writeStateJson('native-profile/settings.json', { active_provider: 'OwnedLease', model: 'owned-lease', credential_store: 'file', permission_mode: 'bypass', max_retries: 0,
    memory: { observer_mode: 'disabled', structured_enabled: false, legacy_prompt_enabled: false }, session_memory: { enabled: false },
    providers: { OwnedLease: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'owned-lease', discover_models: false, no_proxy: true, context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024 } } });
  await context.writeStateJson('native-profile/trusted-folders.json', { trusted: [workspace, writerWorkspace], never: [] });
  // The user plugin store is profile-wide; each Native scope keeps its original owner.
  const serversFile = await context.writeStateJson('native-servers.json', [{ id: 'local', label: 'Native old plugin owner', transport: 'local', command: binary, workspace }, { id: 'writer', label: 'Native independent plugin writer', transport: 'local', command: binary, workspace: writerWorkspace }]);
  await mkdir(context.pathInState('native-gateway-tmp'), { mode: 0o700 });
  const gateway = await startGateway(context, { label: 'native-plugin-lease-gateway', auth: true, workspace, serversFile, kcoderBin: binary, gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT, redactedStderrDiagnostics: true,
    env: { KCODER_CONFIG_DIR: context.pathInState('native-profile'), TMPDIR: context.pathInState('native-gateway-tmp') } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' });
  const initializations = {};
  const open = async target => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, target, token), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close original Native plugin ${target} RPC`, () => closeRpcAndWait(rpc));
    const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: `native-plugin-lease-${target}`, version: '1' }, capabilities: { experimental: { integrationScopeV1: true, taskSourcesV1: true, taskSourceChoicesV1: true, studioWorkModesV1: true } } }, 60000);
    for (const capability of ['integrationScopeV1', 'taskSourcesV1', 'taskSourceChoicesV1', 'studioWorkModesV1']) assert.equal(initialized.capabilities?.experimental?.[capability], true, `Native ${capability} must be negotiated`);
    assert.equal(initialized.cwd, target === 'local' ? workspace : writerWorkspace);
    assert.ok(typeof initialized.sessionId === 'string' && initialized.sessionId);
    initializations[target] = initialized;
    return rpc;
  };
  const rpc = await open('local'), writer = await open('writer'), threads = [], activeTurns = new Map();
  context.addCleanup('settle only owned Native plugin turns and delete threads', () => settleNativePluginLeaseThreads(rpc, activeTurns, threads), { timeoutMs: 45000 });
  const start = async () => { const result = await rpc.request('thread/start', { cwd: workspace, studioWorkMode: 'kcoder' }, 45000); threads.push(result.thread.id); return result.thread.id; };
  const scope = await rpc.request('integrations/scope/read', {}), writerScope = await writer.request('integrations/scope/read', {}); let serial = 0;
  assert.notEqual(initializations.local.sessionId, initializations.writer.sessionId, 'The plugin writer must have an independent Native process identity');
  assert.equal(scope.accountId, writerScope.accountId); assert.equal(scope.targetId, writerScope.targetId);
  assert.notDeepEqual(scope.workspaceId, writerScope.workspaceId, 'Independent Native owners require independent workspace scopes');
  const scopeEvidence = { scope, writerScope, initializations, workspace, writerWorkspace, sharedStore: context.pathInState('native-profile/plugin_store') };
  await context.writeArtifactJson('native-plugin-original-owner-scopes.json', scopeEvidence);
  const read = async (method, tuple, { uninstalledCatalogue = false } = {}) => {
    const requestId = `native-lease-${++serial}`;
    const value = await rpc.request(`integrations/tasks/${method}`, { contractVersion: 'parallel-v1', requestId, scope, timeoutMs: 15000,
      payload: method === 'listTaskSourceChoices' ? { target: { initialAttempt: tuple } } : { target: { initialAttempt: tuple }, params: { threadId: tuple.threadId } } });
    assert.equal(value.contractVersion, 'parallel-v1'); assert.equal(value.requestId, requestId);
    if (uninstalledCatalogue) {
      assert.equal(method, 'listTaskSourceChoices');
      await context.writeArtifactJson(`native-plugin-${requestId}-uninstalled-source-catalog-reply.json`, value);
      assert.equal(value.status, 'unavailable'); assert.equal(value.error?.code, 'TASK_CAPABILITY_SOURCE_CHOICES_UNAVAILABLE');
      return value;
    }
    assert.equal(value.status, 'completed', value.error?.code); return value.result;
  };
  const results = [];
  const run = async (threadId, name, version, { wrongField, positive, revoke } = {}) => {
    const active = phase = { name, version, wrongField, expectedServer: `plugin.${first.plugin.id}.peer`, released: !revoke };
    const boundary = new Set(rpc.messages()), previous = (await calls()).length;
    const diagnosticBoundary = gateway.stderrDiagnostics.snapshot().text.length;
    const accepted = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: `OWNED_NATIVE_PLUGIN_PHASE:${name}` }], clientPresentation: { version: 1, studioWorkMode: 'kcoder' } }, 45000);
    activeTurns.set(threadId, accepted.turn.id);
    const started = await rpc.waitFor(value => !boundary.has(value) && value.method === 'turn/started' && value.params?.threadId === threadId && (value.params?.turnId ?? value.params?.turn?.id) === accepted.turn.id, 15000, 'original Native accepted attempt');
    const tuple = { threadId, turnId: accepted.turn.id, attemptId: started?.params?.attemptId ?? started?.params?.turn?.attemptId };
    assert.ok(tuple.attemptId, 'The original Native accepted attempt must be observed');
    let sourceSnapshot, sourceCatalog, denial;
    if (revoke) {
      await waitFor(() => Boolean(active.invocation), 15000, 'actual Provider exposure before revocation', 20, context.abortSignal);
      sourceSnapshot = await read('readTaskSources', tuple); sourceCatalog = await read('listTaskSourceChoices', tuple);
      try {
        const before = await writer.request('plugin/list', { all: true });
        await writer.request(revoke === 'disabled' ? 'plugin/disable' : 'plugin/uninstall', { pluginId: second.plugin.id, ...(revoke === 'uninstalled' ? { purgeData: false } : {}) });
        denial = { action: revoke, pluginId: second.plugin.id, currentRoot: second.plugin.root, before, after: await writer.request('plugin/list', { all: true }),
          sourceSnapshot: await read('readTaskSources', tuple) };
        if (revoke === 'uninstalled') denial.sourceCatalogReply = await read('listTaskSourceChoices', tuple, { uninstalledCatalogue: true });
        else denial.sourceCatalog = await read('listTaskSourceChoices', tuple);
      } finally { active.released = true; }
    }
    const terminal = await rpc.waitFor(value => !boundary.has(value) && value.method === 'turn/completed' && value.params?.threadId === threadId && value.params?.turnId === accepted.turn.id, 45000, `original Native lease ${name}`);
    activeTurns.delete(threadId);
    if (denial) {
      const expectedCode = revoke === 'disabled' ? 'NATIVE_PLUGIN_GLOBALLY_DISABLED' : 'PLUGIN_VERSION_UNINSTALLED';
      denial.guardDiagnostic = await waitFor(() => {
        const captured = gateway.stderrDiagnostics.snapshot();
        assert.equal(captured.overflow, false, 'Native guard diagnostics must fit their owned capture');
        const lines = captured.text.slice(diagnosticBoundary).split('\n').filter(line => line.includes('Native task source boundary unavailable') && line.includes('source_guard_stage="tool"'));
        if (!lines.length) return null;
        assert.equal(lines.length, 1, 'One Native tool guard diagnostic must accompany the revoked invocation');
        assert.equal(lines[0].match(/source_guard_code=([A-Z0-9_:]+)/)?.[1], expectedCode, 'The owned diagnostic must identify the exact plugin revocation boundary');
        return { evidenceClass: captured.evidenceClass, ownerLabel: captured.ownerLabel, phase: name, stage: 'tool', code: expectedCode, lines };
      }, 2000, `original Native ${revoke} guard diagnostic`, 20, context.abortSignal);
    }
    sourceSnapshot ??= await read('readTaskSources', tuple); sourceCatalog ??= await read('listTaskSourceChoices', tuple);
    const observation = { name, tuple, version, wrongField, invocation: active.invocation, terminal, frames: rpc.messages().filter(value => !boundary.has(value)), calls: (await calls()).slice(previous), sourceSnapshot, sourceCatalog, expectedServer: active.expectedServer, positive, denial };
    await context.writeArtifactJson(`native-plugin-${name}-observations.json`, observation);
    const proof = assertNativePluginLeaseEvidence(observation);
    results.push(proof); return proof;
  };
  await version(1); const first = await writer.request('plugin/install', { path: source });
  const a = await start(), firstProof = await run(a, 'a-version-one', 1), original = firstProof.tuple, originalSources = firstProof.sourceSnapshot;
  await version(2); const second = await writer.request('plugin/install', { path: source }); assert.equal(first.plugin.id, second.plugin.id); assert.notEqual(first.plugin.root, second.plugin.root);
  const b = await start(), secondProof = await run(b, 'b-version-two', 2), currentSources = secondProof.sourceSnapshot;
  const retainedProof = await run(a, 'a-retained-one', 1, { positive: firstProof }), retainedSources = retainedProof.sourceSnapshot, retainedCatalog = retainedProof.sourceCatalog;
  assert.deepEqual(retainedSources.effectiveSources, originalSources.effectiveSources); assert.notDeepEqual(currentSources.effectiveSources, originalSources.effectiveSources);
  assert.ok(retainedCatalog.items.some(value => value.reasonCode === 'NATIVE_SOURCE_RETAINED_PLUGIN_VERSION' && value.state === 'ready'));
  await run(b, 'b-old-schema-refused', 2, { wrongField: 'version_1', positive: secondProof });
  await run(a, 'a-current-disabled', 1, { positive: firstProof, revoke: 'disabled' });
  await writer.request('plugin/enable', { pluginId: second.plugin.id }); await run(a, 'a-enabled-original', 1, { positive: firstProof });
  await run(a, 'a-current-uninstalled', 1, { positive: firstProof, revoke: 'uninstalled' }); assert.ok(await stat(first.plugin.root));
  assert.deepEqual((await calls()).map(value => value.version), ['1', '2', '1', '1']);
  await context.writeArtifactJson('actual-native-plugin-source-lease-proof.json', { binarySha256, scopeEvidence, original, originalSources, currentSources, retainedSources, retainedCatalog, results, protocol, actualCalls: await calls(), paidModelCalls: 0, providerRequests: model.requests.length,
    limitations: ['Actual owned local plugin installation, versioned files, MCP/Native SourceGuard and original task calls; no external platform/account/model quality claim.', 'This Linux native acceptance does not prove Windows or Electron host behavior.'] });
  return { originalLeaseRetained: true, differentCurrentVersion: true, currentDisableAndUninstallDeny: true, currentSchemaRejectsOldArguments: true, actualMcpCalls: 4, paidModelCalls: 0 };
}
