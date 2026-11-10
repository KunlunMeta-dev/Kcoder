import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';

/** The existing registered workbench suite supplies its owned Gateway/profile and real ready upload. */
export async function exerciseUploadCollection({ context, page, observer, profile, supplement, upload, bytes, observations }) {
  const id = upload.upload.operationId, selection = upload.upload.selection;
  const directory = resolve(profile, 'migrations/local-attachment-uploads', id);
  const part = resolve(directory, 'parts/part-0000.bin'), payload = resolve(directory, 'payload.bin');
  const exists = file => access(file).then(() => true, () => false);
  const panel = supplement.getByTestId('migration-upload-collection');
  const begins = observations.length;
  await panel.locator('summary').click();
  await panel.getByTestId('migration-collection-prepare').waitFor();
  assert.ok(await exists(part)); assert.ok(await exists(payload));
  assert.equal(observations.slice(begins).filter(value => value.method === 'migration/history/upload-collection/prepare').length, 0, 'disclosure only reads collection records');
  await panel.getByTestId('migration-collection-prepare').click();
  await panel.getByTestId('migration-collection-status').getByText('回收准备完成', { exact: true }).waitFor();
  const prepared = await observer.request('migration/history/upload-collection/read', { operationId: id, selection });
  assert.equal(prepared.collection.stage, 'prepared'); assert.equal(prepared.collection.storageRetired, false);
  assert.ok(await exists(part)); assert.ok(await exists(payload));
  await panel.getByTestId('migration-collection-cancel').click();
  await panel.getByTestId('migration-collection-status').getByText('回收已停止', { exact: true }).waitFor();
  assert.ok(await exists(part));
  // Unmount the disclosure's controller and reopen through Native's source-scoped list.
  await panel.locator('summary').click(); await panel.locator('summary').click();
  await panel.getByTestId('migration-collection-records').getByRole('button', { name: `${id.slice(0, 8)} · 回收已停止`, exact: true }).click();
  await panel.getByTestId('migration-collection-resume').click();
  const confirmation = panel.getByTestId('migration-collection-confirm');
  await confirmation.getByRole('textbox').fill('RESUME');
  await panel.getByTestId('migration-collection-confirm-submit').click();
  await panel.getByTestId('migration-collection-status').getByText('回收准备完成', { exact: true }).waitFor();
  assert.ok(await exists(part)); assert.ok(await exists(payload));
  assert.equal(observations.slice(begins).filter(value => value.method === 'migration/history/upload-collection/run').length, 0, 'resume never dispatches deletion');
  await panel.getByTestId('migration-collection-run').click();
  assert.equal(await panel.getByTestId('migration-collection-confirm-submit').isDisabled(), true);
  await confirmation.getByRole('textbox').fill('COLLECT');
  await panel.getByTestId('migration-collection-confirm-submit').click();
  await panel.getByTestId('migration-collection-status').getByText('上传暂存已回收', { exact: true }).waitFor({ timeout: 15000 });
  const done = await waitFor(async () => {
    const value = await observer.request('migration/history/upload-collection/read', { operationId: id, selection });
    return value.collection.stage === 'collected' && !value.workerRunning && !value.workerScheduled ? value : false;
  }, 15000, 'same Native staging collection completion');
  assert.equal(done.collection.collectionId, prepared.collection.collectionId);
  assert.equal(done.collection.deletedBytes, bytes.length * 2);
  assert.equal(done.collection.releasedReservationBytes, bytes.length * 2);
  assert.equal(await exists(part), false); assert.equal(await exists(payload), false);
  for (const path of ['grant.json', 'collection.json', 'collection-complete.json', 'parts/part-0000.receipt.json']) assert.ok(await exists(resolve(directory, path)), 'original audit retained');
  const archive = await observer.request('migration/history/read', { jobId: selection.jobId });
  assert.equal(archive.job.stage, 'normalized');
  await panel.locator('summary').click(); await panel.locator('summary').click();
  await panel.getByTestId('migration-collection-records').getByRole('button', { name: `${id.slice(0, 8)} · 上传暂存已回收`, exact: true }).click();
  await panel.getByTestId('migration-collection-status').getByText('上传暂存已回收', { exact: true }).waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByTestId('migration-collection-download').click()]);
  assert.deepEqual(await readFile(await download.path()), bytes);
  assert.equal(await panel.getByTestId('migration-collection-run').count(), 0);
  assert.equal(observations.slice(begins).filter(value => value.method === 'migration/history/upload-collection/run').length, 1, 'reopen never repeats deletion');
  await context.writeArtifactJson('migration-upload-collection.json', { passed: true, operationId: id, collectionId: done.collection.collectionId, cancelledBeforeRetirement: true, reopenedFromNativeList: true, resumeDoesNotDelete: true, explicitKeyword: 'COLLECT', exactlyOneRun: true, deletedBytes: done.collection.deletedBytes, releasedReservationBytes: done.collection.releasedReservationBytes, finalDownloadVerified: true, originalHistoryAndAuditRetained: true, scope: 'Actual browser/Gateway/Native synthetic profile; no automatic cleanup, model, personal data, native chooser or installer claim.' });
}
