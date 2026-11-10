import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { keyringAccountSourceReview, runOwnedKeyringAccount, validateOwnedVaultResult, validateOwnedKeyringCleanup } from './windows-keyring-account.mjs';
import { prepareSuiteArtifacts } from '../run-all.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';

function result() {
  const value = { status: 'passed', fileBackendUsed: false, exactRandomAccountOnly: true, readbackMatched: true, enumeratedAccounts: false };
  return { passed: true, scope: 'os_backend_only', owner: 'owned', username: 'kc_e2e_12345678', ownedSid: 'S-1-5-21-1-2-3-1000',
    coreMigrationVerified: false, hostMigrationVerified: false,
    written: { ...value, stage: 'written_pending_independent_reopen' },
    reopened: { ...value, stage: 'reopened_and_deleted', cleanup: { systemEntryAbsenceVerified: true } },
    jobs: ['bootstrap', 'write', 'reopen'].map((action, index) => ({ action, pid: index + 1, creationTicks: String(index + 10), sid: 'S-1-5-21-1-2-3-1000',
      logonLuid: `2:${index + 1}`, logonType: 2, profileHiveLoaded: true, elevated: false, stopped: true })) };
}
test('a real independent normal-logon vault result cannot substitute file storage, a shared logon or an active worker', () => {
  validateOwnedVaultResult(result(), 'owned', 'kc_e2e_12345678');
  for (const mutate of [value => { value.jobs[1].logonType = 3; }, value => { value.jobs[1].sid += '0'; },
    value => { value.jobs[1].stopped = false; }, value => { value.jobs[1].logonLuid = value.jobs[0].logonLuid; },
    value => { value.reopened.fileBackendUsed = true; }, value => { value.reopened.cleanup.systemEntryAbsenceVerified = false; },
    value => { value.coreMigrationVerified = true; }]) {
    const bad = result(); mutate(bad); assert.throws(() => validateOwnedVaultResult(bad, 'owned', 'kc_e2e_12345678'));
  }
});
test('no account can start until the exact complete adapter source has an explicit reviewed hash', async () => {
  const review = await keyringAccountSourceReview(); assert.match(review.sourceSha256, /^[a-f0-9]{64}$/);
  assert.ok(review.files.some(value => value.path.endsWith('windows-keyring-account.mjs')));
  await assert.rejects(runOwnedKeyringAccount({ spawnOwned() { throw Error('must never start'); } },
    { consent: '1', mode: 'roundtrip', target: 'owned-host', parent: 'D:\\' }));
});
test('cleanup separates verified deletion from a durable no-write birth and never accepts an unknown active job', () => {
  const base = { cleaned: true, accountAbsent: true, profileAbsent: true, allJobsStopped: true };
  validateOwnedKeyringCleanup({ ...base, vault: { safeToRemoveRoot: true, systemEntryAbsenceVerified: true } });
  validateOwnedKeyringCleanup({ ...base, vault: { safeToRemoveRoot: true, systemEntryAbsenceVerified: false, noVaultWriteDispatched: true } });
  validateOwnedKeyringCleanup({ cleaned: true, accountAbsent: true, profileAbsent: true, disposition: 'never_created' });
  for (const value of [
    { ...base, allJobsStopped: false, vault: { safeToRemoveRoot: true, systemEntryAbsenceVerified: true } },
    { ...base, vault: { safeToRemoveRoot: true, systemEntryAbsenceVerified: false } },
    { ...base, vault: { safeToRemoveRoot: false, noVaultWriteDispatched: true } },
  ]) assert.throws(() => validateOwnedKeyringCleanup(value));
});
test('compile/account registration uses only explicit scope inputs and never rebuilds shared app outputs', async () => {
  const suite = 'suites/gateway/windows-keyring-account.e2e.mjs';
  const calls = []; await prepareSuiteArtifacts([suite], { run: async (...args) => { calls.push(args); } });
  assert.deepEqual(calls, []);
  const names = suiteEnvironmentNames(suite);
  assert.ok(names.includes('KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_REVIEW_SHA256'));
  assert.ok(names.includes('KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_FAULT'));
  assert.equal(suiteEnvironmentNames('suites/gateway/windows-keyring-logon.e2e.mjs').includes('KCODER_E2E_WINDOWS_KEYRING_ACCOUNT_REVIEW_SHA256'), false);
});
test('owned logon uses profile authentication and records actual process identity before resume without personal token shortcuts', async () => {
  const source = await readFile(new URL('./windows-keyring-logon-process.cs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('publishBirth(birth)') < source.indexOf('ResumeThread(process.Thread)'));
  assert.match(source, /LsaGetLogonSessionData/); assert.match(source, /type!=2/);
  assert.match(source, /wait==0xffffffff/); assert.match(source, /KeyringStopJob\(job\)/);
  assert.match(source, /OpenProcessToken\(process,8,/);
  assert.match(source, /KeyringTokenBuffer\(token,1,/); assert.match(source, /KeyringTokenBuffer\(token,2,/);
  assert.match(source, /S-1-5-32-544/);
  assert.doesNotMatch(source, /new WindowsIdentity|new WindowsPrincipal/);
  assert.doesNotMatch(source, /WTSQueryUserToken|DuplicateTokenEx|CreateProcessWithToken|AdjustTokenPrivileges|Impersonate/);
  const actor = await readFile(new URL('./windows-keyring-logon-user.ps1', import.meta.url), 'utf8');
  assert.match(actor, /Original root birth receipt missing/);
  assert.match(actor, /stagingParentIdentity/);
  assert.match(actor, /Action -eq 'observe'/);
  assert.doesNotMatch(actor.slice(actor.indexOf('function Observe-OriginalRoot'), actor.indexOf('\ntry {')), /CreateDirectory|WriteAllText/);
});
