import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';
import { prepareWindowsProfileStartup } from '../desktop/windows-profile-startup.mjs';
import { defaultStorageLocation } from './storage-paths.mjs';
import { readWindowsCurrentIdentity, validWindowsSid, readWindowsProfileSelection, saveWindowsProfileSelection } from './windows-current-identity.mjs';

const identity = { sid: 'S-1-5-21-100-200-300-1001', userProfile: String.raw`D:\Users\29505`,
  localAppData: String.raw`D:\Users\29505\AppData\Local`, appData: String.raw`D:\Users\29505\AppData\Roaming`,
  programData: String.raw`D:\ProgramData` };
test('actual Windows process token and Known Folders are readable', {
  skip: process.platform !== 'win32' && 'Requires the actual Windows token and Known Folders',
}, async () => {
  const result = await readWindowsCurrentIdentity();
  assert.equal(validWindowsSid(result.sid), true);
  for (const key of ['userProfile', 'appData', 'localAppData', 'programData']) {
    assert.equal(win32.isAbsolute(result[key]), true, key);
  }
  const original = { ...process.env, KCODER_HOME: undefined, KCODER_CONFIG_DIR: undefined,
    USERPROFILE: String.raw`Z:\unrelated-profile`, APPDATA: String.raw`Z:\unrelated-roaming`,
    LOCALAPPDATA: String.raw`Z:\unrelated-local` };
  const startup = await prepareWindowsProfileStartup({ env: original });
  assert.equal(startup.env.KCODER_HOME, win32.join(result.userProfile, '.config', 'kcoder'));
  assert.equal(startup.env.KCODER_CONFIG_DIR, startup.env.KCODER_HOME);
  const selected = defaultStorageLocation({ home: result.userProfile, platformCache: result.localAppData });
  assert.equal(selected.dataRoot, startup.env.KCODER_HOME);
  assert.equal(selected.cacheRoot, win32.join(result.localAppData, 'kcoder'));
  assert.equal(original.KCODER_HOME, undefined);
});

