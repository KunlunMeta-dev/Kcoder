import { exerciseLegacyResourceBudgetUi } from './migration-legacy-resource-budget.mjs';
import { exerciseInitialResourceBudgetUi } from './migration-initial-resource-budget.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';

/** Drop exactly one already-accepted budget reply on this page's owned transport. */
export async function installBudgetReceiptFault(page, { withholdFirst = false, history = false, attachment = false } = {}) {
  const evidence = { requests: [], dropped: null, attachments: [], withheld: null, withholdFirst };
  await page.routeWebSocket('**/rpc*', socket => {
    const upstream = socket.connectToServer(), pending = new Map();
    socket.onMessage(raw => {
      try {
        const frame = JSON.parse(String(raw));
        for (let node = frame, depth = 0; node && typeof node === 'object' && depth < 3; node = node.params, depth++) {
          if (!node.method?.startsWith('migration/batch/') && !(history && node.method?.startsWith('migration/history/'))) continue;
          const row = { method: node.method, jobId: node.params?.jobId, requestId: node.params?.requestId, mode: node.params?.mode, ...(attachment ? { expectedSequence: node.params?.expectedSequence, planId: node.params?.planId, ...(node.params?.limits ? { limits: Object.fromEntries(['maxTotalBytes', 'maxPayloadFiles', 'minFreeBytes', 'minFreeFileNodes'].filter(key => Number.isSafeInteger(node.params.limits[key])).map(key => [key, node.params.limits[key]])) } : {}) } : {}), ...(history && node.params?.resourceLimits ? { resourceLimits: Object.fromEntries(['maxTotalBytes', 'maxPayloadFiles', 'minFreeBytes', 'minFreeFileNodes'].filter(key => Number.isSafeInteger(node.params.resourceLimits[key])).map(key => [key, node.params.resourceLimits[key]])) } : {}) };
          evidence.requests.push(row); pending.set(frame.id, row);
          if (withholdFirst && !evidence.withheld && row.method === 'migration/batch/resources/increase') { evidence.withheld = { ...row }; void upstream.close({ code: 1011, reason: 'owned unsent budget fault' }); void socket.close({ code: 1011, reason: 'owned unsent budget fault' }); return; }
          break;
        }
      } catch { /* Non-JSON transport frames are forwarded unchanged. */ }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      try {
        const frame = JSON.parse(String(raw)), row = pending.get(frame.id); pending.delete(frame.id);
        if (history && row && typeof frame.result?.job?.jobId === 'string') row.responseJobId = frame.result.job.jobId;
        if (attachment && row && ['migration/history/resources/attach', 'migration/batch/resources/attach'].includes(row.method) && !evidence.attachments.some(value => value.jobId === row.jobId) && (row.method === 'migration/history/resources/attach' ? frame.result?.budget?.phase === 'active' && frame.result.budget.jobId === row.jobId && frame.result.ownerJobId === row.jobId && JSON.stringify(frame.result.initialLimits) === JSON.stringify(row.limits) : frame.result?.phase === 'active' && frame.result.jobId === row.jobId && JSON.stringify(frame.result.limits) === JSON.stringify(row.limits))) {
          evidence.attachments.push({ ...row, accepted: true }); void upstream.close({ code: 1011, reason: 'owned attachment receipt fault' }); void socket.close({ code: 1011, reason: 'owned attachment receipt fault' }); return;
        }
        if (!attachment && row?.method === (history ? 'migration/history/resources/increase' : 'migration/batch/resources/increase') && !evidence.dropped && frame.result?.requestId === row.requestId && frame.result.jobId === row.jobId && Number.isSafeInteger(frame.result.revision) && frame.result.revision > 0) {
          evidence.dropped = { ...row, revision: frame.result.revision };
          void upstream.close({ code: 1011, reason: 'owned budget receipt fault' });
          void socket.close({ code: 1011, reason: 'owned budget receipt fault' }); return;
        }
      } catch { /* Unknown responses retain their ordinary client semantics. */ }
      socket.send(raw);
    });
  });
  return evidence;
}

