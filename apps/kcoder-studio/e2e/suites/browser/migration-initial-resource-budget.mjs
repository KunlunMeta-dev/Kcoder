import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';

/** Exercise initial UI choices and the real standalone accounting owner; never publish settings. */
export async function exerciseInitialResourceBudgetUi({ context, page, gateway, profile, workspace, sourceRoot, model, transport, mobile = false }) {
  const target = mobile ? 'migration-target' : 'fixture-target';
  const observer = await openOwnedMobileRpc(context, gateway, target, workspace), rpc = observer.rpc;
  const originalSettings = await readFile(resolve(profile, 'settings.json'));
  const session = randomUUID(), title = `Owned H3 initial budget ${session}`;
  const file = resolve(sourceRoot, `projects/h3-${session}/${session}.jsonl`);
  const records = [{ type: 'user', uuid: 'root', sessionId: session, message: { role: 'user', content: title } }, { type: 'assistant', uuid: 'reply', parentUuid: 'root', sessionId: session, message: { role: 'assistant', content: 'Owned static transcript without tools or model calls.' } }];
  await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 });
  await writeFile(file, records.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
  const initial = { maxTotalBytes: 32, maxPayloadFiles: 16, minFreeBytes: 1048576, minFreeFileNodes: 0 };
  const scanLimits = { ...initial, maxTotalBytes: 8388608 };
  let phase = 'initial-scan', jobId = null, scanJobId = null;
  const dialog = () => page.getByTestId('migration-dialog');
  const selectMobileTarget = async () => { await page.getByTestId('settings-runtime-target-selector').click(); await page.getByTestId(`settings-runtime-target-option-${target}`).click(); };
  const openBrowser = async () => {
    await page.goto(`${gateway.baseUrl}/settings/general`);
    await page.getByTestId('general-language-en-button').click();
    await page.getByTestId('general-external-content-import-button').click();
    await dialog().locator('#migration-target').selectOption(target);
  };
  const setLimits = async limits => {
    const form = page.getByTestId('migration-initial-resources'); await form.waitFor();
    const enabled = page.getByTestId('migration-initial-enabled');
    if (!await enabled.isVisible()) {
      if (mobile) await page.getByTestId('migration-initial-details').click();
      else await form.locator('summary').click();
    }
    await enabled.waitFor();
    const checked = mobile ? (await enabled.innerText()).includes('☑') : await enabled.isChecked();
    if (!checked) await enabled.click();
    for (const [key, value] of Object.entries(limits)) await page.getByTestId(`migration-initial-${key}`).fill(String(value));
  };
  const openOriginal = async () => {
    if (mobile) {
      await selectMobileTarget(); await page.getByTestId('migration-archive-open').click();
      await page.getByRole('button', { name: 'History tasks', exact: true }).click();
      await page.getByTestId(`migration-job-${jobId}`).click();
    } else {
      await openBrowser(); await selectAdvancedMigration(dialog(), 'history');
      await page.getByRole('button', { name: 'Archive jobs', exact: true }).click();
      await page.getByTestId(`migration-history-record-${jobId}`).click();
    }
  };
  const mobileControl = async (name, word) => {
    await page.getByTestId(`migration-history-${name}`).click();
    await page.getByTestId('migration-history-confirm-input').fill(word);
    await page.getByTestId('migration-history-confirm-submit').click();
  };
  try {
    if (mobile) { await page.getByTestId('migration-source-claude-code').click(); await page.getByTestId('migration-discover-history').click(); }
    else { await openBrowser(); await page.getByTestId('migration-batch-history-picker').getByRole('button', { name: 'Find conversations', exact: true }).click(); }
    const sourceRow = mobile ? page.locator('[data-testid^="migration-history-selection-"]').filter({ hasText: title }) : page.getByTestId('migration-batch-history-picker').locator('label').filter({ hasText: title });
    await sourceRow.waitFor(); assert.equal(await sourceRow.count(), 1);
    if (mobile) await sourceRow.getByTestId(/^migration-history-source-/).click(); else await sourceRow.getByRole('checkbox').check();
    await setLimits(scanLimits);
    await page.getByTestId(mobile ? 'migration-scan-selection' : 'migration-initial-scan').click();
    const scanned = await waitFor(() => transport.requests.find(row => row.method === 'migration/batch/scan' && row.responseJobId), 20000, 'original initial-budget UI scan accepted');
    scanJobId = scanned.responseJobId; assert.deepEqual(scanned.resourceLimits, scanLimits);
    const planned = await rpc.request('migration/batch/resources/read', { jobId: scanJobId });
    assert.equal(planned.phase, 'planned'); assert.deepEqual(planned.limits, scanLimits);
    phase = 'standalone-create';
    if (mobile) { await page.getByTestId('migration-close-job').click(); await page.getByTestId('migration-source-claude-code').click(); await page.getByTestId('migration-discover-history').click(); }
    else { await selectAdvancedMigration(dialog(), 'history'); await page.getByRole('button', { name: 'Find conversations', exact: true }).click(); }
    await setLimits(initial);
    if (mobile) await page.locator('[data-testid^="migration-history-selection-"]').filter({ hasText: title }).getByTestId(/^migration-standalone-create-/).click();
    else await page.getByText(title, { exact: true }).locator('..').locator('..').getByTestId(/^migration-history-create-/).click();
    const created = await waitFor(() => transport.requests.find(row => row.method === 'migration/history/create' && row.responseJobId), 20000, 'standalone original creation acknowledgement');
    jobId = created.responseJobId; assert.equal(jobId, created.requestId); assert.deepEqual(created.resourceLimits, initial);
    if (mobile) await mobileControl('run', 'RUN');
    const stopped = await waitFor(async () => { const value = await rpc.request('migration/history/read', { jobId }); return value.job.stage === 'failed' && !value.workerRunning ? value : null; }, 20000, 'original 32-byte budget rejects before archive allocation');
    assert.equal(stopped.job.failureCode, 'history_resource_budget_exceeded'); assert.equal(stopped.job.archived, false);
    const before = await rpc.request('migration/history/resources/read', { jobId });
    assert.equal(before.ownerJobId, jobId); assert.deepEqual(before.initialLimits, initial); assert.equal(before.budget.policyRevision, 0);
    phase = 'increase-lost-reply';
    if (mobile) await page.getByTestId('migration-history-resource-details').click();
    else await page.getByTestId('migration-history-resource-budget').locator('summary').click();
    await page.getByTestId('migration-history-resource-bytes').fill('2097152'); await page.getByTestId('migration-history-resource-files').fill('16');
    await page.getByTestId('migration-history-resource-increase').click();
    assert.equal(transport.requests.filter(row => row.method === 'migration/history/resources/increase').length, 0);
    await page.getByTestId(mobile ? 'migration-history-resource-confirm-input' : 'migration-history-resource-word').fill('INCREASE');
    await page.getByTestId(mobile ? 'migration-history-resource-confirm-submit' : 'migration-history-resource-confirm').click();
    await waitFor(() => transport.dropped, 20000, 'accepted standalone policy reply deliberately lost');
    const requestId = transport.dropped.requestId;
    const accepted = await rpc.request('migration/history/resources/read', { jobId, requestId });
    assert.equal(accepted.ownerJobId, jobId); assert.deepEqual(accepted.initialLimits, initial); assert.equal(accepted.budget.requestedReceipt.requestId, requestId);
    assert.equal((await rpc.request('migration/history/read', { jobId })).job.sequence, stopped.job.sequence);
    phase = 'reopen-read-only';
    await page.reload(); await openOriginal();
    await page.getByTestId('migration-history-resource-receipt').waitFor({ timeout: 20000 });
    assert.equal(transport.requests.filter(row => row.method === 'migration/history/resources/increase').length, 1);
    assert.equal(transport.requests.filter(row => row.method === 'migration/history/create').length, 1);
    assert.ok(transport.requests.some(row => row.method === 'migration/history/resources/read' && row.requestId === requestId));
    phase = 'explicit-resume';
    if (mobile) {
      await mobileControl('resume', 'RESUME');
      await waitFor(async () => { const value = await rpc.request('migration/history/read', { jobId }); return value.job.stage === 'planned' && !value.job.archived && !value.workerRunning ? value : null; }, 20000, 'separate metadata resume does not start capture');
      await mobileControl('run', 'RUN');
    } else await page.getByRole('button', { name: 'Resume archive', exact: true }).click();
    const complete = await waitFor(async () => { const value = await rpc.request('migration/history/read', { jobId }); return value.job.stage === 'normalized' && !value.workerRunning ? value : null; }, 30000, 'explicit resume completes original archive within increased limit');
    assert.equal(complete.job.archived, true); assert.equal(complete.job.normalization.sourceRecords, 2);
    phase = 'source-gone'; await rename(file, `${file}.withheld`);
    const display = await rpc.request('migration/history/transcript', { jobId }); assert.equal(display.items.length, 2); assert.equal(display.totalRecords, 2);
    const final = await rpc.request('migration/history/resources/read', { jobId, requestId });
    assert.deepEqual(final.initialLimits, initial); assert.deepEqual(final.budget.requestedReceipt, accepted.budget.requestedReceipt);
    assert.ok(final.budget.usage.committedBytes > 0); assert.ok(final.budget.usage.committedFiles >= 4);
    assert.equal((await readFile(resolve(profile, 'settings.json'))).equals(originalSettings), true); assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('migration-initial-resource-budget-roundtrip.json', { passed: true, platform: mobile ? 'Mobile Web' : 'Studio Web', scanJobId, jobId, requestId, scanLimits, planned, initial, before, accepted, final, explicitlyFailedBeforeCapture: true, lostReceiptReadOnlyRecovery: true, explicitResume: true, sourceUnavailableFinal: true, settingsUnchanged: true, standaloneArchiveIsNotPublishedSession: true, transport: transport.requests, modelRequests: 0 });
    return { initialScan: true, standaloneBudget: true, lostReceiptReconciled: true, sourceGoneRead: true, modelRequests: 0 };
  } catch (error) {
    await context.writeArtifactJson('migration-initial-resource-budget-checkpoint.json', { phase, jobId, scanJobId, transport, ...(jobId ? { job: await rpc.request('migration/history/read', { jobId }).catch(() => null), budget: await rpc.request('migration/history/resources/read', { jobId }).catch(() => null) } : {}) }); throw error;
  } finally { await observer.close(); }
}
