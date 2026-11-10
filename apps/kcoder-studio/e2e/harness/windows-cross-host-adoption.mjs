import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openRpc, initializeRpc, closeRpcAndWait } from './rpc.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
export const CROSS_HOST_SKILL_BODY = 'Preserve explicitly supplied office material. Never execute recorded history.\n';
export const CROSS_HOST_SKILL_TEXT = '---\nname: cross-host-office\ndescription: Review explicitly supplied office material\n---\n' + CROSS_HOST_SKILL_BODY;
export const CROSS_HOST_HISTORY_RELATIVE = 'codex/archived_sessions/rollout-2026-10-17T00-00-00-10000000-0000-4000-8000-000000000001.jsonl.zst';

/** Both machines receive only this run's synthetic files, never a vendor or user home. */
export async function seedCrossHostAdoptionSource(source, label, marker, original, decoded) {
  assert.ok(['windows', 'linux'].includes(label));
  assert.ok(Buffer.isBuffer(original) && original.length > 4 && original.length < 65536);
  assert.equal(original.subarray(0, 4).toString('hex'), '28b52ffd');
  assert.ok(Buffer.isBuffer(decoded) && decoded.length < 65536);
  const rows = decoded.toString('utf8').trim().split('\n').map(value => JSON.parse(value));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].payload.id, '10000000-0000-4000-8000-000000000001');
  const command = label === 'windows'
    ? `powershell -NoProfile -Command Set-Content '${marker}' executed` : `touch ${marker}`;
  const sourceBytes = JSON.stringify({ model: `owned-${label}-source-model`,
    env: { ANTHROPIC_BASE_URL: 'https://owned-cross-host.example.invalid' },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } });
  const items = [['settings.json', Buffer.from(sourceBytes)],
    ['skills/cross-host-office/SKILL.md', Buffer.from(CROSS_HOST_SKILL_TEXT)],
    [CROSS_HOST_HISTORY_RELATIVE, original]];
  for (const [relative, bytes] of items) {
    const file = join(source, ...relative.split('/'));
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o600 });
  }
  return { model: `owned-${label}-source-model`, files: items.map(([path, bytes]) => ({ path, sha256: sha(bytes), bytes: bytes.length })),
    historyOriginalSha256: sha(original), historyDecodedSha256: sha(decoded), historyDecodedBytes: decoded.length };
}

/** A new authenticated public RPC connection targets the same Gateway account/workspace. */
export async function openCrossHostMigrationRpc(base, credentials, targetId, workspace) {
  const url = new URL('/rpc', base); url.protocol = 'ws:';
  url.searchParams.set('server', targetId); url.searchParams.set('workspace', workspace);
  url.searchParams.set('token', credentials.rpcToken);
  const rpc = await openRpc(url.toString(), { headers: { authorization: `Bearer ${credentials.accessToken}`, origin: base } });
  try {
    const initialized = await initializeRpc(rpc, 'owned-cross-host-adoption');
    assert.equal(initialized.capabilities.experimental.migrationBatchWorkersV1, true);
    rpc.crossHostCapabilities = Object.freeze({ ...initialized.capabilities.experimental });
    return rpc;
  } catch (error) { await closeRpcAndWait(rpc); throw error; }
}

const RPC_METHODS = new Set(['migration/items', 'migration/batch/read', 'migration/batch/item/plan',
  'migration/batch/plan', 'migration/batch/run', 'migration/history/read']);
async function request(rpc, method, params) {
  assert.ok(RPC_METHODS.has(method), 'the fixture never starts a model or historical tool');
  try { return await rpc.request(method, params); }
  catch (error) { throw new Error(`${method}: ${error.message}`, { cause: error }); }
}
async function stopped(rpc, jobId, until, expectedStatus) {
  return until(async () => {
    const value = await request(rpc, 'migration/batch/read', { jobId });
    if (value.workerRunning) return false;
    assert.equal(value.workerError, null);
    assert.equal(value.state.job.status, expectedStatus);
    assert.equal(value.state.job.hasUnconfirmedOutcomes, false);
    return value;
  }, 'authoritative ordinary batch stopped', 30000);
}
export function assertCrossHostSelectedDiagnostics(item) {
  const issues = item.issues.map(issue => ({ code: issue.code, severity: issue.severity, phase: issue.phase }))
    .sort((left, right) => left.code.localeCompare(right.code));
  if (item.category === 'provider') {
    // This fixture adds an API canary, producing both provider and inventory exclusion notices.
    assert.deepEqual(issues, [
      { code: 'credential_resolution_required', severity: 'blocking', phase: 'activation' },
      { code: 'secret_excluded', severity: 'notice', phase: 'import' },
      { code: 'secret_excluded', severity: 'notice', phase: 'import' },
    ]);
  } else if (item.category === 'history') {
    assert.deepEqual(issues, [{ code: 'requires_review', severity: 'warning', phase: 'activation' }]);
  } else assert.deepEqual(issues, []);
}

