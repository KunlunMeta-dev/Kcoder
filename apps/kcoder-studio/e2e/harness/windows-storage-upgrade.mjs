import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { prepareWindowsStorageHistory, seedWindowsStorageClientState, modelConfigurationSnapshot, rpcClient, attachmentBytes } from './windows-storage-relocation.mjs';

// The retained public installer is an old input, never the candidate under test.
export const windowsStorageUpgradeOldPackage = Object.freeze({
  expectedVersion: '2.0.49', expectedCommit: '77bd021f78ee30ee7bbee13f1bddf899685523d1',
  installerSha256: 'e96636ff92a18af610aa7fa32bb12ff337b57e59791df91826e5893abc07d035',
  expectedHostSha256: '4c4049a1a934f4d6b7583d2d587a861b620698de9aa711d2c2737ac746eb1c26',
  expectedCliSha256: '57049277c63018992e5acef9015833821cfcaaae2610cf01f4aa118ccd1a44da',
  expectedManifestSha256: '527935a467863301b8b4a2a7d725270a3bfc680041096bc28bac371a88fb38dc',
});

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stateLeaf = 'windows-storage-upgrade-private.json';
const same = (left, right) => win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
const absent = path => assert.rejects(lstat(path), { code: 'ENOENT' });

export function validateWindowsStorageUpgradeOptions(options) {
  assert.equal(options.storageUpgrade, true);
  for (const key of ['storageOnly', 'profileQualificationOnly', 'exerciseUI', 'mechanismOnlyUpgrade', 'nativeComponentsProbe', 'nativeWebSearch'])
    assert.ok(!options[key], 'Storage upgrade must use its own model-independent normal-logon lane');
  assert.equal(options.installation, undefined, 'Storage upgrade cannot inspect a personal baseline');
  assert.ok(options.installer?.endsWith('.exe') && options.newInstaller?.endsWith('.exe'));
  assert.notEqual(options.installer, options.newInstaller, 'Two explicit installer paths are required');
  for (const key of ['expectedInstallerSha256', 'expectedHostSha256', 'expectedCliSha256', 'expectedManifestSha256'])
    assert.match(options[key] ?? '', /^[a-f0-9]{64}$/, 'Candidate must have external package pins');
  assert.match(options.expectedCommit ?? '', /^[a-f0-9]{40}$/);
  if (options.expectedNativeCommit !== undefined) assert.match(options.expectedNativeCommit, /^[a-f0-9]{40}$/);
  assert.match(options.expectedVersion ?? '', /^\d+\.\d+\.\d+$/);
  const old = windowsStorageUpgradeOldPackage.expectedVersion.split('.').map(Number), next = options.expectedVersion.split('.').map(Number);
  assert.ok(next.some((value, index) => value > old[index] && next.slice(0, index).every((part, before) => part === old[before])), 'Candidate version must be newer than the retained old package');
  assert.notEqual(options.expectedCommit, windowsStorageUpgradeOldPackage.expectedCommit);
  assert.notEqual(options.expectedInstallerSha256, windowsStorageUpgradeOldPackage.installerSha256);
  return windowsStorageUpgradeOldPackage;
}

export function validateWindowsStorageUpgradeReceipt(receipt, selected, source, originalId) {
  assert.equal(originalId, 'legacy-locations-v1', 'Known-layout startup retains its documented original operation');
  assert.equal(receipt.plan.operationId, originalId); assert.equal(selected.operationId, originalId);
  assert.equal(receipt.phase, 'verified'); assert.equal(receipt.disposition, 'complete');
  assert.equal(receipt.errorCode, undefined); assert.equal(receipt.plan.original, null);
  assert.equal(receipt.plan.from.layout, 'legacy'); assert.equal(selected.revision, 1);
  assert.ok(same(receipt.plan.from.dataRoot, source.dataRoot));
  assert.ok(same(receipt.plan.from.cacheRoot, win32.join(source.dataRoot, 'tmp')));
  assert.ok(same(selected.dataRoot, source.dataRoot)); assert.ok(same(selected.cacheRoot, source.cacheRoot));
  assert.deepEqual(receipt.plan.components.map(({ domain, source: path, destination }) => ({ domain, source: path, destination })), [
    { domain: 'persistent-root', source: source.dataRoot, destination: source.dataRoot },
    { domain: 'gateway', source: source.sharedRoot, destination: win32.join(source.dataRoot, 'studio/gateway') },
    { domain: 'desktop', source: source.sharedRoot, destination: win32.join(source.dataRoot, 'studio/desktop') },
  ]);
  return originalId;
}

