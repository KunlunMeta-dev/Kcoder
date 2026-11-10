import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateKeyringLogonOptions, validateLogonPreflight } from './windows-keyring-logon.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';
import { prepareSuiteArtifacts } from '../run-all.mjs';

const ready = { readOnly: true, prerequisitesReady: true, effectiveAdministrator: true, isLocalSystem: false,
  localAccountsCommandsAvailable: true, secondaryLogonPresent: true, secondaryLogonStartType: 'Manual',
  fixedNtfsParent: true, domainController: false, accountsCreated: 0, vaultCalls: 0,
  scheduledTasksCreated: 0, normalLogonAttempted: false, borrowedConsoleIdentity: false };

test('only explicit non-C owned-logon preflight can be selected before account adapter review', () => {
  const options = { consent: '1', target: 'owned-host', parent: 'D:\\', mode: 'preflight' };
  validateKeyringLogonOptions(options);
  for (const patch of [{ consent: '0' }, { parent: 'C:\\' }, { mode: 'roundtrip' }, { target: 'host;unsafe' }])
    assert.throws(() => validateKeyringLogonOptions({ ...options, ...patch }));
});

test('unavailable rights or any account/credential/scheduler action cannot satisfy the read-only observation', () => {
  validateLogonPreflight(ready);
  for (const patch of [{ prerequisitesReady: false }, { effectiveAdministrator: false }, { isLocalSystem: true },
    { secondaryLogonStartType: 'Disabled' }, { secondaryLogonStartType: null }, { accountsCreated: 1 }, { vaultCalls: 1 },
    { normalLogonAttempted: true }, { scheduledTasksCreated: 1 }, { borrowedConsoleIdentity: true }])
    assert.throws(() => validateLogonPreflight({ ...ready, ...patch }));
});

test('preflight only discovers command/service availability and never invokes account or credential mutators', async () => {
  const source = await readFile(new URL('./windows-keyring-logon-preflight.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:^|[;\n])\s*(?:New-LocalUser|Remove-LocalUser|Start-Service|Register-ScheduledTask)\b/);
  assert.doesNotMatch(source, /Cred(?:Read|Write|Delete|Enumerate)|CreateProcessWithLogonW|OpenProcessToken|WinSta0/i);
  assert.match(source, /Get-Command -Name \$name/);
  assert.match(source, /accountsCreated=0;vaultCalls=0;scheduledTasksCreated=0/);
});

test('registered owned-logon preflight forwards its explicit gate and never rebuilds shared artifacts', async () => {
  const suite = 'suites/gateway/windows-keyring-logon.e2e.mjs';
  const names = suiteEnvironmentNames(suite);
  for (const name of ['KCODER_E2E_WINDOWS_KEYRING_LOGON', 'KCODER_E2E_WINDOWS_KEYRING_LOGON_MODE',
    'KCODER_E2E_WINDOWS_SSH_TARGET', 'KCODER_E2E_WINDOWS_PROBE_PARENT']) assert.ok(names.includes(name));
  assert.equal(suiteEnvironmentNames('suites/gateway/windows-archive-retention.e2e.mjs').includes('KCODER_E2E_WINDOWS_KEYRING_LOGON'), false);
  const calls = [];
  await prepareSuiteArtifacts([suite], { run: async (...args) => { calls.push(args); } });
  assert.deepEqual(calls, [], 'Preflight must not rebuild a shared CLI or renderer while a platform suite is running');
});
