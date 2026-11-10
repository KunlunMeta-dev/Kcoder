import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { join } from 'node:path';
import { privatePrefix, privateUntil, readPrivateFixture, windowsPrivateNativeOwner } from './windows-private-credential-native.mjs';
import { privateDiagnostic, privateFinishReceipt, privatePlanCandidates, validatePrivateFixture } from './windows-private-credential-review.mjs';
import { startMigrationNoInferenceFixture, assertNoMigrationInference } from './migration-no-inference.mjs';

import { keyringSaveIntent, keyringNoValues } from './windows-private-keyring-state.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const consent = { apiKeys: true, mcpPrivateFields: true };
const internal = (owner, operation, params = {}) => owner.rpc(privatePrefix + operation, params);
const bound = (requestId, peerRef, params = {}) => ({ requestId, peerRef, ...params });

export async function runPrivateKeyringWrite({ root, binary, environment, owner, audit }) {
  assert.equal(process.platform, 'win32');
  const values = validatePrivateFixture(await readPrivateFixture(join(root, 'private-fixture.json')), owner);
  const cleanup = [], ports = [];
  const model = await startMigrationNoInferenceFixture({ registerPort: (name, port) => ports.push({ name, port }),
    addCleanup: (_label, action) => cleanup.push(action) });
  const natives = windowsPrivateNativeOwner({ root, binary, environment, values });
  let phase = 'setup';
  try {
    const sourceProfile = join(root, 'private-source-profile'), targetProfile = join(root, 'private-target-profile');
    const vendor = join(root, 'private-codex'), empty = join(root, 'empty-claude');
    for (const path of [sourceProfile, targetProfile, vendor, empty]) await mkdir(path);
    await writeFile(join(root, 'empty-overlay.json'), '{}', { flag: 'wx' });
    const baseline = { credential_store: 'keyring', active_provider: 'fixture', providers: { fixture: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', discover_models: false, no_proxy: true,
      context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192,
    } }, mcp_servers: [], mcp_disabled_servers: [] };
    for (const profile of [sourceProfile, targetProfile]) await writeFile(join(profile, 'settings.json'), JSON.stringify(baseline), { flag: 'wx' });
    assert.equal((await audit('--private-admit')).admitted, true);
    const marker = join(root, 'source-tool-must-not-run');
    const tool = join(root, 'never-run-source-tool.ps1');
    await writeFile(tool, `Set-Content -LiteralPath '${marker}' -Value 'invoked'`, { flag: 'wx' });
    const originals = [];
    for (let index = 0; index < 2; index++) {
      const name = index ? 'review.config.toml' : 'config.toml';
      const body = `model='fixture'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://source-${index}.invalid/v1'\nwire_api='responses'\nenv_key='OWNED_WINDOWS_PRIVATE_API_${index}'\n[mcp_servers.notes]\ncommand='${tool}'\n[mcp_servers.notes.env]\nTOKEN='${values[index + 2]}'\n`;
      await writeFile(join(vendor, name), body, { flag: 'wx' }); originals.push({ name, body });
    }
    let source = await natives.start('source', sourceProfile, vendor,
      { OWNED_WINDOWS_PRIVATE_API_0: values[0], OWNED_WINDOWS_PRIVATE_API_1: values[1] });
    let target = await natives.start('target', targetProfile, empty);
    const requestId = randomUUID(), adoptionId = randomUUID();
    const sourceIdentity = await internal(source, 'identity'), targetIdentity = await internal(target, 'identity');
    const descriptor = (identity, name) => ({ authority: identity.authority, targetFingerprint: sha(name), principal: { kind: 'localOs' } });
    const proof = { version: 1, requestId, source: descriptor(sourceIdentity, 'owned-source'), target: descriptor(targetIdentity, 'owned-target') };
    const sourcePeer = await source.accept(requestId, 'source', proof), targetPeer = await target.accept(requestId, 'target', proof);
    const discovered = await source.rpc('migration/discover', { sources: ['codex'] });
    const sources = discovered.sources.filter(row => row.scope === 'user' && row.availableCategories.includes('provider') && row.availableCategories.includes('mcp'));
    assert.equal(sources.length, 2, 'private_windows_source_roster');
    const destination = await internal(target, 'target/grant', bound(requestId, targetPeer));
    const prepared = await internal(source, 'source/prepare', bound(requestId, sourcePeer, {
      destination, selections: sources.map(row => ({ kind: 'configuration', sourceId: row.sourceId })),
    }));
    phase = 'capture';
    await internal(source, 'source/capture', bound(requestId, sourcePeer));
    await privateUntil(() => internal(source, 'source/state', bound(requestId, sourcePeer)), value => {
      assert.ok(!['failed', 'interrupted'].includes(value.capture.status), 'private_windows_capture_failed');
      return value.capture.status === 'ready' && value.state.ready;
    }, 'capture');
    const exported = await internal(source, 'source/manifest', bound(requestId, sourcePeer));
    assert.equal(exported.manifest.entries.length, 2);
    const attemptId = randomUUID();
    assert.equal((await internal(target, 'target/attempt/claim', bound(requestId, targetPeer, {
      attemptId, kind: 'run', callDigest: sha(JSON.stringify({ requestId, selections: sources.map(row => row.sourceId) })), selectionDigest: prepared.selectionDigest,
    }))).admitted, true);
    await internal(target, 'target/begin', bound(requestId, targetPeer, { manifest: exported.manifest }));
    let parts = 0;
    for (const entry of exported.manifest.entries) {
      assert.ok(entry.bytes <= 1024 * 1024, 'private_windows_fixture_byte_budget');
      for (let index = 0; index < Math.ceil(entry.bytes / 131072); index++) {
        const chunk = await internal(source, 'source/chunk', bound(requestId, sourcePeer, { entryId: entry.id, index }));
        const bytes = Buffer.from(chunk.dataBase64, 'base64');
        assert.ok(bytes.length <= 131072); assert.equal(sha(bytes), chunk.sha256);
        for (const value of values) assert.equal(bytes.includes(Buffer.from(value)), false, 'private_windows_ordinary_ir_value');
        await internal(target, 'target/part/write', { ...chunk, peerRef: targetPeer }); parts++;
      }
    }
    phase = 'ordinary_finish';
    const receipt = privateFinishReceipt(await internal(target, 'target/finish', bound(requestId, targetPeer)), requestId, exported.manifestSha256);
    assert.equal((await internal(target, 'target/attempt/release', bound(requestId, targetPeer, { attemptId }))).released, true);
    phase = 'adoption';
    await internal(target, 'target/adoption/prepare', bound(requestId, targetPeer, {
      adoptionId, manifestSha256: receipt.manifestSha256, selections: exported.manifest.entries.map(entry => ({ entryId: entry.id })),
    }));
    const adopted = await privateUntil(() => internal(target, 'target/adoption/read', bound(requestId, targetPeer, { adoptionId })), value => {
      assert.ok(!['failed', 'blocked', 'unknown'].includes(value.state.phase), 'private_windows_adoption_failed');
      return value.state.phase === 'preview_ready' && value.state.workerState === 'stopped';
    }, 'adoption');
    assert.equal(adopted.state.jobs.length, 1); assert.equal(adopted.state.jobs[0].previewReady, true);
    const jobId = adopted.state.jobs[0].jobId;
    const inventory = privatePlanCandidates(await target.rpc('migration/items', { jobId, pageIndex: 0 }));
    const items = inventory.selected;
    const before = await target.rpc('migration/batch/read', { jobId });
    const choices = items.map((item, index) => item.category === 'provider'
      ? { kind: 'provider', itemId: item.id, targetName: `WindowsPrivateProvider${index}`, endpoint: null, model: null,
        contextWindowTokens: 128000, maxOutputTokens: 8192, outputHeadroomTokens: 8192 }
      : { kind: 'mcp', itemId: item.id, targetName: `windows-private-notes-${index}`, cwd: null, enableAfterImport: false });
    phase = 'ordinary_plan';
    const plan = await target.rpc('migration/batch/plan', { jobId, expectedSequence: before.state.job.sequence,
      choices, includeDefaultItems: false, excludedItemIds: [], reuseExisting: false });
    const statusParams = bound(requestId, targetPeer, { jobId });
    const absence = await internal(target, 'target/private/prepare-status', statusParams);
    assert.equal(absence.phase, 'not_started'); assert.equal(absence.offerIds, null);
    const pending = [], digests = Array(4), offers = [randomUUID(), randomUUID()].sort();
    for (const entry of exported.manifest.entries) {
      const candidates = await internal(target, 'target/private/candidates', bound(requestId, targetPeer, {
        manifestSha256: receipt.manifestSha256, entryId: entry.id, pageIndex: 0, jobId, expectedPlanId: plan.batch.planId,
      }));
      assert.equal(candidates.items.length, 2);
      const provider = candidates.items.find(item => item.kind === 'provider');
      const index = /^https:\/\/source-([01])\.invalid\/v1$/.exec(provider.endpoint)?.[1];
      assert.ok(index !== undefined, 'private_keyring_source_mapping');
      const selections = candidates.items.map(item => {
        assert.equal(item.targets.length, 1); const mapped = item.targets[0];
        const position = choices.findIndex(choice => choice.targetName === mapped.targetName);
        assert.ok(position >= 0); digests[position] = sha(values[Number(index) + (item.kind === 'provider' ? 0 : 2)]);
        return item.kind === 'provider' ? { kind: 'provider', source_name: item.sourceName, target_name: mapped.targetName,
          endpoint: item.endpoint, api_format: item.apiFormat, selector: item.selectors[0] }
          : { kind: 'mcp', source_name: item.sourceName, target_name: mapped.targetName,
            definition_sha256: item.definitionSha256, fields: item.fields };
      });
      pending.push({ entry, selections });
    }
    assert.equal(digests.filter(value => typeof value === 'string').length, 4);
    assert.equal(new Set(digests).size, 4, 'private_keyring_source_slots_collapsed');
    const intent = { version: 1, owner, requestId, offers, sourceSha256: digests,
      providerNames: choices.filter(row => row.kind === 'provider').map(row => row.targetName),
      mcpNames: choices.filter(row => row.kind === 'mcp').map(row => row.targetName),
      writeDispatched: false, originalIntent: null, jobId, applyRequestId: randomUUID(), applySequence: null,
      undoRequestId: randomUUID(), undoSequence: null, undoDispatched: false, phase: 'bound' };
    await keyringSaveIntent(root, intent, true);
    assert.equal((await audit('--private-bind')).bound, true);
    // Publish the exact two recipient IDs before any Native OS-keyring write.
    intent.writeDispatched = true; intent.phase = 'receiving'; await keyringSaveIntent(root, intent);
    phase = 'private_receive';
    for (let index = 0; index < pending.length; index++) {
      const { entry, selections } = pending[index], offerId = offers[index];
      const offered = await internal(target, 'target/private/offer', bound(requestId, targetPeer, {
        offerId, manifestSha256: receipt.manifestSha256, entryId: entry.id, selections, consent,
      }));
      assert.equal(offered.offer.context.targetPolicy, 'keyring');
      const sealed = await internal(source, 'source/private/seal', bound(requestId, sourcePeer, { offer: offered.offer, consent }));
      const accepted = await internal(target, 'target/private/accept', bound(requestId, targetPeer, { offerId, envelope: sealed.envelope, consent }));
      assert.equal(accepted.received, true);
    }
    phase = 'private_prepare';
    const firstSequence = plan.job.sequence;
    const prepareId = await target.client.sendWithoutWaitingForResponse(privatePrefix + 'target/private/prepare', bound(requestId, targetPeer,
      { offerId: offers[0], additionalOffers: [offers[1]], jobId, expectedSequence: firstSequence, consent }));
    const discard = await target.client.waitForDiscardedResponse(prepareId, 30000);
    assert.equal(discard.error === undefined, true, 'private_windows_prepare_rejected');
    const originalIntent = await internal(target, 'target/private/prepare-status', statusParams);
    assert.equal(originalIntent.phase, 'prepared'); assert.deepEqual(originalIntent.offerIds, [...offers].sort());
    assert.equal(originalIntent.expectedSequence, firstSequence); assert.deepEqual(originalIntent.consent, consent);
    assert.equal(originalIntent.originalPlanId, plan.batch.planId);
    intent.originalIntent = originalIntent; intent.phase = 'prepared'; await keyringSaveIntent(root, intent);
    for (const [wrong, params] of [[source, bound(requestId, sourcePeer, { jobId })],
      [target, bound(requestId, sourcePeer, { jobId })], [target, bound(randomUUID(), targetPeer, { jobId })]]) {
      const rejected = await wrong.raw(privatePrefix + 'target/private/prepare-status', params);
      assert.equal(rejected.error?.code === -32047, true, 'private_windows_foreign_status_rejected');
      assert.equal(rejected.result === undefined, true);
    }
    assert.deepEqual(await internal(target, 'target/private/prepare-status', statusParams), originalIntent);
    for (const original of originals) assert.equal(await readFile(join(vendor, original.name), 'utf8') === original.body, true, 'private_windows_source_changed');
    await source.stop(); await target.stop();
    const withheld = join(root, 'private-source-withheld'); await rename(vendor, withheld);
    phase = 'target_recovery'; target = await natives.start('target-recovery', targetProfile, empty);
    const recovery = await internal(target, 'peer/recover-target', { requestId });
    const recovered = bound(requestId, recovery.peerRef, { jobId });
    assert.deepEqual(await internal(target, 'target/private/prepare-status', recovered), originalIntent);
    const current = (await target.rpc('migration/batch/read', { jobId })).state;
    intent.applySequence = current.job.sequence; intent.phase = 'apply_dispatched'; await keyringSaveIntent(root, intent);
    phase = 'ordinary_apply';
    await target.rpc('migration/batch/run', { jobId, expectedSequence: current.job.sequence,
      planId: originalIntent.planId, requestId: intent.applyRequestId, mode: 'apply' });
    const published = await privateUntil(() => target.rpc('migration/batch/read', { jobId }), value => !value.workerRunning, 'publication');
    assert.ok(['completed', 'completed_with_issues'].includes(published.state.job.status));
    assert.equal(published.state.job.committedItems, 4); assert.equal(published.state.job.hasUnconfirmedOutcomes, false);
    assert.equal(published.state.batch.unresolvedActions, 0);
    assert.equal(published.state.batch.committedActions, published.state.batch.totalActions);
    const afterPublication = await target.rpc('migration/items', { jobId, pageIndex: 0 });
    for (const selected of items) assert.equal(afterPublication.items.find(item => item.id === selected.id)?.status, 'committed');
    for (const retained of inventory.retained) assert.equal(afterPublication.items.find(item => item.id === retained.id)?.status, retained.status,
      'private_windows_unselected_declaration_changed');
    assert.equal(published.state.credentialPlans.length, 2);
    assert.ok(published.state.credentialPlans.every(plan => plan.phase === 'published'));
    const mcp = await target.rpc('migration/batch/mcp/credential/read', { jobId });
    assert.equal(mcp.plans.length, 2); assert.ok(mcp.plans.every(plan => plan.phase === 'published' && plan.fields.length === 1 && plan.remainingFields === 0));
    const savedText = await readFile(join(targetProfile, 'settings.json'), 'utf8'), saved = JSON.parse(savedText);
    for (const value of values) assert.equal(savedText.includes(value), false, 'private_windows_public_settings_value');
    const privateBytes = await readFile(join(targetProfile, 'credentials.json'));
    for (const value of values) assert.equal(privateBytes.includes(Buffer.from(value)), false, 'private_keyring_private_document_value');
    assert.equal(saved.active_provider, baseline.active_provider);
    for (const choice of choices) if (choice.kind === 'mcp') assert.ok(saved.mcp_disabled_servers.includes(choice.targetName));
    await target.stop();
    await keyringNoValues(targetProfile, values);
    const nativeAudit = await audit('--private-capture');
    assert.equal(nativeAudit.publishedBindingsVerified, true); assert.equal(nativeAudit.referenceCount, 4);
    assert.equal(nativeAudit.recipientCount, 2); assert.equal(nativeAudit.fileBackendUsed, false);
    intent.phase = 'published'; await keyringSaveIntent(root, intent);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    const auditRequests = assertNoMigrationInference(model.requests);
    assert.equal(natives.processes.reduce((sum, row) => sum + row.privatePrepareCalls, 0), 1);
    return { status: 'passed', stage: 'private_bundle_published_pending_independent_logon', forcedKeyring: true,
      entries: 2, offers: 2, publishedReferences: 4, sourceOffline: true, prepareReplyDiscarded: true,
      originalIntentRecovered: true, nativeAudit, privatePrepareCalls: 1, targetFilesAndRpcContainNoOriginalValues: true,
      sourceBytesUnchanged: true,
      retainedItems: inventory.publicRetained, discoveredItems: inventory.discoveredItems, selectedItems: 4,
      processes: natives.processes, modelInferenceRequests: auditRequests.inferenceRequests, oldToolsExecuted: 0 };
  } catch (error) {
    await writeFile(join(root, 'private-diagnostic.json'), JSON.stringify(privateDiagnostic(phase, error)), { flag: 'wx' });
    throw error;
  } finally {
    const results = await Promise.allSettled([natives.close(), ...cleanup.reverse().map(action => action())]);
    assert.ok(results.every(value => value.status === 'fulfilled'), 'private_windows_case_cleanup_failed');
  }
}
