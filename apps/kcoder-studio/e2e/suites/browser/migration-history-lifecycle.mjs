import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';

export const lifecycleExists = file => access(file).then(() => true, () => false);
export async function seedLifecycleArchives(context, rpc, sourceRoot, count = 12) {
  let auditCount = 0, cursor;
  for (let page = 0; page < 64; page++) {
    const current = await rpc.request('migration/history/retirement/list', cursor ? { cursor } : {});
    auditCount += current.items.length;
    if (!current.nextCursor) break;
    cursor = current.nextCursor;
    assert.ok(page < 63, 'owned retirement audit fixture exceeds its explicit bound');
  }
  const prefix = `Owned retirement ${randomUUID()}`, sources = [];
  for (let index = 0; index < count; index++) {
    const session = randomUUID(), title = `${prefix} ${index}`, file = resolve(sourceRoot, `projects/owned-retirement/${session}.jsonl`);
    const text = [{ type: 'user', uuid: 'root', parentUuid: null, sessionId: session, version: '2.1.301', message: { role: 'user', content: title } },
      { type: 'assistant', uuid: 'answer', parentUuid: 'root', sessionId: session, version: '2.1.301', message: { role: 'assistant', content: 'Owned synthetic archive; never an active model request.' } }].map(row => JSON.stringify(row)).join('\n') + '\n';
    await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 }); await writeFile(file, text, { mode: 0o600 });
    sources.push({ file, title, sha256: createHash('sha256').update(text).digest('hex') });
  }
  const catalog = await rpc.request('migration/history/discover', { source: 'claude-code' });
  const matches = []; let page = catalog;
  for (let index = 0; index < 32; index++) {
    matches.push(...page.items.filter(item => sources.some(source => source.title === item.title)));
    if (!page.nextCursor) break;
    page = await rpc.request('migration/history/sources', { catalogId: catalog.catalogId, cursor: page.nextCursor });
  }
  assert.equal(matches.length, count, 'all synthetic lifecycle sources must be statically discovered');
  const jobs = [];
  for (const item of matches) {
    const id = randomUUID(), created = await rpc.request('migration/history/create', { catalogId: catalog.catalogId, sourceHandle: item.sourceHandle, requestId: id });
    await rpc.request('migration/history/run', { jobId: id, expectedSequence: created.job.sequence });
    const job = await waitFor(async () => {
      const value = await rpc.request('migration/history/read', { jobId: id });
      return value.job.stage === 'normalized' && !value.workerRunning ? value.job : null;
    }, 30_000, 'owned lifecycle archive normalization');
    jobs.push(job);
  }
  return { jobs, sources, auditCount };
}

export async function assertLifecycleCollection(context, rpc, profile, fixture, job, operation, platform, pageSizes) {
  const done = await waitFor(async () => {
    const value = await rpc.request('migration/history/retirement/read', { jobId: job.jobId, operationId: operation });
    return value.retirement.phase === 'collected' && value.workerState === 'stopped' && !value.workerScheduled ? value : null;
  }, 15_000, 'original archive collection receipt');
  assert.equal(done.retirement.logicalRetired, true); assert.ok(done.retirement.collectedBytes > 0);
  assert.equal(await lifecycleExists(resolve(profile, 'external-history', job.archiveId, 'source.bin')), false);
  assert.ok(await lifecycleExists(resolve(profile, 'external-history/managed-v2/lifecycle.json')));
  assert.deepEqual((await rpc.request('migration/history/read', { jobId: job.jobId })).job, job, 'import facts must remain unchanged');
  for (const source of fixture.sources) assert.equal(createHash('sha256').update(await readFile(source.file)).digest('hex'), source.sha256);
  await context.writeArtifactJson(`${platform}-history-view-retirement.json`, { passed: true, platform, sourceJobId: job.jobId, operationId: operation,
    nativeManagedBirth: true, noImplicitRetirement: true, viewProtectionConfirmed: true, peerViewBlockedCollection: true,
    cancellationAndReopen: true, resumeDoesNotDelete: true, explicitConfirmation: 'RETIRE', explicitRuns: 2,
    logicalRetirementSeparate: true, physicalArchiveBytesRemoved: done.retirement.collectedBytes, auditRetained: true,
    importFactsAndSourcesUnchanged: true, auditPageSizes: pageSizes, modelCalls: 0,
    scope: 'Actual owned UI/Gateway/Native synthetic archives. No personal data, native desktop/Android/iOS, installer or filesystem free-block claim.' });
  return done;
}

