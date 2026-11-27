import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordApplicationStartupFailure } from '../src/applications/startup-diagnostics.mjs';

test('startup evidence stays in the captured directory after pathname replacement', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'owned-startup-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const named = join(root, 'runtime'), held = join(root, 'captured'), foreign = join(root, 'foreign');
  await fs.mkdir(named, { mode: 0o700 }); await fs.mkdir(foreign, { mode: 0o700 });
  const original = fs.open;
  const mocked = t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await original(path, ...args);
    if (path === named) {
      await fs.rename(named, held);
      await fs.symlink(foreign, named);
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await recordApplicationStartupFailure(new Error('inert fixture'), { runtimeDirectory: named }), true);
    assert.deepEqual(await fs.readdir(foreign), []);
    assert.deepEqual(await fs.readdir(held), [`kcoder-application-startup-${process.pid}.json`]);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});
