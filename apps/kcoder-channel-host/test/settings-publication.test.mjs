import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelStore } from '../src/channels/store.mjs';
import { ChannelSettingsFile } from '../src/channels/settings.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'channel-publication-'));
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, open(name = 'channels') {
    const store = new ChannelStore(join(root, name), { settingsDirectory: root }); stores.push(store);
    store.saveConnection({ id: 'bot', platform: 'feishu', label: 'Fixture' });
    const chat = store.observeChat('bot', { platform: 'feishu', conversationId: 'fixture', eventId: 'old' });
    return { store, chat };
  } };
}
const unchanged = (before, after) => {
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[field], before[field], field);
};
function enqueue(store, chat, id, generation, state = 'pending') {
  store.transaction(() => {
    const source = { role: 'assistant', ...(generation === undefined ? {} : { mirrorGeneration: generation }) };
    store.enqueueOutput(id, chat.id, { content: { text: id }, source });
    if (state !== 'pending') {
      assert.equal(store.claimOutput(id), true);
      if (state !== 'sending') store.settleOutput(id, state, { code: 'ORIGINAL_RECEIPT' });
    }
  });
}

test('v1/v2 upgrades and tool-only saves retain the explicit legacy null generation and pending intent', t => {
  for (const version of [1, 2]) {
    const f = fixture(t);
    const original = `// retained v${version}\n{"meta":{"config_version":${version}},"channels":{"mirror_client_turns":true},"other":{"keep":1}}`;
    const path = join(f.root, 'settings.json'); writeFileSync(path, original, { mode: 0o600 });
    const { store, chat } = f.open();
    enqueue(store, chat, 'legacy', undefined);
    const before = statSync(path);
    for (let i = 0; i < 20; i++) assert.deepEqual(store.mirrorPublication(), { enabled: true, generation: null });
    unchanged(before, statSync(path));
    assert.equal(readdirSync(f.root).filter(name => name.endsWith('.bak')).length, 0);
    store.setSettings({ toolRestrictions: { enabled: true, disabledTools: ['AskUserQuestion'] } });
    assert.equal(store.output('legacy').state, 'pending');
    assert.equal(store.mirrorPublication().generation, null);
    assert.equal(JSON.parse(readFileSync(path, 'utf8').split('\n').slice(1).join('\n')).meta.config_version, 3);
    const digest = createHash('sha256').update(original).digest('hex');
    assert.equal(readFileSync(`${path}.v${version}-${digest}.bak`, 'utf8'), original);
    assert.equal(store.claimOutput('legacy'), true);
  }
});

test('same-value retries, tool saves and a lost commit receipt preserve newly accepted intents', t => {
  const f = fixture(t), { store, chat } = f.open();
  store.setSettings({ mirrorClientTurns: true });
  const publication = store.mirrorPublication();
  enqueue(store, chat, 'new', publication.generation);
  const exec = store.db.exec.bind(store.db);
  const mocked = t.mock.method(store.db, 'exec', sql => {
    exec(sql);
    if (sql === 'COMMIT') throw new Error('CONTROLLED_COMMIT_RECEIPT_LOST');
  });
  assert.throws(() => store.setSettings({ mirrorClientTurns: true }), { code: 'CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED', externalOutcome: 'unknown' });
  mocked.mock.restore();
  assert.deepEqual(store.mirrorPublication(), publication);
  store.setSettings({ mirrorClientTurns: true });
  store.setSettings({ toolRestrictions: { enabled: false, disabledTools: [] } });
  assert.deepEqual(store.mirrorPublication(), publication);
  assert.equal(store.claimOutput('new'), true);
});

test('file generations fence a disconnected peer database after both SQLite cancellations fail', t => {
  const f = fixture(t), { store: writer } = f.open('writer'), { store: peer, chat } = f.open('peer');
  writer.setSettings({ mirrorClientTurns: true });
  const first = peer.mirrorPublication(); enqueue(peer, chat, 'old', first.generation);
  const cancel = t.mock.method(writer, 'cancelPendingClientMirrors', () => { throw new Error('CONTROLLED_SQLITE_FULL'); });
  assert.throws(() => writer.setSettings({ mirrorClientTurns: false }), { code: 'CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED', externalOutcome: 'unknown' });
  assert.equal(peer.mirrorPublication().enabled, false);
  assert.throws(() => writer.setSettings({ mirrorClientTurns: true }), { code: 'CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED', externalOutcome: 'unknown' });
  cancel.mock.restore();
  assert.notEqual(peer.mirrorPublication().generation, first.generation);
  assert.equal(peer.claimOutput('old'), false);
  assert.equal(peer.output('old').receipt.code, 'CHANNEL_CLIENT_SYNC_DISABLED');
});

