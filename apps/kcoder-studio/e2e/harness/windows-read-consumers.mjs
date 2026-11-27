import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { win32 as path } from 'node:path';

const roster = {
  tools: ['file::read_access::tests::actual_read_evidence_cannot_survive_replaced_file_or_parent', 'file::read_access::tests::failed_or_oversized_reads_and_hardlinks_do_not_produce_activation_authority'],
  engine: ['tests::imported_instruction_scopes_order_native_dedup_and_trusted_actual_read_are_frozen'],
};
export const WINDOWS_READ_PATH_MODES = Object.freeze(['baseline', 'long-case', 'unc']);
export function windowsReadConsumerSelections(scope) {
  assert.ok(Object.hasOwn(roster, scope), 'Choose the fixed read-consumer crate roster');
  return roster[scope].map((name, index) => ({ slug: `${scope}-${index + 1}`, exactTest: name, expectedTests: [name] }));
}
/** These cases are explicit subscopes of the existing registered Native runner. */
export function windowsReadConsumerRunSelection(scope, mode) {
  const crate = { 'read-tools': 'tools', 'read-engine': 'engine' }[scope];
  assert.ok(crate, 'Choose read-tools or read-engine');
  assert.ok(WINDOWS_READ_PATH_MODES.includes(mode), 'Explicit baseline, long-case or unc mode is required');
  return { pathFixture: { scope: crate, mode }, selections: windowsReadConsumerSelections(crate) };
}
/** Every spelling is derived from the original run-owned local root, never a supplied UNC host. */
export function windowsReadPathPlan(root, mode) {
  assert.match(root, /^[D-Zd-z]:\\kcoder-package-[a-f0-9-]{36}$/);
  assert.ok(WINDOWS_READ_PATH_MODES.includes(mode));
  const ordinary = path.join(root, 'temporary');
  if (mode === 'baseline') return { local: ordinary, temporary: ordinary };
  if (mode === 'unc') return { local: ordinary, temporary: `\\\\localhost\\${root[0].toUpperCase()}$${ordinary.slice(2)}` };
  const local = path.join(root, 'P1-资料-CaseIdentity', ...Array.from({ length: 6 }, (_, index) => `Part${index}-` + 'MixedCase'.repeat(6)));
  assert.ok(local.length > 300 && local.split('\\').every(part => part.length <= 255));
  return { local, temporary: local.toLowerCase() };
}
const observedIdentity = value => {
  assert.ok(BigInt(value.ino) > 0n, 'Native path identity is unavailable');
  return value;
};
const sameIdentity = (a, b) => observedIdentity(a).dev === observedIdentity(b).dev && a.ino === b.ino;
const safeCode = code => ['EACCES', 'EPERM', 'ENOENT', 'ENOTSUP', 'EINVAL', 'UNKNOWN'].includes(code) ? code : 'UNKNOWN';
const cleanupCapabilities = new WeakMap();

