import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, lstat, open, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function assertKeyringSamePreparation(actual, original) {
  const fields = ['requestId', 'jobId', 'sequence', 'phase', 'originalPlanId', 'planId', 'offerIds', 'expectedSequence', 'consent'];
  for (const value of [actual, original]) {
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
    assert.equal(value.phase, 'prepared');
    assert.ok(Number.isSafeInteger(value.sequence) && value.sequence >= 0);
  }
  const { sequence: observed, ...intent } = actual;
  const { sequence: earlier, ...expected } = original;
  assert.deepEqual(intent, expected, 'private_keyring_original_preparation_changed');
  assert.ok(observed >= earlier, 'private_keyring_observed_sequence_regressed');
}

export async function keyringJson(path, limit = 131072) {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit);
  return JSON.parse(await readFile(path, 'utf8'));
}
export function validateKeyringIntent(value, owner) {
  assert.equal(value.version, 1); assert.equal(value.owner, owner);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  for (const name of ['owner', 'requestId', 'applyRequestId', 'undoRequestId']) assert.match(value[name], uuid);
  assert.equal(value.offers.length, 2); for (const offer of value.offers) assert.match(offer, uuid);
  assert.ok(value.offers[0] < value.offers[1]);
  assert.equal(new Set([value.requestId, value.applyRequestId, value.undoRequestId, ...value.offers]).size, 5);
  assert.equal(value.sourceSha256.length, 4); for (const hash of value.sourceSha256) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(new Set(value.sourceSha256).size, 4);
  assert.deepEqual(value.providerNames, ['WindowsPrivateProvider0', 'WindowsPrivateProvider1']);
  assert.deepEqual(value.mcpNames, ['windows-private-notes-2', 'windows-private-notes-3']);
  assert.equal(typeof value.writeDispatched, 'boolean'); assert.equal(typeof value.undoDispatched, 'boolean');
  for (const name of ['applySequence', 'undoSequence']) assert.ok(value[name] === null || (Number.isSafeInteger(value[name]) && value[name] >= 0));
  assert.ok(['bound', 'receiving', 'prepared', 'apply_dispatched', 'published', 'undo_dispatched', 'undone', 'released'].includes(value.phase));
  assert.match(value.jobId, /^mig-[a-f0-9]{32}$/);
  if (value.originalIntent !== null) {
    const receipt = value.originalIntent;
    assert.equal(receipt.phase, 'prepared'); assert.equal(receipt.requestId, value.requestId); assert.equal(receipt.jobId, value.jobId);
    assert.deepEqual(receipt.offerIds, value.offers); assert.deepEqual(receipt.consent, { apiKeys: true, mcpPrivateFields: true });
    assert.ok(Number.isSafeInteger(receipt.expectedSequence) && receipt.expectedSequence >= 0);
    for (const name of ['originalPlanId', 'planId']) assert.ok(typeof receipt[name] === 'string' && receipt[name].length > 0);
  }
  return value;
}
export async function keyringSaveIntent(root, value, fresh = false) {
  validateKeyringIntent(value, value.owner);
  const path = join(root, 'private-keyring-intent.json');
  if (fresh) await assert.rejects(lstat(path), { code: 'ENOENT' });
  else {
    const original = validateKeyringIntent(await keyringJson(path), value.owner);
    for (const name of ['requestId', 'offers', 'sourceSha256', 'providerNames', 'mcpNames', 'jobId', 'applyRequestId', 'undoRequestId'])
      assert.deepEqual(value[name], original[name], 'private_keyring_original_intent_changed');
    for (const name of ['applySequence', 'undoSequence']) if (original[name] !== null) assert.equal(value[name], original[name], 'private_keyring_original_cas_changed');
    if (original.originalIntent !== null) assert.deepEqual(value.originalIntent, original.originalIntent, 'private_keyring_original_preparation_changed');
    assert.ok(!original.writeDispatched || value.writeDispatched); assert.ok(!original.undoDispatched || value.undoDispatched);
    const phases = ['bound', 'receiving', 'prepared', 'apply_dispatched', 'published', 'undo_dispatched', 'undone', 'released'];
    assert.ok(phases.indexOf(value.phase) >= phases.indexOf(original.phase), 'private_keyring_phase_regressed');
  }
  const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx');
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}

export async function keyringNoValues(path, values, state = { nodes: 0, bytes: 0 }, depth = 0) {
  assert.ok(depth <= 16);
  for (const name of await readdir(path)) {
    assert.ok(++state.nodes <= 1024);
    assert.ok(!['private-key.bin', '.private-key.retired'].includes(name), 'private_keyring_file_key_fallback');
    const leaf = join(path, name), stat = await lstat(leaf);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) { await keyringNoValues(leaf, values, state, depth + 1); continue; }
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024);
    state.bytes += stat.size; assert.ok(state.bytes <= 64 * 1024 * 1024);
    if (stat.size === 0) continue; // Empty held coordination locks cannot contain a fixture value.
    const bytes = await readFile(leaf);
    for (const value of values) assert.equal(bytes.includes(Buffer.from(value)), false, 'private_keyring_profile_plaintext');
  }
}