test('identity probe derives a missing SystemDrive only in its child environment', async () => {
  const originalSystemDriveEntries = Object.keys(process.env)
    .filter(key => key.toLowerCase() === 'systemdrive')
    .map(key => [key, process.env[key]]);
  const systemDriveKeys = () => Object.keys(process.env).filter(key => key.toLowerCase() === 'systemdrive');
  try {
    for (const callerDrive of [undefined, '']) {
      for (const key of systemDriveKeys()) delete process.env[key];
      if (callerDrive !== undefined) process.env.SystemDrive = callerDrive;
      const env = { SystemRoot: String.raw`D:\Windows` };
      if (callerDrive !== undefined) env.SystemDrive = callerDrive;
      const originalEnv = { ...env };
      let calls = 0, childEnv;
      const result = await readWindowsCurrentIdentity({ platform: 'win32', env,
        execute: async (file, args, options) => {
          calls++;
          assert.equal(file, String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
          childEnv = options.env;
          return { stdout: JSON.stringify(identity) };
        } });
      assert.deepEqual(result, identity);
      assert.equal(calls, 1);
      assert.notStrictEqual(childEnv, process.env);
      assert.notStrictEqual(childEnv, env);
      assert.equal(childEnv.SystemDrive, 'D:');
      assert.deepEqual(Object.keys(childEnv).filter(key => key.toLowerCase() === 'systemdrive'), ['SystemDrive']);
      assert.equal(process.env.SystemDrive, callerDrive);
      assert.deepEqual(env, originalEnv);
    }
  } finally {
    for (const key of systemDriveKeys()) delete process.env[key];
    for (const [key, value] of originalSystemDriveEntries) process.env[key] = value;
  }
});

test('actual Windows Known Folders survive missing or empty SystemDrive without changing caller environment', {
  skip: process.platform !== 'win32' && 'Requires actual Windows Known Folders', timeout: 40_000,
}, async () => {
  const expected = await readWindowsCurrentIdentity();
  const originalDrive = process.env.SystemDrive;
  try {
    for (const empty of [false, true]) {
      delete process.env.SystemDrive;
      if (empty) process.env.SystemDrive = '';
      const before = process.env.SystemDrive;
      assert.deepEqual(await readWindowsCurrentIdentity(), expected);
      assert.equal(process.env.SystemDrive, before);
    }
  } finally {
    if (originalDrive === undefined) delete process.env.SystemDrive;
    else process.env.SystemDrive = originalDrive;
  }
});

test('Windows identity uses the actual token SID and Known Folders when machine and user names match', async () => {
  let launched;
  const result = await readWindowsCurrentIdentity({ platform: 'win32', env: { SystemRoot: String.raw`D:\Windows`,
    USERNAME: 'same-machine-name', USERDOMAIN: 'same-machine-name', USERPROFILE: String.raw`Z:\foreign` },
    execute: async (file, args, options) => { launched = { file, args, options }; return { stdout: JSON.stringify(identity) }; } });
  assert.deepEqual(result, identity);
  assert.equal(launched.file, String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  const script = Buffer.from(launched.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /WindowsIdentity\]::GetCurrent\(\)/);
  assert.match(script, /identity\.User\.Value/);
  assert.doesNotMatch(script, /USERNAME|USERDOMAIN|takeown|Set-Acl|Everyone|grant/);
  assert.equal(launched.options.windowsHide, true);
});

test('Windows startup resolves SystemRoot case-insensitively in copied environments', async () => {
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'systemroot']) {
    const env = { [key]: String.raw`D:\Windows` };
    const assertExecutable = file => assert.equal(file, String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    await readWindowsCurrentIdentity({ platform: 'win32', env, execute: async file => {
      assertExecutable(file); return { stdout: JSON.stringify(identity) };
    } });
    assert.equal(await readWindowsProfileSelection({ env, identity, execute: async file => {
      assertExecutable(file); return { stdout: JSON.stringify({ sid: identity.sid, value: null }) };
    } }), null);
    assert.equal(await saveWindowsProfileSelection({ env, identity, sourceDirectory: identity.userProfile,
      directory: identity.localAppData, execute: async file => { assertExecutable(file); return { stdout: 'saved' }; } }), true);
  }
});
test('identity failures are closed diagnostics without raw subprocess output', async () => {
  for (const value of [{ ...identity, sid: 'machine\\same' }, { ...identity, userProfile: 'relative' },
    { ...identity, programData: '' }, { ...identity, extra: 'unrecognized' }, null]) {
    await assert.rejects(readWindowsCurrentIdentity({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
      execute: async () => ({ stdout: JSON.stringify(value) }) }), error => error.code === 'WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE'
        && error.reason === 'invalid_identity');
  }
  await assert.rejects(readWindowsCurrentIdentity({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    execute: async () => { throw Object.assign(new Error('sensitive subprocess stderr'), { code: 'ENOENT' }); } }),
  error => error.reason === 'powershell_unavailable' && !error.message.includes('sensitive'));
  assert.equal(validWindowsSid('S-1-12-1-111-222-333-444'), true);
  assert.equal(validWindowsSid('*S-1-1-0:(F)'), false);
});

test('profile selections preserve recovery sources without inventing them for legacy records', async () => {
  const env = { SystemRoot: String.raw`D:\Windows` };
  let stored;
  const save = selectionSource => saveWindowsProfileSelection({ env, identity,
    sourceDirectory: String.raw`E:\Private\QA`, directory: identity.localAppData, selectionSource,
    execute: async (_file, _args, options) => { stored = JSON.parse(options.input); return { stdout: 'saved' }; },
  });
  const read = () => readWindowsProfileSelection({ env, identity,
    execute: async () => ({ stdout: JSON.stringify({ sid: identity.sid, value: JSON.stringify(stored) }) }),
  });
  for (const source of ['interactive', 'installer']) {
    assert.equal(await save(source), true);
    assert.equal((await read()).selectionSource, source);
  }
  stored.selectionSource = 'automatic';
  assert.equal(await read(), null);
  assert.equal(await save(undefined), true);
  assert.equal(Object.hasOwn(stored, 'selectionSource'), false);
  assert.equal((await read()).selectionSource, undefined);
});
