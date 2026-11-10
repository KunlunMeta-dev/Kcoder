import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationPerformanceCase, smallAssetCounts, smallAssetObservationBudget, writeSmallAssetFixture, verifySmallAssetFixture, activeSmallAssetCheckpoint, smallAssetCancellationReceipt, smallAssetPlannedTargets, SMALL_ASSET_COUNTS, SMALL_ASSET_LIMITS } from './migration-small-assets.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';
import { prepareSuiteArtifacts } from '../run-all.mjs';

async function owned(t) { const root = await mkdtemp(join(tmpdir(), 'kcoder-small-assets-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('the registered performance entry keeps 500MiB default and rejects unknown cases without widening other suite environments', async () => {
  assert.equal(migrationPerformanceCase(undefined), 'history-500mib'); assert.equal(migrationPerformanceCase('history-500mib'), 'history-500mib');
  assert.equal(migrationPerformanceCase('small-assets'), 'small-assets');
  for (const value of ['', true, 'small', '5000-files']) assert.throws(() => migrationPerformanceCase(value));
  const suite = 'suites/browser/migration-large-history.e2e.mjs'; assert.ok(suiteEnvironmentNames(suite).includes('KCODER_E2E_MIGRATION_PERF_CASE'));
  for (const env of ['KCODER_E2E_MIGRATION_RENDERER_BASELINE', 'KCODER_E2E_MIGRATION_RENDERER_BASELINE_SHA256', 'KCODER_E2E_MIGRATION_SMALL_ASSET_COUNT']) {
    assert.ok(suiteEnvironmentNames(suite).includes(env));
    assert.equal(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes(env), false);
  }
  assert.equal(suiteEnvironmentNames('suites/browser/migration.e2e.mjs').includes('KCODER_E2E_MIGRATION_PERF_CASE'), false);
  await prepareSuiteArtifacts([suite], { run: () => assert.fail('performance selection must not rebuild Native or Renderer') });
  assert.deepEqual(SMALL_ASSET_COUNTS, [128, 1024]);
});

test('a diagnostic count selects only a known scale while the original default retains both', () => {
  assert.deepEqual(smallAssetCounts(undefined), [128, 1024]);
  assert.deepEqual(smallAssetCounts('128'), [128]); assert.deepEqual(smallAssetCounts('1024'), [1024]);
  for (const value of ['', '0', '1025', '128,1024', '01024', 1024, true]) assert.throws(() => smallAssetCounts(value));
});
test('only1024 receives its declared normal-dev functional observation allowance, with fixed performance goals', () => {
  assert.deepEqual(smallAssetObservationBudget(128), { totalMs: 600000, resumeMs: 390000, undoMs: 390000 });
  assert.deepEqual(smallAssetObservationBudget(1024), { totalMs: 1200000, resumeMs: 390000, undoMs: 720000 });
  assert.throws(() => smallAssetObservationBudget(1025));
  assert.deepEqual([SMALL_ASSET_LIMITS.firstFeedbackMs, SMALL_ASSET_LIMITS.cancelIntentMs, SMALL_ASSET_LIMITS.cancelStoppedMs], [2000, 1000, 5000]);
  assert.deepEqual([SMALL_ASSET_LIMITS.nativeDeltaBytes, SMALL_ASSET_LIMITS.gatewayDeltaBytes, SMALL_ASSET_LIMITS.browserDeltaBytes], [128, 128, 256].map(value => value * 1024 * 1024));
});

test('small fixtures are bounded ordinary files with complete byte receipts and refuse overwrite/source edits', async t => {
  const parent = await owned(t), root = join(parent, 'source'); const fixture = await writeSmallAssetFixture(root, 128);
  assert.equal(fixture.assets, 128); assert.equal(fixture.payloadFiles, 256); assert.equal(fixture.directoryEntries, 384);
  assert.ok(fixture.totalBytes < 128 * 1024); assert.equal(await verifySmallAssetFixture(fixture), true);
  assert.match(fixture.cacheCondition, /no cold-cache/); assert.equal((await readdir(join(root, 'skills'))).length, 128);
  await assert.rejects(writeSmallAssetFixture(root, 128), { code: 'EEXIST' });
  await writeFile(join(root, fixture.files[0].path), 'changed'); await assert.rejects(verifySmallAssetFixture(fixture), /source bytes changed/);
  for (const count of [0, -1, 1025, 1.5, '128']) await assert.rejects(writeSmallAssetFixture(join(parent, 'invalid'), count));
  assert.deepEqual((await readdir(parent)).sort(), ['source']);
});

test('fixture generation cannot follow a linked ancestor to an unowned directory', async t => {
  const parent = await owned(t), outside = join(parent, 'outside'); await mkdir(outside); await symlink(outside, join(parent, 'linked'));
  await assert.rejects(writeSmallAssetFixture(join(parent, 'linked/source'), 2), /ordinary path/);
  assert.deepEqual(await readdir(outside), []);
});

test('completed, stopped, failed, foreign-size or unknown workers never count as active cancellation', () => {
  const sample = { workerRunning: true, workerError: null, state: { job: { totalItems: 1024, committedItems: 1, hasUnconfirmedOutcomes: false, status: 'applying' } } };
  assert.equal(activeSmallAssetCheckpoint(sample, 1024), sample);
  assert.equal(activeSmallAssetCheckpoint({ ...sample, workerRunning: false }, 1024), false);
  assert.equal(activeSmallAssetCheckpoint({ ...sample, workerRunning: null }, 1024), false);
  for (const status of ['completed', 'completed_with_issues', 'failed', 'cancelled', 'rolled_back', 'interrupted', 'commit_unknown']) assert.throws(() => activeSmallAssetCheckpoint({ ...sample, state: { job: { ...sample.state.job, status } } }, 1024));
  assert.throws(() => activeSmallAssetCheckpoint({ ...sample, workerError: 'outcome_unknown' }, 1024));
  const committing = { ...sample, state: { job: { ...sample.state.job, hasUnconfirmedOutcomes: true } } };
  assert.equal(activeSmallAssetCheckpoint(committing, 1024), committing);
  assert.throws(() => activeSmallAssetCheckpoint({ ...committing, workerRunning: false }, 1024));
  assert.throws(() => activeSmallAssetCheckpoint(sample, 128));
});

test('cancellation is bound to the original execution and UUID receipt independently of progress revisions', () => {
  const generation = { planId: 'owned-plan', runRequestId: 'original-run', admissionSequence: 2, mode: 'apply' };
  const original = { jobId: 'owned-job', phase: 'tracked', currentSequence: 14, generation };
  const receipt = { commandId: '11111111-1111-4111-8111-111111111111', planId: generation.planId,
    runRequestId: generation.runRequestId, admissionSequence: 2, acceptedSequence: 20 };
  const operation = { method: 'migration/batch/control/cancel', jobId: original.jobId, ...receipt,
    control: { jobId: original.jobId, phase: 'tracked', currentSequence: 21, generation, cancelRequested: true, requestedReceipt: receipt } };
  assert.equal(smallAssetCancellationReceipt(original, operation), receipt);
  for (const changed of [{ jobId: 'peer-job' }, { planId: 'peer-plan' }, { runRequestId: 'later-run' }, { admissionSequence: 15 },
    { commandId: '22222222-2222-4222-8222-222222222222' }, { method: 'migration/cancel' }, { errorCode: -32047 }])
    assert.throws(() => smallAssetCancellationReceipt(original, { ...operation, ...changed }));
  for (const changed of [{ phase: 'legacy_unknown' }, { requestedReceipt: null }, { cancelRequested: false },
    { requestedReceipt: { ...receipt, acceptedSequence: 999 } }, { generation: { ...generation, runRequestId: 'new-owner' } }])
    assert.throws(() => smallAssetCancellationReceipt(original, { ...operation, control: { ...operation.control, ...changed } }));
});

test('unified asset target names come from exact paged item plans and cannot borrow a peer or enabled plan', async () => {
  const requests = [], rpc = { async request(method, params) {
    assert.equal(method, 'migration/items'); assert.equal(params.jobId, 'original'); requests.push(params.pageIndex);
    const offset = params.pageIndex * 10, count = params.pageIndex ? 2 : 10;
    return { items: Array.from({ length: count }, (_, index) => ({ id: `item-${offset + index}`, category: 'skill' })),
      planned: Array.from({ length: count }, (_, index) => ({ itemId: `item-${offset + index}`, targetName: `native-target-${offset + index}`, enabled: false })), nextCursor: params.pageIndex ? null : 'owned-next' };
  } };
  assert.equal((await smallAssetPlannedTargets(rpc, 'original', 12)).length, 12); assert.deepEqual(requests, [0, 1]);
  await assert.rejects(smallAssetPlannedTargets({ request: async (...args) => {
    const value = await rpc.request(...args); value.planned[0].itemId = 'peer-item'; return value;
  } }, 'original', 12));
  await assert.rejects(smallAssetPlannedTargets({ request: async (...args) => {
    const value = await rpc.request(...args); value.planned[0].enabled = true; return value;
  } }, 'original', 12));
});
