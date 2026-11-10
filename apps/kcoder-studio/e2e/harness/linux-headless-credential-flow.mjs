import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startMigrationNoInferenceFixture, assertNoMigrationInference } from './migration-no-inference.mjs';
import { headlessNativeOwner, verifyHeadlessNative } from './linux-headless-credential-native.mjs';
import { assertHeadlessKeyringRejected, assertHeadlessGroupSettled, assertHeadlessPublic } from './linux-headless-credential-policy.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const names = { provider: 'P3ImportedProvider', mcp: 'P3ImportedMcp' };
async function privateJson(path) {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024, 'headless_private_file_required');
  assert.equal(stat.mode & 0o7777, 0o600, 'headless_private_file_permissions');
  assert.equal(stat.uid, process.getuid(), 'headless_private_file_owner');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function assertNoProfileValues(path, values, state = { files: 0, bytes: 0 }, depth = 0) {
  assert.ok(depth <= 16, 'headless_profile_depth_budget');
  for (const leaf of await readdir(path)) {
    const entry = join(path, leaf), stat = await lstat(entry);
    assert.ok(++state.files <= 1024 && !stat.isSymbolicLink(), 'headless_profile_node_budget');
    if (stat.isDirectory()) { await assertNoProfileValues(entry, values, state, depth + 1); continue; }
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024, 'headless_profile_file_budget');
    state.bytes += stat.size; assert.ok(state.bytes <= 64 * 1024 * 1024, 'headless_profile_byte_budget');
    if (stat.size === 0) continue;
    const bytes = await readFile(entry);
    for (const value of values) assert.equal(bytes.includes(Buffer.from(value)), false, 'headless_profile_private_fallback');
  }
}
async function stopped(owner, jobId) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const result = await owner.rpc('migration/batch/read', { jobId });
    if (!result.workerRunning) return result;
    assert.ok(Date.now() < deadline, 'headless_batch_worker_deadline');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