test('disable boundaries preserve original sending, accepted and unknown receipts and payloads', t => {
  const f = fixture(t), { store, chat } = f.open(); store.setSettings({ mirrorClientTurns: true });
  const generation = store.mirrorPublication().generation;
  for (const state of ['pending', 'sending', 'accepted', 'unknown']) enqueue(store, chat, state, generation, state);
  const original = ['sending', 'accepted', 'unknown'].map(id => store.output(id));
  store.setSettings({ mirrorClientTurns: false }); store.setSettings({ mirrorClientTurns: true });
  assert.equal(store.output('pending').state, 'failed');
  for (const row of original) {
    assert.equal(store.claimOutput(row.id), false);
    assert.deepEqual(store.output(row.id), row);
  }
});

test('manual off is observed without writes; missing or invalid v3 generation never grants enabled publication', t => {
  const f = fixture(t), file = new ChannelSettingsFile(f.root), path = file.path;
  for (const generation of [undefined, 'broken', 123, {}]) {
    const channels = { mirror_client_turns: true, ...(generation === undefined ? {} : { mirror_generation: generation }) };
    const source = JSON.stringify({ meta: { config_version: 3 }, channels }); writeFileSync(path, source);
    assert.throws(() => file.readPublication(), /CHANNEL_SETTINGS_INVALID/);
    assert.equal(readFileSync(path, 'utf8'), source);
  }
  writeFileSync(path, '{"meta":{"config_version":3},"channels":{"mirror_client_turns":false}}');
  const before = statSync(path);
  assert.equal(file.readPublication().enabled, false);
  unchanged(before, statSync(path));
  file.write({ mirrorClientTurns: false });
  const disabled = file.readPublication(); assert.equal(typeof disabled.generation, 'string');
  file.write({ mirrorClientTurns: false }); assert.deepEqual(file.readPublication(), disabled);
});

test('rename followed by a directory sync failure is unknown and fences old mirrors before SQL cancellation', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), { store, chat } = f.open(); store.setSettings({ mirrorClientTurns: true });
  const generation = store.mirrorPublication().generation; enqueue(store, chat, 'old', generation);
  const sync = fs.fsyncSync, stat = fs.fstatSync;
  const mocked = t.mock.method(fs, 'fsyncSync', fd => {
    if (stat(fd).isDirectory()) throw Object.assign(new Error('CONTROLLED_DIRECTORY_SYNC_FAILED'), { code: 'EIO' });
    return sync(fd);
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => store.setSettings({ mirrorClientTurns: false }), {
    message: 'CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED', code: 'CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED', externalOutcome: 'unknown',
  });
  mocked.mock.restore(); syncBuiltinESMExports();
  assert.equal(store.settings().mirrorClientTurns, false);
  assert.equal(store.output('old').state, 'pending', 'SQL cancellation was never acknowledged');
  store.setSettings({ mirrorClientTurns: true });
  assert.notEqual(store.mirrorPublication().generation, generation);
  assert.equal(store.claimOutput('old'), false);
});