export async function exerciseResourceBudgetUi({ context, page, gateway, profile, workspace, sourceRoot, model, transport, mobile = false, httpMetadataAuthority = false, onAcceptedUnknown }) {
  if (process.env.KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY === 'legacy') return exerciseLegacyResourceBudgetUi({ context, page, gateway, profile, workspace, sourceRoot, model, transport, mobile });
  if (process.env.KCODER_E2E_MIGRATION_RESOURCE_BUDGET_ONLY === 'initial') return exerciseInitialResourceBudgetUi({ context, page, gateway, profile, workspace, sourceRoot, model, transport, mobile });
  const target = mobile ? 'migration-target' : 'fixture-target';
  const observer = await openOwnedMobileRpc(context, gateway, target, workspace), rpc = observer.rpc;
  const originalSettings = await readFile(resolve(profile, 'settings.json'));
  let checkpoint = 'seed', jobId = null;
  const files = [], prefix = `Owned budget ${randomUUID()}`;
  try {
    for (let index = 0; index < 2; index++) {
      const session = randomUUID(), title = `${prefix} ${index}`, file = resolve(sourceRoot, `projects/budget-${index}/${session}.jsonl`);
      const bytes = [{ type: 'user', uuid: 'root', sessionId: session, version: '2.1.301', message: { role: 'user', content: title } }, { type: 'assistant', uuid: 'reply', parentUuid: 'root', sessionId: session, message: { role: 'assistant', content: 'Owned static history. No live tool or model execution.' } }].map(row => JSON.stringify(row)).join('\n') + '\n';
      await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode: 0o600 });
      files.push({ file, title, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const catalog = await rpc.request('migration/history/discover', { source: 'claude-code' });
    let pageOfSources = catalog; const selections = [];
    for (let count = 0; count < 16; count++) {
      selections.push(...pageOfSources.items.filter(item => files.some(file => file.title === item.title)).map(item => ({ catalogId: catalog.catalogId, sourceHandle: item.sourceHandle })));
      if (!pageOfSources.nextCursor) break;
      pageOfSources = await rpc.request('migration/history/sources', { catalogId: catalog.catalogId, cursor: pageOfSources.nextCursor });
    }
    assert.equal(selections.length, 2);
    const limits = { maxTotalBytes: 8 * 1024 * 1024, maxPayloadFiles: 6, minFreeBytes: 1024 * 1024, minFreeFileNodes: 0 };
    const scan = await rpc.request('migration/batch/scan', { sourceIds: [], historySources: selections, resourceLimits: limits }); jobId = scan.job.jobId;
    const items = await rpc.request('migration/items', { jobId }); assert.equal(items.items.length, 2);
    const planned = await rpc.request('migration/batch/plan', { jobId, expectedSequence: scan.job.sequence, choices: items.items.map(item => ({ kind: 'history', itemId: item.id })), includeDefaultItems: false });
    const planId = planned.batch.planId;
    await rpc.request('migration/batch/run', { jobId, planId, requestId: randomUUID(), expectedSequence: planned.job.sequence, mode: 'apply' });
    const stopped = await waitFor(async () => { const result = await rpc.request('migration/batch/read', { jobId }); return !result.workerRunning && result.state.job.status === 'completed_with_issues' ? result : null; }, 30000, 'small original budget deterministically stops the second archive');
    assert.equal(stopped.state.job.committedItems, 1); assert.ok(stopped.state.batch.unresolvedActions > 0);
    const initial = await rpc.request('migration/batch/resources/read', { jobId }); assert.equal(initial.phase, 'active'); assert.equal(initial.policyRevision, 0); assert.equal(initial.usage.committedFiles, 5);
    checkpoint = 'open-original-record';
    const disableLocks = async () => { if (!transport.withholdFirst || mobile) return; await page.evaluate(() => { if (!('__budgetOriginalLocks' in globalThis)) globalThis.__budgetOriginalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks') ?? { value: navigator.locks, configurable: true }; Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }); }); };
    const open = async () => {
      if (mobile) {
        await disableLocks(); await page.getByTestId('migration-tab-records').click(); await page.getByTestId(`migration-batch-record-${jobId}`).click();
        await page.getByTestId('migration-resource-budget').waitFor(); await page.getByTestId('migration-resource-details').click();
      } else {
        await page.goto(`${gateway.baseUrl}/settings/general`); await page.getByTestId('general-language-en-button').click();
        await disableLocks(); await page.getByTestId('general-external-content-import-button').click(); const dialog = page.getByTestId('migration-dialog'); await dialog.locator('#migration-target').selectOption(target);
        await dialog.getByRole('button', { name: 'Migration records', exact: true }).click(); await dialog.getByRole('button').filter({ hasText: 'Claude Code ·' }).first().click();
        await page.getByTestId('migration-resource-budget').waitFor(); if (await page.getByTestId('migration-resource-budget').getAttribute('open') === null) await page.getByTestId('migration-resource-budget').locator('summary').first().click();
      }
    };
    await open(); await page.getByTestId('migration-resource-bytes').fill(String(limits.maxTotalBytes)); await page.getByTestId('migration-resource-files').fill('12');
    await page.getByTestId('migration-resource-increase').click(); assert.equal(transport.requests.filter(row => row.method === 'migration/batch/resources/increase').length, 0);
    await page.getByTestId('migration-resource-confirm-input').fill('INCREASE'); await page.getByTestId(mobile ? 'migration-resource-confirm-submit' : 'migration-resource-confirm').click();
    let archivedOriginal = null;
    if (transport.withholdFirst) {
      await waitFor(() => transport.withheld, 15000, 'original UI intent deliberately not forwarded');
      const oldRequestId = transport.withheld.requestId;
      await page.reload();
      if (mobile) { await page.getByTestId('settings-runtime-target-selector').click(); await page.getByTestId(`settings-runtime-target-option-${target}`).click(); }
      await open(); await page.getByTestId('migration-resource-resubmit').waitFor();
      assert.equal(await page.getByTestId('migration-resource-archive-expired').count(), 0, 'same-CAS missing receipt is still unknown');
      const peerRequestId = randomUUID();
      await rpc.request('migration/batch/resources/increase', { jobId, planId, requestId: peerRequestId, expectedPolicyRevision: 0, limits: { ...limits, maxPayloadFiles: 8 }, confirm: true });
      await page.getByTestId('migration-resource-read').click(); await page.getByTestId('migration-resource-expired').waitFor();
      const observed = await rpc.request('migration/batch/resources/read', { jobId, requestId: oldRequestId });
      assert.equal(observed.policyRevision, 1); assert.equal(observed.requestedReceipt ?? null, null);
      await page.getByTestId('migration-resource-archive-expired').click(); await page.getByTestId('migration-resource-confirm-input').fill('ARCHIVE');
      await page.getByTestId(mobile ? 'migration-resource-confirm-submit' : 'migration-resource-confirm').click(); await page.getByTestId('migration-resource-expired-history').waitFor({ state: 'attached' });
      assert.equal(transport.requests.filter(row => row.method === 'migration/batch/resources/increase').length, 1, 'local archival never submits a replacement');
      if (!mobile && await page.getByTestId('migration-resource-budget').getAttribute('open') === null) await page.getByTestId('migration-resource-budget').locator('summary').first().click();
      await page.getByTestId('migration-resource-bytes').fill(String(limits.maxTotalBytes)); await page.getByTestId('migration-resource-files').fill('12'); await page.getByTestId('migration-resource-increase').click();
      await page.getByTestId('migration-resource-confirm-input').fill('INCREASE'); await page.getByTestId(mobile ? 'migration-resource-confirm-submit' : 'migration-resource-confirm').click();
      archivedOriginal = { oldRequestId, peerRequestId, observedRevision: observed.policyRevision, unchangedOldCAS: 0, nativeOriginalNeverAccepted: true, explicitArchiveThenNewConfirm: true };
    }
    await waitFor(() => transport.dropped, 15000, 'accepted original budget reply deliberately lost'); checkpoint = 'accepted-reply-lost';
    const requestId = transport.dropped.requestId;
    const accepted = await rpc.request('migration/batch/resources/read', { jobId, requestId }); assert.equal(accepted.requestedReceipt.revision, transport.withholdFirst ? 2 : 1);
    if (archivedOriginal) { assert.notEqual(requestId, archivedOriginal.oldRequestId); assert.equal(accepted.requestedReceipt.previousRevision, 1); }
    assert.equal((await rpc.request('migration/batch/read', { jobId })).state.job.sequence, stopped.state.job.sequence, 'increase does not resume or clear task state');
    await onAcceptedUnknown?.({ jobId, requestId });
    await page.reload();
    if (mobile) {
      await page.getByTestId('settings-runtime-target-selector').waitFor();
      await page.getByTestId('settings-runtime-target-selector').click(); await page.getByTestId(`settings-runtime-target-option-${target}`).click();
    }
    await open(); await page.getByTestId('migration-resource-receipt').waitFor({ timeout: 15000 });
    assert.equal(transport.requests.filter(row => row.method === 'migration/batch/resources/increase').length, transport.withholdFirst ? 2 : 1, 'reopening only observes the original request');
    assert.ok(transport.requests.some(row => row.method === 'migration/batch/resources/read' && row.requestId === requestId));
    assert.equal((await rpc.request('migration/batch/read', { jobId })).state.job.status, 'completed_with_issues');
    if (transport.withholdFirst && !mobile) await page.evaluate(() => { Object.defineProperty(navigator, 'locks', globalThis.__budgetOriginalLocks); });
    checkpoint = 'explicit-resume';
    if (mobile) { await page.getByTestId('migration-batch-resume').click(); await page.getByTestId('migration-batch-confirm-input').fill('RESUME'); await page.getByTestId('migration-batch-confirm-submit').click(); }
    else await page.getByTestId('migration-dialog').getByRole('button', { name: 'Reconcile and continue', exact: true }).click();
    const done = await waitFor(async () => { const value = await rpc.request('migration/batch/read', { jobId }); return value.state.job.status === 'completed' && !value.workerRunning ? value : null; }, 30000, 'separate user resume completes the two original actions');
    assert.equal(done.state.job.committedItems, 2);
    const after = await rpc.request('migration/batch/resources/read', { jobId, requestId }); assert.equal(after.policyRevision, transport.withholdFirst ? 2 : 1); assert.equal(after.usage.committedFiles, 10);
    for (const file of files) { assert.equal(createHash('sha256').update(await readFile(file.file)).digest('hex'), file.sha256); await rename(file.file, `${file.file}-withheld`); }
    checkpoint = 'offline-original-undo';
    if (mobile) { await page.getByTestId('migration-batch-undo').click(); await page.getByTestId('migration-batch-confirm-input').fill('UNDO'); await page.getByTestId('migration-batch-confirm-submit').click(); }
    else await page.getByTestId('migration-dialog').getByRole('button', { name: 'Undo this import', exact: true }).click();
    await waitFor(async () => (await rpc.request('migration/batch/read', { jobId })).state.job.status === 'rolled_back', 30000, 'original normal batch Undo works without source');
    await page.getByTestId('migration-resource-read').click();
    const retained = await rpc.request('migration/batch/resources/read', { jobId, requestId }); assert.deepEqual(retained.requestedReceipt, accepted.requestedReceipt);
    assert.equal((await readFile(resolve(profile, 'settings.json'))).equals(originalSettings), true); assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('migration-resource-budget-roundtrip.json', { passed: true, platform: mobile ? 'Mobile Web' : 'Studio Web', jobId, requestId, initial, accepted, after, retained, sourceUnavailableAfterPublication: true, targetSettingsUnchanged: true, nativeApply: 'owned fixture prerequisite only', UIIncrease: true, lostReplyReconciled: true, archivedOriginal, budgetWritesWithoutWebLocks: httpMetadataAuthority || transport.withholdFirst && !mobile, legacyMobileProfileFenceRequiresWebLocks: mobile && !httpMetadataAuthority, receiptStorage: 'IndexedDB atomic metadata transaction', automaticResume: false, explicitResume: true, ordinaryBatchUndo: true, transport: transport.requests, modelRequests: 0 });
    return { originalArchives: 2, explicitIncrease: true, lostReceiptReconciled: true, explicitResume: true, originalOfflineUndo: true, modelRequests: 0 };
  } catch (error) {
    await context.writeArtifactJson('migration-resource-budget-checkpoint.json', { checkpoint, jobId, transport, ...(jobId ? { batch: await rpc.request('migration/batch/read', { jobId }).catch(() => null), budget: await rpc.request('migration/batch/resources/read', { jobId }).catch(() => null) } : {}) }); throw error;
  } finally { await observer.close(); }
}