/** Receive/preview never publish. Only original ordinary batch confirmations may write or undo. */
export async function exerciseCrossHostAdoption({ call, until, connect, closeRecovery, reopenRecovery,
  recovery, pair, receipt, from, to, files, expected }) {
  const originalSettings = JSON.parse(await files.read('settings.json'));
  const received = await call('source-transfer', 'received', { target: recovery, requestId: pair.requestId,
    manifestSha256: receipt.manifestSha256, pageIndex: 0 });
  assert.equal(received.totalSources, 3); assert.equal(received.items.length, 3); assert.equal(received.nextPage, null);
  assert.deepEqual(received.items.map(item => item.class).sort(), ['configuration', 'history', 'work_asset']);
  assert.equal(received.items.find(item => item.class === 'work_asset').category, 'skill');
  const historySource = received.items.find(item => item.class === 'history');
  assert.equal(historySource.projectScoped, true, 'historical project is provenance, not a destination mapping');
  const locator = { target: recovery, requestId: pair.requestId, adoptionId: randomUUID() };
  const initial = await call('source-transfer', 'adoption-prepare', { locator, manifestSha256: receipt.manifestSha256,
    selections: received.items.map(item => ({ entryId: item.entryId })) });
  assert.equal(initial.state.adoptionId, locator.adoptionId);
  const ready = await until(async () => {
    const value = await call('source-transfer', 'adoption-read', locator);
    if (value.state.workerState === 'running') return false;
    assert.equal(value.state.workerState, 'stopped'); assert.equal(value.state.phase, 'preview_ready'); return value.state;
  }, 'cross-host adoption preview', 30000);
  assert.equal(ready.completedSources, 3); assert.equal(ready.jobs.length, 2);
  assert.ok(ready.jobs.every(job => job.previewReady));
  assert.deepEqual(JSON.parse(await files.read('settings.json')), originalSettings);
  const providerName = to === 'windows' ? 'ReceivedLinuxOffice' : 'ReceivedWindowsOffice';
  const skillName = `received-${from}-office`;
  assert.equal(await files.exists(`skills/${skillName}`), false);
  const jobs = [];
  for (const preview of ready.jobs) {
    let rpc = await connect();
    try {
      const inventory = await request(rpc, 'migration/items', { jobId: preview.jobId, pageIndex: 0 });
      assert.ok(inventory.items.length > 0 && inventory.items.length <= 10);
      const selected = inventory.items.filter(item => ['provider', 'skill', 'history'].includes(item.category));
      assert.deepEqual(selected.map(item => item.category).sort(), preview.source === 'codex' ? ['history'] : ['provider', 'skill']);
      const choices = selected.map(item => item.category === 'provider'
        ? { kind: 'provider', itemId: item.id, targetName: providerName, endpoint: null, model: null,
          contextWindowTokens: 128000, outputHeadroomTokens: 8192, maxOutputTokens: 8192 }
        : item.category === 'history' ? { kind: 'history', itemId: item.id }
          : { kind: 'asset', itemId: item.id, targetName: skillName, enableAfterImport: false });
      const before = await request(rpc, 'migration/batch/read', { jobId: preview.jobId });
      const planned = await request(rpc, 'migration/batch/plan', { jobId: preview.jobId, expectedSequence: before.state.job.sequence,
        choices, includeDefaultItems: false, excludedItemIds: [], reuseExisting: false });
      assert.ok(planned.batch.planId);
      const childItem = selected.find(item => item.category === 'history');
      const detail = await request(rpc, 'migration/batch/item/plan', { jobId: preview.jobId, itemId: selected[0].id });
      if (!childItem) {
        assert.equal(await files.exists(`skills/${skillName}`), false, 'planning cannot install a skill');
        assert.equal(JSON.parse(await files.read('settings.json')).providers[providerName], undefined);
        const skillItem = selected.find(item => item.category === 'skill');
        const skillPlan = await request(rpc, 'migration/batch/item/plan', { jobId: preview.jobId, itemId: skillItem.id });
        assert.equal(skillPlan.item.enabled, false); assert.equal(skillPlan.item.nativeReference, false);
      } else {
        assert.match(detail.item.historyJobId, /^[a-f0-9-]{36}$/);
        assert.equal(await files.exists(`migrations/history/${detail.item.historyJobId}.json`), false, 'preview does not create a history child');
      }
      await request(rpc, 'migration/batch/run', { jobId: preview.jobId, expectedSequence: planned.job.sequence,
        planId: planned.batch.planId, requestId: randomUUID(), mode: 'apply' });
      const published = await stopped(rpc, preview.jobId, until, 'completed_with_issues');
      assert.equal(published.state.job.committedItems, selected.length);
      assert.equal(published.state.batch.committedActions, childItem ? 1 : 2);
      const checked = await request(rpc, 'migration/items', { jobId: preview.jobId, pageIndex: 0 });
      for (const chosen of selected) {
        const item = checked.items.find(item => item.id === chosen.id);
        assert.equal(item.status, 'committed'); assertCrossHostSelectedDiagnostics(item);
      }
      let child = null, archive = null;
      if (!childItem) {
        const settings = JSON.parse(await files.read('settings.json'));
        assert.equal(settings.active_provider, originalSettings.active_provider);
        assert.equal(settings.providers[providerName].default_model, expected.model);
        const body = (await files.read(`skills/${skillName}/SKILL.md`)).toString('utf8');
        assert.ok(body.endsWith(CROSS_HOST_SKILL_BODY)); assert.ok(body.includes('default_enabled: false'));
      } else {
        child = detail.item.historyJobId;
        const history = await request(rpc, 'migration/history/read', { jobId: child });
        assert.equal(history.job.stage, 'normalized'); assert.equal(history.job.archived, true);
        assert.equal(history.job.normalization.normalizedRecords, 3); assert.ok(history.job.normalization.recordsWithDiagnostics > 0);
        archive = history.job.archiveId; assert.match(archive, /^archive-[a-f0-9]{64}$/);
        assert.equal(sha(await files.read(`external-history/${archive}/original.bin`)), expected.historyOriginalSha256);
        assert.equal(sha(await files.read(`external-history/${archive}/source.bin`)), expected.historyDecodedSha256);
      }
      await closeRpcAndWait(rpc, 'cross-host publication observer'); rpc = null;
      rpc = await connect();
      const reopened = await request(rpc, 'migration/batch/read', { jobId: preview.jobId });
      assert.equal(reopened.state.job.status, 'completed_with_issues');
      assert.equal(reopened.state.batch.committedActions, childItem ? 1 : 2);
      await request(rpc, 'migration/batch/run', { jobId: preview.jobId, expectedSequence: reopened.state.job.sequence,
        planId: planned.batch.planId, requestId: randomUUID(), mode: 'rollback' });
      const undone = await stopped(rpc, preview.jobId, until, 'rolled_back');
      if (child) {
        const history = await request(rpc, 'migration/history/read', { jobId: child });
        assert.equal(history.job.archived, true, 'the original import fact remains in audit');
        assert.equal(await files.exists(`external-history/${archive}`), false, 'only the original unreferenced managed generation is collected');
      } else {
        assert.deepEqual(JSON.parse(await files.read('settings.json')), originalSettings);
        assert.equal(await files.exists(`skills/${skillName}`), false);
      }
      jobs.push({ jobId: preview.jobId, source: preview.source, selectedClasses: selected.map(item => item.category),
        publishedStatus: published.state.job.status, committedItems: published.state.job.committedItems,
        reopenedOnNewRpc: true, undoStatus: undone.state.job.status, historyJobId: child, archiveId: archive,
        originalAndDecodedHistoryVerified: !!child, defaultSkillDisabled: !child,
        diagnostics: checked.items.filter(item => selected.some(chosen => chosen.id === item.id)).map(item => ({ category: item.category, issues: item.issues })) });
    } finally { await closeRpcAndWait(rpc, 'cross-host ordinary migration observer'); }
  }
  await closeRecovery(recovery);
  const reopenedRecovery = await reopenRecovery();
  try {
    const observed = await call('source-transfer', 'adoption-read', { ...locator, target: reopenedRecovery });
    assert.deepEqual(observed.state.jobs, ready.jobs);
    const incoming = await call('source-transfer', 'target-read', { requestId: pair.requestId, target: reopenedRecovery });
    assert.equal(incoming.result.sourceObserved, false); assert.deepEqual(incoming.result.receipt, receipt);
  } finally { await closeRecovery(reopenedRecovery); }
  assert.deepEqual(JSON.parse(await files.read('settings.json')), originalSettings);
  return { adoptionId: locator.adoptionId, previewCreatedNoPublishedOutput: true, sourceOfflineBeforeAdoption: true,
    logicalClasses: received.items.map(item => item.class), ordinaryJobs: jobs, sameAdoptionReopenedOnNewTargetChild: true,
    settingsRestored: true, skillRemovedByOwnedUndo: true, originalHistoryAuditRetained: true };
}
