import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import test from 'node:test';
import { windowsStorageUpgradeOldPackage as old, validateWindowsStorageUpgradeOptions, validateWindowsStorageUpgradeReceipt, validateWindowsStorageUpgradeResult } from './windows-storage-upgrade.mjs';
import { validateWindowsInstallerInputs, windowsInstallerFixtureParent, validateWindowsInstallerUpgradeMode } from './windows-installer-lifecycle.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';

const candidate = () => ({ storageUpgrade: true, installer: '/owned/2.0.49.exe', newInstaller: '/owned/candidate.exe', target: 'owned-windows',
  expectedVersion: '2.0.50', expectedCommit: 'a'.repeat(40), expectedInstallerSha256: 'b'.repeat(64), expectedCliSha256: 'c'.repeat(64),
  expectedHostSha256: 'd'.repeat(64), expectedManifestSha256: 'e'.repeat(64) });

test('old/new storage upgrade requires separate external candidate pins before provisioning', () => {
  const options = candidate(); assert.equal(validateWindowsStorageUpgradeOptions(options), old);
  assert.doesNotThrow(() => validateWindowsInstallerInputs(options)); assert.equal(windowsInstallerFixtureParent(options), 'C:\\ProgramData');
  assert.equal(validateWindowsInstallerUpgradeMode(options), false);
  for (const patch of [{ storageOnly: true }, { profileQualificationOnly: true }, { mechanismOnlyUpgrade: true }, { exerciseUI: true },
    { installation: 'C:\\Users\\personal' }, { expectedInstallerSha256: undefined }, { expectedHostSha256: undefined },
    { expectedManifestSha256: undefined }, { expectedVersion: old.expectedVersion }, { expectedVersion: '1.9.99' },
    { expectedCommit: old.expectedCommit }, { expectedNativeCommit: 'not-a-commit' }, { expectedInstallerSha256: old.installerSha256 }, { newInstaller: options.installer }])
    assert.throws(() => validateWindowsStorageUpgradeOptions({ ...options, ...patch }));
  const env = suiteEnvironmentNames('suites/browser/desktop-storage-upgrade.e2e.mjs');
  for (const key of ['KCODER_E2E_WINDOWS_OLD_INSTALLER', 'KCODER_E2E_WINDOWS_NEW_INSTALLER', 'KCODER_E2E_WINDOWS_EXPECTED_INSTALLER_SHA256', 'KCODER_E2E_WINDOWS_EXPECTED_NATIVE_COMMIT']) assert.ok(env.includes(key));
});

test('registered installer upgrade uses only its explicit packages without preparing products', async () => {
  const { prepareSuiteArtifacts } = await import('../run-all.mjs');
  await prepareSuiteArtifacts(['suites/browser/desktop-storage-upgrade.e2e.mjs'], {
    environment: {}, run: async () => assert.fail('Installed acceptance must not build shared products'),
  });
});

test('legacy receipt requires original ID, retained Native root and exact domain destinations', () => {
  const operationId = 'legacy-locations-v1', source = { dataRoot: 'C:\\Users\\owned\\.config\\kcoder', cacheRoot: 'C:\\Users\\owned\\AppData\\Local\\kcoder', sharedRoot: 'C:\\Users\\owned\\AppData\\Roaming\\kcoder-studio' };
  const selected = { ...source, revision: 1, operationId };
  const receipt = { phase: 'verified', disposition: 'complete', plan: { operationId, original: null, from: { layout: 'legacy', dataRoot: source.dataRoot, cacheRoot: win32.join(source.dataRoot, 'tmp') }, components: [
    { domain: 'persistent-root', source: source.dataRoot, destination: source.dataRoot },
    { domain: 'gateway', source: source.sharedRoot, destination: win32.join(source.dataRoot, 'studio/gateway') },
    { domain: 'desktop', source: source.sharedRoot, destination: win32.join(source.dataRoot, 'studio/desktop') },
  ] } };
  assert.equal(validateWindowsStorageUpgradeReceipt(receipt, selected, source, operationId), operationId);
  for (const mutate of [value => { value.phase = 'committed'; }, value => { value.disposition = 'unknown'; }, value => { value.plan.operationId = randomUUID(); },
    value => { value.plan.components[0].destination = 'D:\\other'; }, value => { value.plan.components[1].source = 'C:\\Users\\peer'; }]) {
    const changed = structuredClone(receipt); mutate(changed); assert.throws(() => validateWindowsStorageUpgradeReceipt(changed, selected, source, operationId));
  }
  assert.throws(() => validateWindowsStorageUpgradeReceipt(receipt, { ...selected, operationId: randomUUID() }, source, operationId));
});