/** Runs inside the already qualified ordinary actor; no account or launch mechanism. */
export async function prepareWindowsStorageUpgrade({ request, root, profile, identity, workspace, env, execute }) {
  assert.equal(request.storageUpgrade, true); assert.equal(profile.sid, request.sid);
  assert.equal(profile.realOsProfile, true); assert.equal(profile.environmentOverridden, false); assert.equal(profile.isAdmin, false); assert.equal(profile.userInteractive, true);
  const seed = request.action === 'storageUpgradeSeed'; assert.ok(seed || request.action === 'storageUpgradeRead');
  const source = { dataRoot: join(profile.userProfile, '.config/kcoder'), cacheRoot: join(profile.localAppData, 'kcoder'),
    sharedRoot: join(profile.roamingAppData, 'kcoder-studio') };
  const location = join(profile.userProfile, '.config/kcoder-storage.json'), migrations = join(profile.userProfile, '.config/kcoder-storage-migrations');
  if (seed) {
    for (const path of [location, migrations, source.dataRoot, source.sharedRoot]) await absent(path);
    await prepareWindowsStorageHistory({ request, profile, workspace });
    const input = join(root, 'storage-upgrade-empty-provider-settings.json');
    await writeFile(input, JSON.stringify({ providers: {}, max_retries: 2 }), { flag: 'wx', mode: 0o600 });
    await execute(identity.nativePath, ['config', 'import', '--file', input, '--scope', 'user'], { cwd: workspace, env, timeout: 30000, windowsHide: true });
    await absent(location);
  } else {
    const state = JSON.parse(await readFile(join(root, stateLeaf), 'utf8'));
    assert.equal(state.owner, request.owner); assert.equal(state.sid, request.sid); assert.equal(state.originalNormalQuit, true);
    assert.deepEqual(state.source, source); await absent(location);
    for (const [path, expected] of Object.entries(state.stoppedFiles)) assert.equal(sha(await readFile(path)), expected, 'Stopped old input changed before the candidate startup');
  }
  return { seed, ...source, expectedUserData: seed ? source.sharedRoot : join(source.dataRoot, 'studio/desktop'), location, migrations };
}

