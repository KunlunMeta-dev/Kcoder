import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CROSS_HOST_CONTENT_CAPABILITIES, CROSS_HOST_CONTENT_VERSION, requireCrossHostContentCapabilities, crossHostContentSelection, validateCrossHostContentEvidence, releaseCrossHostSourceSession, awaitCrossHostReady } from './windows-cross-host-content-contract.mjs';
import { seedCrossHostContentSource, verifyCrossHostContentSource, crossHostWindowsTrustPaths } from './windows-cross-host-content-fixture.mjs';

async function owned(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-cross-host-contents-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('extended content negotiation requires every exact public cap without exposing private owner capabilities', () => {
  const all = Object.fromEntries(Object.values(CROSS_HOST_CONTENT_CAPABILITIES).flat().map(name => [name, true]));
  const result = requireCrossHostContentCapabilities(all); assert.equal(result.selected.length, 5);
  assert.equal(Object.keys(all).some(name => /Private|HPKE/.test(name)), false);
  for (const name of Object.keys(all)) {
    for (const value of [undefined, false, 1, 'true']) assert.throws(() => requireCrossHostContentCapabilities({ ...all, [name]: value }), /UNMET_PREREQUISITE/);
  }
  const old = { ...all }; delete old.migrationInstructionSourcesV1; delete old.migrationSourceTransferInstructionsV1;
  assert.throws(() => requireCrossHostContentCapabilities(old), /migrationInstructionSourcesV1/);
  assert.doesNotThrow(() => requireCrossHostContentCapabilities(old, ['memory', 'definitions']));
  assert.throws(() => requireCrossHostContentCapabilities(all, ['unknown']));
  assert.throws(() => requireCrossHostContentCapabilities(all, ['plugin', 'plugin']));
});

test('memory and passive definition selections retain only the actual opaque Native grant', () => {
  for (const kind of ['memory', 'definitions']) assert.deepEqual(crossHostContentSelection(kind, 'opaque-native-source'), { kind: 'assets', sourceId: 'opaque-native-source' });
  for (const source of ['', 'a'.repeat(257), 'control\nsource']) assert.throws(() => crossHostContentSelection('memory', source));
  assert.throws(() => crossHostContentSelection('configuration', 'opaque-native-source'));
});

test('owned Windows trust records preserve exact roots in the canonical extended path form used by FolderTrustStore', () => {
  const input = ['D:\\owned\\workspace', 'D:\\owned\\source\\instruction-claude'];
  assert.deepEqual(crossHostWindowsTrustPaths(input), ['\\\\?\\D:\\owned\\workspace', '\\\\?\\D:\\owned\\source\\instruction-claude']);
  assert.deepEqual(input, ['D:\\owned\\workspace', 'D:\\owned\\source\\instruction-claude']);
  for (const path of ['relative', '/etc', 'C:drive-relative', 'D:\\owned\nwrong']) assert.throws(() => crossHostWindowsTrustPaths([path]));
});

test('full content evidence cannot count missing classes, Ready alone, unknown publication or a foreign Undo as completion', () => {
  const details = { contentVersion: CROSS_HOST_CONTENT_VERSION, dedicatedAccountIsolationClaim: false, results: ['windows->linux', 'linux->windows'].map(direction => ({ direction,
    contents: ['memory', 'memory', 'definitions', 'definitions', 'instructions', 'instructions', 'plugin', 'private'].map((kind, index) => ({ kind, direction, jobId: `job-${index}`, requestId: `request-${index}`, adoptionId: `adoption-${index}`,
      ...(kind === 'private' ? { publishedReferences: 2, sourceGoneBeforePublication: true, acceptedPreparationReopened: true, ordinaryOwnedUndo: true, targetSettingsRestored: true, keyReleased: true, backendMode: 'file', osKeyringClaim: false }
        : { importedItems: 1, publishedStatus: 'completed_with_issues', sourceAbsentBeforeAdoption: true, reopenedOriginalPlan: true, undoStatus: 'rolled_back', defaultDisabled: true, factsVerified: false, dataOnlyTargetMapping: kind === 'instructions' }) })),
  })) };
  assert.equal(validateCrossHostContentEvidence(details).publishedAndUndoneBatches, 16);
  const mutate = fn => { const value = structuredClone(details); fn(value); assert.throws(() => validateCrossHostContentEvidence(value)); };
  mutate(value => value.results[0].contents.pop());
  mutate(value => value.results[0].contents[0].publishedStatus = 'ready');
  mutate(value => value.results[0].contents[0].reopenedOriginalPlan = false);
  mutate(value => value.results[0].contents[0].undoStatus = 'unknown');
  mutate(value => value.results[0].contents[0].factsVerified = true);
  mutate(value => value.results[0].contents.at(-1).keyReleased = false);
  mutate(value => value.dedicatedAccountIsolationClaim = true);
});

test('pending close observes only its original session and cannot repeat cancellation or invent stopped children', async () => {
  const session = { sessionId: 'owned-original' }, calls = [];
  const values = [{ status: 'released', ownedChildren: 1, launching: false }, { status: 'released', ownedChildren: 0, launching: false }];
  const result = await releaseCrossHostSourceSession({ session,
    call: async (lane, operation, original) => { assert.equal(lane, 'source-session'); assert.equal(original, session); calls.push(operation); return operation === 'close' ? { status: 'pending' } : values.shift(); },
    until: async read => { assert.equal(await read(), false); return read(); } });
  assert.deepEqual(result, { sessionId: session.sessionId, status: 'released' }); assert.deepEqual(calls, ['close', 'read', 'read']);
});

test('a deadline preserves the original read handle and only proven active work gets bounded read-only continuation', async () => {
  const pair = { requestId: 'original' }, calls = [], budgets = [];
  const running = { coordinatorState: 'running', result: { phase: 'capturing', sourceCapture: { status: 'running' } } };
  const ready = { result: { phase: 'ready', receipt: { requestId: pair.requestId } } }; let observations = 0;
  const value = await awaitCrossHostReady({ pair, label: 'active', call: async (lane, method, input) => {
    assert.equal(input, pair); calls.push([lane, method]); return ++observations < 3 ? running : ready;
  }, until: async (poll, label, budget) => { budgets.push(budget); const value = await poll(); if (budgets.length === 1) throw new Error(`Owned cross-host deadline: ${label}`); return value; } });
  assert.equal(value, ready); assert.deepEqual(budgets, [30000, 90000]); assert.deepEqual(calls, Array(3).fill(['source-transfer', 'read']));
  let unknownReads = 0;
  await assert.rejects(awaitCrossHostReady({ pair, label: 'unknown', call: async () => { unknownReads++; return { coordinatorState: 'unknown', result: { phase: 'pending' }, errorCode: 'source_transfer_outcome_unknown' }; },
    until: async poll => { await poll(); throw new Error('Owned cross-host deadline: unknown'); } }), /last observation.*source_transfer_outcome_unknown/);
  assert.equal(unknownReads, 2);
});

test('both synthetic host layouts preserve legacy bytes and contain paged memory, inert definitions, scoped graphs and a disabled package', async t => {
  const root = await owned(t);
  for (const label of ['windows', 'linux']) {
    const source = join(root, label); await mkdir(source);
    await writeFile(join(source, 'settings.json'), 'ORIGINAL_LEGACY_FIXTURE_BYTES');
    const metadata = await seedCrossHostContentSource(source, label, join(root, `${label}-must-not-run`));
    assert.equal(await readFile(join(source, 'settings.json'), 'utf8'), 'ORIGINAL_LEGACY_FIXTURE_BYTES');
    assert.equal(metadata.memoryNoteCount, 12);
    assert.equal(metadata.files.filter(row => row.path.includes('/memory/')).length, 11);
    assert.equal(metadata.passiveDefinitionsOnly, true); assert.equal(metadata.pluginDefaultDisabled, true);
    if (label === 'linux') assert.ok((await lstat(join(source, 'plugins/cache/owned/cross-host-static/1.0.0/skills/inspect/SKILL.md'))).mode & 0o111);
    assert.deepEqual(await readFile(join(source, 'agents/opaque.md')), Buffer.from([255, 0, 254]));
    const manifest = JSON.parse(await readFile(join(source, 'plugins/installed_plugins.json'), 'utf8'));
    assert.equal(manifest.plugins['cross-host-static@owned'][0].scope, 'user');
    assert.ok(manifest.plugins['cross-host-static@owned'][0].installPath.startsWith(source));
    assert.deepEqual(await verifyCrossHostContentSource(source, metadata), { sourceUnchanged: true, verifiedFiles: metadata.files.length });
    assert.equal((await readdir(root)).some(name => name.includes('must-not-run')), false);
  }
});

test('an already populated source cannot be silently reseeded or accepted after bytes change', async t => {
  const root = await owned(t); const source = join(root, 'source'); await mkdir(source);
  const metadata = await seedCrossHostContentSource(source, 'linux', join(root, 'marker'));
  await assert.rejects(seedCrossHostContentSource(source, 'linux', join(root, 'marker')), { code: 'EEXIST' });
  await writeFile(join(source, metadata.files[0].path), 'different source');
  await assert.rejects(verifyCrossHostContentSource(source, metadata), /owned source bytes changed/);
});

test('a linked source ancestor cannot make fixture writes escape their owned root', { skip: process.platform === 'win32' ? 'Requires a supported native Windows link fixture; not inferred from Linux' : false }, async t => {
  const root = await owned(t), source = join(root, 'source'), outside = join(root, 'outside');
  await mkdir(source); await mkdir(outside); await symlink(outside, join(source, 'projects'));
  await assert.rejects(seedCrossHostContentSource(source, 'linux', join(root, 'marker')), /ordinary source directory/);
  assert.deepEqual(await readdir(outside), []);
});
