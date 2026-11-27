import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runE2E } from '../run-context.mjs';
import { cleanupOwnedPeerUidImage, createPeerUidDockerConnection, observeOwnedPeerUidImage } from './image.mjs';

assert.equal(process.env.KCODER_E2E_PEER_UID_CONTAINER_CLEANUP, '1', 'Explicit cleanup gate required');
assert.equal(process.argv.length, 3, 'Usage: cleanup-image.mjs ORIGINAL_IMAGE_RECEIPT');
const receiptPath = resolve(process.argv[2]);
await runE2E(import.meta.url, { testId: 'cleanup-original-peer-uid-fixture-image', tier: 'platform-cleanup', modelPolicy: 'Remove only the exact original owned Docker image; no container/account/model execution.' }, async context => {
  const info = await lstat(receiptPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 128 * 1024);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.schemaVersion, 1);
  assert.ok(['apps/kcoder-studio/e2e/fixtures/accounts/Dockerfile', 'apps/kcoder-studio/e2e/harness/peer-uid-container/Dockerfile.offline'].includes(receipt.source));
  const execute = await createPeerUidDockerConnection(context);
  const handle = await observeOwnedPeerUidImage(context, receipt, execute);
  await cleanupOwnedPeerUidImage(context, handle);
  return { originalImageId: receipt.imageId, originalTag: receipt.tag, removedOnlyOriginalTag: true };
});
