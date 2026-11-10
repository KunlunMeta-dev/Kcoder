import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { makeOwnedLegacyBudgetFixture } from '../../harness/migration-legacy-budget-fixture.mjs';
const limits = { maxTotalBytes: 4194304, maxPayloadFiles: 16, minFreeBytes: 1048576, minFreeFileNodes: 0 };
async function clearAttachmentSelectors(page) {
  await page.evaluate(async () => {
    const prefix = 'kcoder.migration.resource-budget.v1:attachment:';
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('kcoder-migration-resource-budget-v2', 1);
      request.onerror = () => reject(Error('owned attachment metadata unavailable'));
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('selectors', 'readwrite'), store = tx.objectStore('selectors'), keys = store.getAllKeys();
        keys.onsuccess = () => { if (keys.result.length > 4096) { tx.abort(); return; } for (const key of keys.result) if (typeof key === 'string' && key.startsWith(prefix)) store.delete(key); };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(Error('owned attachment metadata aborted')); };
      };
    });
  });
}
/** Real old headers are harness prerequisites; all binding/increase/Undo actions use formal UI. */
export async function exerciseLegacyResourceBudgetUi({ context, page, gateway, profile, workspace, sourceRoot, model, transport, mobile = false }) {
  const target = mobile ? 'migration-target' : 'fixture-target', owned = await openOwnedMobileRpc(context, gateway, target, workspace), rpc = owned.rpc;
  const originalSettings = await readFile(resolve(profile, 'settings.json')), files = [];
  let phase = 'seed', parentId = null, childId = null, standaloneId = null;
  const attachment = kind => page.getByTestId(`migration-resource-attachment-${kind}`);
  const details = async (panel, kind = 'attachment') => {
    if (mobile) await panel.getByTestId(kind === 'attachment' ? 'migration-attachment-details' : 'migration-resource-details').click();
    else if (await panel.getAttribute('open') === null) await panel.locator('summary').first().click();
  };
  const selectTarget = async () => {
    if (mobile) { await page.getByTestId('settings-runtime-target-selector').click(); await page.getByTestId(`settings-runtime-target-option-${target}`).click(); }
    else { await page.goto(`${gateway.baseUrl}/settings/general`); await page.getByTestId('general-language-en-button').click(); await page.getByTestId('general-external-content-import-button').click(); await page.locator('#migration-target').selectOption(target); }
  };
  const openHistory = async id => {
    await selectTarget();
    if (mobile) { await page.getByTestId('migration-archive-open').click(); await page.getByRole('button', { name: 'History tasks', exact: true }).click(); await page.getByTestId(`migration-job-${id}`).click(); }
    else { await selectAdvancedMigration(page.getByTestId('migration-dialog'), 'history'); await page.getByRole('button', { name: 'Archive jobs', exact: true }).click(); await page.getByTestId(`migration-history-record-${id}`).click(); }
  };
  const openParent = async () => {
    await selectTarget();
    if (mobile) { await page.getByTestId('migration-tab-records').click(); await page.getByTestId(`migration-batch-record-${parentId}`).click(); }
    else { await page.getByTestId('migration-dialog').getByRole('button', { name: 'Migration records', exact: true }).click(); await page.getByTestId(`migration-batch-record-${parentId}`).click(); }
  };
  const bind = async panel => {
    const form = panel.getByTestId('migration-initial-resources');
    if (mobile) await form.getByTestId('migration-initial-details').click(); else await form.locator('summary').click();
    for (const [key, value] of Object.entries(limits)) await form.getByTestId(`migration-initial-${key}`).fill(String(value));
    await panel.getByTestId('migration-attachment-review').click();
    await panel.getByTestId(mobile ? 'migration-attachment-confirm-input' : 'migration-attachment-word').fill('BIND');
    await panel.getByTestId(mobile ? 'migration-attachment-confirm-submit' : 'migration-attachment-confirm').click();
  };
  try {
    for (let index = 0; index < 2; index++) {
      const session = randomUUID(), title = `Owned legacy budget ${session}`, file = resolve(sourceRoot, `projects/legacy-${session}/${session}.jsonl`);
      await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 }); await writeFile(file, JSON.stringify({ type: 'user', sessionId: session, uuid: 'original', message: { role: 'user', content: title } }) + '\n', { mode: 0o600 }); files.push({ file, title });
    }
    const catalog = await rpc.request('migration/history/discover', { source: 'claude-code' }), selected = [];
    let sources = catalog;
    for (let count = 0; count < 16; count++) { for (const file of files) { const item = sources.items.find(row => row.title === file.title); if (item) selected.push({ file, source: { catalogId: catalog.catalogId, sourceHandle: item.sourceHandle } }); } if (!sources.nextCursor) break; sources = await rpc.request('migration/history/sources', { catalogId: catalog.catalogId, cursor: sources.nextCursor }); }
    assert.equal(selected.length, 2);
    const scan = await rpc.request('migration/batch/scan', { sourceIds: [], historySources: [selected[0].source], resourceLimits: limits }); parentId = scan.job.jobId;
    const items = await rpc.request('migration/items', { jobId: parentId }); assert.equal(items.items.length, 1);
    const plan = await rpc.request('migration/batch/plan', { jobId: parentId, expectedSequence: scan.job.sequence, choices: [{ kind: 'history', itemId: items.items[0].id }], includeDefaultItems: false });
    const planId = plan.batch.planId;
    await rpc.request('migration/batch/run', { jobId: parentId, expectedSequence: plan.job.sequence, planId, requestId: randomUUID(), mode: 'apply' });
    const parent = await waitFor(async () => { const value = await rpc.request('migration/batch/read', { jobId: parentId }); return value.state.job.status === 'completed' && !value.workerRunning && value.workerError === null ? value : null; }, 30000, 'owned parent completed before legacy fixture');
    const planned = await rpc.request('migration/items', { jobId: parentId }); childId = planned.planned.find(row => row.itemId === items.items[0].id)?.historyJobId; assert.match(childId, /^[a-f0-9-]{36}$/);
    standaloneId = randomUUID(); await rpc.request('migration/history/create', { ...selected[1].source, requestId: standaloneId, resourceLimits: limits });
    await rpc.request('migration/history/run', { jobId: standaloneId, expectedSequence: 0 });
    const standalone = await waitFor(async () => { const value = await rpc.request('migration/history/read', { jobId: standaloneId }); return value.job.stage === 'normalized' && !value.workerRunning && value.workerError === null ? value : null; }, 30000, 'owned standalone completed before legacy fixture');
    const child = await rpc.request('migration/history/read', { jobId: childId });
    await makeOwnedLegacyBudgetFixture(context, profile, { parent: parentId, children: [childId] }, async () => { const p = await rpc.request('migration/batch/read', { jobId: parentId }), c = await rpc.request('migration/history/read', { jobId: childId }); return p.state.job.status === 'completed' && !p.workerRunning && p.workerError === null && c.job.stage === 'normalized' && !c.workerRunning && c.workerError === null; });
    await makeOwnedLegacyBudgetFixture(context, profile, { children: [standaloneId] }, async () => { const value = await rpc.request('migration/history/read', { jobId: standaloneId }); return value.job.stage === 'normalized' && !value.workerRunning && value.workerError === null; });
    const before = await rpc.request('migration/batch/resources/attachment/read', { jobId: parentId }); assert.equal(before.phase, 'untracked');
    assert.equal((await rpc.request('migration/history/resources/attachment/read', { jobId: childId })).phase, 'parent_owned');
    phase = 'parent-owned-ui'; await openHistory(childId); await details(attachment('history'));
    await attachment('history').getByRole('button', { name: 'Open the original parent binding', exact: true }).click();
    await details(attachment('batch')); await bind(attachment('batch'));
    await waitFor(() => transport.attachments.some(row => row.jobId === parentId), 15000, 'parent attachment accepted and reply deliberately lost');
    const parentReceipt = await rpc.request('migration/batch/resources/attachment/read', { jobId: parentId }); assert.equal(parentReceipt.phase, 'attached'); assert.equal(parentReceipt.originalIntent.expectedSequence, parent.state.job.sequence); assert.equal(parentReceipt.originalIntent.planId, planId); assert.deepEqual(parentReceipt.originalIntent.initialLimits, limits);
    assert.equal((await rpc.request('migration/batch/read', { jobId: parentId })).state.job.sequence, parent.state.job.sequence);
    await clearAttachmentSelectors(page); await page.reload(); await openParent(); await details(attachment('batch')); await attachment('batch').getByTestId('migration-attachment-original').waitFor();
    assert.equal(transport.requests.filter(row => row.method === 'migration/batch/resources/attach').length, 1);
    phase = 'standalone-ui'; await page.reload(); await openHistory(standaloneId); await details(attachment('history')); await bind(attachment('history'));
    await waitFor(() => transport.attachments.some(row => row.jobId === standaloneId), 15000, 'standalone attachment accepted and reply deliberately lost');
    const standaloneReceipt = await rpc.request('migration/history/resources/attachment/read', { jobId: standaloneId }); assert.equal(standaloneReceipt.phase, 'attached'); assert.equal(standaloneReceipt.originalIntent.expectedSequence, standalone.job.sequence); assert.equal(standaloneReceipt.originalIntent.planId, null); assert.deepEqual(standaloneReceipt.originalIntent.initialLimits, limits);
    for (const file of files) await rename(file.file, `${file.file}.withheld`);
    await clearAttachmentSelectors(page); await page.reload(); await openHistory(standaloneId); await details(attachment('history')); await attachment('history').getByTestId('migration-attachment-original').waitFor();
    assert.equal(transport.requests.filter(row => row.method === 'migration/history/resources/attach').length, 1);
    assert.deepEqual((await rpc.request('migration/history/read', { jobId: standaloneId })).job, standalone.job); assert.deepEqual((await rpc.request('migration/history/read', { jobId: childId })).job, child.job);
    assert.deepEqual(await rpc.request('migration/batch/resources/attachment/read', { jobId: parentId }), parentReceipt);
    phase = 'completed-parent-increase'; await page.reload(); await openParent(); await details(page.getByTestId('migration-resource-budget'), 'budget'); await page.getByTestId('migration-resource-read').click();
    await page.getByTestId('migration-resource-bytes').fill('8388608'); await page.getByTestId('migration-resource-files').fill('32'); await page.getByTestId('migration-resource-increase').click(); await page.getByTestId('migration-resource-confirm-input').fill('INCREASE'); await page.getByTestId(mobile ? 'migration-resource-confirm-submit' : 'migration-resource-confirm').click(); await page.getByTestId('migration-resource-receipt').waitFor();
    const increased = await rpc.request('migration/batch/resources/read', { jobId: parentId }); assert.equal(increased.policyRevision, 1); assert.equal(increased.limits.maxTotalBytes, 8388608); assert.equal((await rpc.request('migration/batch/read', { jobId: parentId })).state.job.sequence, parent.state.job.sequence);
    phase = 'original-undo';
    if (mobile) { await page.getByTestId('migration-batch-undo').click(); await page.getByTestId('migration-batch-confirm-input').fill('UNDO'); await page.getByTestId('migration-batch-confirm-submit').click(); } else await page.getByTestId('migration-dialog').getByRole('button', { name: 'Undo this import', exact: true }).click();
    await waitFor(async () => (await rpc.request('migration/batch/read', { jobId: parentId })).state.job.status === 'rolled_back', 30000, 'original parent Undo without source');
    assert.ok((await readFile(resolve(profile, 'settings.json'))).equals(originalSettings)); assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('migration-legacy-resource-budget-roundtrip.json', { passed: true, platform: mobile ? 'Mobile Web' : 'Studio Web', parentId, childId, standaloneId, parentReceipt, standaloneReceipt, parentOwnedUi: true, explicitBinds: 2, noAutomaticResubmit: true, allLocalAttachmentSelectorsRemoved: true, sourceUnavailable: true, originalViewsPreserved: true, completedParentIncrease: increased.policyRevision, originalParentUndo: true, targetSettingsUnchanged: true, pendingResumeActual: false, pendingCoverage: 'Native deterministic lost-group receipt plus controller/UI regressions', transport, modelRequests: 0 });
    return { legacyBindings: 2, originalParentGuidance: true, lostAcksRecoveredByRead: true, sourceGoneParentUndo: true, modelRequests: 0 };
  } catch (error) { await context.writeArtifactJson('migration-legacy-resource-budget-checkpoint.json', { phase, parentId, childId, standaloneId, transport }); throw error; }
  finally { await owned.close(); }
}
