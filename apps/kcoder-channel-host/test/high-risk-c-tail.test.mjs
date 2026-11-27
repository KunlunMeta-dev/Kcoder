import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { githubRequest } from '../src/adapters/github.mjs';
import { qqRegistrationRequestOptions } from '../src/adapters/qq-registration-transport.mjs';
import { validateApplicationConfiguration } from '../src/catalog.mjs';
import { taskSourceCatalog } from '../src/applications/task-sources.mjs';
import { installationFacts } from '../src/installation.mjs';
import { resolveBundledNodeLicense } from '../scripts/stage-native-resources.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createFixtureStore, removeFixtureStore } from './store-fixture.mjs';

test('GitHub transport failures cannot expose SDK request headers or nested errors', async () => {
  const secret = 'SYNTHETIC_GITHUB_BEARER';
  await assert.rejects(githubRequest('https://api.github.com/repos/fixture/repo/issues/1/comments', {
    headers: { authorization: 'Bearer ' + secret }, fetchImpl: async () => {
      throw Object.assign(new Error(secret), { request: { headers: { authorization: 'Bearer ' + secret } } });
    },
  }), error => error.code === 'GITHUB_TRANSPORT_FAILED' && error.recovery === 'reconcile_original' &&
    !error.request && !error.cause && !JSON.stringify(error).includes(secret) && !error.stack.includes(secret));
});

test('QQ registration admits exactly the pinned SDK request shapes and rejects socket overrides', () => {
  for (const path of ['/lite/create_bind_task', '/lite/poll_bind_result']) {
    const original = { hostname: 'q.qq.com', method: 'POST', path, timeout: 3000, headers: { 'content-type': 'application/json' } };
    assert.equal(qqRegistrationRequestOptions(original).timeout, 10000);
    for (const key of ['host', 'createConnection', 'lookup', 'rejectUnauthorized', 'ca', 'socketPath', 'agent', 'port']) {
      assert.throws(() => qqRegistrationRequestOptions({ ...original, [key]: key === 'rejectUnauthorized' ? false : 'override' }), /QQ_QR_HOST_INVALID/);
    }
  }
});

test('application configuration failures retain their documented repair error contract', () => {
  for (const mcpServerName of [undefined, null, 1, '', 'a'.repeat(257)]) {
    assert.throws(() => validateApplicationConfiguration({ mcpServerName }), { code: 'INVALID_APPLICATION_CONFIGURATION', recovery: 'repair_configuration' });
  }
  assert.deepEqual(validateApplicationConfiguration({ mcpServerName: 'source', pluginId: null }), { mcpServerName: 'source', pluginId: null });
});

test('task source uniqueness follows kind and account identity rather than a stale revision', () => {
  const source = { sourceRef: { id: 'source', revision: 'old' }, accountRef: null, kind: 'mcp', displayName: 'Source',
    accountDisplayName: null, state: 'ready', reasonCode: null, capabilities: ['tools'] };
  assert.throws(() => taskSourceCatalog({ taskSources: [source, { ...source, sourceRef: { id: 'source', revision: 'fresh' } }] }), { code: 'TASK_CAPABILITY_SOURCE_DUPLICATE' });
  assert.equal(taskSourceCatalog({ taskSources: [source, { ...source, kind: 'plugin_mcp' }] }).taskSources.length, 2);
  assert.equal(taskSourceCatalog({ taskSources: [source, { ...source, accountRef: { id: 'account', revision: '1' } }] }).taskSources.length, 2);
});

test('SDK facts verify resolved entry presence and the real QQ root export', t => {
  assert.equal(installationFacts().find(value => value.kind === 'qq').installed, true);
  const original = fs.statSync;
  const mock = t.mock.method(fs, 'statSync', (file, ...args) => {
    if (String(file).endsWith('/src/vendor/tencent-openclaw-weixin/api.mjs')) throw Object.assign(new Error('inert missing entry'), { code: 'ENOENT' });
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(installationFacts().find(value => value.kind === 'weixin').installed, false);
});

test('bundled Node license supports distribution and adjacent layouts and fails before guessing legal data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'channel-node-license-c-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  await assert.rejects(resolveBundledNodeLicense(join(bin, 'node')), /complete LICENSE/);
  await writeFile(join(bin, 'LICENSE'), 'synthetic distribution license');
  assert.equal(await resolveBundledNodeLicense(join(bin, 'node.exe')), join(bin, 'LICENSE'));
  await writeFile(join(root, 'LICENSE'), 'synthetic prefix license');
  assert.equal(await resolveBundledNodeLicense(join(bin, 'node')), join(root, 'LICENSE'));
});

test('actual SQLite sidecars are created and usable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'channel-sidecar-c-'));
  let store, db;
  t.after(() => { db?.close(); store?.close(); removeFixtureStore(root); });
  store = createFixtureStore(root);
  const path = join(root, 'connectivity.sqlite3');
  db = new DatabaseSync(path);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  db.exec(`PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; PRAGMA user_version=${version}; COMMIT;`);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(fs.statSync(path + suffix).isFile(), true);
});
