import assert from 'node:assert/strict';
import test from 'node:test';
import { readWindowsRegisteredStorageRoots, windowsLegacyDataInputKey } from './windows-registered-sources.mjs';

const identity = { sid: 'S-1-5-21-1-2-3-1001' };
const selected = { context: { development: false, record: null }, paths: { externallyConfigured: false,
  dataRoot: 'C:\\Users\\Example\\.config\\kcoder', gatewayRoot: 'C:\\Users\\Example\\AppData\\Roaming\\kcoder-studio' } };
const legacy = { version: 1, sid: identity.sid, sourceDirectory: selected.paths.dataRoot,
  directory: 'D:\\旧数据\\Native' };
const read = (selection, options = {}) => readWindowsRegisteredStorageRoots({ selected, platform: 'win32', env: {},
  readIdentity: async () => identity, readSelection: async () => selection, ...options });

test('only the recorded current-account source contributes roots and never changes the running selection', async () => {
  const original = structuredClone(selected);
  assert.deepEqual(await read(legacy), [legacy.directory]);
  for (const selection of [null, { ...legacy, sid: 'S-1-5-21-9-9-9-1001' },
    { ...legacy, sourceDirectory: 'D:\\another-instance' }]) assert.deepEqual(await read(selection), []);
  assert.deepEqual(selected, original);
});

test('v2 Gateway roots require the original input fingerprint including catalog inputs', async () => {
  const env = { KCODER_STUDIO_SERVERS_FILE: 'D:\\输入\\servers.json', KCODER_STUDIO_SERVERS: '[{"id":"fixture"}]' };
  const selection = { ...legacy, version: 2, sourceDataKey: windowsLegacyDataInputKey(selected, env),
    dataDirectory: 'D:\\旧数据\\Gateway', serversStore: 'D:\\旧数据\\Gateway\\servers.json' };
  assert.equal(selection.sourceDataKey, '78ab1eb9cbfdeac1cca197cd79b67ef5164fb5e095690b1d4112c3f8170d68d0');
  assert.deepEqual(await read(selection, { env }), [legacy.directory, selection.dataDirectory]);
  await assert.rejects(read(selection, { env: { ...env, KCODER_STUDIO_SERVERS: '[{"id":"changed"}]' } }),
    { code: 'STORAGE_LEGACY_REGISTRATION_INPUT_CHANGED' });
  assert.equal(windowsLegacyDataInputKey(selected, { kcoder_studio_servers_file: env.KCODER_STUDIO_SERVERS_FILE,
    kcoder_studio_servers: env.KCODER_STUDIO_SERVERS }), selection.sourceDataKey);
});

test('saved, explicit and non-Windows instances never consult the legacy registry', async () => {
  for (const options of [{ platform: 'linux' }, { selected: { ...selected, context: { ...selected.context, record: { revision: 1 } } } },
    { selected: { ...selected, paths: { ...selected.paths, externallyConfigured: true } } },
    { selected: { ...selected, context: { ...selected.context, development: true } } }]) {
    assert.deepEqual(await read(legacy, { ...options, readIdentity() { assert.fail('unrelated instances must not read HKCU'); } }), []);
  }
});

test('a matching registration is retained as a source fact without requiring its disk to be online', async () => {
  assert.deepEqual(await read({ ...legacy, directory: 'Z:\\offline-registered-profile' }),
    ['Z:\\offline-registered-profile']);
});
