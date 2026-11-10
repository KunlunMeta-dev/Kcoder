import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway } from '../../harness/gateway.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { exerciseTerminalSourceViews } from './migration-terminal-views.mjs';
import { exerciseTerminalGuide } from './migration-terminal-guide.mjs';
import { exerciseTerminalInstructions } from './migration-terminal-instructions.mjs';
import { exerciseTerminalPrivate } from './migration-terminal-private.mjs';
import { exerciseTerminalProjects } from './migration-terminal-projects.mjs';

await runE2E(import.meta.url, { testId: 'migration-terminal-transfer', tier: 'full-integration',
  modelPolicy: 'model-independent actual terminal CLI, authenticated Gateway and isolated Native source/destination; no model turns' }, async context => {
  assert.equal(process.platform, 'linux', 'this acceptance owns Linux launchers, not Windows or SSH hosts');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder CLI');
  if (process.env.KCODER_E2E_MIGRATION_PROJECTS_ONLY === '1') {
    await exerciseTerminalProjects(context, binary);
    return;
  }
  if (process.env.KCODER_E2E_MIGRATION_TERMINAL_PRIVATE_ONLY === '1') {
    await exerciseTerminalPrivate(context, binary);
    return;
  }
  if (process.env.KCODER_E2E_MIGRATION_INSTRUCTIONS_ONLY === '1') {
    await exerciseTerminalInstructions(context, binary);
    return;
  }
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: 'assistant', content: 'UNEXPECTED_MODEL_CALL' }, finishReason: 'stop' }] });
  const settings = { credential_store: 'file', active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture',
    context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192, no_proxy: true, discover_models: false,
  } } };
  const sourceProfile = context.pathInState('source-profile'), targetProfile = context.pathInState('target-profile');
  await context.writeStateJson('source-profile/settings.json', settings);
  await context.writeStateJson('target-profile/settings.json', settings);
  const targetBefore = await readFile(resolve(targetProfile, 'settings.json'), 'utf8');
  const source = context.pathInState('vendor');
  const sourceBytes = JSON.stringify({ model: 'terminal-source', env: { ANTHROPIC_BASE_URL: 'https://inert.example.invalid' } });
  await context.writeStateJson('vendor/settings.json', JSON.parse(sourceBytes));
  await writeFile(resolve(source, 'CLAUDE.md'), 'Inert source instructions. Never execute source programs.\n', { mode: 0o600 });
  for (let index = 0, unknownReadObservations = 0, lastReadObservation = null; index < 12; index++) {
    const sessionId = randomUUID();
    const record = { type: 'user', uuid: `u-${index}`, sessionId, version: '2.1.301',
      message: { role: 'user', content: `Owned transfer history ${index}` } };
    const file = await context.writeStateJson(`vendor/projects/owned/${sessionId}.jsonl`, record);
    await writeFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = async (name, profile) => {
    const file = context.pathInState(name);
    await writeFile(file, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexport CLAUDE_CONFIG_DIR=${quote(source)}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
    return file;
  };
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'source', label: 'Owned source', transport: 'local', command: await launcher('source-launcher', sourceProfile), workspace },
    { id: 'destination', label: 'Owned destination', transport: 'local', command: await launcher('destination-launcher', targetProfile), workspace },
  ]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true, env: { KCODER_CONFIG_DIR: sourceProfile } });
  const login = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: gateway.authToken }) });
  assert.equal(login.status, 200);
  const credentials = await login.json(); context.registerSecret(credentials.accessToken);
  context.addCleanup('revoke only terminal fixture account token', async () => {
    const result = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'DELETE', headers: { authorization: `Bearer ${credentials.accessToken}` } });
    assert.ok([204, 401].includes(result.status));
  });
  let index = 0, unknownReadObservations = 0, lastReadObservation = null;
  async function invoke(args, payload, { confirm = false, base = gateway.baseUrl, token = credentials.accessToken, success = true, observeRead = false } = {}) {
    const label = `terminal-transfer-${++index}`;
    const path = payload === undefined ? null : await context.writeStateJson(`requests/${label}.json`, payload);
    const argv = ['migrate', 'transfer', '--gateway', base, '--access-token-env', 'OWNED_GATEWAY_ACCESS', ...args,
      ...(path ? ['--input', path] : []), ...(confirm ? ['--confirm'] : [])];
    const child = context.spawnOwned(label, binary, argv, { cwd: workspace, env: context.isolatedEnvironment({ OWNED_GATEWAY_ACCESS: token }) });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; assert.ok(stdout.length <= 2 * 1024 * 1024); });
    child.stderr.on('data', bytes => { stderr += bytes; assert.ok(stderr.length <= 64 * 1024); });
    await waitFor(() => child.exitCode !== null, 40000, 'owned terminal transfer subprocess exit', 20, context.abortSignal);
    if (observeRead && child.exitCode !== 0 && /^Error: source_transfer_outcome_unknown\s*$/.test(stderr)) {
      assert.deepEqual(args, ['copy', 'read'], 'only the original read may be observed again');
      unknownReadObservations++;
      await context.writeArtifactJson(`terminal-copy-read-unknown-${unknownReadObservations}.json`, {
        requestId: payload.requestId, observation: 'unknown', errorCode: 'source_transfer_outcome_unknown',
        priorCheckpoint: lastReadObservation, replayedMutation: false,
      });
      return null;
    }
    assert.equal(child.exitCode === 0, success, context.redactText(stderr));
    assert.ok(!stdout.includes(credentials.accessToken) && !stderr.includes(credentials.accessToken));
    return success ? JSON.parse(stdout) : stderr;
  }
  assert.match(await invoke(['targets'], undefined, { token: 'a'.repeat(64), success: false }), /login_or_permission_required/);
  const targets = await invoke(['targets']);
  assert.deepEqual(targets.targets.map(row => row.id), ['source', 'destination']);
  assert.ok(targets.targets.every(row => Object.keys(row).sort().join(',') === 'id,label,transport'));
  const sourceSession = { sessionId: randomUUID(), purpose: 'source', targetId: 'source', workspacePath: workspace };
  const destination = { sessionId: randomUUID(), purpose: 'target', targetId: 'destination', workspacePath: workspace };
  assert.match(await invoke(['session', 'open'], sourceSession, { success: false }), /confirmation_required/);
  for (const session of [sourceSession, destination]) assert.equal((await invoke(['session', 'open'], session, { confirm: true })).status, 'ready');
  const discovered = await invoke(['query'], { session: sourceSession, query: { kind: 'configuration', params: { sources: ['claude-code'] } } });
  assert.ok(discovered.sources.length >= 2 && discovered.sources.length <= 10);
  const ids = discovered.sources.map(row => row.sourceId);
  const descriptors = await invoke(['query'], { session: sourceSession, query: { kind: 'source_bindings', params: { sourceIds: ids } } });
  assert.deepEqual(descriptors.bindings.map(row => row.sourceId), ids);
  assert.deepEqual(new Set(descriptors.bindings.map(row => row.family)), new Set(['configuration', 'assets']));
  const catalog = await invoke(['query'], { session: sourceSession, query: { kind: 'history', params: { source: 'claude-code' } } });
  assert.equal(catalog.items.length, 10); assert.ok(catalog.nextCursor);
  const page = await invoke(['query'], { session: sourceSession, query: { kind: 'history_page', params: { catalogId: catalog.catalogId, cursor: catalog.nextCursor } } });
  assert.equal(page.items.length, 2);
  const selections = descriptors.bindings.map(row => ({ kind: row.family, sourceId: row.sourceId }));
  selections.push({ kind: 'history', catalogId: catalog.catalogId, sourceHandle: catalog.items[0].sourceHandle });
  const requestId = randomUUID(), attemptId = randomUUID(), pair = { requestId, source: sourceSession, target: destination };
  let droppedRuns = 0;
  const proxy = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/api/migration/source-transfer/run');
      const parts = []; for await (const part of request) parts.push(part);
      const body = Buffer.concat(parts); assert.ok(body.length <= 64 * 1024);
      const upstream = await fetch(`${gateway.baseUrl}${request.url}`, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: request.headers.authorization,
      }, body });
      assert.equal(upstream.status, 200); await upstream.arrayBuffer(); droppedRuns++;
      response.destroy();
    } catch (error) { response.destroy(error); }
  });
  context.addCleanup('close owned single-response-loss proxy', () => new Promise((resolveClose, reject) => { proxy.close(error => error ? reject(error) : resolveClose()); proxy.closeAllConnections(); }));
  await new Promise(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen)); context.registerPort('terminal-receipt-loss-proxy', proxy.address().port);
  assert.match(await invoke(['copy', 'run'], { ...pair, attemptId, selections }, { confirm: true, base: `http://127.0.0.1:${proxy.address().port}`, success: false }), /outcome_unknown/);
  assert.equal(droppedRuns, 1, 'an ambiguous HTTP response never automatically retries the mutation');
  let complete;
  await waitFor(async () => { complete = await invoke(['copy', 'read'], pair, { observeRead: true });
    if (!complete) return false;
    lastReadObservation = { coordinatorState: complete.coordinatorState, phase: complete.result?.phase ?? null };
    assert.ok(complete.result == null || ['pending', 'ready', 'cancelling'].includes(complete.result.phase), 'an explicit terminal failure is not a transient observation');
    return complete.result?.phase === 'ready'; }, 30000, 'original Native transfer completion', 100, context.abortSignal);
  const receipt = complete.result.receipt; assert.ok(receipt); assert.equal(receipt.requestId, requestId);
  assert.equal(await readFile(resolve(targetProfile, 'settings.json'), 'utf8'), targetBefore);
  for (const session of [sourceSession, destination]) assert.equal((await invoke(['session', 'close'], session, { confirm: true })).status, 'released');
  await rename(source, `${source}.withheld`);
  const recovery = { sessionId: randomUUID(), purpose: 'target_recovery', targetId: 'destination', workspacePath: workspace };
  assert.equal((await invoke(['session', 'open'], recovery, { confirm: true })).status, 'ready');
  const recovered = await invoke(['copy', 'target-read'], { requestId, target: recovery });
  assert.equal(recovered.result.sourceObserved, false); assert.deepEqual(recovered.result.receipt, receipt);
  const received = await invoke(['adoption', 'received'], { target: recovery, requestId, manifestSha256: receipt.manifestSha256, pageIndex: 0 });
  assert.ok(received.items.length > 0 && received.items.length <= 10);
  const locator = { target: recovery, requestId, adoptionId: randomUUID() };
  await invoke(['adoption', 'prepare'], { locator, manifestSha256: receipt.manifestSha256, selections: received.items.map(row => ({ entryId: row.entryId })) }, { confirm: true });
  let adopted;
  await waitFor(async () => { adopted = await invoke(['adoption', 'read'], locator); return adopted.state?.phase === 'preview_ready' && adopted.state.workerState === 'stopped'; }, 30000, 'same adoption preview completion', 100, context.abortSignal);
  assert.ok(adopted.state.jobs.length >= 1 && adopted.state.jobs.every(job => job.previewReady));
  assert.equal(await readFile(resolve(targetProfile, 'settings.json'), 'utf8'), targetBefore, 'preview is never publication');
  const remoteArgs = operation => ['batch', '--target-id', 'destination', '--workspace-path', workspace, operation];
  const remoteJob = adopted.state.jobs[0].jobId;
  assert.match(await invoke(['batch', '--target-id', 'source', '--workspace-path', workspace, 'read'], { jobId: remoteJob }, { success: false }), /rpc_rejected_read_original_job/);
  const remoteItems = (await invoke(remoteArgs('items'), { jobId: remoteJob, pageIndex: 0 })).result;
  assert.ok(remoteItems.items.length <= 10);
  const instruction = remoteItems.items.find(item => item.category === 'instructions');
  assert.ok(instruction, 'the received instructions remain independently selectable');
  const remoteBefore = (await invoke(remoteArgs('read'), { jobId: remoteJob })).result;
  const planned = (await invoke(remoteArgs('plan'), { jobId: remoteJob, expectedSequence: remoteBefore.state.job.sequence,
    choices: [{ kind: 'asset', itemId: instruction.id, targetName: 'terminal-received-instructions', enableAfterImport: false }],
    includeDefaultItems: false, excludedItemIds: [], reuseExisting: false }, { confirm: true })).result;
  assert.ok(planned.batch.planId);
  const published = (await invoke(remoteArgs('run'), { jobId: remoteJob, expectedSequence: planned.job.sequence,
    planId: planned.batch.planId, requestId: randomUUID(), mode: 'apply' }, { confirm: true })).result;
  assert.equal(published.workerRunning, false);
  assert.equal(published.state.job.status, 'completed', 'the ordinary batch completion status requires Native receipts');
  assert.equal(published.state.batch.committedActions, 1);
  const reopened = (await invoke(remoteArgs('read'), { jobId: remoteJob })).result;
  assert.equal(reopened.state.job.status, 'completed');
  const undone = (await invoke(remoteArgs('run'), { jobId: remoteJob, expectedSequence: reopened.state.job.sequence,
    planId: planned.batch.planId, requestId: randomUUID(), mode: 'rollback' }, { confirm: true })).result;
  assert.equal(undone.workerRunning, false); assert.equal(undone.state.job.status, 'rolled_back');
  assert.equal(await readFile(resolve(targetProfile, 'settings.json'), 'utf8'), targetBefore, 'asset selection never changes provider settings');
  assert.equal((await invoke(['session', 'close'], recovery, { confirm: true })).status, 'released');
  await exerciseTerminalSourceViews({ context, binary, gateway, token: credentials.accessToken, workspace, sourceProfile, targetProfile });
  await exerciseTerminalGuide({ context, binary, gateway, token: credentials.accessToken, workspace, source, targetProfile, originalSettings: targetBefore });
  assert.equal(model.requests.length, 0);
  await context.writeArtifactJson('terminal-transfer-receipts.json', { requestId, attemptId, receipt, adoptionId: locator.adoptionId,
    jobs: adopted.state.jobs, lostResponseRuns: droppedRuns, unknownReadObservations, sourceReleasedBeforeRecovery: true, targetSettingsUnchanged: true,
    explicitRemoteBatchImported: true, explicitRemoteBatchUndone: true, modelRequests: 0 });
  return { targets: 2, historyPages: [10, 2], lostAcknowledgementReconciled: true, targetOnlyRecovery: true,
    adoptionPreviewReady: true, receivedAloneImported: false, explicitRemoteBatchImported: true, explicitRemoteBatchUndone: true, modelRequests: 0 };
});