test('upgrade verdict cannot adopt a peer SID, old binary or incomplete migration', () => {
  const expected = { ...candidate(), expectedCommit: '2944d8ff9d95922f1bd0536f43f9526a71f35e5c', expectedNativeCommit: 'ee25b18e51505cceab829b275972daeaa2d9658c' }, sid = 'S-1-5-21-1-2-3-1008';
  const observation = { passed: true, observedTurnStarts: 0, modelCalls: 0, normalExit: { code: 0, signal: null } };
  const result = { passed: true, verificationScope: 'installed_old_version_upgrade_and_legacy_startup', versionUpgrade: true, modelCalls: 0, personalBaselineRead: false,
    supervision: { helperClosed: true, exitAuthority: 'original-supervisor-job-empty' },
    steps: ['profileQualification', 'inspect', 'install', 'storageUpgradeSeed', 'install', 'storageUpgradeRead', 'uninstall'].map(action => ({ action, sid, isAdmin: false, ok: true })),
    seed: { ...observation, oldAppDataObserved: true, nativeDefaultObserved: true, draftPersistenceSupported: false },
    restored: { ...observation, actualAutomaticLegacyMigration: true, nativeInPlace: true, oldSourceRetained: true, modelConfigurationRetained: true,
      logicalIdentityRetained: true, originalOriginRetained: true, persistentCookieRetained: true, actualUnsentDraftRetained: null, draftPersistence: 'unsupported-in-old-2.0.49', sourceRetainedAfterQuit: true,
      actualRetainedNativeConfigurationWrite: true, actualUnifiedDesktopWrite: true,
      phase: 'verified', disposition: 'complete', historyRecordsRead: 3,
      buildIdentity: { build_commit: expected.expectedNativeCommit, build_dirty: false, executable_sha256: expected.expectedCliSha256 }, releaseCommit: expected.expectedCommit } };
  result.steps[0].profile = { userInteractive: true };
  Object.assign(result.steps[2], { installedCliVersion: 'kcoder 2.0.49', installedResources: { 'resources\\bin\\kcoder.exe': old.expectedCliSha256 } });
  Object.assign(result.steps[4], { installedCliVersion: 'kcoder 2.0.50', installedResources: { 'resources\\bin\\kcoder.exe': expected.expectedCliSha256 } });
  assert.doesNotThrow(() => validateWindowsStorageUpgradeResult(result, expected));
  for (const mutate of [value => { value.steps[0].profile.userInteractive = false; }, value => { delete value.steps[0].profile.userInteractive; }, value => { value.steps[3].sid = 'peer'; }, value => { value.steps[4].isAdmin = true; }, value => { value.restored.disposition = 'unknown'; },
    value => { value.restored.buildIdentity.executable_sha256 = old.expectedCliSha256; }, value => { value.restored.buildIdentity.build_commit = expected.expectedCommit; },
    value => { value.restored.releaseCommit = expected.expectedNativeCommit; }, value => { delete value.restored.releaseCommit; },
    value => { value.restored.actualUnsentDraftRetained = true; }, value => { value.seed.draftPersistenceSupported = true; },
    value => { value.restored.actualUnifiedDesktopWrite = false; }, value => { value.restored.actualRetainedNativeConfigurationWrite = false; },
    value => { value.restored.observedTurnStarts = 1; }, value => { value.restored.sourceRetainedAfterQuit = false; }]) {
    const changed = structuredClone(result); mutate(changed); assert.throws(() => validateWindowsStorageUpgradeResult(changed, expected));
  }
});
