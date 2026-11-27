import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureStore, removeFixtureStore } from './store-fixture.mjs';

const scope = { accountId: 'owner', targetId: 'target', workspaceId: null,
  identityGeneration: '1', targetRevision: '1' };
function fixture(t, options) {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-store-read-cost-'));
  const store = createFixtureStore(root, options);
  t.after(() => { store.close(); removeFixtureStore(root); });
  store.putEntity('probe', scope, 'original', { value: 'original' });
  store.readEntity('probe', scope, 'original');
  return { root, store };
}
function countSchemaReads(t) {
  const prepare = DatabaseSync.prototype.prepare;
  let scans = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    if (sql.includes('FROM sqlite_schema')) scans++;
    return prepare.call(this, sql);
  };
  t.after(() => { DatabaseSync.prototype.prepare = prepare; });
  return () => scans;
}

test('unchanged warm reads do not rescan or hash the complete database schema', t => {
  const { store } = fixture(t), scans = countSchemaReads(t);
  for (let i = 0; i < 100; i++)
    assert.equal(store.readEntity('probe', scope, 'original').value, 'original');
  assert.equal(scans(), 0);
});

test('another connection invalidates structural evidence without caching business rows', t => {
  const { root, store } = fixture(t), scans = countSchemaReads(t);
  const other = new DatabaseSync(join(root, 'connectivity.sqlite3'));
  try { other.prepare("UPDATE entities SET value_json=? WHERE kind='probe'")
    .run(JSON.stringify({ value: 'changed' })); } finally { other.close(); }
  assert.equal(store.readEntity('probe', scope, 'original').value, 'changed');
  assert.equal(scans(), 1);
  store.readEntity('probe', scope, 'original');
  assert.equal(scans(), 1);
});

test('own mutations invalidate evidence and cannot conceal damaged metadata', t => {
  const { store } = fixture(t);
  store.db.prepare("DELETE FROM meta WHERE key='binding_hash'").run();
  assert.throws(() => store.readEntity('probe', scope, 'original'), /STORE_META_CORRUPT/);
});

test('warm structural evidence cannot retain an expired native writing lease', t => {
  let current = true;
  const { store } = fixture(t, { assertExclusiveLease: () => current });
  current = false;
  assert.throws(() => store.putEntity('probe', scope, 'forbidden', { value: 'no' }),
    /NATIVE_STORE_LEASE_REQUIRED/);
  assert.equal(store.readEntity('probe', scope, 'forbidden'), null);
});