export async function seedWindowsStorageUpgrade(flow) {
  const { request, root, profile, actualUserData } = flow;
  const source = { dataRoot: join(profile.userProfile, '.config/kcoder'), cacheRoot: join(profile.localAppData, 'kcoder'), sharedRoot: join(profile.roamingAppData, 'kcoder-studio') };
  assert.ok(same(actualUserData, source.sharedRoot));
  await absent(join(profile.userProfile, '.config/kcoder-storage.json'));
  const state = await seedWindowsStorageClientState(flow, { source, target: source, profileIdentityFile: null, persistedDraft: false });
  Object.assign(state, { sid: request.sid, oldCommit: request.expectedCommit, oldVersion: request.expectedVersion });
  await writeFile(join(root, stateLeaf), JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  return { passed: true, verificationScope: 'old_installed_storage_seed', actualOldInstalledElectron: true, originalOrigin: state.origin,
    nativeDefaultObserved: true, oldAppDataObserved: true, historyRecordsImported: 3, historicalAttachmentSha256: state.attachment.sha256,
    actualUnsentDraft: true, draftPersistenceSupported: false, persistentCookieCreated: true, modelCalls: 0 };
}

export async function verifyWindowsStorageUpgrade(flow) {
  const { request, root, profile, renderer, evaluate, actualUserData, execute, identity, workspace, env } = flow;
  const state = JSON.parse(await readFile(join(root, stateLeaf), 'utf8')); assert.equal(state.owner, request.owner); assert.equal(state.sid, request.sid);
  const migrations = join(profile.userProfile, '.config/kcoder-storage-migrations');
  const originalId = JSON.parse(await readFile(join(migrations, 'current.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(join(migrations, originalId, 'receipt.json'), 'utf8'));
  const selected = JSON.parse(await readFile(join(profile.userProfile, '.config/kcoder-storage.json'), 'utf8'));
  const operationId = validateWindowsStorageUpgradeReceipt(receipt, selected, state.source, originalId);
  assert.equal(receipt.plan.components[0].sourceIdentity, state.nativeProfileIdentity, 'Legacy Native root retains its actual old physical seed');
  await absent(join(state.source.dataRoot, '.profile-identity.json'));
  assert.ok(same(actualUserData, join(selected.dataRoot, 'studio/desktop')));
  const rpc = await rpcClient(flow); assert.equal(sha(JSON.stringify(modelConfigurationSnapshot(await rpc('runtime.providers.list', {})))), state.providersSha256);
  assert.equal((await rpc('migration/history/transcript', { jobId: request.owner })).items.length, 3);
  assert.deepEqual(await attachmentBytes(rpc, state.selection), state.attachment);
  assert.equal(await evaluate(renderer, 'location.origin'), state.origin);
  assert.equal((await renderer.request('Network.getCookies', { urls: [state.origin] })).cookies.find(cookie => cookie.name === state.cookieName)?.value, request.owner);
  assert.equal(state.persistedDraft, false); assert.equal(state.draftState, null);
  for (const [path, expected] of Object.entries(state.stoppedFiles)) assert.equal(sha(await readFile(path)), expected, 'Automatic migration must retain old Native and shared source bytes');
  for (const leaf of ['servers.json']) assert.equal(sha(await readFile(join(selected.dataRoot, 'studio/gateway', leaf))), state.stoppedFiles[join(state.source.sharedRoot, leaf)]);
  assert.equal(sha(await readFile(join(selected.dataRoot, 'studio/desktop/gateway-port'))), state.stoppedFiles[join(state.source.sharedRoot, 'gateway-port')]);
  const settingsPath = join(selected.dataRoot, 'settings.json'), next = JSON.parse(await readFile(settingsPath, 'utf8'));
  const previousProviders = next.providers; next.max_retries = next.max_retries === 1 ? 2 : 1;
  const input = join(root, 'storage-upgrade-new-write-settings.json');
  await writeFile(input, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
  await execute(identity.nativePath, ['config', 'import', '--file', input, '--scope', 'user'], { cwd: workspace, env, timeout: 30000, windowsHide: true });
  const written = await readFile(settingsPath), current = JSON.parse(written);
  assert.equal(current.max_retries, next.max_retries); assert.deepEqual(current.providers, previousProviders);
  state.nativeWrite = { path: settingsPath, beforeSha256: state.stoppedFiles[settingsPath], afterSha256: sha(written) };
  const markerKey = 'kcoder-owned-storage-upgrade-new-write';
  assert.equal(await evaluate(renderer, `localStorage.setItem(${JSON.stringify(markerKey)},${JSON.stringify(request.owner)});localStorage.getItem(${JSON.stringify(markerKey)})`), request.owner);
  state.operationId = operationId; await writeFile(join(root, stateLeaf), JSON.stringify(state), { mode: 0o600 });
  return { passed: true, verificationScope: 'installed_old_version_upgrade_and_legacy_startup', operationId, phase: receipt.phase, disposition: receipt.disposition,
    actualNewInstalledElectron: true, actualAutomaticLegacyMigration: true, nativeInPlace: true, oldSourceRetained: true,
    modelConfigurationRetained: true, logicalIdentityRetained: true, originalOriginRetained: true, persistentCookieRetained: true,
    actualRetainedNativeConfigurationWrite: true, actualUnifiedDesktopWrite: true,
    actualUnsentDraftRetained: null, draftPersistence: 'unsupported-in-old-2.0.49', historyRecordsRead: 3, historicalAttachmentSha256: state.attachment.sha256, modelCalls: 0 };
}

export async function afterWindowsStorageUpgradeQuit(flow, outcome, exit) {
  assert.deepEqual(exit, { code: 0, signal: null });
  const { root, request } = flow, path = join(root, stateLeaf), state = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(state.owner, request.owner);
  if (request.action === 'storageUpgradeSeed') {
    state.stoppedFiles = {};
    for (const file of [join(state.source.dataRoot, 'settings.json'), join(state.source.sharedRoot, 'servers.json'), join(state.source.sharedRoot, 'gateway-port')]) state.stoppedFiles[file] = sha(await readFile(file));
    await absent(join(state.source.dataRoot, '.profile-identity.json'));
    const identities = [];
    // Observe only the documented Native identity leaves in this owned profile.
    for (const entry of await readdir(state.source.dataRoot, { withFileTypes: true })) {
      if (!/^integration-[a-f0-9]{64}$/.test(entry.name)) continue;
      assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
      const record = join(state.source.dataRoot, entry.name, 'native-identity.jsonl');
      let bytes;
      try { bytes = await readFile(record); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const header = JSON.parse(bytes.toString('utf8').split(/\r?\n/)[0]);
      assert.ok(typeof header.profileIdentity === 'string' && header.profileIdentity.length > 0);
      identities.push(header.profileIdentity); state.stoppedFiles[record] = sha(bytes);
      const head = join(state.source.dataRoot, entry.name, 'native-identity-head.jsonl'); state.stoppedFiles[head] = sha(await readFile(head));
    }
    assert.equal(identities.length, 1, 'The real old user entry must establish one original Native identity');
    state.nativeProfileIdentity = identities[0];
    assert.equal(Number((await readFile(join(state.source.sharedRoot, 'gateway-port'), 'utf8')).trim()), Number(new URL(state.origin).port));
    state.originalNormalQuit = true;
  } else {
    for (const [file, expected] of Object.entries(state.stoppedFiles)) assert.equal(sha(await readFile(file)), file === state.nativeWrite.path ? state.nativeWrite.afterSha256 : expected, 'Normal new host quit preserves retained sources and the explicitly updated current Native settings');
  }
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  return { ...outcome, normalExit: exit, originalNormalQuit: true, sourceRetainedAfterQuit: true };
}

export function validateWindowsStorageUpgradeResult(result, expected) {
  assert.equal(result.passed, true); assert.equal(result.verificationScope, 'installed_old_version_upgrade_and_legacy_startup');
  assert.equal(result.versionUpgrade, true); assert.equal(result.modelCalls, 0); assert.equal(result.personalBaselineRead, false);
  assert.equal(result.supervision.helperClosed, true); assert.equal(result.supervision.exitAuthority, 'original-supervisor-job-empty');
  assert.deepEqual(result.steps.map(step => step.action), ['profileQualification', 'inspect', 'install', 'storageUpgradeSeed', 'install', 'storageUpgradeRead', 'uninstall']);
  const sid = result.steps[0].sid; assert.match(sid, /^S-1-5-21-/);
  assert.equal(result.steps[0].profile.userInteractive, true);
  for (const step of result.steps) { assert.equal(step.sid, sid); assert.equal(step.isAdmin, false); assert.equal(step.ok, true); }
  const installs = result.steps.filter(step => step.action === 'install');
  assert.match(installs[0].installedCliVersion, /^kcoder 2\.0\.49(?:\s|$)/);
  assert.ok(installs[1].installedCliVersion === `kcoder ${expected.expectedVersion}` || installs[1].installedCliVersion.startsWith(`kcoder ${expected.expectedVersion} `));
  assert.equal(installs[0].installedResources['resources\\bin\\kcoder.exe'].toLowerCase(), windowsStorageUpgradeOldPackage.expectedCliSha256);
  assert.equal(installs[1].installedResources['resources\\bin\\kcoder.exe'].toLowerCase(), expected.expectedCliSha256);
  assert.equal(result.seed.oldAppDataObserved, true); assert.equal(result.seed.nativeDefaultObserved, true);
  assert.equal(result.seed.draftPersistenceSupported, false);
  assert.equal(result.restored.actualUnsentDraftRetained, null); assert.equal(result.restored.draftPersistence, 'unsupported-in-old-2.0.49');
  for (const key of ['passed', 'actualAutomaticLegacyMigration', 'nativeInPlace', 'oldSourceRetained', 'modelConfigurationRetained', 'logicalIdentityRetained', 'originalOriginRetained', 'persistentCookieRetained', 'sourceRetainedAfterQuit', 'actualRetainedNativeConfigurationWrite', 'actualUnifiedDesktopWrite'])
    assert.equal(result.restored[key], true, key);
  assert.equal(result.restored.historyRecordsRead, 3); assert.equal(result.restored.phase, 'verified'); assert.equal(result.restored.disposition, 'complete');
  assert.deepEqual(result.restored.buildIdentity, { build_commit: expected.expectedNativeCommit ?? expected.expectedCommit, build_dirty: false, executable_sha256: expected.expectedCliSha256 });
  assert.equal(result.restored.releaseCommit, expected.expectedCommit);
  for (const value of [result.seed, result.restored]) { assert.equal(value.observedTurnStarts, 0); assert.equal(value.modelCalls, 0); assert.deepEqual(value.normalExit, { code: 0, signal: null }); }
}
