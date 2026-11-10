import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32 as path } from 'node:path';
import { suiteEnvironmentNames, selectSuites } from './runner-options.mjs';
import { registeredSuites } from '../suite-registry.mjs';
import { prepareSuiteArtifacts } from '../run-all.mjs';
import { cleanupWindowsReadConsumerPaths, prepareWindowsReadConsumerPaths, windowsReadConsumerSelections, windowsReadConsumerRunSelection, windowsReadPathPlan } from './windows-read-consumers.mjs';
const owner = '11111111-1111-4111-8111-111111111111', root = `D:\\kcoder-package-${owner}`;
test('fixed rosters select exactly two Tools consumers and one Engine consumer without wildcard or ignored cases', () => {
  const tools = windowsReadConsumerSelections('tools'), engine = windowsReadConsumerSelections('engine');
  assert.equal(tools.length, 2); assert.equal(engine.length, 1);
  assert.equal(engine[0].exactTest, 'tests::imported_instruction_scopes_order_native_dedup_and_trusted_actual_read_are_frozen');
  assert.equal(new Set([...tools, ...engine].map(row => row.exactTest)).size, 3);
  for (const row of [...tools, ...engine]) assert.deepEqual(row.expectedTests, [row.exactTest]);
  assert.throws(() => windowsReadConsumerSelections('all'));
});
test('long path/case and UNC plans remain inside the original owned root and never accept another host', () => {
  const long = windowsReadPathPlan(root, 'long-case'); assert.ok(long.local.length > 300); assert.notEqual(long.local, long.temporary); assert.equal(long.local.toLowerCase(), long.temporary);
  assert.deepEqual(windowsReadPathPlan(root, 'unc'), { local: `${root}\\temporary`, temporary: `\\\\localhost\\D$\\kcoder-package-${owner}\\temporary` });
  for (const candidate of ['C:\\Users\\personal', '\\\\peer\\share', root + '\\..', root + ':stream']) assert.throws(() => windowsReadPathPlan(candidate, 'unc'));
});
function fixture({ inaccessible = false, wrongIdentity = false, unavailableIdentity = false } = {}) {
  const data = new Map([[path.join(root, '.owner.json').toLowerCase(), JSON.stringify({ owner })]]);
  let writes = 0, removals = 0, directoryCreated = false;
  const removed = new Set();
  const stat = file => ({ dev: 1, ino: unavailableIdentity ? 0 : wrongIdentity && file.startsWith('d:') ? 8 : 7, nlink: 1, isDirectory: () => !file.endsWith('.txt'), isFile: () => file.endsWith('.txt'), isSymbolicLink: () => false });
  const local = file => file.replace(/^\\\\localhost\\D\$/i, 'D:').toLowerCase();
  const fs = { mkdir: async () => { directoryCreated = true; }, lstat: async file => { if ((!directoryCreated && file.endsWith('P1-资料-CaseIdentity')) || removed.has(local(file))) throw Object.assign(Error('owned absence'), { code: 'ENOENT' }); return stat(file); },
    readFile: async file => { if (inaccessible && file.startsWith('\\\\')) throw Object.assign(Error('must not expose backend detail'), { code: 'EACCES' }); return data.get(local(file)); },
    writeFile: async (file, value, options) => { assert.equal(options.flag, 'wx'); assert.ok(!data.has(local(file))); data.set(local(file), value); writes++; },
    rm: async (file, options) => { assert.deepEqual(options, { recursive: true, force: false }); removed.add(local(file)); removals++; } };
  return { fs, writes: () => writes, removals: () => removals };
}
test('ordinary and long-case preparation verify the original owner and actual alias identities before Native execution', async () => {
  for (const mode of ['baseline', 'long-case', 'unc']) {
    const f = fixture(), result = await prepareWindowsReadConsumerPaths({ root, owner, mode, fs: f.fs });
    assert.equal(result.ready, true); assert.equal(result.sameNativeLeaf, true); assert.equal(result.shareCreated, false); assert.equal(f.writes(), 1);
  }
});
test('unavailable loopback share stays an explicit prerequisite and exposes no arbitrary error text', async () => {
  const f = fixture({ inaccessible: true }), result = await prepareWindowsReadConsumerPaths({ root, owner, mode: 'unc', fs: f.fs });
  assert.deepEqual(result, { ready: false, mode: 'unc', errorCode: 'owned_unc_unavailable', platformCode: 'EACCES', localRootRetained: true }); assert.equal(f.writes(), 0);
});
test('a different physical case-alias directory fails before creating a marker or running any test', async () => {
  const f = fixture({ wrongIdentity: true }); await assert.rejects(prepareWindowsReadConsumerPaths({ root, owner, mode: 'long-case', fs: f.fs }), /original native directory identity/); assert.equal(f.writes(), 0);
});
test('long-path cleanup requires the original capability, unchanged owner and confirmed Native Job exit', async () => {
  const f = fixture(), prepared = await prepareWindowsReadConsumerPaths({ root, owner, mode: 'long-case', fs: f.fs });
  await assert.rejects(cleanupWindowsReadConsumerPaths(prepared, false), /unknown Native owners/); assert.equal(f.removals(), 0);
  await assert.rejects(cleanupWindowsReadConsumerPaths({ ...prepared }, true), /original prepared/); assert.equal(f.removals(), 0);
  assert.deepEqual(await cleanupWindowsReadConsumerPaths(prepared, true), { originalOwnerVerified: true, nativeOwnerStopped: true, longSubtreeRemoved: true }); assert.equal(f.removals(), 1);
});

test('the registered read subscopes require an explicit mode and keep every exact libtest separate', () => {
  for (const [scope, count] of [['read-tools', 2], ['read-engine', 1]]) for (const mode of ['baseline', 'long-case', 'unc']) {
    const selected = windowsReadConsumerRunSelection(scope, mode);
    assert.equal(selected.selections.length, count); assert.deepEqual(selected.pathFixture, { scope: scope.slice(5), mode });
    assert.equal(new Set(selected.selections.map(row => row.exactTest)).size, count);
  }
  for (const mode of [undefined, '', 'all', 'network-host']) assert.throws(() => windowsReadConsumerRunSelection('read-tools', mode));
  for (const scope of ['tools', 'private-credentials', 'cross-host-source']) assert.throws(() => windowsReadConsumerRunSelection(scope, 'baseline'));
});

test('missing Native file identity is a failed prerequisite before any case-path or marker write', async () => {
  const f = fixture({ unavailableIdentity: true });
  await assert.rejects(prepareWindowsReadConsumerPaths({ root, owner, mode: 'long-case', fs: f.fs }), /identity is unavailable/);
  assert.equal(f.writes(), 0); assert.equal(f.removals(), 0);
});

test('read preparation stays on the existing registered native entry without rebuilding a binary or enabling unrelated scopes', async () => {
  const suite = 'suites/gateway/windows-archive-retention.e2e.mjs';
  assert.deepEqual(selectSuites(registeredSuites, ['--suite', 'windows-archive-retention']), [suite]);
  await prepareSuiteArtifacts([suite], { run: () => assert.fail('only Root-frozen PE inputs may execute; no preparation build') });
  for (const scope of ['read-tools', 'read-engine']) {
    const names = suiteEnvironmentNames(suite, { KCODER_E2E_WINDOWS_RETENTION_SCOPE: scope });
    assert.ok(names.includes('KCODER_E2E_WINDOWS_READ_PATH_MODE'));
    assert.equal(names.includes('KCODER_E2E_WINDOWS_NATIVE_RUST_MIN_STACK'), false);
  }
});
