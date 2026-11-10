import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';

export async function exerciseBatchHistoryMigration({ context, page, observer, observations }) {
  const session = randomUUID(), title = `统一批次历史验收-${randomUUID()}`;
  const file = context.pathInState(`sources/claude/projects/example-project/${session}.jsonl`);
  const count = 3000;
  const text = Array.from({ length: count }, (_, index) => JSON.stringify({ type: 'user',
    uuid: `batch-row-${index}`, parentUuid: index ? `batch-row-${index - 1}` : null, sessionId: session,
    message: { role: 'user', content: index ? `批次归档检查 ${index}` : title } })).join('\n') + '\n';
  await mkdir(resolve(file, '..'), { recursive: true });
  await writeFile(file, text);
  const digest = createHash('sha256').update(text).digest('hex');
  const initial = observations.length;
  const dialog = page.getByTestId('migration-dialog');
  await selectAdvancedMigration(dialog, 'batch');
  const picker = dialog.getByTestId('migration-batch-history-picker');
  await picker.getByRole('button', { name: '发现历史会话', exact: true }).click();
  await waitFor(async () => await picker.locator('label').count() > 0, 10_000, 'historical batch candidates');
  for (let index = 0; index < 3 && await picker.getByText(title, { exact: true }).count() === 0; index++)
    await picker.getByRole('button', { name: '下一页', exact: true }).click();
  assert.ok(await picker.locator('label').count() <= 10);
  await picker.locator('label').filter({ hasText: title }).getByRole('checkbox').check();
  await picker.getByText('已选择 1 个会话', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '预览所选来源', exact: true }).click();
  await dialog.getByRole('heading', { name: '选择迁移内容', exact: true }).waitFor();
  await dialog.getByText(title, { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '确认所选内容', exact: true }).click();
  await dialog.getByRole('heading', { name: '确认批量计划', exact: true }).waitFor();
  assert.equal(observations.slice(initial).filter(item => item.method === 'migration/batch/run').length, 0);
  await dialog.getByRole('button', { name: '开始批量迁移', exact: true }).click();
  await dialog.getByRole('heading', { name: '迁移进度', exact: true }).waitFor();
  const started = await waitFor(() => observations.slice(initial).find(item =>
    item.method === 'migration/batch/run' && item.responseJobId && item.settled), 10_000, 'accepted batch worker');
  const current = await observer.request('migration/batch/read', { jobId: started.responseJobId });
  assert.equal(current.workerRunning, true, 'a peer client sees the actual native runner lease');
  await dialog.getByRole('button', { name: '取消本次迁移', exact: true }).click();
  await dialog.getByText('已取消后续迁移', { exact: true }).waitFor();
  const stopped = await observer.request('migration/batch/read', { jobId: started.responseJobId });
  assert.equal(stopped.state.job.status, 'cancelled');
  assert.equal(stopped.workerRunning, false);
  const items = await observer.request('migration/items', { jobId: started.responseJobId });
  const detail = await observer.request('migration/batch/item/plan', { jobId: started.responseJobId, itemId: items.items[0].id });
  const child = detail.item.historyJobId;
  assert.equal(typeof child, 'string');
  await page.screenshot({ path: context.pathInArtifacts('migration-batch-history-cancelled.png') });
  const resumedAtMs=Date.now();
  await dialog.getByRole('button', { name: '核对并继续', exact: true }).click();
  await dialog.getByText('已完成保存', { exact: true }).waitFor();
  await dialog.getByText('已迁入 1 / 1 项', { exact: true }).waitFor();
  const completed = await observer.request('migration/batch/read', { jobId: started.responseJobId });
  assert.equal(completed.state.job.status, 'completed');
  const finalDetail = await observer.request('migration/batch/item/plan', { jobId: started.responseJobId, itemId: items.items[0].id });
  assert.equal(finalDetail.item.historyJobId, child);
  const archive = await observer.request('migration/history/read', { jobId: child });
  assert.equal(archive.job.normalization.normalizedRecords, count);
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), digest);
  const starts = observations.slice(initial).filter(item => item.method === 'migration/batch/run');
  assert.deepEqual(starts.map(item => item.runMode), ['apply', 'resume']);
  assert.equal(new Set(starts.map(item => item.requestId)).size, 2);
  assert.ok(starts.every(item => item.jobId === started.responseJobId));
  await page.screenshot({ path: context.pathInArtifacts('migration-batch-history-completed.png') });
  await context.writeArtifactJson('migration-batch-history-roundtrip.json', {
    jobId: started.responseJobId, childJobId: child, records: count, sourceSha256: digest,
    pageSize: 10, explicitSelection: true, confirmBeforeExecution: true, actualPeerRunning: true,
    durableCancellation: true, explicitResumeSameChild: true, requestModes: starts.map(item => item.runMode),
    resumeToObservedCompletionMs:Date.now()-resumedAtMs,
    workerObservations:observations.slice(initial).filter(item=>item.method==='migration/batch/read'||item.method==='migration/batch/run'),
    sourceUnchanged: true, scope: 'Actual Browser/Gateway/app-server flow. No model turn, no source tool execution, no native desktop or full archive retirement claim.',
  });
}
