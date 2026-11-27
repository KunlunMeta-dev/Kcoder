import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertOwnedSourceTree } from './owned-source-tree.mjs';

test('copied-source traversal refuses a symlink without changing its target', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-source-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owned = join(root, 'owned'), outside = join(root, 'outside');
  await mkdir(owned);
  await writeFile(outside, 'unrelated');
  await symlink(outside, join(owned, 'link'));
  await assert.rejects(assertOwnedSourceTree(owned), /regular files and directories/);
  assert.equal(await readFile(outside, 'utf8'), 'unrelated');
});
