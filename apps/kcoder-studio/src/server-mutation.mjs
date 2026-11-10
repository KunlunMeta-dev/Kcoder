import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writePrivateFile } from '../../kcoder-channel-host/src/jsonc-file.mjs';

/** Serialize the complete read/modify/publish cycle, including in-memory state. */
export function createServerMutationQueue() {
  let tail = Promise.resolve();
  return operation => {
    const current = tail.then(operation);
    tail = current.catch(() => {});
    return current;
  };
}

export async function writeServerConfiguration(path, values) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writePrivateFile(path, `${JSON.stringify(values, null, 2)}\n`);
}
