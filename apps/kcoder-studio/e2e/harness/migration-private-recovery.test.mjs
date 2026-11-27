import assert from 'node:assert/strict';
import test from 'node:test';
import { clearPrivateMigrationRecovery } from './migration-private-recovery.mjs';

test('cache-loss acceptance removes only exact migration selectors and keeps authentication and peer storage', async () => {
  const values = new Map([['kcoder.migration.private:scope:run', 'public selectors'], ['kcoder.migration.private-prepare:scope:job:set', 'public intent'],
    ['kcoder.mobile.private-prepare:scope:job:old', 'public legacy intent'], ['kcoder.mobile.private-cancel:scope:offer:target', 'public cancel identity'],
    ['kcoder.profile', 'owned account'], ['kcoder.migration.private-other', 'other metadata'], ['credential', 'SYNTHETIC_NEVER_READ']]);
  const storage = new Proxy({}, { ownKeys: () => [...values.keys()], getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
    get: (_target, name) => name === 'removeItem' ? key => values.delete(key) : undefined });
  const before = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const result = await clearPrivateMigrationRecovery({ evaluate: (fn, input) => fn(input) });
    assert.deepEqual(result, { removed: 4, remaining: 0 }); assert.equal(values.size, 3);
    assert.equal(values.get('kcoder.profile'), 'owned account'); assert.equal(values.get('credential'), 'SYNTHETIC_NEVER_READ');
  } finally {
    if (before === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: before });
  }
});
