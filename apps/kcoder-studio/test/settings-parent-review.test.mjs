import assert from 'node:assert/strict';
import test from 'node:test';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSshConnectionStore } from '../src/ssh-terminal-store.js';
import { createServerInventoryRoutes } from '../src/server-inventory-routes.js';
import { createServerConfigurationPublisher, configurationPublicationFailure, writeServerConfiguration } from '../src/server-mutation.mjs';

const profile = { id: 'owned', label: 'Owned fixture', host: 'owned.invalid', port: 22, username: 'fixture', authMethod: 'agent' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'settings-second-review-'));
  const cleanup = [];
  t.after(async () => {
    try { for (const action of cleanup.reverse()) await action(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const filePath = join(root, 'ssh_connections.jsonc');
  const store = createSshConnectionStore({ filePath, cipher: { encrypt() { throw Error('unexpected cipher'); }, decrypt() { throw Error('unexpected cipher'); } } });
  return { root, filePath, store, addCleanup: action => cleanup.push(action) };
}
function failDirectorySync(t, root) {
  const open = fsPromises.open;
  const mocked = t.mock.method(fsPromises, 'open', async (...args) => {
    const file = await open(...args);
    if (args[0] === root) file.sync = async () => { throw Object.assign(Error('PRIVATE_DIRECTORY_SYNC_CANARY'), { code: 'EIO' }); };
    return file;
  });
  syncBuiltinESMExports();
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore); return restore;
}
function routeFor(store) {
  return createServerInventoryRoutes({
    getServers: () => [{ id: 'local' }], sshConnections: store,
    jsonResponse: (response, status, body) => Object.assign(response, { status, body }),
    requireSameOriginMutation: () => true, requestBody: async () => JSON.stringify(profile),
  });
}

test('actual SSH store preserves an unconfirmed receipt after publishing the profile bytes', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), restore = failDirectorySync(t, f.root);
  const error = await f.store.upsert(profile).catch(error => error); restore();
  assert.deepEqual(await f.store.list(), [profile], 'the failed durability receipt does not mean the profile was not written');
  assert.equal(error.code, 'CONFIG_FILE_PUBLISH_UNCONFIRMED');
  assert.equal(error.externalOutcome, 'unknown');
  assert.equal(error.message.includes('PRIVATE_DIRECTORY_SYNC_CANARY'), false);
});

test('actual SSH HTTP consumer reports unknown after directory sync failure without echoing private errors', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), route = routeFor(f.store), restore = failDirectorySync(t, f.root), response = {};
  await route({ method: 'PUT', url: '/api/ssh-connections/owned' }, response, '/api/ssh-connections/owned', { allowedServerIds: new Set(['local']) });
  restore(); assert.deepEqual(await f.store.list(), [profile]);
  assert.equal(response.status, 409, 'post-publication uncertainty is not a definitive HTTP400 rejection');
  assert.equal(response.body.code, 'CONFIG_FILE_PUBLISH_UNCONFIRMED');
  assert.equal(response.body.externalOutcome, 'unknown');
  assert.equal(JSON.stringify(response.body).includes('PRIVATE_DIRECTORY_SYNC_CANARY'), false);
  assert.equal(JSON.stringify(response.body).includes(f.root), false);
});

test('the server catalog publisher also retains its actual published unknown outcome', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), path = join(f.root, 'servers.json'), restore = failDirectorySync(t, f.root);
  const values = [{ id: 'owned', transport: 'ssh', host: 'owned.invalid', user: 'fixture' }];
  const error = await writeServerConfiguration(path, values).catch(error => error); restore();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), values);
  assert.equal(error.code, 'CONFIG_FILE_PUBLISH_UNCONFIRMED'); assert.equal(error.externalOutcome, 'unknown');
});

test('a real prepublication permission failure stays definite and never adopts prepared values', async t => {
  const f = await fixture(t), path = join(f.root, 'servers.json');
  await writeServerConfiguration(path, [{ id: 'old' }]);
  const publisher = createServerConfigurationPublisher(path), open = fsPromises.open;
  const mocked = t.mock.method(fsPromises, 'open', async (...args) => {
    if (args[1] === 'wx') throw Object.assign(Error('PRIVATE_PERMISSION_PATH_CANARY'), { code: 'EACCES' });
    return open(...args);
  });
  syncBuiltinESMExports(); const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); }; t.after(restore);
  const error = await publisher.publish([{ id: 'unpublished' }]).catch(error => error); restore();
  assert.equal(error.code, 'SERVER_CONFIGURATION_SAVE_FAILED'); assert.equal(error.externalOutcome, undefined);
  assert.equal(configurationPublicationFailure(error), null);
  assert.equal(error.message.includes('PRIVATE_PERMISSION_PATH_CANARY'), false);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [{ id: 'old' }]);
  assert.doesNotThrow(() => publisher.assertCurrent());
  await publisher.publish([{ id: 'next' }]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [{ id: 'next' }]);
});