/** Preparation touches only this root. Unavailable loopback D$ is an unmet prerequisite, not a pass. */
export async function prepareWindowsReadConsumerPaths({ root, owner, mode, fs = filesystem }) {
  assert.match(owner, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.ok(root.endsWith(`kcoder-package-${owner}`));
  const plan = windowsReadPathPlan(root, mode), ownerPath = path.join(root, '.owner.json');
  const authority = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  assert.equal(authority.owner, owner, 'Original Windows fixture owner is required');
  const rootStat = observedIdentity(await fs.lstat(root, { bigint: true })); assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const result = {}, subtree = mode === 'long-case' ? path.join(root, 'P1-资料-CaseIdentity') : null;
  if (subtree) {
    let absent = false;
    try { await fs.lstat(subtree, { bigint: true }); } catch (error) { if (error?.code === 'ENOENT') absent = true; else throw error; }
    assert.equal(absent, true, 'An existing long-path subtree cannot be adopted');
    await fs.mkdir(subtree, { recursive: false });
  }
  cleanupCapabilities.set(result, { root, owner, rootIdentity: rootStat, subtree, subtreeIdentity: subtree ? await fs.lstat(subtree, { bigint: true }) : null, fs });
  try {
    await fs.mkdir(plan.local, { recursive: true });
    const original = await fs.lstat(plan.local, { bigint: true }); assert.ok(original.isDirectory() && !original.isSymbolicLink());
    if (mode === 'unc') {
      try {
        const observed = JSON.parse(await fs.readFile(path.join(plan.temporary, '..', '.owner.json'), 'utf8'));
        assert.equal(observed.owner, owner, 'UNC may address only the original run-owned root');
      } catch (error) {
        if (error?.code) return { ready: false, mode, errorCode: 'owned_unc_unavailable', platformCode: safeCode(error.code), localRootRetained: true };
        throw error;
      }
    }
    let alias;
    try { alias = await fs.lstat(plan.temporary, { bigint: true }); }
    catch (error) {
      if (mode === 'unc') return { ready: false, mode, errorCode: 'owned_unc_unavailable', platformCode: safeCode(error?.code), localRootRetained: true };
      throw error;
    }
    assert.ok(alias.isDirectory() && !alias.isSymbolicLink());
    assert.ok(sameIdentity(original, alias), 'Alias must resolve to the original native directory identity');
    const marker = path.join(plan.local, `CaseProof-${owner}.txt`), bytes = `owned-read-consumer:${owner}`;
    await fs.writeFile(marker, bytes, { flag: 'wx' });
    const aliasMarker = path.join(plan.temporary, path.basename(marker));
    assert.equal(await fs.readFile(aliasMarker, 'utf8'), bytes);
    const before = await fs.lstat(marker, { bigint: true }), after = await fs.lstat(aliasMarker, { bigint: true });
    assert.ok(before.isFile() && after.isFile() && BigInt(before.nlink) === 1n && BigInt(after.nlink) === 1n && sameIdentity(before, after));
    Object.assign(result, { ready: true, mode, temporary: plan.temporary, characterLength: plan.temporary.length,
      longPath: mode === 'long-case', distinctCaseSpelling: mode === 'long-case' && plan.local !== plan.temporary,
      sameNativeDirectory: true, sameNativeLeaf: true, originalOwnerVerified: true,
      loopbackExistingShare: mode === 'unc', shareCreated: false, policyChanged: false });
    return result;
  } catch (error) {
    // Native execution starts only after preparation returns its capability.
    await cleanupWindowsReadConsumerPaths(result, true);
    throw error;
  }
}

/** The caller must first observe the supervised Native owner and its complete Job exit. */
export async function cleanupWindowsReadConsumerPaths(result, ownerStopped) {
  assert.equal(ownerStopped, true, 'Live or unknown Native owners retain their original paths');
  const cap = cleanupCapabilities.get(result); assert.ok(cap, 'Only the original prepared path capability can be cleaned');
  const { fs, root, owner, rootIdentity, subtree, subtreeIdentity } = cap;
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.owner.json'), 'utf8')).owner, owner);
  assert.ok(sameIdentity(rootIdentity, await fs.lstat(root, { bigint: true })), 'Original fixture root was replaced');
  if (subtree) {
    assert.ok(sameIdentity(subtreeIdentity, await fs.lstat(subtree, { bigint: true })), 'Original long-path subtree was replaced');
    // Node handles extended Windows paths; legacy PowerShell Directory.Delete may not.
    await fs.rm(subtree, { recursive: true, force: false });
    let absent = false;
    try { await fs.lstat(subtree, { bigint: true }); } catch (error) { if (error?.code === 'ENOENT') absent = true; else throw error; }
    assert.equal(absent, true, 'Original long-path subtree survived');
  }
  cleanupCapabilities.delete(result);
  return { originalOwnerVerified: true, nativeOwnerStopped: true, longSubtreeRemoved: subtree !== null };
}
