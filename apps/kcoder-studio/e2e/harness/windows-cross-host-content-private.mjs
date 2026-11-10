import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeRpcAndWait } from './rpc.mjs';
import { requireCrossHostContentCapabilities } from './windows-cross-host-content-contract.mjs';
import { allItems, completed } from './windows-cross-host-content-assets.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
/** Deliberately invalid public test canaries, never usable Provider credentials. */
export function crossHostPrivateCanaries(label) {
  assert.ok(['windows', 'linux'].includes(label));
  return [`SYNTHETIC_CROSS_HOST_${label.toUpperCase()}_API_NEVER_REAL`, `SYNTHETIC_CROSS_HOST_${label.toUpperCase()}_MCP_NEVER_REAL`];
}
export function assertNoCrossHostPlaintext(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const label of ['windows', 'linux']) for (const canary of crossHostPrivateCanaries(label)) assert.ok(!text.includes(canary), 'private fixture value escaped a public message');
}

/** Update only this newly seeded fixture, before any source grant, preserving its byte receipt. */
export async function seedCrossHostPrivateFields(source, label, legacy) {
  const file = join(source, 'settings.json'), stat = await lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  const bytes = await readFile(file), entry = legacy.files.find(item => item.path === 'settings.json'); assert.ok(entry && sha(bytes) === entry.sha256);
  const settings = JSON.parse(bytes), [api, token] = crossHostPrivateCanaries(label);
  assert.equal(settings.env?.ANTHROPIC_API_KEY, undefined); assert.equal(settings.mcpServers, undefined);
  settings.env = { ...settings.env, ANTHROPIC_API_KEY: api };
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  settings.mcpServers = { cross_host_private: { command, env: { TOKEN: token } } };
  const next = Buffer.from(JSON.stringify(settings)); await writeFile(file, next, { mode: 0o600 });
  return { ...legacy, files: legacy.files.map(item => item.path === entry.path ? { path: entry.path, sha256: sha(next), bytes: next.length } : item) };
}