test('only an exact publisher phase or this original publication fence projects unknown', () => {
  const error = Object.assign(Error('PRIVATE_POSTPUBLISH_CANARY'), { code: 'EACCES', externalOutcome: 'unknown' });
  assert.equal(configurationPublicationFailure(error), null);
  assert.deepEqual(configurationPublicationFailure(error, true), {
    error: 'CONFIG_FILE_PUBLISH_UNCONFIRMED', code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED', externalOutcome: 'unknown',
  });
});

test('server publication snapshots its prepared wire bytes before awaiting directory creation', async t => {
  const f = await fixture(t), path = join(f.root, 'servers.json'), values = [{ id: 'original' }];
  const publisher = createServerConfigurationPublisher(path), mkdir = fsPromises.mkdir;
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const mocked = t.mock.method(fsPromises, 'mkdir', async (...args) => { started(); await gate; return mkdir(...args); });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const publishing = publisher.publish(values);
  await ready; values[0].id = 'later-mutated'; release(); await publishing;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [{ id: 'original' }]);
});

test('forty actual channel inventory GETs do not publish, hash, scan or mutate SQL and still observe off', async t => {
  const { ChannelRuntime } = await import('../../kcoder-channel-host/src/channels/runtime.mjs');
  const { createChannelsHttpHandler } = await import('../src/channels-http.mjs');
  const fs = (await import('node:fs')).default, crypto = (await import('node:crypto')).default;
  const f = await fixture(t), runtime = new ChannelRuntime({ directory: join(f.root, 'channels'), settingsDirectory: f.root,
    tasks: { run: async () => { throw Error('unexpected model/task'); }, recover: async () => ({ state: 'unknown' }) } });
  f.addCleanup(() => runtime.close());
  runtime.store.saveConnection({ id: 'owned', platform: 'feishu', label: 'Owned', configuration: { appId: 'owned-app' } }, { appSecret: 'PRIVATE_FIXTURE_CREDENTIAL' });
  runtime.store.setSettings({ mirrorClientTurns: true });
  const handler = createChannelsHttpHandler({ controller: { runtime }, jsonResponse: (response, status, body) => Object.assign(response, { status, body }) });
  const counts = { writes: 0, hashes: 0, scans: 0, sqlWrites: 0 };
  const originals = { write: fs.writeFileSync, rename: fs.renameSync, sync: fs.fsyncSync, scan: fs.readdirSync,
    hash: crypto.createHash, prepare: runtime.store.db.prepare.bind(runtime.store.db), exec: runtime.store.db.exec.bind(runtime.store.db) };
  const mocks = [
    t.mock.method(fs, 'writeFileSync', (...args) => { counts.writes++; return originals.write(...args); }),
    t.mock.method(fs, 'renameSync', (...args) => { counts.writes++; return originals.rename(...args); }),
    t.mock.method(fs, 'fsyncSync', (...args) => { counts.writes++; return originals.sync(...args); }),
    t.mock.method(fs, 'readdirSync', (...args) => { counts.scans++; return originals.scan(...args); }),
    t.mock.method(crypto, 'createHash', (...args) => { counts.hashes++; return originals.hash(...args); }),
    t.mock.method(runtime.store.db, 'prepare', sql => { if (!/^\s*SELECT\b/i.test(sql)) counts.sqlWrites++; return originals.prepare(sql); }),
    t.mock.method(runtime.store.db, 'exec', (...args) => { counts.sqlWrites++; return originals.exec(...args); }),
  ];
  syncBuiltinESMExports();
  const restore = () => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); }; t.after(restore);
  const get = async () => {
    const response = {};
    await handler({ request: { method: 'GET', url: '/api/channels' }, response, pathname: '/api/channels' });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body.settings).sort(), ['mirrorClientTurns', 'toolRestrictions']);
    assert.equal(JSON.stringify(response.body).includes('PRIVATE_FIXTURE_CREDENTIAL'), false);
    return response.body;
  };
  for (let n = 0; n < 40; n++) assert.equal((await get()).settings.mirrorClientTurns, true);
  assert.deepEqual(counts, { writes: 0, hashes: 0, scans: 0, sqlWrites: 0 }); restore();
  const settingsPath = runtime.store.settingsFile.path;
  const document = JSON.parse(await readFile(settingsPath, 'utf8')); document.channels.mirror_client_turns = false;
  await fsPromises.writeFile(settingsPath, JSON.stringify(document));
  assert.equal((await get()).settings.mirrorClientTurns, false);
});
