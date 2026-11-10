import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { readFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from '../../harness/rpc.mjs';
import { waitFor } from '../../harness/run-context.mjs';
import { createLegacyHistoryFixture } from './migration-legacy-history.mjs';

/** Real UI and Native ownership checks; only this run's stopped fixture lock is moved. */
export async function exerciseHistoryWorkerOwnership({ context, page, gateway, profile, model, historySources }) {
  const token = await waitForGatewayRpcToken(context, gateway);
  const observer = await openRpc(gatewayRpcUrl(gateway, 'fixture-target', token));
  context.addCleanup('close history-worker observer', () => closeRpcAndWait(observer));
  const initialized = await observer.request('initialize', {
    protocolVersion: '2026-07-27', clientInfo: { name: 'history-worker-browser-observer', version: '1' },
    capabilities: { experimental: { migrationHistoryWorkerStateClientV1: true } },
  });
  assert.equal(initialized.capabilities.experimental.migrationHistoryWorkerStateV1, true);
  await selectAdvancedMigration(page, 'history');
  const history = page.getByTestId('migration-history');
  await history.getByRole('button', { name: '查找历史会话', exact: true }).click();
  await history.getByRole('button', { name: '保存档案', exact: true }).first().click();
  await history.getByText('档案已保存并解析', { exact: true }).waitFor();
  const jobs = await observer.request('migration/history/jobs', {});
  assert.equal(jobs.jobs.length, 1);
  const jobId = jobs.jobs[0].job.jobId;
  const stopped = await waitFor(async () => {
    const value = await observer.request('migration/history/read', { jobId });
    return value.workerState === 'stopped' && value.job.stage === 'normalized' ? value : null;
  }, 10000, 'actual history owner stopped');
  assert.equal(stopped.workerRunning, false);
  const lock = resolve(profile, `migrations/history/${jobId}.execution.lock`);
  const held = context.pathInState('owned-execution-lock-withheld');
  const original = await stat(lock, { bigint: true });
  await rename(lock, held);
  try {
    await history.getByRole('button', { name: '返回档案选择', exact: true }).click();
    await history.getByRole('button', { name: '归档记录', exact: true }).click();
    await history.getByRole('button', { name: new RegExp(jobId) }).click();
    await history.getByRole('status').filter({ hasText: '暂时无法确认任务执行状态' }).waitFor();
    assert.equal(await history.getByRole('button', { name: '核对旧任务状态', exact: true }).count(), 0);
    assert.equal(await history.getByRole('button', { name: '继续归档', exact: true }).count(), 0);
    const unknown = await observer.request('migration/history/read', { jobId });
    assert.equal(unknown.workerState, 'unknown');
    assert.equal(unknown.workerRunning, false);
    assert.equal(unknown.workerError, 'history_job_execution_unknown');
    assert.equal(await stat(lock).then(() => true, () => false), false, 'read must not repair the missing lock');
    await page.screenshot({ path: context.pathInArtifacts('history-worker-unknown.png') });
  } finally { await rename(held, lock); }
  assert.equal((await stat(lock, { bigint: true })).ino, original.ino);
  await page.getByTestId('migration-history-job').getByRole('button', { name: '刷新', exact: true }).click();
  await history.getByText('档案已保存并解析', { exact: true }).waitFor();
  const legacy = await createLegacyHistoryFixture(context, profile, jobId);
  const legacyPath = resolve(profile, `migrations/history/${legacy.jobId}.json`);
  const before = JSON.parse(await readFile(legacyPath, 'utf8'));
  assert.equal(before.version, 1);
  assert.equal(before.view.stage, 'failed');
  assert.ok(before.normalizationRevision.startsWith('foreign-records/3;'));
  await history.getByRole('button', { name: '返回档案选择', exact: true }).click();
  await history.getByRole('button', { name: '归档记录', exact: true }).click();
  await history.getByRole('button', { name: new RegExp(legacy.jobId) }).click();
  await history.getByRole('button', { name: '核对并恢复', exact: true }).click();
  await waitFor(async () => {
    const current = await observer.request('migration/history/read', { jobId: legacy.jobId });
    return current.workerState === 'stopped' ? current : null;
  }, 10000, 'explicit old terminal owner check');
  const after = JSON.parse(await readFile(legacyPath, 'utf8'));
  assert.ok(after.executionIdentity && after.executionBirthSha256);
  delete after.executionIdentity; delete after.executionBirthSha256;
  assert.deepEqual(after, before, 'old interpretation and failed checkpoint remain unchanged');
  for (const source of historySources) assert.equal(await readFile(source.file, 'utf8'), source.text);
  assert.equal(model.requests.length, 0);
  await page.screenshot({ path: context.pathInArtifacts('history-worker-legacy-checked.png') });
  const result = { passed: true, actualNativeStopped: true, missingLockUnknown: true, missingLockNotRecreated: true,
    originalLockIdentityRestored: true, oldFailedInterpretationPreserved: true, explicitLegacyOwnerCheck: true, modelRequests: 0 };
  await context.writeArtifactJson('history-worker-results.json', result);
  await closeRpcAndWait(observer);
  return result;
}
