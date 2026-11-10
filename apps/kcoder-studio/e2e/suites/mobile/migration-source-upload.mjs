import assert from 'node:assert/strict';
import { readFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';

/** Real Mobile Web chooser, typed Gateway routes and Native receipts; no model turn. */
export async function exerciseMobileSourceUpload({ context, page, gateway, profile, workspace, fixture, observations, heldPart, releasePart, model }) {
  const observer = await openOwnedMobileRpc(context, gateway, 'migration-target', workspace);
  const original = await readFile(resolve(profile, 'settings.json'));
  const http = [], completed = [];
  const cases = process.env.KCODER_E2E_MIGRATION_SOURCE_UPLOAD_CASES?.split(',') ?? ['configuration', 'asset', 'history', 'memory'];
  assert.ok(cases.length > 0 && cases.length <= 4 && new Set(cases).size === cases.length && cases.every(value => ['configuration', 'asset', 'history', 'memory'].includes(value)), 'explicit consumer subset must retain a truthful test scope');
  let lostPrepare = null, losePrepare = cases.includes('configuration'), lostSelect = null, loseSelect = cases.includes('configuration');
  let checkpoint = { kind: null, stage: 'starting' };
  await page.route('**/api/migration/source-session/**', async route => {
    const body = route.request().postDataJSON();
    http.push({ route: new URL(route.request().url()).pathname.split('/').at(-1), sessionId: body.session?.sessionId ?? body.sessionId, purpose: body.session?.purpose ?? body.purpose, kind: body.query?.kind, sourceId: body.query?.params?.sourceId });
    if (body.query?.kind === 'uploaded_select' && loseSelect) {
      loseSelect = false; const reply = await route.fetch(); assert.equal(reply.status(), 200); lostSelect = body; await route.abort('failed'); return;
    }
    await route.continue();
  });
  await page.route('**/api/migration/source-transfer/**', async route => {
    const body = route.request().postDataJSON(), operation = new URL(route.request().url()).pathname.split('/').at(-1);
    http.push({ route: operation, requestId: body.requestId ?? body.locator?.requestId, adoptionId: body.locator?.adoptionId, purpose: body.target?.purpose ?? body.locator?.target?.purpose, sessionId: body.target?.sessionId ?? body.locator?.target?.sessionId });
    if (operation === 'adoption-prepare' && losePrepare) {
      losePrepare = false; const reply = await route.fetch(); assert.equal(reply.status(), 200); lostPrepare = { input: body, output: await reply.json() }; await route.abort('failed'); return;
    }
    await route.continue();
  });
  const openSources = async () => { await page.getByTestId('migration-tab-source').click(); await page.getByTestId('migration-source-workspace').waitFor(); };
  const confirm = async keyword => { await page.getByTestId('migration-batch-confirm-input').fill(keyword); await page.getByTestId('migration-batch-confirm-submit').click(); };
  const enabled = async (locator, label) => waitFor(async () => await locator.count() === 1 && !await locator.isDisabled(), 15000, label);
  const sourceMethods = method => observations.filter(row => row.method === method);
  try {
    for (const kind of cases) {
      checkpoint = { kind, stage: 'selecting' }; await openSources();
      let upload = page.getByTestId('migration-source-upload');
      const productKind = kind === 'configuration' || kind === 'asset' ? 'claude-code' : 'codex';
      await upload.getByTestId(`source-upload-product-${productKind}`).click();
      const mode = kind === 'configuration' ? 'files' : kind === 'history' ? 'package' : 'directory';
      await upload.getByTestId(`source-upload-mode-${mode}`).click();
      const selectedPath = kind === 'configuration' ? fixture.configFile : kind === 'asset' ? fixture.assetDir : kind === 'history' ? fixture.backup : fixture.memoryDir;
      await upload.getByTestId('source-upload-input').setInputFiles(selectedPath);
      await enabled(upload.getByTestId('source-upload-start'), 'bounded chooser hashing');
      if (kind === 'asset') await upload.getByTestId('source-upload-exclusions').getByText(/Excluded 1 authentication/).waitFor();
      const beforePrepare = sourceMethods('migration/source/upload/prepare').length;
      await upload.getByTestId('source-upload-start').click();
      await waitFor(() => sourceMethods('migration/source/upload/prepare').length === beforePrepare + 1, 15000, 'one original Native upload prepare');
      const operationId = sourceMethods('migration/source/upload/prepare').at(-1).operationId; assert.ok(operationId); checkpoint.operationId = operationId;
      if (kind === 'configuration') {
        await waitFor(heldPart, 15000, 'first accepted immutable part reply held');
        await upload.getByTestId('source-upload-cancel').click();
        await upload.getByTestId('source-upload-status').getByText('This receipt was stopped', { exact: true }).waitFor();
        assert.equal(sourceMethods('migration/source/upload/part').length, 1); releasePart();
        await page.reload(); await page.getByTestId('migration-workbench').waitFor({ timeout: 30000 }); await openSources(); upload = page.getByTestId('migration-source-upload');
        await upload.getByTestId('source-upload-records-toggle').click(); await upload.getByTestId(`source-upload-record-${operationId}`).click();
        await upload.getByTestId('source-upload-status').getByText('This receipt was stopped', { exact: true }).waitFor();
        assert.equal(sourceMethods('migration/source/upload/prepare').length, 1); assert.equal(sourceMethods('migration/source/upload/resume').length, 0);
        await upload.getByTestId('source-upload-input').setInputFiles(fixture.wrongFile);
        await upload.getByText(/The product, paths, sizes or hashes differ/).waitFor();
        assert.equal(sourceMethods('migration/source/upload/part').length, 1);
        await upload.getByTestId('source-upload-input').setInputFiles(fixture.configFile);
        await enabled(upload.getByTestId('source-upload-resume'), 'same immutable manifest explicitly reselected'); await upload.getByTestId('source-upload-resume').click();
      }
      await upload.getByTestId('source-upload-use').waitFor({ timeout: 30000 });
      const raw = (await observer.rpc.request('migration/source/upload/read', { operationId })).upload;
      assert.equal(raw.stage, 'ready'); assert.equal(raw.totalFiles, 1);
      assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), JSON.parse(original.toString()));
      await rename(kind === 'configuration' ? fixture.configDir : selectedPath, `${kind === 'configuration' ? fixture.configDir : selectedPath}-withheld`);
      checkpoint.stage = 'product'; await upload.getByTestId('source-upload-use').click();
      const product = page.getByTestId('migration-source-product'); await product.getByTestId('source-product-run').click();
      await product.getByTestId('source-product-inspect').waitFor({ timeout: 30000 }); await product.getByTestId('source-product-inspect').click();
      let browser = page.getByTestId('migration-source-browser');
      if (kind === 'history' || kind === 'memory') await browser.getByTestId(`source-browser-mode-${kind}`).click();
      await browser.getByTestId('source-browser-discover').click();
      if (kind === 'configuration') {
        await waitFor(() => lostSelect, 15000, 'accepted uploaded source binding acknowledgement lost');
        await enabled(browser.getByTestId('source-browser-discover'), 'unknown select is not default discovery');
        assert.equal(await browser.locator('[data-testid^="source-browser-select-"]').count(), 0);
        await browser.getByTestId('source-browser-discover').click();
      }
      const selection = browser.locator('[data-testid^="source-browser-select-"]').first(); await selection.waitFor();
      if (kind === 'configuration') {
        await browser.locator('[data-testid^="source-layer-report-"]').first().click(); await browser.getByTestId('source-layer-report').waitFor();
        const query = http.find(row => row.kind === 'configuration_layers_read'); assert.ok(query?.sourceId); assert.equal(query.sessionId, http.find(row => row.kind === 'configuration').sessionId);
      }
      if (kind === 'history') await browser.getByText('Original compressed artifact', { exact: false }).waitFor();
      await selection.click(); await browser.getByTestId('source-browser-transfer').click();
      await browser.getByTestId('source-transfer-status').getByText('Sources received; not imported', { exact: true }).waitFor({ timeout: 30000 }); checkpoint.stage = 'adoption';
      let adoption = browser.getByTestId('migration-source-adoption'); await adoption.getByTestId('source-adoption-expand').click();
      await adoption.locator('[data-testid^="source-adoption-select-"]').first().click(); await adoption.getByTestId('source-adoption-prepare').click();
      if (kind === 'configuration') {
        await waitFor(() => lostPrepare, 15000, 'accepted preview preparation acknowledgement lost');
        const sentBefore = http.filter(row => row.route === 'adoption-prepare').length, openedBefore = http.filter(row => row.route === 'open' && row.purpose === 'source').length;
        await page.reload(); await page.getByTestId('migration-workbench').waitFor({ timeout: 30000 }); await openSources();
        const records = page.getByTestId('migration-transfer-records'); await records.getByTestId('source-transfer-records-open').click();
        await records.getByTestId(`source-transfer-record-${lostPrepare.input.locator.requestId}`).click();
        adoption = records.getByTestId('migration-source-adoption'); await adoption.getByTestId('source-adoption-expand').click();
        await adoption.getByTestId(`source-adoption-record-${lostPrepare.input.locator.adoptionId}`).click();
        assert.equal(http.filter(row => row.route === 'adoption-prepare').length, sentBefore);
        assert.equal(http.filter(row => row.route === 'open' && row.purpose === 'source').length, openedBefore, 'target-only recovery cannot reconnect source');
      }
      await adoption.getByText('Preview Ready; not saved', { exact: true }).waitFor({ timeout: 30000 });
      const openBatch = adoption.locator('[data-testid^="source-adoption-open-"]').first(), jobId = (await openBatch.getAttribute('data-testid')).slice('source-adoption-open-'.length); await openBatch.click();
      await page.getByTestId('migration-batch-editor').waitFor(); checkpoint.stage = 'ordinary_batch';
      const category = kind === 'configuration' ? 'provider' : kind === 'asset' ? 'skill' : kind;
      const items = await observer.rpc.request('migration/items', { jobId }); const item = items.items.find(row => row.category === category); assert.ok(item);
      await page.getByTestId(`migration-item-edit-${item.id}`).click();
      if (kind !== 'history') await page.getByTestId('migration-item-name').fill(`mobile-uploaded-${kind}`);
      if (kind === 'configuration') { await page.getByTestId('migration-provider-context').fill('128000'); await page.getByTestId('migration-provider-headroom').fill('8192'); await page.getByTestId('migration-provider-output').fill('8192'); }
      if (kind === 'memory') { assert.equal(await page.getByTestId('migration-item-save').isDisabled(), true); await page.getByTestId('migration-memory-map-global').click(); }
      await page.getByTestId('migration-item-save').click(); await page.getByTestId('migration-preview-plan').click(); await page.getByTestId('migration-batch-operation').waitFor();
      const plan = await observer.rpc.request('migration/batch/item/plan', { jobId, itemId: item.id });
      assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), JSON.parse(original.toString()));
      await enabled(page.getByTestId('migration-batch-import'), 'ordinary Native preview read before explicit save'); await page.getByTestId('migration-batch-import').click(); await confirm('IMPORT');
      await waitFor(async () => { const value = await observer.rpc.request('migration/batch/read', { jobId }); return value.state.job.committedItems === 1 && !value.workerRunning; }, 30000, 'ordinary Native batch publication');
      const published = await observer.rpc.request('migration/batch/read', { jobId });
      const observedItems = await observer.rpc.request('migration/items', { jobId });
      await context.writeArtifactJson(`mobile-source-upload-native-${kind}.json`, { checkpoint, job: published.state.job, batch: published.state.batch, issues: published.state.issues, workerRunning: published.workerRunning, workerError: published.workerError, items: observedItems.items.map(({ id, status, issues }) => ({ id, status, issues })), planned: observedItems.planned?.map(({ itemId, errorCode }) => ({ itemId, errorCode })) });
      assert.equal(published.state.job.hasUnconfirmedOutcomes, false, 'an uncertain Native publication is not a completed save');
      if (kind === 'configuration') assert.equal(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')).providers['mobile-uploaded-configuration'].default_model, 'uploaded-browser-model');
      if (kind === 'asset') { const text = await readFile(resolve(profile, 'skills', plan.item.targetName, 'SKILL.md'), 'utf8'); assert.match(text, /UPLOADED_SKILL_BODY/); assert.match(text, /default_enabled: false/); }
      if (kind === 'history') { const history = await observer.rpc.request('migration/history/read', { jobId: plan.item.historyJobId }); assert.equal(history.job.archived, true); assert.ok(history.job.normalization.normalizedRecords > 0); }
      if (kind === 'memory') { const notes = await observer.rpc.request('migration/memory/list', {}); assert.equal(notes.totalRecords, 1); assert.equal(notes.items[0].enabled, false); assert.equal(notes.items[0].provenance.factsVerified, false); assert.equal(notes.items[0].provenance.sourceModifiedAtMs ?? null, null); }
      // Reopen the original ordinary batch before Undo; no parallel publication path exists.
      await page.getByTestId('migration-tab-records').click(); await page.getByTestId(`migration-batch-record-${jobId}`).click(); await page.getByTestId('migration-batch-operation').waitFor();
      await enabled(page.getByTestId('migration-batch-undo'), 'original batch reopened for explicit Undo'); await page.getByTestId('migration-batch-undo').click(); await confirm('UNDO');
      try { await waitFor(async () => (await observer.rpc.request('migration/batch/read', { jobId })).state.job.status === 'rolled_back', 30000, 'original Native batch Undo'); }
      catch (error) { const current = await observer.rpc.request('migration/batch/read', { jobId }); const inventory = await observer.rpc.request('migration/items', { jobId }); await context.writeArtifactJson(`mobile-source-upload-undo-${kind}.json`, { job: current.state.job, batch: current.state.batch, issues: current.state.issues, workerRunning: current.workerRunning, workerError: current.workerError, items: inventory.items.map(({ id, status, issues }) => ({ id, status, issues })), planned: inventory.planned?.map(({ itemId, errorCode }) => ({ itemId, errorCode })) }); throw error; }
      assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), JSON.parse(original.toString()));
      completed.push({ kind, operationId, manifestSha256: raw.manifestSha256, jobId, publishedAndReopenedAndUndone: true });
      // Configuration serialization can change whitespace after a successful Native transaction.
      if (kind !== 'memory') await page.getByTestId('migration-tab-source').click();
    }
    assert.equal(sourceMethods('migration/source/upload/prepare').length, cases.length); assert.equal(sourceMethods('migration/source/upload/resume').length, cases.includes('configuration') ? 1 : 0);
    assert.equal(http.filter(row => row.kind === 'uploaded_select').length, cases.length + (cases.includes('configuration') ? 1 : 0)); assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('mobile-source-upload-roundtrip.json', { passed: true, platform: 'Mobile Web Chromium', completed, sourceQueries: http.filter(row => row.kind), historicalRecordsTreatedAsStaticData: true, cancelledPendingChunk: cases.includes('configuration'), explicitSameManifestResume: cases.includes('configuration'), lostPreparationRecoveredReadOnly: cases.includes('configuration'), targetOnlyRecovery: cases.includes('configuration'), normalBatchReopenAndUndo: true, modelRequests: 0 });
    return { consumers: completed.length, cases, normalBatchPublishedAndUndone: true, modelRequests: 0 };
  } catch (error) {
    const settingsMetadata = await stat(resolve(profile, 'settings.json')).then(value => ({ present: true, links: value.nlink, mode: (value.mode & 0o777).toString(8), bytes: value.size }), value => ({ present: false, code: ['ENOENT', 'EACCES', 'EPERM'].includes(value?.code) ? value.code : 'unconfirmed' }));
    await context.writeArtifactJson('mobile-source-upload-checkpoint.json', { checkpoint, completed, http, settingsMetadata, modelRequests: model.requests.length }); throw error;
  }
  finally { releasePart(); await observer.close(); }
}
