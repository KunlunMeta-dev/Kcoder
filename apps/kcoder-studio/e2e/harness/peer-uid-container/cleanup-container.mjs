import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runE2E } from '../run-context.mjs';
import { createPeerUidDockerConnection } from './image.mjs';
import { capturePeerUidContainer, removeStoppedPeerUidContainer } from './container.mjs';

assert.equal(process.env.KCODER_E2E_PEER_UID_CONTAINER_CLEANUP, '1', 'Explicit original container cleanup gate required');
assert.equal(process.argv.length, 3, 'Original container owner artifact required');
await runE2E(import.meta.url, { testId: 'cleanup-original-stopped-peer-uid-container', tier: 'platform-cleanup',
  modelPolicy: 'Remove only the exact stopped original UID test container after identity/image/owner/mount verification.' }, async context => {
  const path = resolve(process.argv[2]), info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < 128 * 1024);
  const expected = JSON.parse(await readFile(path, 'utf8'));
  const execute = await createPeerUidDockerConnection(context);
  const handle = await capturePeerUidContainer(context, expected, execute);
  await removeStoppedPeerUidContainer(context, handle);
  return { originalContainerId: expected.id, originalImage: expected.image, onlyOriginalStoppedContainerRemoved: true, accountRetirementReceiptWasNotFabricated: true };
});
