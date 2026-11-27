import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareWindowsProfileStartup } from './windows-profile-startup.mjs';

const regular = String.raw`D:\Users\29505\.config\kcoder`;
const forbidden = () => assert.fail('Home selection must not inspect permissions, use recovery preferences, or open dialogs');
const legacyRecovery = {
  inspect: forbidden, readSelection: forbidden, saveSelection: forbidden,
  dialog: { showMessageBox: forbidden, showOpenDialog: forbidden },
};

test('default Windows Home uses the account Known Folder without Home ACL checks or fallback', async () => {
  const original = { USERPROFILE: String.raw`Z:\foreign`, USERNAME: 'machine', USERDOMAIN: 'machine' };
  const result = await prepareWindowsProfileStartup({ platform: 'win32', env: original,
    readIdentity: async () => ({ userProfile: String.raw`D:\Users\29505` }), ...legacyRecovery });
  assert.equal(result.env.KCODER_CONFIG_DIR, regular);
  assert.equal(result.env.KCODER_HOME, regular);
  assert.deepEqual(original, { USERPROFILE: String.raw`Z:\foreign`, USERNAME: 'machine', USERDOMAIN: 'machine' });
});

for (const overrides of [
  { KCODER_HOME: String.raw`E:\Private\QA` },
  { KCODER_CONFIG_DIR: String.raw`C:\ProgramData\KCoder` },
  { KCODER_CONFIG_DIR: String.raw`E:\Selected`, KCODER_HOME: String.raw`E:\Ignored` },
]) test(`explicit Home stays selected without an account/permission probe: ${JSON.stringify(overrides)}`, async () => {
  const result = await prepareWindowsProfileStartup({ platform: 'win32', env: overrides,
    readIdentity: forbidden, ...legacyRecovery });
  const expected = overrides.KCODER_CONFIG_DIR || overrides.KCODER_HOME;
  assert.equal(result.env.KCODER_CONFIG_DIR, expected);
  assert.equal(result.env.KCODER_HOME, expected);
});

for (const selectionSource of [undefined, 'interactive', 'installer']) {
  test(`obsolete ${selectionSource || 'automatic'} recovery choices cannot replace the default Home or Gateway state`, async () => {
    let reads = 0;
    const original = { KCODER_STUDIO_DATA_DIR: String.raw`D:\Gateway`,
      KCODER_STUDIO_SERVERS_STORE: String.raw`D:\Catalog\servers.json`,
      KCODER_STUDIO_SERVERS_FILE: String.raw`D:\Catalog\seed.json`, KCODER_STUDIO_SERVERS: '[{"id":"local"}]' };
    const result = await prepareWindowsProfileStartup({ platform: 'win32', env: original,
      ...legacyRecovery, readIdentity: async () => ({ userProfile: String.raw`D:\Users\29505` }),
      readSelection: async () => { reads++; return { sourceDirectory: regular,
        directory: String.raw`D:\Users\29505\AppData\Local\KCoder\profiles\old`, selectionSource,
        dataDirectory: String.raw`D:\OldGateway`, clearCatalogInputs: true }; },
    });
    assert.equal(reads, 0);
    assert.deepEqual(result.env, { ...original, KCODER_CONFIG_DIR: regular, KCODER_HOME: regular });
  });
}

for (const path of ['relative', '\0invalid', 'C:\\invalid\npath', 'C:\\invalid\rpath']) {
  test(`invalid explicit path fails rather than selecting another Home: ${JSON.stringify(path)}`, async () => {
    await assert.rejects(prepareWindowsProfileStartup({ platform: 'win32', env: { KCODER_HOME: path },
      readIdentity: forbidden, ...legacyRecovery }), { code: 'WINDOWS_PROFILE_PATH_INVALID' });
  });
}

test('account discovery failure propagates instead of falling back to AppData or environment hints', async () => {
  const error = Object.assign(new Error('Unavailable'), { code: 'WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE' });
  await assert.rejects(prepareWindowsProfileStartup({ platform: 'win32', env: { USERPROFILE: 'C:\\other' },
    readIdentity: async () => { throw error; }, ...legacyRecovery }), value => value === error);
});

test('non-Windows startup keeps the environment and does not run Windows probes', async () => {
  const env = { KCODER_HOME: '/owned/test', KCODER_STUDIO_DATA_DIR: '/owned/gateway' };
  const result = await prepareWindowsProfileStartup({ platform: 'linux', env, readIdentity: forbidden, ...legacyRecovery });
  assert.deepEqual(result.env, env);
  assert.notEqual(result.env, env);
});
