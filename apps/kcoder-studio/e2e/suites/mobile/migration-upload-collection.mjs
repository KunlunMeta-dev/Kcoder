import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';

/** The registered Mobile workbench owns the profile, chosen File and all source fixtures. */
export async function exerciseMobileUploadCollection({ context, page, profile, operationId, bytes, observations }) {
  const panel = page.getByTestId('migration-upload-collection');
  const directory = resolve(profile, 'migrations/local-attachment-uploads', operationId);
  const part = resolve(directory, 'parts/part-0000.bin'), payload = resolve(directory, 'payload.bin');
  const exists = file => access(file).then(() => true, () => false);
  const start = observations.length;
  const status = text => waitFor(async () => await panel.getByTestId('migration-collection-status').innerText().catch(() => '') === text, 15000, `Mobile collection ${text}`);
  const confirm = async word => { await panel.getByTestId('migration-collection-confirm-input').fill(word); await panel.getByTestId('migration-collection-confirm-submit').click(); };
  await panel.getByTestId('migration-collection-expand').click();
  await panel.getByTestId('migration-collection-prepare').waitFor();
  assert.equal(observations.slice(start).filter(row => row.method === 'migration/history/upload-collection/prepare').length, 0);
  await panel.getByTestId('migration-collection-prepare').click(); await status('Collection prepared');
  assert.ok(await exists(part)); assert.ok(await exists(payload));
  const prepared = await waitFor(() => [...observations].reverse().find(row => row.collection?.operationId === operationId && row.collection.stage === 'prepared'), 10000, 'source-bound prepared collection');
  await panel.getByTestId('migration-collection-cancel').click(); await status('Collection stopped');
  assert.ok(await exists(part));
  await panel.getByTestId('migration-collection-expand').click(); await panel.getByTestId('migration-collection-expand').click();
  await panel.getByRole('button', { name: `${operationId.slice(0, 8)} · Collection stopped`, exact: true }).click();
  await panel.getByTestId('migration-collection-resume').click(); await confirm('RESUME'); await status('Collection prepared');
  assert.ok(await exists(part)); assert.ok(await exists(payload));
  assert.equal(observations.slice(start).filter(row => row.method === 'migration/history/upload-collection/run').length, 0, 'Mobile resume is metadata-only');
  await panel.getByTestId('migration-collection-run').click();
  assert.equal(await panel.getByTestId('migration-collection-confirm-submit').getAttribute('aria-disabled'), 'true');
  await confirm('COLLECT'); await status('Upload staging collected');
  const done = await waitFor(() => [...observations].reverse().find(row => row.method === 'migration/history/upload-collection/read' && row.collection?.operationId === operationId && row.collection.stage === 'collected' && row.workerRunning === false && row.workerScheduled === false), 15000, 'Native collection complete, no scheduled or active collector');
  assert.equal(done.collection.collectionId, prepared.collection.collectionId);
  assert.equal(done.collection.deletedBytes, bytes.length * 2);
  assert.equal(done.collection.releasedReservationBytes, bytes.length * 2);
  assert.equal(await exists(part), false); assert.equal(await exists(payload), false);
  for (const name of ['grant.json', 'collection.json', 'collection-complete.json', 'parts/part-0000.receipt.json']) assert.ok(await exists(resolve(directory, name)));
  // Reopen from Native records after ordinary upload/read no longer admits staging.
  await panel.getByTestId('migration-collection-expand').click(); await panel.getByTestId('migration-collection-expand').click();
  await panel.getByRole('button', { name: `${operationId.slice(0, 8)} · Upload staging collected`, exact: true }).click(); await status('Upload staging collected');
  const downloaded = page.waitForEvent('download'); await panel.getByTestId('migration-collection-download').click();
  const download = await downloaded, saved = context.pathInArtifacts('mobile-collected-final-attachment.bin'); await download.saveAs(saved);
  assert.deepEqual(await readFile(saved), bytes);
  await panel.getByTestId('migration-collection-bind').waitFor();
  assert.equal(observations.slice(start).filter(row => row.method === 'migration/history/upload-collection/run').length, 1, 'reopen/download never replays deletion');
  assert.equal(await panel.getByTestId('migration-collection-run').count(), 0);
  await context.writeArtifactJson('mobile-upload-collection.json', { passed: true, platform: 'Mobile Web Chromium', operationId, collectionId: done.collection.collectionId, disclosureReadOnly: true, cancellationRetainedBytes: true, reopenedFromSourceScopedRecords: true, resumeDoesNotDelete: true, explicitKeyword: 'COLLECT', exactlyOneRun: true, deletedBytes: done.collection.deletedBytes, releasedReservationBytes: done.collection.releasedReservationBytes, finalDownloadAfterReopenVerified: true, finalBindingAvailable: true, originalAuditRetained: true, scope: 'Actual Mobile Web/Gateway/Native owned fixture; not Android/iOS chooser, installer, physical free-block or power-loss acceptance.' });
}

