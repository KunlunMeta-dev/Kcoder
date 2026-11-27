import assert from 'node:assert/strict';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Validate an owned source tree without following links or changing its entries. */
export async function assertOwnedSourceTree(directory) {
  const visit = async path => {
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink() && (info.isFile() || info.isDirectory()),
      'Owned source must contain only regular files and directories');
    if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(directory);
}