export async function exerciseBrowserHistoryLifecycle({ context, page, observer: rpc, profile, sourceRoot, observations }) {
  const initial = observations.length, fixture = await seedLifecycleArchives(context, rpc, sourceRoot), job = fixture.jobs[0];
  const persisted = JSON.parse(await readFile(resolve(profile, 'migrations/history', `${job.jobId}.json`), 'utf8'));
  assert.equal(persisted.version, 3, 'positive collection must use an actual new managed birth');
  const dialog = page.getByTestId('migration-dialog');
  const openJob = async () => {
    await selectAdvancedMigration(dialog, 'history');
    const history = page.getByTestId('migration-history');
    if (await history.getByRole('button', { name: '返回档案选择', exact: true }).count()) await history.getByRole('button', { name: '返回档案选择', exact: true }).click();
    await history.getByRole('button', { name: '归档记录', exact: true }).click();
    for (let index = 0; index < 16; index++) {
      const row = history.getByRole('button').filter({ hasText: job.jobId });
      if (await row.count()) { await row.click(); break; }
      const next = history.getByRole('button', { name: '下一页', exact: true });
      assert.ok(await next.isEnabled(), 'owned lifecycle job missing from native pages'); await next.click();
    }
    await page.getByTestId('migration-history-view-status').getByText(/刚刚确认/).waitFor();
    const panel = page.getByTestId('migration-archive-retirement'); await panel.locator('summary').first().click(); return panel;
  };
  let panel = await openJob();
  assert.equal(observations.slice(initial).filter(row => row.method === 'migration/history/retirement/run').length, 0);
  assert.equal((await rpc.request('migration/history/retirement/preview', { jobId: job.jobId })).readersIdle, false);
  await panel.getByTestId('migration-retirement-prepare').click();
  await panel.getByTestId('migration-retirement-phase').getByText('已准备，尚未执行', { exact: true }).waitFor();
  const operation = (await rpc.request('migration/history/retirement/preview', { jobId: job.jobId })).existing.retirement.operationId;
  for (const other of fixture.jobs.slice(1)) await rpc.request('migration/history/retirement/prepare', { operationId: randomUUID(), jobId: other.jobId, expectedJobSequence: other.sequence });
  await panel.getByTestId('migration-retirement-cancel').click();
  await panel.getByTestId('migration-retirement-phase').getByText('已停止，内容继续保留', { exact: true }).waitFor();
  await selectAdvancedMigration(dialog, 'single'); panel = await openJob();
  await panel.getByTestId('migration-retirement-phase').getByText('已停止，内容继续保留', { exact: true }).waitFor();
  const confirm = async word => { await panel.getByTestId('migration-retirement-confirm-input').fill(word); await panel.getByTestId('migration-retirement-confirm-submit').click(); };
  await panel.getByTestId('migration-retirement-resume').click(); await confirm('RESUME');
  await panel.getByTestId('migration-retirement-phase').getByText('已准备，尚未执行', { exact: true }).waitFor();
  assert.ok(await lifecycleExists(resolve(profile, 'external-history', job.archiveId, 'source.bin')));
  assert.equal(observations.slice(initial).filter(row => row.method === 'migration/history/retirement/run').length, 0);
  const audit = panel.getByTestId('migration-retirement-audit'); await audit.locator('summary').click();
  await waitFor(async () => await audit.getByTestId('migration-retirement-audit-row').count() === 10, 10_000, 'ten retirement audit rows');
  const pageSizes = [10]; await audit.getByRole('button', { name: '下一页', exact: true }).click();
  await waitFor(async () => await audit.getByTestId('migration-retirement-audit-row').count() === Math.min(10, fixture.auditCount + 2), 10_000, 'second retirement audit page');
  pageSizes.push(await audit.getByTestId('migration-retirement-audit-row').count());
  const peerRequest = randomUUID(), peer = await rpc.request('migration/history/view/open', { requestId: peerRequest, jobId: job.jobId, expectedArchiveId: job.archiveId });
  assert.equal(peer.lease.state, 'active');
  try {
    await panel.getByTestId('migration-retirement-run').click();
    assert.equal(await panel.getByTestId('migration-retirement-confirm-submit').isDisabled(), true);
    await confirm('RETIRE');
    await panel.getByTestId('migration-retirement-phase').getByText('已保留：存在冲突或缺少安全证明', { exact: true }).waitFor();
    const blocked = await rpc.request('migration/history/retirement/read', { jobId: job.jobId, operationId: operation });
    assert.equal(blocked.retirement.failureCode, 'external_history_retirement_readers_busy'); assert.equal(blocked.retirement.logicalRetired, false);
  } finally { await rpc.request('migration/history/view/release', { requestId: peerRequest, leaseId: peer.lease.leaseId }); }
  await panel.getByTestId('migration-retirement-resume').click(); await confirm('RESUME');
  await panel.getByTestId('migration-retirement-phase').getByText('已准备，尚未执行', { exact: true }).waitFor();
  await panel.getByTestId('migration-retirement-run').click(); await confirm('RETIRE');
  await panel.getByTestId('migration-retirement-phase').getByText('回收回执已完成', { exact: true }).waitFor();
  await page.getByTestId('migration-history-retired').waitFor();
  assert.equal(await page.getByTestId('historical-record').count(), 0);
  assert.equal(observations.slice(initial).filter(row => row.method === 'migration/history/retirement/run').length, 2, 'only two explicit confirmations dispatch collection');
  await assertLifecycleCollection(context, rpc, profile, fixture, job, operation, 'browser', pageSizes);
  await page.screenshot({ path: context.pathInArtifacts('browser-history-retired.png') });
  return { historyViewProtection: true, explicitArchiveRetirement: true, auditPageSize: 10, noModelCalls: true };
}