test('cooperative API writers sharing one database serialize settings snapshots across independent threads', async t => {
  const f = fixture(t), { store } = f.open(), control = new SharedArrayBuffer(4), workers = [];
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { ChannelStore } = await import(workerData.module);
      const store = new ChannelStore(workerData.directory, { settingsDirectory: workerData.root });
      parentPort.postMessage('ready');
      await new Promise(resolve => parentPort.once('message', resolve));
      try {
        if (workerData.role === 'toggle') {
          const write = store.settingsFile.write.bind(store.settingsFile);
          store.settingsFile.write = settings => {
            parentPort.postMessage('locked');
            if (Atomics.wait(new Int32Array(workerData.control), 0, 0, 4000) === 'timed-out') throw new Error('fixture lock timeout');
            return write(settings);
          };
          store.setSettings({ mirrorClientTurns: true });
        } else {
          parentPort.postMessage('attempting');
          store.setSettings({ toolRestrictions: { enabled: true, disabledTools: ['WebSearch'] } });
        }
        parentPort.postMessage({ settings: store.settings(), publication: store.mirrorPublication() });
      } finally { store.close(); parentPort.close(); }
    })().catch(error => { throw error; });`;
  try {
    for (const role of ['toggle', 'policy']) {
      const worker = new Worker(source, { eval: true, workerData: { role, control, root: f.root,
        directory: store.directory, module: new URL('../src/channels/store.mjs', import.meta.url).href } });
      workers.push(worker); assert.deepEqual(await once(worker, 'message'), ['ready']);
    }
    const locked = once(workers[0], 'message'); workers[0].postMessage('start'); assert.deepEqual(await locked, ['locked']);
    const first = once(workers[0], 'message'), attempting = once(workers[1], 'message');
    workers[1].postMessage('start'); assert.deepEqual(await attempting, ['attempting']);
    const second = once(workers[1], 'message'); Atomics.store(new Int32Array(control), 0, 1); Atomics.notify(new Int32Array(control), 0);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a[0].settings.mirrorClientTurns, true); assert.equal(b[0].settings.mirrorClientTurns, true);
    assert.equal(a[0].publication.generation, b[0].publication.generation);
    assert.deepEqual(store.settings().toolRestrictions.disabledTools, ['WebSearch']);
  } finally {
    Atomics.store(new Int32Array(control), 0, 1); Atomics.notify(new Int32Array(control), 0);
    await Promise.all(workers.map(worker => worker.terminate()));
  }
});

test('warm settings observations have bounded file reads and no publishing, SQL writes or hashes; manual off stays current', t => {
  const f = fixture(t), { store } = f.open(); store.setSettings({ mirrorClientTurns: true });
  const counts = { reads: 0, writes: 0, renames: 0, syncs: 0, sql: 0, hashes: 0 };
  const original = { open: fs.openSync, write: fs.writeFileSync, rename: fs.renameSync, sync: fs.fsyncSync,
    exec: store.db.exec.bind(store.db), prepare: store.db.prepare.bind(store.db), hash: crypto.createHash };
  const mocks = [
    t.mock.method(fs, 'openSync', (...args) => { counts.reads++; return original.open(...args); }),
    t.mock.method(fs, 'writeFileSync', (...args) => { counts.writes++; return original.write(...args); }),
    t.mock.method(fs, 'renameSync', (...args) => { counts.renames++; return original.rename(...args); }),
    t.mock.method(fs, 'fsyncSync', (...args) => { counts.syncs++; return original.sync(...args); }),
    t.mock.method(store.db, 'exec', (...args) => { counts.sql++; return original.exec(...args); }),
    t.mock.method(store.db, 'prepare', (...args) => { counts.sql++; return original.prepare(...args); }),
    t.mock.method(crypto, 'createHash', (...args) => { counts.hashes++; return original.hash(...args); }),
  ];
  syncBuiltinESMExports(); t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
  for (let i = 0; i < 20; i++) {
    assert.equal(store.settings().mirrorClientTurns, true);
    assert.equal(store.mirrorPublication().enabled, true);
  }
  assert.ok(counts.reads > 0 && counts.reads <= 40);
  assert.deepEqual({ ...counts, reads: 0 }, { reads: 0, writes: 0, renames: 0, syncs: 0, sql: 0, hashes: 0 });
  const path = join(f.root, 'settings.json'), document = JSON.parse(readFileSync(path, 'utf8'));
  document.channels.mirror_client_turns = false; original.write(path, JSON.stringify(document));
  assert.equal(store.settings().mirrorClientTurns, false); assert.equal(store.mirrorPublication().enabled, false);
  original.write(path, '{bad');
  assert.throws(() => store.mirrorPublication(), /CHANNEL_SETTINGS_INVALID/);
});

test('publication decisions derive enabled and generation from one held document snapshot', t => {
  const f = fixture(t), file = new ChannelSettingsFile(f.root), path = file.path;
  const a = { meta: { config_version: 3 }, channels: { mirror_client_turns: true, mirror_generation: '11111111-1111-4111-8111-111111111111' } };
  const b = { meta: { config_version: 3 }, channels: { mirror_client_turns: false, mirror_generation: '22222222-2222-4222-8222-222222222222' } };
  writeFileSync(path, JSON.stringify(a));
  const read = file.readDocument.bind(file); let reads = 0;
  t.mock.method(file, 'readDocument', () => { const snapshot = read(); if (++reads === 1) writeFileSync(path, JSON.stringify(b)); return snapshot; });
  assert.deepEqual(file.readPublication(), { enabled: true, generation: a.channels.mirror_generation });
  assert.equal(reads, 1);
  assert.deepEqual(file.readPublication(), { enabled: false, generation: b.channels.mirror_generation });
  assert.equal(reads, 2);
});
