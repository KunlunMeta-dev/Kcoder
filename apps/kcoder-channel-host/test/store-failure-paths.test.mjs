import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectivityStore } from '../src/applications/store.mjs';
import { ChannelError } from '../src/errors.mjs';
import { createFixtureStore, removeFixtureStore } from './store-fixture.mjs';

const scope = { accountId: 'owner', targetId: 'local', workspaceId: null, identityGeneration: '1', targetRevision: '1' };
function root(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'kcoder-store-failure-'));
  t.after(() => removeFixtureStore(directory));
  return directory;
}
function patchFs(t, name, implementation) {
  const mock = t.mock.method(fs, name, implementation);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}
function trackHandles(t, { failClose = true } = {}) {
  const opened = [], closed = [];
  const open = fs.openSync, close = fs.closeSync;
  patchFs(t, 'openSync', (...args) => { const fd = open(...args); opened.push(fd); return fd; });
  let injected = false;
  patchFs(t, 'closeSync', fd => {
    close(fd); closed.push(fd);
    if (failClose && !injected) { injected = true; throw Object.assign(new Error('injected close failure'), { code: 'EIO' }); }
  });
  t.after(() => { for (const fd of opened) if (!closed.includes(fd)) { try { close(fd); } catch {} } });
  return { opened, closed };
}

test('a reopened writer enforces the original configured capacity and preserves committed data after SQLITE_FULL', t => {
  const directory = root(t), maxMetadataBytes = 1024 * 1024;
  const initial = createFixtureStore(directory, { maxMetadataBytes });
  initial.putEntity('probe', scope, 'original', { value: 'kept' });
  initial.close();
  const store = ConnectivityStore.open(directory, { assertExclusiveLease: () => true, maxMetadataBytes });
  t.after(() => store.close());
  let failure, committed = 0;
  for (; committed < 80; committed++) {
    try { store.putEntity('probe', scope, 'row-' + committed, { value: 'x'.repeat(24 * 1024) }); }
    catch (error) { failure = error; break; }
  }
  assert.ok(failure, 'the configured 1 MiB limit must stop a bounded sequence of 24 KiB rows');
  assert.equal(failure.code, 'STORE_CAPACITY_EXCEEDED');
  assert.equal(failure.cause?.errcode, 13, 'the original SQLite FULL evidence must survive rollback');
  assert.equal(store.readEntity('probe', scope, 'original').value, 'kept');
  assert.equal(store.readEntity('probe', scope, 'row-' + committed), null);
  for (let index = 0; index < committed; index++) assert.equal(store.readEntity('probe', scope, 'row-' + index).value.length, 24 * 1024);
  const observer = new DatabaseSync(join(directory, 'connectivity.sqlite3'), { readOnly: true });
  try {
    const storedBytes = observer.prepare('PRAGMA page_size').get().page_size * observer.prepare('PRAGMA page_count').get().page_count;
    assert.ok(storedBytes <= maxMetadataBytes);
    t.diagnostic(JSON.stringify({ configuredBytes: maxMetadataBytes, committedRows: committed, storedBytes, sqliteCode: failure.cause.errcode }));
  } finally { observer.close(); }
});

test('lazy writer initialization refuses a database that grew beyond its limit after the read-only open', t => {
  const directory = root(t), maxMetadataBytes = 1024 * 1024;
  const initial = createFixtureStore(directory, { maxMetadataBytes }); initial.close();
  const store = ConnectivityStore.open(directory, { assertExclusiveLease: () => true, maxMetadataBytes });
  t.after(() => store.close());
  const other = new DatabaseSync(join(directory, 'connectivity.sqlite3'));
  try {
    const insert = other.prepare('INSERT INTO entities VALUES(?,?,?,?,?)');
    for (let index = 0; index < 50; index++) insert.run('probe', 'fixture-only-owner', 'external-' + index, 1, JSON.stringify({ value: 'x'.repeat(24 * 1024) }));
    const before = other.prepare('PRAGMA page_count').get().page_count;
    assert.throws(() => store.putEntity('probe', scope, 'forbidden', { value: 'no' }), /STORE_CAPACITY_EXCEEDED/);
    assert.equal(other.prepare('PRAGMA page_count').get().page_count, before);
    assert.equal(store.readEntity('probe', scope, 'forbidden'), null);
  } finally { other.close(); }
});

test('receipt writes complete short writes before truncation and flush', t => {
  const directory = root(t), write = fs.writeSync;
  let calls = 0;
  patchFs(t, 'writeSync', (fd, bytes, offset, length, position) => {
    calls++;
    return write(fd, bytes, offset, Math.min(length, 7), position);
  });
  const store = createFixtureStore(directory);
  store.close();
  assert.ok(calls > 2);
  assert.equal(JSON.parse(fs.readFileSync(directory + '.binding.json', 'utf8')).version, 1);
});

test('a zero-progress receipt write fails closed and retains the original initialization files', t => {
  const directory = root(t);
  patchFs(t, 'writeSync', () => 0);
  assert.throws(() => createFixtureStore(directory), /STORE_BINDING_WRITE_UNCONFIRMED/);
  assert.equal(fs.existsSync(directory + '.binding.json'), true);
  assert.equal(fs.existsSync(join(directory, 'connectivity.sqlite3')), true);
});