async function unavailable(owner) {
  const value = await owner.rpc('diagnostics/storage/read');
  assert.equal(value.credentials.keyringAvailable, false, 'headless_real_os_backend_unexpectedly_available');
  assert.equal(value.credentials.keyringBackend, 'Secret Service (gnome-keyring / KWallet) [kcoder]', 'headless_os_backend_required');
  return { realOsBackend: true, keyringAvailable: false, description: value.credentials.keyringBackend };
}
async function scan(owner) {
  const found = await owner.rpc('migration/discover', { sources: ['claude-code'] });
  const sources = found.sources.filter(row => row.scope === 'user' && row.availableCategories.includes('provider') && row.availableCategories.includes('mcp'));
  assert.equal(sources.length, 1, 'headless_explicit_source_roster');
  const scanned = await owner.rpc('migration/batch/scan', { sourceIds: [sources[0].sourceId] });
  const jobId = scanned.job.jobId, items = await owner.rpc('migration/items', { jobId, pageIndex: 0 });
  assert.equal(items.providers.length, 1, 'headless_provider_roster'); assert.equal(items.mcps.length, 1, 'headless_mcp_roster');
  const provider = items.providers[0].itemId, mcp = items.mcps[0].itemId;
  assert.notEqual(provider, mcp); assert.equal(items.items.find(item => item.id === provider)?.category, 'provider');
  assert.equal(items.items.find(item => item.id === mcp)?.category, 'mcp');
  const extras = items.items.filter(item => ![provider, mcp].includes(item.id)).map(item => ({ id: item.id, status: item.status, category: item.category }));
  return { jobId, scanned, extras, params: { jobId, expectedSequence: scanned.job.sequence, choices: [
    { kind: 'provider', itemId: provider, targetName: names.provider, contextWindowTokens: 64000, outputHeadroomTokens: 8192, maxOutputTokens: 8192 },
    { kind: 'mcp', itemId: mcp, targetName: names.mcp, enableAfterImport: false },
  ], credentials: [{ itemId: provider, source: 'configuration', consentApiKey: true }],
  mcpCredentials: [{ itemId: mcp, fields: [{ kind: 'environment', name: 'TOKEN' }], consentPrivateValues: true }] } };
}
function assertMcpReceipt(value, phase) {
  assert.equal(value.plans.length, 1, 'headless_mcp_plan_roster');
  const plan = value.plans[0]; assert.equal(plan.phase, phase); assert.equal(plan.storage, 'file');
  assert.deepEqual(plan.fields, [{ kind: 'environment', name: 'TOKEN' }]);
  return plan;
}
async function assertPublishedFiles(profile, values) {
  const settings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'));
  assertHeadlessPublic(settings, values);
  assert.equal(settings.active_provider, 'fixture'); assert.ok(settings.providers[names.provider]);
  assert.ok(settings.mcp_servers.some(server => server.name === names.mcp));
  assert.ok(settings.mcp_disabled_servers.includes(names.mcp), 'headless_mcp_must_remain_disabled');
  const credentials = await privateJson(join(profile, 'credentials.json'));
  assert.equal(credentials[names.provider]?.key === values[0], true, 'headless_provider_file_value_mismatch');
  const bindings = Object.values(credentials.$kcoder_credential_imports?.mcp_bindings ?? {});
  assert.equal(bindings.length, 1, 'headless_mcp_file_binding_roster');
  assert.equal(JSON.parse(bindings[0]).env.TOKEN === values[1], true, 'headless_distinct_mcp_file_value_mismatch');
}
export async function runLinuxHeadlessCredentials(context, options) {
  assert.equal(options.consent, '1', 'headless_credentials_explicit_gate_required');
  const binary = await verifyHeadlessNative(options.binary, options.sha256);
  const root = context.pathInState('headless-credentials'); await mkdir(root, { mode: 0o700 });
  for (const name of ['home','workspace','claude','empty-codex','xdg-config','xdg-data','xdg-state','xdg-cache','runtime','tmp','keyring-profile','file-profile'])
    await mkdir(join(root, name), { mode: 0o700 });
  const runtime = await context.createOwnedScratchDirectory('linux-headless-dbus', { baseDirectory: await realpath(tmpdir()), requiredBytes: 4096 });
  for (const leaf of ['absent-session-bus.sock','absent-system-bus.sock']) await assert.rejects(access(context.pathInScratch(runtime, leaf)), { code: 'ENOENT' });
  const values = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  assert.notEqual(values[0], values[1]); for (const value of values) context.registerSecret(value);
  const model = await startMigrationNoInferenceFixture(context);
  const baseline = policy => ({ credential_store: policy, active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
    default_model: 'fixture', discover_models: false, no_proxy: true, context_window_tokens: 128000,
    max_output_tokens: 8192, output_headroom_tokens: 8192 } }, mcp_servers: [], mcp_disabled_servers: [] });
  for (const policy of ['keyring','file']) await writeFile(join(root, policy + '-profile', 'settings.json'), JSON.stringify(baseline(policy)), { flag: 'wx', mode: 0o600 });
  await writeFile(join(root, 'overlay.json'), '{}', { flag: 'wx', mode: 0o600 });
  const helper = join(root, 'claude', 'must-not-run.sh'), marker = join(root, 'source-command-must-not-run');
  const script = 'printf invoked > ' + "'" + marker.replaceAll("'", "'\\''") + "'\n";
  await writeFile(helper, script, { flag: 'wx', mode: 0o600 });
  const originalSource = JSON.stringify({ model: 'fixture', env: { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: values[0] },
    mcpServers: { notes: { command: 'sh', args: [helper], env: { TOKEN: values[1] } } } });
  const source = join(root, 'claude', 'settings.json'); await writeFile(source, originalSource, { flag: 'wx', mode: 0o600 });
  const owners = headlessNativeOwner(context, { root, binary: options.binary, values, runtime });
  try {
    const keyring = await owners.start('headless-forced-keyring', join(root, 'keyring-profile'));
    const backend = await unavailable(keyring), forced = await scan(keyring);
    const before = await readFile(join(root, 'keyring-profile', 'settings.json'));
    const rejected = await keyring.raw('migration/batch/plan', forced.params);
    const errorCode = assertHeadlessKeyringRejected(rejected);
    const observed = await keyring.rpc('migration/batch/read', { jobId: forced.jobId });
    assert.equal(observed.state.job.hasUnconfirmedOutcomes, false, 'headless_forced_failure_state_unknown');
    assert.equal(observed.state.batch?.publishedCredentials ?? 0, 0, 'headless_keyring_failure_cannot_publish');
    assert.equal((await readFile(join(root, 'keyring-profile', 'settings.json'))).equals(before), true, 'headless_keyring_failure_settings_changed');
    await assertNoProfileValues(join(root, 'keyring-profile'), values);
    const forcedEvidence = { ...backend, errorCode, jobId: forced.jobId, sequenceBefore: forced.scanned.job.sequence,
      sequenceAfter: observed.state.job.sequence, status: observed.state.job.status, planId: observed.state.batch?.planId ?? null,
      hasUnconfirmedOutcomes: observed.state.job.hasUnconfirmedOutcomes, settingsUnchanged: true, noFilePrivateFallback: true,
      ordinaryRunCalls: keyring.client.methodsSent.filter(method => method === 'migration/batch/run').length };
    assert.equal(forcedEvidence.ordinaryRunCalls, 0); await keyring.close();
    await context.writeArtifactJson('linux-headless-keyring-rejected.json', forcedEvidence);

    let file = await owners.start('headless-explicit-file', join(root, 'file-profile'));
    await unavailable(file); const selected = await scan(file);
    const originalSettings = JSON.parse(await readFile(join(root, 'file-profile', 'settings.json'), 'utf8'));
    const planned = await file.rpc('migration/batch/plan', selected.params);
    assert.equal(planned.batch.atomicCredentials, true); assert.equal(planned.batch.credentialActions, 2);
    assert.equal(planned.credentialPlans.length, 1); assert.equal(planned.credentialPlans[0].storage, 'file');
    assert.equal(planned.credentialPlans[0].phase, 'ready');
    assertMcpReceipt(await file.rpc('migration/batch/mcp/credential/read', { jobId: selected.jobId }), 'ready');
    const intent = { version: 1, jobId: selected.jobId, planId: planned.batch.planId, expectedSequence: planned.job.sequence,
      applyRequestId: randomUUID(), undoRequestId: randomUUID(), policy: 'file', selectedItems: 2, sourceSha256: sha(originalSource) };
    await context.writeStateJson('linux-headless-file-original-intent.json', intent);
    // The submitted UUID is fixed before its single dispatch; only the original job is observed afterward.
    await file.rpc('migration/batch/run', { jobId: intent.jobId, planId: intent.planId, expectedSequence: intent.expectedSequence,
      requestId: intent.applyRequestId, mode: 'apply' });
    const published = assertHeadlessGroupSettled(await stopped(file, intent.jobId));
    assert.equal(published.batch.publishedCredentials, 2); assert.equal(published.job.committedItems, 2);
    assert.equal(published.credentialPlans[0].phase, 'published');
    assertMcpReceipt(await file.rpc('migration/batch/mcp/credential/read', { jobId: intent.jobId }), 'published');
    await assertPublishedFiles(join(root, 'file-profile'), values); await file.close();
    await rename(join(root, 'claude'), join(root, 'original-source-offline'));
    file = await owners.start('headless-file-independent-reopen', join(root, 'file-profile'));
    const reopened = assertHeadlessGroupSettled(await file.rpc('migration/batch/read', { jobId: intent.jobId }));
    assert.equal(reopened.batch.planId, intent.planId); await assertPublishedFiles(join(root, 'file-profile'), values);
    const mcp = assertMcpReceipt(await file.rpc('migration/batch/mcp/credential/read', { jobId: intent.jobId }), 'published');
    assert.equal(mcp.remainingFields, 0);
    const undoIntent = { ...intent, expectedSequence: reopened.job.sequence, mode: 'rollback' };
    await context.writeStateJson('linux-headless-file-undo-intent.json', undoIntent);
    await file.rpc('migration/batch/run', { jobId: intent.jobId, planId: intent.planId, expectedSequence: undoIntent.expectedSequence,
      requestId: intent.undoRequestId, mode: 'rollback' });
    const undone = (await stopped(file, intent.jobId)).state;
    assert.equal(undone.job.status, 'rolled_back'); assert.equal(undone.job.hasUnconfirmedOutcomes, false);
    assert.equal(undone.batch.unresolvedActions, 0); assert.equal(undone.credentialPlans[0].phase, 'undone');
    assertMcpReceipt(await file.rpc('migration/batch/mcp/credential/read', { jobId: intent.jobId }), 'undone');
    assert.deepEqual(JSON.parse(await readFile(join(root, 'file-profile', 'settings.json'), 'utf8')), originalSettings);
    await assertNoProfileValues(join(root, 'file-profile'), values);
    const afterItems = await file.rpc('migration/items', { jobId: intent.jobId, pageIndex: 0 });
    for (const extra of selected.extras) assert.equal(afterItems.items.find(item => item.id === extra.id)?.status, extra.status, 'headless_unselected_row_changed');
    await file.close();
    assert.equal(sha(await readFile(join(root, 'original-source-offline', 'settings.json'))), intent.sourceSha256);
    assert.equal(sha(await readFile(join(root, 'original-source-offline', 'must-not-run.sh'))), sha(script));
    await assert.rejects(access(marker), { code: 'ENOENT' });
    const result = { binary, forcedKeyring: forcedEvidence, explicitFile: { jobId: intent.jobId, planId: intent.planId,
      selectedItems: 2, preservedExtraItems: selected.extras.length, privateReferences: 2, distinctProviderAndMcpValuesVerified: true,
      committedActions: published.batch.committedActions, totalActions: published.batch.totalActions, unresolvedActions: 0,
      providerAndMcpPublished: true, independentReopen: true, sourceOfflineUndo: true, originalGroupUndone: true,
      targetSettingsRestored: true, noValuesAfterUndo: true, mcpRemainedDisabled: true, fileIsNotOsEncryption: true },
      sourceSha256: intent.sourceSha256, sourceHelperSha256: sha(script), sourceUnchanged: true, sourceCommandsExecuted: 0,
      inference: assertNoMigrationInference(model.requests), nativeProcesses: owners.rows, scope: 'same Linux host; real unavailable OS backend, explicit private-file policy; no available vault or cross-host claim' };
    await context.writeArtifactJson('linux-headless-credential-result.json', result); return result;
  } finally { await owners.close(); }
}
