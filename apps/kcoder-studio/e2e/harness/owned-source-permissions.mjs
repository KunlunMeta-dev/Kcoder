import assert from 'node:assert/strict';
import { chmod, chown, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Only a freshly copied tree inside an owned private fixture may be passed here. */
export async function secureOwnedSourceTree(directory, { uid, gid } = {}) {
  const visit = async path => {
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink() && (info.isFile() || info.isDirectory()), 'Owned source must contain only copied regular files and directories');
    await chmod(path, info.isDirectory() ? 0o700 : 0o600);
    if (process.getuid() === 0 && uid !== undefined) await chown(path, uid, gid);
    if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(directory);
}
