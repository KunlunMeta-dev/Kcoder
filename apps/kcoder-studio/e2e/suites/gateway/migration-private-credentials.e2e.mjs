import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway } from '../../harness/gateway.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, { testId: 'gateway-migration-private-credentials', tier: 'full-integration',
  modelPolicy: 'Actual authenticated HTTP/private relay/Native publication; synthetic values, no model turns' }, async context => {
  assert.equal(process.platform, 'linux', 'this suite owns POSIX fixture launchers, not Windows vaults or another machine');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: 'assistant', content: 'UNEXPECTED' }, finishReason: 'stop' }] });
  const settings = { credential_store: 'file', active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture',
    context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192, no_proxy: true, discover_models: false,
  } }, mcp_servers: [], mcp_disabled_servers: [] };
  const profile = context.pathInState('source-profile'), destination = context.pathInState('destination-profile');
  await context.writeStateJson('source-profile/settings.json', settings); await context.writeStateJson('destination-profile/settings.json', settings);
  const targetBefore = await readFile(resolve(destination, 'settings.json'), 'utf8');
  const vendor = context.pathInState('vendor'), emptyClaude = context.pathInState('empty-claude');
  await mkdir(vendor, { recursive: true, mode: 0o700 }); await mkdir(emptyClaude, { recursive: true, mode: 0o700 });
  const privateValues = Array.from({ length: 4 }, () => `owned-private-${randomUUID()}`);
  for (const value of privateValues) context.registerSecret(value);
  const sourceFiles = [];
  const oldToolMarker = context.pathInState('old-tool-invoked');
  const oldTool = context.pathInState('never-run-source-tool');
  await writeFile(oldTool, `#!/bin/sh\nprintf invoked > '${oldToolMarker.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
  for (let index = 0; index < 2; index++) {
    const body = `model='fixture'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://source-${index}.invalid/v1'\nwire_api='responses'\nenv_key='OWNED_PRIVATE_BUNDLE_API_${index}'\n[mcp_servers.notes]\ncommand='${oldTool}'\n[mcp_servers.notes.env]\nTOKEN='${privateValues[2 + index]}'\n`;
    const file = resolve(vendor, index ? 'review.config.toml' : 'config.toml');
    await writeFile(file, body, { mode: 0o600 }); sourceFiles.push([file, body]);
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const sourceLauncher = context.pathInState('source-launcher'), targetLauncher = context.pathInState('target-launcher');
  // Only the source Native receives these synthetic declared environment slots.
  // They are absent from Gateway env, public requests, ordinary IR and artifacts.
  await writeFile(sourceLauncher, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexport CODEX_HOME=${quote(vendor)}\nexport CLAUDE_CONFIG_DIR=${quote(emptyClaude)}\nexport OWNED_PRIVATE_BUNDLE_API_0=${quote(privateValues[0])}\nexport OWNED_PRIVATE_BUNDLE_API_1=${quote(privateValues[1])}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
  await writeFile(targetLauncher, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(destination)}\nexport CLAUDE_CONFIG_DIR=${quote(emptyClaude)}\nexport CODEX_HOME=${quote(emptyClaude)}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'source', label: 'Owned private source', transport: 'local', command: sourceLauncher, workspace },
    { id: 'destination', label: 'Owned private destination', transport: 'local', command: targetLauncher, workspace },
  ]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true,
    env: { KCODER_CONFIG_DIR: profile, CLAUDE_CONFIG_DIR: emptyClaude, CODEX_HOME: emptyClaude } });
  const login = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: gateway.authToken }) });
  assert.equal(login.status, 200); const credentials = await login.json(); context.registerSecret(credentials.accessToken);
  context.addCleanup('revoke only private transfer fixture login', async () => {
    const response = await fetch(`${gateway.baseUrl}/api/mobile/session`, { method: 'DELETE', headers: { authorization: `Bearer ${credentials.accessToken}` } });
    assert.ok([204, 401].includes(response.status));
  });
  async function call(lane, operation, payload, { discard = false } = {}) {
    const response = await fetch(`${gateway.baseUrl}/api/migration/${lane}/${operation}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.accessToken}` }, body: JSON.stringify(payload) });
    if (discard) { assert.equal(response.status, 200); await response.body.cancel(); return null; }
    const body = await response.json();
    for (const value of privateValues) assert.equal(JSON.stringify(body).includes(value), false, 'private value escaped an HTTP response');
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  const source = { sessionId: randomUUID(), purpose: 'source', targetId: 'source', workspacePath: workspace };
  const target = { sessionId: randomUUID(), purpose: 'target', targetId: 'destination', workspacePath: workspace };
  for (const session of [source, target]) assert.equal((await call('source-session', 'open', session)).status, 'ready');
  const discovered = await call('source-session', 'query', { session: source, query: { kind: 'configuration', params: { sources: ['codex'] } } });
  const sources = discovered.sources.filter(row => row.kind === 'codex' && row.scope === 'user');
  assert.equal(sources.length, 2);
  const requestId = randomUUID(), pair = { requestId, source, target };
  await call('source-transfer', 'run', { ...pair, attemptId: randomUUID(), selections: sources.map(row => ({ kind: 'configuration', sourceId: row.sourceId })) });
  let receipt;
  await waitFor(async () => { const read = await call('source-transfer', 'read', pair); receipt = read.result?.receipt; return read.result?.phase === 'ready'; }, 30_000, 'original transfer ready', 100, context.abortSignal);
  const received = await call('source-transfer', 'received', { requestId, target, manifestSha256: receipt.manifestSha256, pageIndex: 0 });
  assert.equal(received.items.length, 2);
  const adoptionId = randomUUID(), locator = { requestId, adoptionId, target };
  await call('source-transfer', 'adoption-prepare', { locator, manifestSha256: receipt.manifestSha256, selections: received.items.map(item => ({ entryId: item.entryId })) });
  let adoption;
  await waitFor(async () => { const read = await call('source-transfer', 'adoption-read', locator); adoption = read.state; return adoption?.jobs.length === 1 && adoption.jobs[0].previewReady && adoption.workerState === 'stopped'; }, 30_000, 'same-source original batch preview', 100, context.abortSignal);
  const jobId = adoption.jobs[0].jobId;
  const observer = await openOwnedMobileRpc(context, gateway, 'destination', workspace);
  const items = await observer.rpc.request('migration/items', { jobId });
  assert.equal(items.providers.length, 2); assert.equal(items.mcps.length, 2);
  const job = await observer.rpc.request('migration/batch/read', { jobId });
  const choices = items.providers.map((item, index) => ({ kind: 'provider', itemId: item.itemId, targetName: `HttpProvider${index}`,
    endpoint: null, model: null, contextWindowTokens: 64000, outputHeadroomTokens: 8192, maxOutputTokens: 8192 }))
    .concat(items.mcps.map((item, index) => ({ kind: 'mcp', itemId: item.itemId, targetName: `http-notes-${index}`, cwd: null, enableAfterImport: false })));
  const plan = await observer.rpc.request('migration/batch/plan', { jobId, expectedSequence: job.state.job.sequence, choices, includeDefaultItems: false });
  const offers = [];
  for (const entry of received.items) {
    const page = await call('source-transfer/private', 'candidates', { requestId, target, manifestSha256: receipt.manifestSha256, entryId: entry.entryId, pageIndex: 0, jobId, expectedPlanId: plan.batch.planId });
    const selected = page.items.map(item => {
      assert.equal(item.targets.length, 1); const saved = item.targets[0];
      return item.kind === 'provider' ? { kind: 'provider', sourceName: item.sourceName, targetName: saved.targetName,
        selector: item.selectors[0], endpoint: item.endpoint, apiFormat: item.apiFormat } : { kind: 'mcp', sourceName: item.sourceName,
        targetName: saved.targetName, fields: item.fields, definitionSha256: item.definitionSha256 };
    });
    const offerId = randomUUID(); offers.push(offerId);
    const received = await call('source-transfer/private', 'run', { locator: { requestId, offerId, target }, source,
      manifestSha256: receipt.manifestSha256, entryId: entry.entryId, selections: selected, consent: { apiKeys: true, mcpPrivateFields: true } });
    assert.equal(received.received, true);
  }
  const intent = { locator: { requestId, offerId: offers[0], target }, additionalOffers: [offers[1]], jobId,
    expectedSequence: plan.job.sequence, consent: { apiKeys: true, mcpPrivateFields: true } };
  await call('source-transfer/private', 'prepare', intent, { discard: true });
  const prepared = await call('source-transfer/private', 'prepare', intent);
  const subset = { ...intent }; delete subset.additionalOffers;
  const rejectedSubset = await fetch(`${gateway.baseUrl}/api/migration/source-transfer/private/prepare`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.accessToken}` }, body: JSON.stringify(subset) });
  assert.equal(rejectedSubset.status, 409, 'a prepared complete set cannot be reconciled as a single offer');
  const rejectedBody = await rejectedSubset.json();
  assert.equal(rejectedBody.error, 'private_credentials_publication_binding_changed');
  assert.deepEqual(prepared.offerIds, [...offers].sort());
  assert.equal(prepared.job.batch.credentialActions, 4);
  assert.notEqual(prepared.job.batch.planId, plan.batch.planId);
  assert.equal(await readFile(resolve(destination, 'settings.json'), 'utf8'), targetBefore);
  for (const session of [source, target]) assert.equal((await call('source-session', 'close', session)).status, 'released');
  await rename(vendor, context.pathInState('source-withheld'));
  const observationSource = { ...source, sessionId: randomUUID() };
  assert.equal((await call('source-session', 'open', observationSource)).status, 'ready');
  const sourceObservation = await call('source-transfer/private', 'source-read', {
    locator: { requestId, offerId: offers[0], target }, source: observationSource,
  });
  assert.equal(sourceObservation.sourceObserved, true);
  assert.equal(sourceObservation.sourceControl.ready, true);
  assert.equal(sourceObservation.sourceWorkerRunning, false);
  assert.equal(sourceObservation.targetObserved, false);
  assert.equal(sourceObservation.targetControl, null);
  assert.equal(sourceObservation.targetWorkerRunning, null);
  assert.equal(sourceObservation.received, false);
  assert.equal(sourceObservation.keyReleased, false);
  assert.equal((await call('source-session', 'read', target)).status, 'released', 'source-only observation cannot reopen the closed target');
  assert.equal((await call('source-session', 'close', observationSource)).status, 'released');
  const recoveredTarget = { ...target, sessionId: randomUUID(), purpose: 'target_recovery' };
  assert.equal((await call('source-session', 'open', recoveredTarget)).status, 'ready');
  const recoveredPreparation = await call('source-transfer/private', 'prepare-status', { requestId, target: recoveredTarget, jobId });
  assert.equal(recoveredPreparation.phase, 'prepared');
  assert.deepEqual(recoveredPreparation.offerIds, prepared.offerIds);
  assert.equal(recoveredPreparation.expectedSequence, intent.expectedSequence);
  assert.deepEqual(recoveredPreparation.consent, intent.consent);
  const reconciled = await call('source-transfer/private', 'prepare', { ...intent, locator: { requestId, offerId: offers[1], target: recoveredTarget }, additionalOffers: [offers[0]] });
  assert.deepEqual(reconciled.offerIds, prepared.offerIds); assert.deepEqual(reconciled.job, prepared.job);
  let published = await observer.rpc.request('migration/batch/apply', { jobId, planId: prepared.job.batch.planId, expectedSequence: prepared.job.job.sequence, requestId: randomUUID() });
  await waitFor(async () => { const read = await observer.rpc.request('migration/batch/read', { jobId }); published = read.state; return !read.workerRunning; }, 30_000, 'native private group publication finished', 100, context.abortSignal);
  assert.equal(published.batch.publishedCredentials, 4);
  const saved = JSON.parse(await readFile(resolve(destination, 'settings.json'), 'utf8'));
  for (const value of privateValues) assert.equal(JSON.stringify(saved).includes(value), false);
  for (const name of ['http-notes-0', 'http-notes-1']) assert.ok(saved.mcp_disabled_servers.includes(name));
  let undone = await observer.rpc.request('migration/batch/rollback', { jobId, planId: prepared.job.batch.planId, expectedSequence: published.job.sequence, requestId: randomUUID() });
  await waitFor(async () => { const read = await observer.rpc.request('migration/batch/read', { jobId }); undone = read.state; return !read.workerRunning; }, 30_000, 'native private group Undo finished', 100, context.abortSignal);
  assert.equal(undone.job.status, 'rolled_back'); assert.deepEqual(JSON.parse(await readFile(resolve(destination, 'settings.json'), 'utf8')), JSON.parse(targetBefore));
  for (const offerId of offers) assert.equal((await call('source-transfer/private', 'release', { locator: { requestId, offerId, target: recoveredTarget }, jobId })).keyReleased, true);
  await observer.close(); assert.equal((await call('source-session', 'close', recoveredTarget)).status, 'released');
  for (const [file, body] of sourceFiles) assert.equal(await readFile(resolve(context.pathInState('source-withheld'), file.split('/').at(-1)), 'utf8'), body);
  assert.equal(model.requests.length, 0);
  await assert.rejects(access(oldToolMarker), { code: 'ENOENT' });
  const sourceSha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  await context.writeArtifactJson('private-bundle-roundtrip.json', { requestId, adoptionId, jobId, offerIds: [...offers].sort(),
    sourceSha256, discardedPrepareReply: true, exactSetPreserved: true, sourceOnlyObservationWithoutTarget: true, recoveryRolePreparationRead: true, entries: 2, publishedReferences: 4,
    sourceOffline: true, targetReopened: true, normalBatchUndo: true, targetSettingsRestored: true,
    modelInferenceRequests: 0, oldMcpExecuted: false, boundary: 'Actual Linux Gateway HTTP and local isolated Native profiles; not client UI, two machines or Windows vault.' });
  return { privateBundle: true, sourceOnlyObservationWithoutTarget: true, recoveryRolePreparationRead: true, entries: 2, publishedReferences: 4, exactOfferSet: true, sourceOffline: true,
    targetReopened: true, ordinaryPublicationAndUndo: true, modelInferenceRequests: 0 };
});
