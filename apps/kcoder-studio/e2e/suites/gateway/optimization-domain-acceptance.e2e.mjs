import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startWorkflowModelFixture } from '../../harness/workflow-model.mjs';

// Actual local/loopback-SSH workflow storage and run evidence. The bounded model
// fixture routes the Workflow tool; all execution and result checks are real.
await runE2E(import.meta.url, {
  testId: 'optimization-workflow-storage-evidence-and-ssh-conditional-reads',
  tier: 'full-integration',
  modelPolicy: 'model-independent protocol, deterministic bounded Workflow fixture; no LLM quality claim',
  retainSuccessLogs: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'workflow-acceptance' });
  const fixture = await startWorkflowModelFixture(context);
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {
    active_provider: 'fixture', permission_mode: 'bypass', max_retries: 0, max_tokens: 4096, tools: { profile: 'full' },
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: fixture.baseUrl, default_model: 'fixture', context_window_tokens: 128000,
      max_output_tokens: 4096, output_headroom_tokens: 8192, no_proxy: true } },
  });
  const ssh = await startSshFixture(context);
  const wrapper = context.pathInState('ssh', 'owned-kcoder');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Workflow local', transport: 'local', command: binary, workspace },
    { id: 'ssh', label: 'Workflow owned SSH', transport: 'ssh', host: '127.0.0.1', port: ssh.port, user: ssh.user, command: wrapper, workspace },
  ]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary,
    env: { ...ssh.gatewayEnv, KCODER_CONFIG_DIR: profile } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const connect = async target => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, target, token));
    context.addCleanup(`close workflow ${target} RPC`, () => rpc.close());
    await initializeRpc(rpc, `workflow-acceptance-${target}`);
    return rpc;
  };
  const local = await connect('local');
  let remote = await connect('ssh');
  assert.equal((await remote.request('workflow/capabilities/read')).conditionalRead, true);
  const remoteThread = (await remote.request('thread/start', { cwd: workspace, model: 'fixture::fixture' })).thread;
  const remoteProviders = await remote.request('runtime.providers.list', { threadId: remoteThread.id });
  assert.equal(remoteProviders.supportsIndependentProbe, true);
  const observationsBeforeSave = fixture.observations.length;
  const remoteSaved = await remote.request('runtime.providers.upsert', { threadId: remoteThread.id,
    id: 'offline-remote', model: 'remote-model', apiFormat: 'openai_chat_completions', endpoint: fixture.baseUrl,
    authentication: { mode: 'none' }, contextWindowTokens: 1000000, maxOutputTokens: 65536,
    validateConnection: false, expectedRevision: remoteProviders.revision });
  assert.equal(fixture.observations.length, observationsBeforeSave, 'actual SSH offline save does not issue model traffic');
  const remoteRow = remoteSaved.profiles.find(item=>item.id==='offline-remote');
  assert.equal(remoteRow.profileConfiguration.maxOutputTokens, 65536);
  assert.equal(remoteRow.nextTurnConfiguration.maxOutputTokens, 4096);
  await assert.rejects(remote.request('runtime.providers.probe', { threadId: remoteThread.id,
    id: 'offline-remote', model: 'remote-model', expectedRevision: 'stale' }), /revision|changed|reload/i);
  const remoteCleared = await remote.request('runtime.providers.clearUserOverride', { threadId: remoteThread.id,
    field: 'max_tokens', expectedRevision: remoteSaved.savedRevision });
  assert.equal(remoteCleared.profiles.find(item=>item.id==='offline-remote').nextTurnConfiguration.maxOutputTokens,65536);
  let definition = await local.request('workflow/create', { title: 'Actual bounded verification' });
  definition = await local.request('workflow/upsertNode', { id: definition.id, expectedRevision: definition.revision,
    node: { id: 'compute', title: 'Checked deterministic computation', kind: 'code', position: { x: 0, y: 0 },
      config: { code: { source: 'return {answer: input.value * 2};' }, resultCheck: { source: 'return result.answer === 42;' } } } });
  definition = await local.request('workflow/save', { id: definition.id, expectedRevision: definition.revision });
  assert.equal(definition.savedVersion, 1);
  const full = await remote.request('workflow/read', { id: definition.id });
  assert.equal(full.id, definition.id);
  let receivedBytes = 0;
  remote.socket.addEventListener('message', event => { receivedBytes += Buffer.byteLength(event.data); });
  const beforeFull = receivedBytes;
  await remote.request('workflow/read', { id: definition.id });
  const fullFrameBytes = receivedBytes - beforeFull;
  const beforeConditional = receivedBytes;
  for (let index = 0; index < 5; index++) {
    const unchanged = await remote.request('workflow/read', { id: full.id, knownRevision: full.revision, knownUpdatedAtMs: full.updatedAtMs });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.nodes, undefined);
  }
  const conditionalFrameBytes = (receivedBytes - beforeConditional) / 5;
  assert.ok(conditionalFrameBytes < fullFrameBytes, 'actual Gateway response frames are smaller through SSH');
  const moved = await local.request('workflow/moveNode', { id: full.id, nodeId: 'compute',
    expectedPosition: full.nodes[0].position, position: { x: 100, y: 70 } });
  assert.equal(moved.revision, full.revision);
  const changed = await remote.request('workflow/read', { id: full.id, knownRevision: full.revision, knownUpdatedAtMs: full.updatedAtMs });
  assert.deepEqual(changed.nodes[0].position, { x: 100, y: 70 });
  await assert.rejects(local.request('workflow/upsertNode', { id: full.id, expectedRevision: 0, node: full.nodes[0] }), /revision|conflict/i);
  remote.close();
  remote = await connect('ssh');
  assert.deepEqual((await remote.request('workflow/read', { id: full.id })).nodes[0].position, { x: 100, y: 70 });
  const { thread } = await local.request('thread/start', { cwd: workspace, model: 'fixture::fixture' });
  const turn = await local.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Run saved workflow ' + JSON.stringify({ definition_id: full.id, version: 1, args: { value: 21 } }) }] });
  await local.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.turn.id, 45000, 'workflow turn completion');
  const verification = await waitFor(async () => {
    const result = await local.request('workflow/verification/read', { id: full.id, version: 1 });
    return result.runs.some(run => run.executionStatus === 'completed') ? result : null;
  }, 15000, 'actual saved-version run verification');
  const run = verification.runs.find(item => item.executionStatus === 'completed');
  assert.equal(run.checkStatus, 'passed');
  assert.deepEqual(run.checkedNodes, ['compute']);
  assert.equal(run.savedVersion, 1);
  assert.equal(run.definitionSha256, verification.staticCheck.definitionSha256);
  assert.ok(run.inputSha256 && run.outputSha256 && run.runId);
  const refs = await local.request('workflow/versions/references', { id: full.id, version: 1 });
  assert.ok(JSON.stringify(refs).includes(run.runId));
  await assert.rejects(local.request('workflow/storage/migrate', { confirm: false }), /confirmation/i);
  const capacity = await local.request('workflow/storage/read');
  assert.equal(capacity.workflowCount, 1);
  const migrated = await local.request('workflow/storage/migrate', { confirm: true });
  assert.equal(migrated.backend, 'immutable_objects');
  assert.equal((await remote.request('workflow/read', { id: full.id })).savedVersion, 1);
  assert.equal((await remote.request('workflow/verification/read', { id: full.id, version: 1 })).runs[0].runId, run.runId);
  await local.request('workflow/storage/rollback', { confirm: true });
  assert.equal((await local.request('workflow/read', { id: full.id })).savedVersion, 1);
  await context.writeArtifactJson('workflow-acceptance.json', { runId: run.runId, definitionSha256: run.definitionSha256,
    checkedNodes: run.checkedNodes, fullFrameBytes, conditionalFrameBytes, conditionalRequests: 5,
    measurementScope: 'actual Gateway WebSocket response frames, backend executed over owned loopback SSH; excludes SSH encryption overhead',
    crossProcessMoveObserved: true, sshReconnected: true, staleMutationRejected: true,
    verificationPreservedAcrossMigration: true, rollbackPreservedDefinition: true,
    remoteProviderOfflineSave: true, remoteProviderStaleProbeRejected: true, remoteProviderUserOverrideCleared: true });
  return { passed: true, local: true, loopbackSsh: true, runtimeVerification: true, storageMigration: true };
});