export async function assertLegacyUploadCollectionRetained({ context, page, profile, operationId, observations }) {
  const directory = resolve(profile, 'migrations/local-attachment-uploads', operationId);
  const grant = JSON.parse(await readFile(resolve(directory, 'grant.json'), 'utf8'));
  assert.ok(grant.version < 3, 'the intentional legacy archive never acquires managed upload birth');
  const original = await readFile(resolve(directory, 'parts/part-0000.bin'));
  const start = observations.length, panel = page.getByTestId('migration-upload-collection');
  await panel.getByTestId('migration-collection-expand').click();
  await panel.getByTestId('migration-collection-prepare').click();
  await panel.getByText('local_upload_collection_legacy_retained', { exact: true }).waitFor();
  assert.deepEqual(await readFile(resolve(directory, 'parts/part-0000.bin')), original);
  assert.equal(await access(resolve(directory, 'collection.json')).then(() => true, () => false), false);
  assert.equal(observations.slice(start).filter(row => row.method === 'migration/history/upload-collection/run').length, 0);
  await context.writeArtifactJson('mobile-legacy-upload-retained.json', { passed: true, operationId, version: grant.version, legacyBirthNotAdopted: true, dataUnchanged: true, noCollectionControlOrRun: true });
}

export async function exerciseManagedMobileUploadCollection({ context, page, profile, gatewayBaseUrl, historyJobId }) {
  const browser = page.context().browser();
  assert.ok(browser);
  // Transfer only this run's authenticated fixture state in memory, never a personal profile or an artifact.
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', storageState: await page.context().storageState({ indexedDB: true }) });
  context.addCleanup('close owned managed upload collection Mobile context', () => mobileContext.close());
  const managed = await mobileContext.newPage();
  const observations = [];
  managed.on('websocket', socket => {
    const pending = new Map();
    socket.on('framesent', frame => {
      try {
        const value = JSON.parse(frame.payload);
        if (!value.method?.startsWith('migration/')) return;
        const row = { method: value.method, operationId: value.params?.operationId }; observations.push(row); pending.set(value.id, row);
      } catch { /* Passive observation never changes authenticated transport frames. */ }
    });
    socket.on('framereceived', frame => {
      try {
        const value = JSON.parse(frame.payload), row = pending.get(value.id);
        if (!row) return;
        pending.delete(value.id);
        row.error = value.error?.code; row.collection = value.result?.collection;
        row.workerRunning = value.result?.workerRunning; row.workerScheduled = value.result?.workerScheduled;
        row.uploadedBytes = value.result?.upload?.receivedBytes; row.uploadOperationId = value.result?.upload?.operationId;
      } catch { /* Only bounded public collection metadata is retained. */ }
    });
  });
  await managed.addInitScript(() => { Object.defineProperty(globalThis, 'showSaveFilePicker', { value: undefined, configurable: true }); });
  await managed.goto(`${gatewayBaseUrl}/settings-section?section=migration_results`);
  await managed.getByTestId('migration-workbench').waitFor({ timeout: 30000 });
  await managed.getByTestId('migration-archive-open').click();
  await managed.getByRole('button', { name: 'History tasks', exact: true }).click();
  await managed.getByTestId(`migration-job-${historyJobId}`).click();
  await managed.getByTestId('migration-history-workspace').waitFor();
  await managed.getByTestId('migration-history-branch-tab').click();
  const confirm = async (prefix, word) => { await managed.getByTestId(`${prefix}-input`).fill(word); await managed.getByTestId(`${prefix}-submit`).click(); };
  await managed.getByTestId('migration-branch-choose').click(); await managed.getByTestId('migration-branch-prepare').click(); await confirm('migration-branch-confirm', 'PREPARE');
  await waitFor(async () => await managed.getByTestId('migration-branch-run').getAttribute('aria-disabled') !== 'true', 10000, 'fresh managed branch');
  await managed.getByTestId('migration-branch-run').click(); await confirm('migration-branch-confirm', 'RUN');
  await managed.getByTestId('migration-branch-record-4').waitFor({ timeout: 30000 }); await managed.getByTestId('migration-branch-record-4').click();
  await managed.getByTestId('migration-branch-attachment-0').click(); await managed.getByTestId('migration-attachment-run').click(); await confirm('migration-attachment-confirm', 'RUN');
  await managed.getByTestId('migration-local-new').click();
  const bytes = Buffer.from('A separately chosen managed upload stays distinct from the original legacy fixture.\n'.repeat(100));
  const filename = context.pathInState('managed-collection-chosen.txt');
  const { writeFile } = await import('node:fs/promises'); await writeFile(filename, bytes);
  const choosing = managed.waitForEvent('filechooser'); await confirm('migration-local-confirm', 'UPLOAD'); await (await choosing).setFiles(filename);
  const uploaded = await waitFor(() => observations.find(row => row.method === 'migration/history/local-attachment/part' && row.uploadedBytes === bytes.length), 30000, 'fresh managed upload bytes');
  assert.ok(uploaded.uploadOperationId);
  const grant = JSON.parse(await readFile(resolve(profile, 'migrations/local-attachment-uploads', uploaded.uploadOperationId, 'grant.json'), 'utf8'));
  assert.equal(grant.version, 3, 'positive collection uses a genuinely new managed grant, never a rewritten legacy marker');
  await managed.getByTestId('migration-local-finish').click(); await confirm('migration-local-confirm', 'FINISH');
  await waitFor(async () => await managed.getByTestId('migration-local-run').getAttribute('aria-disabled') !== 'true', 10000, 'managed Local authorized');
  await managed.getByTestId('migration-local-run').click(); await confirm('migration-local-confirm', 'RUN');
  await managed.getByTestId('migration-local-bind').waitFor({ timeout: 15000 });
  await exerciseMobileUploadCollection({ context, page: managed, profile, operationId: uploaded.uploadOperationId, bytes, observations });
  await managed.close();
}
