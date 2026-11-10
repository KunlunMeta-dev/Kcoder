import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');

export async function seedHistoryFamilies(context, root, sourceProgram) {
  const ids = ['10000000-0000-4000-8000-000000000001', ...Array.from({ length: 21 }, () => randomUUID())], files = [];
  for (let index = 0; index < ids.length; index++) {
    const parent = index === 0 ? null : index < 10 ? ids[0] : index === 10 ? ids[9] : index < 20 ? ids[10] : ids[19];
    const file = resolve(root, `sessions/2026/10/18/rollout-2026-10-18T00-00-00-${ids[index]}_${randomUUID()}.jsonl`);
    const title = `T10 original physical history ${index}`;
    const bytes = Buffer.from([{ timestamp: '2026-10-18T00:00:00Z', type: 'session_meta', payload: { id: ids[index], source: 'cli', cli_version: '0.64.0',
      parent_thread_id: parent, cwd: index ? '/owned/t10-child-cwd' : '/owned/t10-root-cwd', fixture_tag: 'T10-A' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'never-run', arguments: JSON.stringify({ command: `sh ${sourceProgram}` }) } }].map(value => JSON.stringify(value)).join('\n') + '\n');
    await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode: 0o600 });
    const modified = new Date(Date.UTC(2020, 0, 2) - (index + 1) * 1000); await utimes(file, modified, modified);
    files.push({ index, id: ids[index], parent, title, file, bytes, sha256: sha(bytes), modified, compressed: false });
  }
  const bytes = await readFile(fileURLToPath(new URL('../../fixtures/migration/history-source-compressed.jsonl.zst', import.meta.url)));
  const file = resolve(root, `archived_sessions/rollout-2026-10-18T00-00-00-${ids[0]}.jsonl.zst`);
  await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode: 0o600 });
  const modified = new Date(Date.UTC(2020, 0, 2)); await utimes(file, modified, modified);
  const compressed = { index: -1, id: ids[0], parent: null, title: 'Owned compressed source history', file, bytes, sha256: sha(bytes), modified, compressed: true };
  files.push(compressed);
  return { root, files, ids, compressed };
}