/** Offers and the original private intent are prepared while Source is still available. */
export async function prepareCrossHostPrivateTransfer({ call, until, source, target, connect, from, to, capabilities, targetWorkspace }) {
  for (const peer of ['source', 'target']) requireCrossHostContentCapabilities(capabilities?.[peer], ['private']);
  assert.ok(typeof targetWorkspace === 'string' && (/^\//.test(targetWorkspace) || /^[A-Za-z]:\\/.test(targetWorkspace)) && !/[\u0000-\u001f]/.test(targetWorkspace));
  const catalog = await call('source-session', 'query', { session: source, query: { kind: 'configuration', params: { sources: ['claude-code'] } } });
  const descriptors = await call('source-session', 'query', { session: source, query: { kind: 'source_bindings', params: { sourceIds: catalog.sources.map(row => row.sourceId) } } });
  const candidates = descriptors.bindings.filter(row => row.family === 'configuration'); assert.equal(candidates.length, 1);
  const pair = { requestId: randomUUID(), source, target };
  await call('source-transfer', 'run', { ...pair, attemptId: randomUUID(), selections: [{ kind: 'configuration', sourceId: candidates[0].sourceId }] });
  const receipt = await until(async () => {
    const read = await call('source-transfer', 'read', pair, false, true); if (!read) return false;
    assert.ok(!['failed', 'cancelled'].includes(read.result.phase)); return read.result.phase === 'ready' ? read.result.receipt : false;
  }, 'private public manifest receipt', 30000);
  const received = await call('source-transfer', 'received', { requestId: pair.requestId, target, manifestSha256: receipt.manifestSha256, pageIndex: 0 }); assert.equal(received.items.length, 1);
  const locator = { requestId: pair.requestId, target, adoptionId: randomUUID() };
  await call('source-transfer', 'adoption-prepare', { locator, manifestSha256: receipt.manifestSha256, selections: [{ entryId: received.items[0].entryId }] });
  const adoption = await until(async () => {
    const value = (await call('source-transfer', 'adoption-read', locator)).state; if (value.workerState === 'running') return false;
    assert.equal(value.workerState, 'stopped'); assert.equal(value.phase, 'preview_ready'); assert.equal(value.jobs.length, 1); return value;
  }, 'private original public batch preview', 30000);
  let rpc = await connect();
  try {
    const jobId = adoption.jobs[0].jobId, items = await allItems(rpc, jobId);
    const providers = items.filter(item => item.category === 'provider'), mcps = items.filter(item => item.category === 'mcp');
    assert.equal(providers.length, 1); assert.equal(mcps.length, 1);
    const providerName = `Private${from}Office`, mcpName = `private-${from}-notes`;
    const before = await rpc.request('migration/batch/read', { jobId });
    const choices = [{ kind: 'provider', itemId: providers[0].id, targetName: providerName, endpoint: null, model: null, contextWindowTokens: 128000, outputHeadroomTokens: 8192, maxOutputTokens: 8192 },
      { kind: 'mcp', itemId: mcps[0].id, targetName: mcpName, cwd: targetWorkspace, enableAfterImport: false }];
    const plan = await rpc.request('migration/batch/plan', { jobId, expectedSequence: before.state.job.sequence, choices, includeDefaultItems: false });
    const page = await call('source-transfer/private', 'candidates', { requestId: pair.requestId, target, manifestSha256: receipt.manifestSha256, entryId: received.items[0].entryId, pageIndex: 0, jobId, expectedPlanId: plan.batch.planId });
    assert.equal(page.items.length, 2);
    const selections = page.items.map(item => {
      assert.equal(item.targets.length, 1); const destination = item.targets[0];
      if (item.kind === 'provider') {
        const selector = item.selectors.find(row => row.kind === 'claude_configuration'); assert.ok(selector);
        assert.equal(destination.kind, 'provider'); assert.equal(destination.targetName, providerName);
        return { kind: 'provider', sourceName: item.sourceName, targetName: destination.targetName, selector, endpoint: destination.endpoint, apiFormat: destination.apiFormat };
      }
      assert.equal(item.kind, 'mcp'); assert.equal(destination.kind, 'mcp'); assert.equal(destination.targetName, mcpName);
      assert.ok(item.fields.some(field => field.kind === 'environment' && field.name === 'TOKEN'));
      return { kind: 'mcp', sourceName: item.sourceName, targetName: destination.targetName, fields: item.fields.filter(field => field.kind === 'environment' && field.name === 'TOKEN'), definitionSha256: item.definitionSha256 };
    });
    const offerId = randomUUID(), consent = { apiKeys: true, mcpPrivateFields: true };
    const offer = await call('source-transfer/private', 'run', { locator: { requestId: pair.requestId, offerId, target }, source, manifestSha256: receipt.manifestSha256, entryId: received.items[0].entryId, selections, consent }); assert.equal(offer.received, true);
    const intent = { locator: { requestId: pair.requestId, offerId, target }, jobId, expectedSequence: plan.job.sequence, consent };
    await call('source-transfer/private', 'prepare', intent, true);
    const prepared = await call('source-transfer/private', 'prepare-status', { requestId: pair.requestId, target, jobId });
    assert.equal(prepared.phase, 'prepared'); assert.deepEqual(prepared.offerIds, [offerId]); assert.equal(prepared.expectedSequence, intent.expectedSequence);
    assert.equal(prepared.originalPlanId, plan.batch.planId); assert.notEqual(prepared.planId, prepared.originalPlanId); assert.deepEqual(prepared.consent, consent);
    return { from, to, pair, receipt, adoptionId: locator.adoptionId, jobId, offerId, expectedSequence: intent.expectedSequence, consent, providerName, mcpName };
  } finally { await closeRpcAndWait(rpc); }
}

/** Recovery reads the original accepted preparation before any source-independent publication. */
export async function finishCrossHostPrivateTransfer({ prepared, call, until, recovery, connect, files }) {
  const original = JSON.parse(await files.read('settings.json')); let rpc = await connect();
  try {
    const { pair, jobId, offerId } = prepared;
    const observed = await call('source-transfer/private', 'prepare-status', { requestId: pair.requestId, target: recovery, jobId });
    assert.equal(observed.phase, 'prepared'); assert.deepEqual(observed.offerIds, [offerId]); assert.equal(observed.expectedSequence, prepared.expectedSequence); assert.deepEqual(observed.consent, prepared.consent);
    const current = await rpc.request('migration/batch/read', { jobId });
    await rpc.request('migration/batch/run', { jobId, expectedSequence: current.state.job.sequence, planId: current.state.batch.planId, requestId: randomUUID(), mode: 'apply' });
    const published = await completed(rpc, jobId, until, 2); assert.equal(published.state.batch.publishedCredentials, 2);
    const settings = JSON.parse(await files.read('settings.json')); assertNoCrossHostPlaintext(settings);
    assert.ok(settings.mcp_disabled_servers.includes(prepared.mcpName));
    const stored = await files.read('credentials.json');
    for (const value of crossHostPrivateCanaries(prepared.from)) assert.ok(stored.includes(Buffer.from(value)), 'the original private value was not published in the owned file backend');
    await closeRpcAndWait(rpc); rpc = await connect();
    const reopened = await rpc.request('migration/batch/read', { jobId }); assert.equal(reopened.state.batch.planId, published.state.batch.planId);
    await rpc.request('migration/batch/run', { jobId, expectedSequence: reopened.state.job.sequence, planId: reopened.state.batch.planId, requestId: randomUUID(), mode: 'rollback' });
    await until(async () => { const read = await rpc.request('migration/batch/read', { jobId }); if (read.workerRunning) return false; assert.equal(read.state.job.status, 'rolled_back'); return read; }, 'original cross-host private Undo', 30000);
    assert.deepEqual(JSON.parse(await files.read('settings.json')), original);
    if (await files.exists('credentials.json')) {
      const remaining = await files.read('credentials.json');
      for (const value of crossHostPrivateCanaries(prepared.from)) assert.ok(!remaining.includes(Buffer.from(value)), 'owned Undo left its migrated private value behind');
    }
    assert.equal((await call('source-transfer/private', 'release', { locator: { requestId: pair.requestId, offerId, target: recovery }, jobId })).keyReleased, true);
    return { kind: 'private', direction: `${prepared.from}->${prepared.to}`, requestId: pair.requestId, adoptionId: prepared.adoptionId, jobId, offerId,
      entries: 1, publishedReferences: 2, sourceGoneBeforePublication: true, acceptedPreparationReopened: true, ordinaryOwnedUndo: true,
      targetSettingsRestored: true, keyReleased: true, backendMode: 'file', osKeyringClaim: false };
  } finally { await closeRpcAndWait(rpc); }
}
