import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rename, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { clearPrivateMigrationRecovery } from '../../harness/migration-private-recovery.mjs';

/** Private values stay between the two Native endpoints; the actual Web UI sees selectors and receipts only. */
export async function exerciseMobilePrivateCredentials({ context, page, gateway, profile, workspace, sourceRoot, marker, model, observations }) {
  const observer = await openOwnedMobileRpc(context, gateway, 'migration-target', workspace);
  const original = await readFile(resolve(profile, 'settings.json')), sourceBytes = await readFile(resolve(sourceRoot, 'settings.json'));
  const http = [], steps = []; let loseRun = true, losePrepare = true, firstOffer = null, originalPrepare = null;
  let releaseRunReply = null;
  let configurationSource = null, candidateMetadata = null;
  let preparationStatus = null;
  await page.route('**/api/migration/source-session/query', async route => {
    const input = route.request().postDataJSON();
    if (input.query?.kind === 'configuration') {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      const result = await response.json();
      configurationSource = result.sources.find(row => row.availableCategories.includes('provider') && row.availableCategories.includes('mcp'));
      await route.fulfill({ response }); return;
    }
    await route.continue();
  });
  await page.route('**/api/migration/source-transfer/private/**', async route => {
    const input = route.request().postDataJSON(), operation = new URL(route.request().url()).pathname.split('/').at(-1);
    const row = { operation, requestId: input.locator?.requestId ?? input.requestId, offerId: input.locator?.offerId ?? input.offerId,
      entryId: input.entryId, jobId: input.jobId, side: input.side, sourceId: input.source?.targetId,
      additionalOffers: input.additionalOffers?.length ?? 0 };
    http.push(row);
    if (operation === 'candidates') {
      const response = await route.fetch(); assert.equal(response.status(), 200); candidateMetadata = await response.json();
      await route.fulfill({ response }); return;
    }
    if (operation === 'prepare-status') {
      const response = await route.fetch(); assert.equal(response.status(), 200); preparationStatus = await response.json();
      await route.fulfill({ response }); return;
    }
    if (operation === 'run' && loseRun || operation === 'prepare' && losePrepare) {
      const response = await route.fetch(); assert.equal(response.status(), 200, 'owned reply fault follows actual acceptance');
      if (operation === 'run') {
        loseRun = false; firstOffer = input.locator.offerId;
        await new Promise(resolve => { releaseRunReply = resolve; });
      }
      else { losePrepare = false; originalPrepare = input; }
      row.replyDiscarded = true; await route.abort('failed'); return;
    }
    await route.continue();
  });
  const enabled = (locator, label) => waitFor(async () => await locator.count() === 1 && !await locator.isDisabled(), 20000, label);
  const confirm = async keyword => { await page.getByTestId('migration-private-confirm-input').fill(keyword); await page.getByTestId('migration-private-confirm-submit').click(); };
  const batchConfirm = async keyword => { await page.getByTestId('migration-batch-confirm-input').fill(keyword); await page.getByTestId('migration-batch-confirm-submit').click(); };
  const openPrivate = async () => { const panel = page.getByTestId('migration-private-credentials'); await panel.waitFor(); await panel.getByTestId('migration-private-details').click(); return panel; };
  let jobId, providerId, mcpId, publication, rollback;
  try {
    await page.getByTestId('migration-tab-source').click(); await page.getByTestId('migration-source-remote-mode').click();
    await page.getByTestId('source-device-peer-target').click();
    const source = page.getByTestId('migration-source-browser'); await source.getByTestId('source-browser-product-claude-code').click(); await source.getByTestId('source-browser-discover').click();
    await waitFor(() => configurationSource, 20000, 'Native public source explicitly declares Provider and MCP categories');
    const choice = source.getByTestId(`source-browser-select-${configurationSource.sourceId}`); await choice.waitFor(); await choice.click();
    await source.getByTestId('source-browser-transfer').click();
    await source.getByTestId('source-transfer-status').getByText('Sources received; not imported', { exact: true }).waitFor({ timeout: 30000 });
    const adoption = source.getByTestId('migration-source-adoption'); await adoption.getByTestId('source-adoption-expand').click();
    await adoption.locator('[data-testid^="source-adoption-select-"]').first().click(); await adoption.getByTestId('source-adoption-prepare').click();
    const openBatch = adoption.locator('[data-testid^="source-adoption-open-"]').first(); await openBatch.waitFor({ timeout: 30000 });
    jobId = (await openBatch.getAttribute('data-testid')).slice('source-adoption-open-'.length); await openBatch.click();
    await page.getByTestId('migration-batch-editor').waitFor();
    const items = (await observer.rpc.request('migration/items', { jobId })).items;
    const provider = items.find(item => item.category === 'provider'), mcp = items.find(item => item.category === 'mcp');
    assert.ok(provider && mcp); providerId = provider.id; mcpId = mcp.id;
    for (const item of [provider, mcp]) {
      await page.getByTestId(`migration-item-edit-${item.id}`).click();
      await page.getByTestId('migration-item-name').fill(item.category === 'provider' ? 'mobile-private-provider' : 'mobile-private-documents');
      if (item.category === 'provider') {
        await page.getByTestId('migration-provider-context').fill('128000'); await page.getByTestId('migration-provider-headroom').fill('4096'); await page.getByTestId('migration-provider-output').fill('4096');
      }
      await page.getByTestId('migration-item-save').click();
    }
    await page.getByTestId('migration-preview-plan').click(); await page.getByTestId('migration-batch-operation').waitFor();
    assert.deepEqual(await readFile(resolve(profile, 'settings.json')), original);
    let panel = await openPrivate(); await panel.getByTestId('migration-private-sources').click();
    const row = panel.locator('[data-testid^="migration-private-source-e"]').first(); await row.waitFor();
    const entryId = (await row.getAttribute('data-testid')).slice('migration-private-source-'.length); await row.click();
    await panel.getByTestId('migration-private-device-peer-target').click(); await panel.getByTestId('migration-private-candidates').click();
    await waitFor(() => candidateMetadata?.items.some(row => row.kind === 'provider'), 20000, 'original saved-plan Provider candidate');
    const providerCandidate = candidateMetadata.items.find(row => row.kind === 'provider' && row.targets?.[0]?.batchItemId === providerId);
    assert.ok(providerCandidate); const selectorIndex = providerCandidate.selectors.findIndex(value => value.kind === 'claude_configuration');
    assert.ok(selectorIndex >= 0, 'the owned fixture explicitly stores the key in its declared Claude configuration');
    await panel.getByTestId(`migration-private-selector-${providerCandidate.itemId}-${selectorIndex}`).click(); await panel.getByTestId('migration-private-consent-keys').click();
    await panel.getByTestId('migration-private-transfer').click(); await confirm('TRANSFER');
    await waitFor(() => firstOffer && releaseRunReply, 20000, 'accepted original private transfer reply held');
    await enabled(panel.getByTestId('migration-private-read'), 'receipt reading remains reachable during the held run reply');
    await panel.getByTestId('migration-private-read').click(); await panel.getByText('Received on target; batch not yet saved', { exact: true }).waitFor();
    await panel.getByTestId('migration-private-cancel-target').click(); await confirm('CANCEL');
    await panel.getByTestId('migration-private-cancelled-target').waitFor();
    assert.equal(await panel.getByTestId('migration-private-cancelled-target').innerText(), 'Cancelled');
    assert.equal(http.filter(row => row.operation === 'cancel' && row.side === 'target').length, 1);
    releaseRunReply();
    await enabled(panel.getByTestId('migration-private-sources'), 'the lost original run reply settles without hiding the cancellation');
    await panel.getByText('The outcome is unknown. No transfer was automatically repeated.', { exact: true }).waitFor();
    assert.equal(http.filter(row => row.operation === 'run').length, 1); steps.push('accepted-run-reply-lost');
    await page.reload(); await page.getByTestId('migration-workbench').waitFor({ timeout: 30000 }); await page.getByTestId('migration-tab-records').click();
    await page.getByTestId(`migration-batch-record-${jobId}`).click(); await page.getByTestId('migration-batch-operation').waitFor(); panel = await openPrivate();
    await panel.getByTestId('migration-private-sources').click(); await panel.getByTestId(`migration-private-source-${entryId}`).click();
    await panel.getByTestId('migration-private-candidates').click(); await panel.getByTestId(`migration-private-recover-${firstOffer}`).click();
    await panel.getByTestId('migration-private-cancelled-target').waitFor();
    assert.equal(http.filter(row => row.operation === 'run').length, 1); assert.equal(await panel.getByTestId('migration-private-resume-source').isDisabled(), true);
    await panel.getByTestId('migration-private-resume-target').click(); await confirm('RESUME');
    await enabled(panel.getByTestId('migration-private-read'), 'explicit target resume receipt settled'); await panel.getByTestId('migration-private-read').click();
    await panel.getByText('Received on target; batch not yet saved', { exact: true }).waitFor();
    assert.equal(http.filter(row => row.operation === 'cancel' && row.side === 'target').length, 1);
    assert.equal(http.filter(row => row.operation === 'resume' && row.side === 'target').length, 1);
    assert.equal(http.filter(row => row.operation === 'run').length, 1);
    await panel.getByTestId('migration-private-include-offer').click(); steps.push('target-only-original-offer-recovery');
    await panel.getByTestId('migration-private-device-peer-target').click();
    await panel.getByTestId(`migration-private-recover-${firstOffer}`).click(); await panel.getByTestId('migration-private-source-read').click();
    await enabled(panel.getByTestId('migration-private-resume-source'), 'original source-side observation supplies an actual stopped watermark');
    await panel.getByTestId('migration-private-cancel-source').click(); await confirm('CANCEL');
    await panel.getByTestId('migration-private-cancelled-source').waitFor();
    assert.equal(await panel.getByTestId('migration-private-cancelled-source').innerText(), 'Cancelled');
    await panel.getByTestId('migration-private-source-read').click();
    await enabled(panel.getByTestId('migration-private-resume-source'), 'explicit source-only cancellation observation');
    await panel.getByTestId('migration-private-resume-source').click(); await confirm('RESUME');
    await waitFor(async () => await panel.getByTestId('migration-private-cancelled-source').count() === 0, 15000, 'actual source resume receipt clears only its own cancellation');
    await panel.getByTestId('migration-private-read').click(); await panel.getByText('Received on target; batch not yet saved', { exact: true }).waitFor();
    assert.equal(http.filter(row => row.operation === 'cancel' && row.side === 'source').length, 1);
    assert.equal(http.filter(row => row.operation === 'resume' && row.side === 'source').length, 1);
    assert.equal(http.filter(row => row.operation === 'run').length, 1); steps.push('explicit-source-observation-cancel-resume');
    const mcpCandidate = candidateMetadata.items.find(row => row.kind === 'mcp' && row.targets?.[0]?.batchItemId === mcpId); assert.ok(mcpCandidate);
    const candidate = panel.getByTestId(`migration-private-candidate-${mcpCandidate.itemId}`); await candidate.waitFor();
    assert.equal(mcpCandidate.fields.length, 12);
    const fields = candidate.locator('[data-testid^="migration-private-field-"]'); assert.equal(await fields.count(), 10);
    for (let index = 0; index < 10; index++) await fields.nth(index).click();
    await candidate.getByRole('button', { name: 'Next', exact: true }).click(); assert.equal(await fields.count(), 2);
    for (let index = 0; index < 2; index++) await fields.nth(index).click();
    await panel.getByTestId('migration-private-consent-mcp').click(); await panel.getByTestId('migration-private-transfer').click(); await confirm('TRANSFER');
    await panel.getByText('Received on target; batch not yet saved', { exact: true }).waitFor();
    const secondOffer = http.filter(row => row.operation === 'run').at(-1).offerId; assert.notEqual(secondOffer, firstOffer);
    await panel.getByTestId('migration-private-include-offer').click(); await panel.getByTestId('migration-private-included').getByText('2 explicitly included offers', { exact: true }).waitFor();
    await panel.getByTestId('migration-private-prepare').click(); await confirm('PREPARE');
    await waitFor(() => originalPrepare, 20000, 'accepted original complete offer set reply discarded');
    assert.equal(originalPrepare.additionalOffers.length, 1); assert.deepEqual(new Set([originalPrepare.locator.offerId, ...originalPrepare.additionalOffers]), new Set([firstOffer, secondOffer]));
    const cacheLoss = await clearPrivateMigrationRecovery(page); assert.ok(cacheLoss.removed >= 3); assert.equal(cacheLoss.remaining, 0);
    await page.reload(); await page.getByTestId('migration-workbench').waitFor({ timeout: 30000 }); await page.getByTestId('migration-tab-records').click();
    await page.getByTestId(`migration-batch-record-${jobId}`).click(); await page.getByTestId('migration-batch-operation').waitFor(); panel = await openPrivate();
    await panel.getByTestId('migration-private-sources').click(); await panel.getByTestId(`migration-private-source-${entryId}`).click();
    await panel.getByTestId('migration-private-preparation-read').click();
    await waitFor(async () => await panel.getByTestId('migration-private-preparation-status').innerText() === 'The original offer set was prepared.', 20000, 'original prepared Native intent after complete local cache loss');
    assert.equal(preparationStatus.phase, 'prepared'); assert.equal(preparationStatus.expectedSequence, originalPrepare.expectedSequence);
    assert.deepEqual(preparationStatus.offerIds, [firstOffer, secondOffer].sort()); assert.deepEqual(preparationStatus.consent, originalPrepare.consent);
    assert.equal(http.filter(row => row.operation === 'prepare').length, 1); assert.equal(http.filter(row => row.operation === 'run').length, 2);
    assert.equal(await panel.getByTestId('migration-private-preparation-restore').count(), 0);
    assert.equal(await panel.getByTestId('migration-private-offer').count(), 0, 'a preparation fact does not manufacture a live offer/worker observation');
    await panel.getByTestId('migration-private-batch-read').click();
    steps.push('complete-local-cache-loss-original-native-preparation-read');
    const withheld = resolve(sourceRoot, '../source-withheld-private'); await rename(sourceRoot, withheld);
    await enabled(page.getByTestId('migration-batch-import'), 'ordinary explicit batch save'); await page.getByTestId('migration-batch-import').click(); await batchConfirm('IMPORT');
    await waitFor(() => observations.some(row => row.method === 'migration/batch/run' && row.jobId === jobId && row.mode === 'apply'), 15000, 'the one explicit ordinary apply request is dispatched');
    await waitFor(async () => { const value = await observer.rpc.request('migration/batch/read', { jobId });
      if (value.workerRunning || !['completed', 'completed_with_issues', 'cancelled', 'rolled_back', 'rollback_conflict'].includes(value.state.job.status)) return false;
      assert.ok(['completed', 'completed_with_issues'].includes(value.state.job.status)); assert.equal(value.state.job.hasUnconfirmedOutcomes, false);
      assert.equal(value.state.batch.unresolvedActions, 0); assert.equal(value.state.job.committedItems, 2);
      assert.ok(value.state.batch.totalActions > 0); assert.equal(value.state.batch.committedActions, value.state.batch.totalActions);
      const savedItems = await observer.rpc.request('migration/items', { jobId });
      for (const itemId of [providerId, mcpId]) {
        const item = savedItems.items.find(item => item.id === itemId); assert.equal(item?.status, 'committed');
        const planned = savedItems.planned.find(item => item.itemId === itemId); assert.equal(planned?.errorCode, null); assert.equal(planned?.enabled, false);
      }
      const providers = value.state.credentialPlans.filter(plan => plan.itemId === providerId);
      assert.equal(providers.length, 1); assert.equal(providers[0].phase, 'published'); assert.equal(providers[0].errorCode, undefined);
      const mcp = (await observer.rpc.request('migration/batch/mcp/credential/read', { jobId })).plans.filter(plan => plan.itemId === mcpId);
      assert.equal(mcp.length, 1); assert.equal(mcp[0].phase, 'published'); assert.equal(mcp[0].errorCode, null);
      assert.equal(mcp[0].fields.length, 12); assert.equal(mcp[0].remainingFields, 0);
      const blockers = savedItems.items.flatMap(item => item.issues.filter(issue => issue.severity === 'blocking').map(issue => ({ itemId: item.id, ...issue })));
      assert.ok(blockers.every(issue => issue.phase === 'activation' && ['credential_resolution_required', 'requires_review'].includes(issue.code)), 'retained source activation diagnostics cannot conceal a failed publication');
      publication = { status: value.state.job.status, sequence: value.state.job.sequence, committedItems: value.state.job.committedItems,
        totalActions: value.state.batch.totalActions, committedActions: value.state.batch.committedActions,
        unresolvedActions: value.state.batch.unresolvedActions, hasUnconfirmedOutcomes: value.state.job.hasUnconfirmedOutcomes,
        items: savedItems.items.map(item => ({ id: item.id, status: item.status })), retainedSourceActivationIssues: blockers,
        providerPhases: providers.map(plan => ({ itemId: plan.itemId, phase: plan.phase })),
        mcpPhases: mcp.map(plan => ({ itemId: plan.itemId, phase: plan.phase, fields: plan.fields.length, remaining: plan.remainingFields })) };
      return true;
    }, 30000, 'ordinary original batch publication without source');
    const saved = await readFile(resolve(profile, 'settings.json'), 'utf8');
    const settings = JSON.parse(saved);
    assert.ok(settings.providers['mobile-private-provider']); assert.ok(settings.mcp_servers.find(server => server.name === 'mobile-private-documents'));
    assert.ok(settings.mcp_disabled_servers.includes('mobile-private-documents'));
    assert.equal(settings.active_provider, JSON.parse(original).active_provider, 'explicit migration does not replace the default provider');
    await page.reload(); await page.getByTestId('migration-workbench').waitFor({ timeout: 30000 }); await page.getByTestId('migration-tab-records').click();
    await page.getByTestId(`migration-batch-record-${jobId}`).click(); await enabled(page.getByTestId('migration-batch-undo'), 'original saved record reopened');
    await page.getByTestId('migration-batch-undo').click(); await batchConfirm('UNDO');
    await waitFor(async () => { const value = await observer.rpc.request('migration/batch/read', { jobId });
      if (value.state.job.status !== 'rolled_back' || value.workerRunning) return false;
      assert.equal(value.state.job.hasUnconfirmedOutcomes, false); assert.equal(value.state.batch.unresolvedActions, 0);
      const undoneItems = await observer.rpc.request('migration/items', { jobId });
      for (const itemId of [providerId, mcpId]) assert.equal(undoneItems.items.find(item => item.id === itemId)?.status, 'rolled_back');
      assert.equal(value.state.credentialPlans.find(plan => plan.itemId === providerId)?.phase, 'undone');
      const mcp = await observer.rpc.request('migration/batch/mcp/credential/read', { jobId });
      assert.equal(mcp.plans.find(plan => plan.itemId === mcpId)?.phase, 'undone');
      rollback = { status: value.state.job.status, sequence: value.state.job.sequence, unresolvedActions: value.state.batch.unresolvedActions,
        hasUnconfirmedOutcomes: value.state.job.hasUnconfirmedOutcomes, items: undoneItems.items.map(item => ({ id: item.id, status: item.status })),
        providerPhase: 'undone', mcpPhase: 'undone', originalSettingsRestored: true };
      return true;
    }, 30000, 'ordinary owner Undo without source');
    assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), JSON.parse(original));
    assert.equal(observations.filter(row => row.method === 'migration/batch/run' && row.jobId === jobId && row.mode === 'apply').length, 1);
    assert.equal(observations.filter(row => row.method === 'migration/batch/run' && row.jobId === jobId && row.mode === 'rollback').length, 1);
    assert.equal(createHash('sha256').update(await readFile(resolve(withheld, 'settings.json'))).digest('hex'), createHash('sha256').update(sourceBytes).digest('hex'));
    await assert.rejects(access(marker)); assert.equal(model.requests.length, 0);
    steps.push('source-absent-publish-reopen-ordinary-undo');
    await context.writeArtifactJson('mobile-private-credential-roundtrip.json', { passed: true, platform: 'Mobile Web Chromium', jobId, firstOffer, secondOffer,
      receivedOffers: 2, sourcesFromOwnedJob: true, explicitSourceDevice: 'peer-target', noAutomaticReplay: true,
      preparationRecovery: { cacheLoss, status: preparationStatus, runs: 2, prepares: 1, noInventedWorkerFacts: true }, publication, rollback, steps, http, modelRequests: 0 });
  } catch (error) {
    if (jobId) {
      const value = await observer.rpc.request('migration/batch/read', { jobId }).catch(() => null);
      const items = await observer.rpc.request('migration/items', { jobId }).catch(() => null);
      const mcp = await observer.rpc.request('migration/batch/mcp/credential/read', { jobId }).catch(() => null);
      await context.writeArtifactJson('mobile-private-credential-checkpoint.json', { jobId, stage: value?.state?.job.status, sequence: value?.state?.job.sequence,
        workerRunning: value?.workerRunning, workerError: value?.workerError, hasUnconfirmedOutcomes: value?.state?.job.hasUnconfirmedOutcomes,
        unresolvedActions: value?.state?.batch?.unresolvedActions, issues: value?.state?.issues, steps, http,
        committedItems: value?.state?.job.committedItems, batch: value?.state?.batch,
        items: items?.items.map(item => ({ id: item.id, category: item.category, status: item.status, issues: item.issues })),
        planned: items?.planned?.map(item => ({ itemId: item.itemId, targetName: item.targetName, enabled: item.enabled, errorCode: item.errorCode })),
        providerPhases: value?.state?.credentialPlans?.map(plan => ({ itemId: plan.itemId, phase: plan.phase, errorCode: plan.errorCode })),
        mcpPhases: mcp?.plans?.map(plan => ({ itemId: plan.itemId, phase: plan.phase, errorCode: plan.errorCode, fields: plan.fields.length, remaining: plan.remainingFields })),
        ordinaryRequests: observations.filter(row => row.jobId === jobId && ['migration/batch/run', 'migration/batch/read'].includes(row.method)), modelRequests: model.requests.length });
    }
    throw error;
  } finally { releaseRunReply?.(); await page.unroute('**/api/migration/source-transfer/private/**'); await page.unroute('**/api/migration/source-session/query'); await observer.close(); }
}