/** Only existing SourceSession/transfer/adoption/batch APIs own the actual effects. */
export async function exerciseHistoryFamilies({ context, page, gateway, profile, workspace, fixture, sourceProgram, model, mobile = false }) {
  const sourceId = mobile ? 'peer-target' : 'history-source-target', targetId = mobile ? 'migration-target' : 'fixture-target';
  const observer = await openOwnedMobileRpc(context, gateway, targetId, workspace);
  const before = await readFile(resolve(profile, 'settings.json')), queries = [], transfers = [], closes = [], pages = [], closeObservations = [], sessionRequests = [];
  let currentPage = null, middleCursor = null, sessionReadUrl = null;
  const onRequest = request => {
    if (/\/api\/migration\/source-session\/(open|close)$/.test(new URL(request.url()).pathname)) sessionRequests.push({ operation: request.url().split('/').at(-1), input: request.postDataJSON() });
    if (request.url().endsWith('/api/migration/source-session/query')) { queries.push(request.postDataJSON()); sessionReadUrl = request.url().replace(/query$/, 'read'); }
    if (request.url().endsWith('/api/migration/source-transfer/run')) transfers.push(request.postDataJSON());
  };
  const onResponse = async response => {
    try {
      if (response.url().endsWith('/api/migration/source-session/close')) closeObservations.push({ input: response.request().postDataJSON(), status: response.status(), value: await response.json() });
      if (!response.ok()) return;
      const value = await response.json();
      if (response.url().endsWith('/api/migration/source-session/close') && value.status === 'released') closes.push(response.request().postDataJSON());
      if (response.url().endsWith('/api/migration/source-session/query') && value.catalogId) {
        pages.push({ query: response.request().postDataJSON().query, catalogId: value.catalogId, totalItems: value.totalItems,
          nextCursor: value.nextCursor, items: value.items.map(row => ({ sourceHandle: row.sourceHandle, sourceSessionId: row.sourceSessionId,
            parentSessionId: row.parentSessionId, compressed: row.compressed })) });
      }
    } catch { /* Assertions below use public receipts and independently verified owned bytes. */ }
  };
  page.on('request', onRequest); page.on('response', onResponse);
  const enabled = (button, label) => waitFor(async () => await button.count() === 1 && !await button.isDisabled(), 20000, label);
  const confirm = async word => { await page.getByTestId('migration-batch-confirm-input').fill(word); await page.getByTestId('migration-batch-confirm-submit').click(); };
  let browser, history, withheld = null, jobId = null;
  try {
    if (mobile) {
      await page.getByTestId('migration-tab-source').click(); await page.getByTestId('migration-source-remote-mode').click(); await page.getByTestId(`source-device-${sourceId}`).click();
      browser = page.getByTestId('migration-source-browser'); await browser.getByTestId('source-browser-mode-history').click(); await browser.getByTestId('source-browser-product-codex').click(); history = browser;
    } else {
      await selectAdvancedMigration(page.getByTestId('migration-dialog'), 'source'); browser = page.getByTestId('migration-source-browser');
      await browser.locator('#migration-source-device').selectOption(sourceId); await browser.getByTestId('migration-source-mode-history').click();
      history = browser.getByTestId('migration-history-source-browser'); await history.getByRole('button', { name: 'Codex', exact: true }).click();
    }
    const rows = () => mobile ? history.locator('[data-testid^="source-browser-select-"]') : history.getByTestId('migration-history-source-row');
    const next = () => mobile ? history.getByRole('button', { name: 'Next', exact: true }) : history.getByTestId('migration-history-source-next');
    const previous = () => mobile ? history.getByRole('button', { name: 'Previous', exact: true }) : history.getByTestId('migration-history-source-previous');
    const choose = async row => mobile ? history.getByTestId(`source-browser-select-${row.sourceHandle}`).click() : history.getByRole('checkbox', { name: row.title || row.sourceSessionId, exact: true }).check();
    const queryResponse = (kind, cursor = null) => page.waitForResponse(response => {
      if (!new URL(response.url()).pathname.endsWith('/api/migration/source-session/query')) return false;
      const query = response.request().postDataJSON()?.query;
      return query?.kind === kind && (query.params.cursor ?? null) === cursor;
    });
    const loadPage = async (button, kind, cursor = null) => {
      const pending = queryResponse(kind, cursor); await button.click(); const response = await pending;
      const value = await response.json(); assert.equal(response.ok(), true, JSON.stringify(value)); currentPage = value;
      await waitFor(async () => await rows().count() === value.items.length && (mobile
        ? await history.getByTestId(`source-browser-select-${value.items[0].sourceHandle}`).count() === 1
        : await history.getByRole('checkbox', { name: value.items[0].title || value.items[0].sourceSessionId, exact: true }).count() === 1), 15000, 'the visible page matches this exact Native query receipt');
    };
    const discover = async () => {
      currentPage = null; await loadPage(history.getByTestId('migration-history-families-discover'), 'history_families');
      assert.equal(currentPage.totalItems, 23); assert.equal(await rows().count(), 10);
    };
    const selectAcrossPages = async () => {
      const compressed = currentPage.items.find(row => row.compressed && row.sourceSessionId === fixture.ids[0]); assert.ok(compressed); await choose(compressed);
      assert.equal(mobile ? await rows().filter({ hasText: '☑' }).count() : await history.getByRole('checkbox', { checked: true }).count(), 1, 'one physical variant never selects its family');
      middleCursor = currentPage.nextCursor;
      await loadPage(next(), 'history_page', middleCursor); assert.equal(await rows().count(), 10);
      assert.ok(currentPage.items.some(row => row.sourceSessionId === fixture.ids[10]));
      await loadPage(next(), 'history_page', currentPage.nextCursor); assert.equal(await rows().count(), 3);
      const descendant = currentPage.items.find(row => row.sourceSessionId === fixture.ids[21]); assert.ok(descendant); await choose(descendant);
      const families = mobile ? history.getByTestId('migration-history-family-label') : history.locator(`[data-family-session="${fixture.ids[0]}"]`);
      assert.equal(await families.count(), 1, 'three original physical rows share one observed root caption');
      for (const family of await families.all()) {
        assert.ok((await family.innerText()).includes(fixture.ids[0]), 'ambiguous root variants retain the original root id instead of borrowing one physical title');
        await family.getByText(mobile ? 'The ancestor was observed on another page. Only explicitly selected physical entries will transfer.' : '祖先已在另一页观察到；仅传输明确选择的物理条目。', { exact: true }).waitFor();
      }
      return [compressed, descendant];
    };
    await discover(); await selectAcrossPages();
    // An owned external edit preserves inode, size and mtime but invalidates the original header proof.
    const changed = fixture.files.find(row => row.index === 9), edited = Buffer.from(changed.bytes.toString().replace('T10-A', 'T10-B'));
    assert.equal(edited.length, changed.bytes.length); await writeFile(changed.file, edited); await utimes(changed.file, changed.modified, changed.modified);
    const invalidResponse = queryResponse('history_page', middleCursor);
    await previous().click(); const invalid = await invalidResponse;
    assert.equal(invalid.ok(), false); assert.equal((await invalid.json()).error, 'source_transfer_history_catalog_unavailable');
    await waitFor(async () => await rows().count() === 0, 15000, 'changed first record invalidates the old UI catalog and all selections');
    assert.equal(transfers.length, 0);
    if (mobile) assert.equal(await history.getByTestId('source-browser-transfer').isDisabled(), true);
    else assert.equal(await history.getByTestId('migration-history-source-transfer').count(), 0);
    await writeFile(changed.file, changed.bytes); await utimes(changed.file, changed.modified, changed.modified);
    await discover(); const selected = await selectAcrossPages();
    await page.screenshot({ path: context.pathInArtifacts('history-families-third-page.png') });
    const transfer = mobile ? history.getByTestId('source-browser-transfer') : history.getByTestId('migration-history-source-transfer');
    await transfer.evaluate(button => { button.click(); button.click(); });
    const status = mobile ? history.getByTestId('source-transfer-status') : history.getByTestId('migration-transfer-status');
    await status.getByText(mobile ? 'Sources received; not imported' : '资料已接收', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(transfers.length, 1); const run = transfers[0]; assert.equal(run.source.targetId, sourceId); assert.equal(run.target.targetId, targetId);
    assert.deepEqual(new Set(run.selections.map(row => row.sourceHandle)), new Set(selected.map(row => row.sourceHandle)));
    assert.ok(run.selections.every(row => row.kind === 'history' && row.catalogId === currentPage.catalogId));
    const incoming = resolve(profile, 'migrations/source-transfer/incoming', run.requestId), manifest = JSON.parse(await readFile(resolve(incoming, 'manifest.json'), 'utf8'));
    assert.equal(manifest.entries.length, 2);
    for (const entry of manifest.entries) {
      const original = fixture.files.find(row => row.sha256 === entry.sha256); assert.ok(original);
      const source = selected.find(row => row.sourceArtifactId === entry.content.snapshot.origin.sourceArtifactId); assert.ok(source);
      assert.equal(entry.content.snapshot.origin.parentSessionId ?? null, source.parentSessionId ?? null);
      assert.deepEqual(await readFile(resolve(incoming, `${entry.id}${original.compressed ? '.jsonl.zst' : '.jsonl'}`)), original.bytes);
    }
    assert.deepEqual(await readFile(resolve(profile, 'settings.json')), before);
    withheld = `${fixture.root}-withheld`; await rename(fixture.root, withheld);
    const adoption = browser.getByTestId('migration-source-adoption'), prefix = mobile ? 'source-adoption' : 'migration-adoption';
    await adoption.getByTestId(`${prefix}-expand`).click();
    if (mobile) { const entries = adoption.locator('[data-testid^="source-adoption-select-"]'); await waitFor(async () => await entries.count() === 2, 15000, 'two received original history artifacts'); await entries.nth(0).click(); await entries.nth(1).click(); }
    else { const entries = adoption.getByRole('checkbox'); await waitFor(async () => await entries.count() === 2, 15000, 'two received history selections without project mappings'); await entries.nth(0).check(); await entries.nth(1).check(); }
    assert.equal(await adoption.locator(`[data-testid^="${prefix}-map-"]`).count(), 0, 'history cwd is provenance, never a target workspace mapping');
    await adoption.getByTestId(`${prefix}-prepare`).click(); const open = adoption.locator(`[data-testid^="${prefix}-open-"]`).first(); await open.waitFor({ timeout: 30000 });
    assert.equal(await adoption.locator(`[data-testid^="${prefix}-open-"]`).count(), 1);
    jobId = (await open.getAttribute('data-testid')).slice(`${prefix}-open-`.length); await open.click();
    await waitFor(async () => await browser.count() === 0, 10000, 'normal batch navigation unmounts the original source browser');
    const items = (await observer.rpc.request('migration/items', { jobId })).items; assert.equal(items.length, 2); assert.ok(items.every(row => row.category === 'history'));
    if (mobile) {
      await page.getByTestId('migration-batch-editor').waitFor();
      for (const item of items) { await page.getByTestId(`migration-item-edit-${item.id}`).click(); await page.getByTestId('migration-item-save').click(); }
      await page.getByTestId('migration-preview-plan').click(); await page.getByTestId('migration-batch-operation').waitFor();
      await enabled(page.getByTestId('migration-batch-import'), 'ordinary history import'); await page.getByTestId('migration-batch-import').click(); await confirm('IMPORT');
    } else {
      const dialog = page.getByTestId('migration-dialog'); await dialog.getByRole('heading', { name: '选择迁移内容', exact: true }).waitFor();
      for (const item of items) await dialog.getByRole('checkbox', { name: `选择 ${item.sourceName}`, exact: true }).check();
      await dialog.getByRole('button', { name: '确认所选内容', exact: true }).click(); await dialog.getByRole('heading', { name: '确认批量计划', exact: true }).waitFor();
      await dialog.getByRole('button', { name: '开始批量迁移', exact: true }).click();
    }
    await waitFor(async () => { const value = await observer.rpc.request('migration/batch/read', { jobId });
      if (value.workerRunning || !['completed', 'completed_with_issues'].includes(value.state.job.status)) return false;
      assert.equal(value.state.job.hasUnconfirmedOutcomes, false); assert.equal(value.state.job.committedItems, 2); assert.equal(value.state.batch.unresolvedActions, 0);
      assert.equal(value.state.batch.committedActions, value.state.batch.totalActions); return true;
    }, 30000, 'two original history artifacts saved without the source');
    assert.ok((await observer.rpc.request('migration/items', { jobId })).items.every(item => item.status === 'committed'));
    const children = [];
    for (const item of items) { const plan = await observer.rpc.request('migration/batch/item/plan', { jobId, itemId: item.id }); assert.ok(plan.item.historyJobId);
      const child = await observer.rpc.request('migration/history/read', { jobId: plan.item.historyJobId }); assert.equal(child.job.archived, true); assert.ok(child.job.normalization.normalizedRecords > 0); children.push(plan.item.historyJobId); }
    if (mobile) { await page.getByTestId('migration-tab-records').click(); await page.getByTestId(`migration-batch-record-${jobId}`).click(); await enabled(page.getByTestId('migration-batch-undo'), 'original history batch reopened'); await page.getByTestId('migration-batch-undo').click(); await confirm('UNDO'); }
    else await page.getByTestId('migration-dialog').getByRole('button', { name: '撤销本次导入', exact: true }).click();
    await waitFor(async () => { const value = await observer.rpc.request('migration/batch/read', { jobId }); return !value.workerRunning && value.state.job.status === 'rolled_back'; }, 30000, 'ordinary owner history Undo');
    assert.deepEqual(await readFile(resolve(profile, 'settings.json')), before);
    for (const file of fixture.files) assert.equal(sha(await readFile(file.file.replace(fixture.root, withheld))), file.sha256);
    assert.equal(await access(`${sourceProgram}.marker`).then(() => true, () => false), false); assert.equal(model.requests.length, 0);
    assert.ok(queries.every(row => row.session.targetId === sourceId && ['history_families', 'history_page'].includes(row.query.kind)));
    const ownedRoutes = new Map([...queries.map(row => [row.session.sessionId, row.session]), [run.target.sessionId, run.target]]);
    const ownedSessions = new Set(ownedRoutes.keys());
    if (!mobile) {
      await page.getByTestId('migration-dialog').getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByTestId('migration-dialog').waitFor({ state: 'detached' });
    }
    let releaseProof = 'close_receipts', releasedByRead = [];
    try { await waitFor(() => [...ownedSessions].every(id => closes.some(row => row.sessionId === id)), 15000, 'release only the original source and transfer target children after normal batch navigation'); }
    catch {
      // A lost close reply is reconciled by observing only that same original owner.
      const missing = [...ownedRoutes].filter(([id]) => !closes.some(row => row.sessionId === id)).map(([, session]) => session);
      assert.ok(missing.every(session => sessionRequests.some(row => row.operation === 'close' && row.input.sessionId === session.sessionId)));
      releasedByRead = await page.evaluate(async ({ url, sessions }) => Promise.all(sessions.map(async session => {
        const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(session), signal: AbortSignal.timeout(5000) });
        return { session, status: response.status, value: await response.json() };
      })), { url: sessionReadUrl, sessions: missing });
      await context.writeArtifactJson('history-families-session-release-read.json', { releasedByRead });
      for (const value of releasedByRead) { assert.equal(value.status, 200); assert.deepEqual(value.value, { status: 'released', launching: false, ownedChildren: 0 }); }
      releaseProof = 'original_session_read';
    }
    await context.writeArtifactJson('history-families-roundtrip.json', { passed: true, platform: mobile ? 'Mobile Web Chromium' : 'Studio browser Chromium',
      jobId, children, pageSizes: [10, 10, 3], physicalArtifacts: 23, explicitSelections: 2, observedRootSession: fixture.ids[0], observedGrandchildSession: fixture.ids[21],
      cachedAncestorAcrossCwd: true, preservedPhysicalVariants: true, sameSizeMtimeHeaderChangeRejected: true, invalidSelectionsCleared: true,
      explicitRediscovery: true, compressedPhysicalBytesPreserved: true, transferRequests: 1, sourceGoneBeforeAdoption: true,
      ordinaryPublishedAndUndone: true, historyProjectOnlyProvenance: true, originalChildrenReleased: ownedSessions.size, releaseProof,
      releasedByRead: releasedByRead.map(value => value.session.sessionId), sourceBytesPreserved: true, historicalToolsExecuted: false, modelRequests: 0 });
    return { historyFamilies: true, sourceGoneOrdinaryUndo: true, modelRequests: 0 };
  } catch (error) {
    await context.writeArtifactJson('history-families-pages.json', { pages, closeObservations, sessionRequests, target: transfers[0]?.target,
      visibleRows: await page.locator('[data-testid="migration-history-source-row"], [data-testid^="source-browser-select-"]').count() });
    if (jobId) { const value = await observer.rpc.request('migration/batch/read', { jobId }).catch(() => null); await context.writeArtifactJson('history-families-checkpoint.json', { jobId, state: value, queries: queries.map(row => ({ sessionId: row.session.sessionId, kind: row.query.kind })), transferRequests: transfers.length }); }
    throw error;
  } finally { page.off('request', onRequest); page.off('response', onResponse); await observer.close(); }
}