test('an unconfirmed rollback preserves its original error, closes the writer lane and retains read-only observation', t => {
  const directory = root(t), store = createFixtureStore(directory);
  t.after(() => store.close());
  store.putEntity('probe', scope, 'original', { value: 'kept' });
  const exec = DatabaseSync.prototype.exec;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function(sql) {
    if (sql === 'ROLLBACK') throw new Error('injected rollback failure');
    return exec.call(this, sql);
  });
  t.after(() => mock.mock.restore());
  const original = new ChannelError('REVISION_CONFLICT', 'repair_configuration');
  assert.throws(() => store.transaction(() => {
    store.putEntityInTransaction('probe', scope, 'uncommitted', { value: 'no' });
    throw original;
  }), error => error === original);
  assert.equal(store.readEntity('probe', scope, 'original').value, 'kept');
  assert.equal(store.readEntity('probe', scope, 'uncommitted'), null);
  assert.throws(() => store.putEntity('probe', scope, 'forbidden', { value: 'no' }), /STORE_WRITER_UNCONFIRMED/);
  store.close();
  mock.mock.restore();
  const reopened = ConnectivityStore.open(directory, { assertExclusiveLease: () => true });
  try { assert.equal(reopened.putEntity('probe', scope, 'reopened', { value: 'safe' }).revision, '1'); }
  finally { reopened.close(); }
});

test('open failure attempts every anchor close and retains the original schema diagnosis', t => {
  const directory = root(t), initial = createFixtureStore(directory);
  initial.close();
  const corrupt = new DatabaseSync(join(directory, 'connectivity.sqlite3'));
  corrupt.exec('PRAGMA user_version=3'); corrupt.close();
  const handles = trackHandles(t);
  assert.throws(() => ConnectivityStore.open(directory), error => error.code === 'STORE_SCHEMA_CORRUPT');
  assert.deepEqual(handles.closed.toSorted(), handles.opened.toSorted());
});

test('initialization failure preserves its primary error while closing every owned descriptor', t => {
  const directory = root(t), handles = trackHandles(t), flush = fs.fsyncSync;
  const primary = new ChannelError('STORE_BINDING_WRITE_UNCONFIRMED', 'repair_configuration');
  let calls = 0;
  patchFs(t, 'fsyncSync', fd => { if (++calls === 4) throw primary; return flush(fd); });
  assert.throws(() => createFixtureStore(directory), error => error === primary);
  assert.deepEqual(handles.closed.toSorted(), handles.opened.toSorted());
  assert.equal(fs.existsSync(directory + '.binding.json'), true);
});

test('successful initialization cannot report success when an owned descriptor close is unconfirmed', t => {
  const directory = root(t), handles = trackHandles(t);
  assert.throws(() => createFixtureStore(directory), error => error.code === 'STORE_CLOSE_UNCONFIRMED');
  assert.deepEqual(handles.closed.toSorted(), handles.opened.toSorted());
  assert.equal(fs.existsSync(directory + '.binding.json'), true);
});

test('a rejected initialization retry retains STORE_ALREADY_BOUND even when closing its observed store fails', t => {
  const directory = root(t), store = createFixtureStore(directory, { initializationId: 'original' });
  store.close();
  const handles = trackHandles(t);
  assert.throws(() => createFixtureStore(directory, { initializationId: 'different' }), error => error.code === 'STORE_ALREADY_BOUND' && error.recovery === 'reconcile_original');
  assert.deepEqual(handles.closed.toSorted(), handles.opened.toSorted());
});

test('creation binds the expected Native namespace before opening and never creates missing parent trees', t => {
  const directory = root(t);
  const store = createFixtureStore(directory, { expectedNamespaceId: 'native-namespace' });
  assert.equal(store.storage.binding.namespaceId, 'native-namespace');
  store.close();
  const missing = join(directory, 'absent-parent', 'store');
  assert.throws(() => createFixtureStore(missing), error => error.code === 'STORE_DIRECTORY_MISSING' && error.recovery === 'repair_configuration');
  assert.equal(fs.existsSync(join(directory, 'absent-parent')), false);
});

test('invalid cursors and scopes reject before SQL binding and invalid operation states never poison a pending intent', t => {
  const directory = root(t), store = createFixtureStore(directory);
  t.after(() => store.close());
  store.putEntity('probe', scope, 'original', { value: 'kept' });
  for (const after of [null, 12, {}, []]) assert.throws(() => store.listEntities('probe', scope, { after }), /INVALID_CURSOR/);
  const malformed = { ...scope }; delete malformed.identityGeneration;
  assert.throws(() => store.readEntity('probe', malformed, 'original'), /INVALID_SCOPE/);
  assert.throws(() => store.listEntities('probe', malformed), /INVALID_SCOPE/);
  store.beginOperation(scope, 'op', 'save', {});
  assert.throws(() => store.finishOperation(scope, 'op', { value: 'kept' }, 'unknown-state'), /INVALID_OPERATION_STATE/);
  assert.equal(store.beginOperation(scope, 'op', 'save', {}).state, 'pending');
  store.finishOperation(scope, 'op', { value: 'kept' });
  assert.equal(store.beginOperation(scope, 'op', 'save', {}).state, 'completed');
});

test('a missing held anchor reports a repairable missing-binding diagnosis without recreating the file', t => {
  const directory = root(t), store = createFixtureStore(directory);
  t.after(() => store.close());
  const path = join(directory, 'connectivity.lock'); fs.rmSync(path);
  assert.throws(() => store.readEntity('probe', scope, 'original'), error => error.code === 'STORE_BINDING_OR_DATA_MISSING' && error.recovery === 'repair_configuration');
  assert.equal(fs.existsSync(path), false);
});
