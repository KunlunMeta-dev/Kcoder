import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceBudgetStorage } from './migrationResourceBudgetStorage.mjs';
import { budgetIndexedDbFixture } from './migrationResourceBudgetIndexedDbFixture.mjs';
const key = 'kcoder.migration.resource-budget.v1:owned-target:mig-owned';
const legacyStore = () => { const rows = new Map(); return { rows, getItem: key => rows.get(key) ?? null }; };
test('normal HTTP does not need Web Locks: selector transactions use IndexedDB and reads do not create rows', async () => {
  const db = budgetIndexedDbFixture(), storage = legacyStore(), adapter = createResourceBudgetStorage({ storage, indexedDB: db.indexedDB, isCurrent: () => true });
  assert.equal(adapter.getItem(key), null); await adapter.refresh(key); assert.equal(db.rows.size, 0);
  await adapter.withTransaction(key, local => { assert.equal(local.getItem(key), null); local.setItem(key, 'complete-selector'); });
  assert.deepEqual(db.modes, ['readonly', 'readwrite']); assert.equal(db.rows.get(key).raw, 'complete-selector'); assert.equal(storage.rows.size, 0);
  adapter.close(); assert.equal(db.closes(), 1);
});
test('legacy bytes remain unchanged and an older client rewriting them fails closed without overwriting either selector', async () => {
  const db = budgetIndexedDbFixture(), storage = legacyStore(); storage.rows.set(key, 'original-v1');
  const adapter = createResourceBudgetStorage({ storage, indexedDB: db.indexedDB, isCurrent: () => true });
  await adapter.withTransaction(key, local => { assert.equal(local.getItem(key), 'original-v1'); local.setItem(key, 'v2-owned'); });
  assert.equal(storage.rows.get(key), 'original-v1'); storage.rows.set(key, 'older-peer-new-intent');
  await assert.rejects(adapter.withTransaction(key, local => local.setItem(key, 'not-written')), /migration_recovery_storage_changed/);
  assert.equal(db.rows.get(key).raw, 'v2-owned'); assert.equal(storage.rows.get(key), 'older-peer-new-intent'); adapter.close();
});
test('missing IndexedDB rejects writes instead of falling back to localStorage CAS', async () => {
  const storage = legacyStore(), adapter = createResourceBudgetStorage({ storage, isCurrent: () => true });
  await assert.rejects(adapter.withTransaction(key, local => local.setItem(key, 'never-written')), /migration_recovery_storage_unavailable/);
  assert.equal(storage.rows.size, 0);
});
test('a revoked original scope cannot update metadata, and closing aborts only this adapter connection', async () => {
  const db = budgetIndexedDbFixture(), storage = legacyStore(); let current = true;
  const first = createResourceBudgetStorage({ storage, indexedDB: db.indexedDB, isCurrent: () => current });
  const second = createResourceBudgetStorage({ storage, indexedDB: db.indexedDB, isCurrent: () => true });
  await first.refresh(key); const update = first.withTransaction(key, local => local.setItem(key, 'never-written'));
  current = false; await assert.rejects(update, /migration_scope_changed|migration_recovery_storage_unavailable/);
  first.close(); await second.withTransaction(key, local => local.setItem(key, 'peer-owned')); assert.equal(db.rows.get(key).raw, 'peer-owned'); second.close();
});
