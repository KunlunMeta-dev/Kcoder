import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { seedLifecycleArchives, assertLifecycleCollection, lifecycleExists } from '../browser/migration-history-lifecycle.mjs';

export async function exerciseMobileHistoryLifecycle({ context, page, observer: rpc, profile, sourceRoot, observations }) {
  const initial = observations.length, fixture = await seedLifecycleArchives(context, rpc, sourceRoot), job = fixture.jobs[0];
  const openJob = async () => {
    await page.getByTestId('migration-archive-open').click();
    await page.getByRole('button', { name: 'History tasks', exact: true }).click();
    const list = page.getByTestId('migration-results-list');
    await waitFor(async () => await list.locator('[data-testid^="migration-job-"]').count() > 0, 15_000, 'first authoritative native history page');
    for (let index = 0; index < 16; index++) {
      await list.waitFor();
      const row = list.getByTestId(`migration-job-${job.jobId}`);
      if (await row.count()) { await row.click(); break; }
      const next = list.getByRole('button', { name: 'Next', exact: true });
      const ids = await list.locator('[data-testid^="migration-job-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')).join(','));
      assert.ok(await next.isEnabled(), 'owned lifecycle archive must remain in native history pages');
      await next.click();
      await waitFor(async () => {
        const current = await list.locator('[data-testid^="migration-job-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')).join(','));
        return current.length > 0 && current !== ids;
      }, 10_000, 'next authoritative native history page');
    }
    await page.getByTestId('migration-history-workspace').waitFor();
    await page.getByTestId('migration-history-view-status').getByText(/Read protection was just confirmed/).waitFor();
    const panel = page.getByTestId('migration-archive-retirement');
    await panel.getByTestId('migration-retirement-expand').click();
    return panel;
  };
  let panel = await openJob();
  await page.getByTestId('migration-record-0').waitFor();
  assert.equal(observations.slice(initial).filter(row => row.method === 'migration/history/retirement/run').length, 0);
  assert.equal((await rpc.request('migration/history/retirement/preview', { jobId: job.jobId })).readersIdle, false);
  await panel.getByTestId('migration-retirement-prepare').click();
  await panel.getByTestId('migration-retirement-phase').getByText('Prepared; not executed', { exact: true }).waitFor();
  const operation = (await rpc.request('migration/history/retirement/preview', { jobId: job.jobId })).existing.retirement.operationId;
  for (const other of fixture.jobs.slice(1)) await rpc.request('migration/history/retirement/prepare', { operationId: randomUUID(), jobId: other.jobId, expectedJobSequence: other.sequence });
  await panel.getByTestId('migration-retirement-cancel').click();
  await panel.getByTestId('migration-retirement-phase').getByText('Stopped; content retained', { exact: true }).waitFor();
  await page.getByTestId('migration-workbench-open').click(); panel = await openJob();
  await panel.getByTestId('migration-retirement-phase').getByText('Stopped; content retained', { exact: true }).waitFor();
  const confirm = async word => {
    await panel.getByTestId('migration-retirement-confirm-input').fill(word);
    await panel.getByTestId('migration-retirement-confirm-submit').click();
  };
  await panel.getByTestId('migration-retirement-resume').click(); await confirm('RESUME');
  await panel.getByTestId('migration-retirement-phase').getByText('Prepared; not executed', { exact: true }).waitFor();
  assert.ok(await lifecycleExists(resolve(profile, 'external-history', job.archiveId, 'source.bin')), 'resume must not remove content');
  assert.equal(observations.slice(initial).filter(row => row.method === 'migration/history/retirement/run').length, 0);
  const audit = panel.getByTestId('migration-retirement-audit');
  await waitFor(async () => await audit.getByTestId('migration-retirement-audit-row').count() === 10, 10_000, 'ten retained native audit records');
  const pageSizes = [10], previousText = await audit.innerText();
  await audit.getByRole('button', { name: 'Next', exact: true }).click();
  const remaining = Math.min(10, fixture.auditCount + 2);
  await waitFor(async () => await audit.getByTestId('migration-retirement-audit-row').count() === remaining && await audit.innerText() !== previousText, 10_000, 'second native audit page');
  pageSizes.push(remaining);
  const requestId = randomUUID(), peer = await rpc.request('migration/history/view/open', { requestId, jobId: job.jobId, expectedArchiveId: job.archiveId });
  assert.equal(peer.lease.state, 'active');
  try {
    await panel.getByTestId('migration-retirement-run').click();
    assert.equal(await panel.getByTestId('migration-retirement-confirm-submit').isDisabled(), true);
    await confirm('RETIRE');
    await panel.getByTestId('migration-retirement-phase').getByText('Retained: conflict or safety proof unavailable', { exact: true }).waitFor();
    const blocked = await rpc.request('migration/history/retirement/read', { jobId: job.jobId, operationId: operation });
    assert.equal(blocked.retirement.failureCode, 'external_history_retirement_readers_busy');
    assert.equal(blocked.retirement.logicalRetired, false);
  } finally { await rpc.request('migration/history/view/release', { requestId, leaseId: peer.lease.leaseId }); }
  await panel.getByTestId('migration-retirement-resume').click(); await confirm('RESUME');
  await panel.getByTestId('migration-retirement-phase').getByText('Prepared; not executed', { exact: true }).waitFor();
  await panel.getByTestId('migration-retirement-run').click(); await confirm('RETIRE');
  await panel.getByTestId('migration-retirement-phase').getByText('Collection receipt completed', { exact: true }).waitFor();
  await page.getByTestId('migration-history-retired').waitFor();
  assert.equal(await page.locator('[data-testid^="migration-record-"]').count(), 0);
  assert.equal(observations.slice(initial).filter(row => row.method === 'migration/history/retirement/run').length, 2);
  await assertLifecycleCollection(context, rpc, profile, fixture, job, operation, 'mobile-web', pageSizes);
  await page.screenshot({ path: context.pathInArtifacts('mobile-history-retired.png'), fullPage: true });
  return { historyViewProtection: true, explicitArchiveRetirement: true, auditPageSize: 10, noModelCalls: true };
}
