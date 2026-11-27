import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runE2E } from '../run-context.mjs';
import { cleanupOwnedPeerUidImage, createPeerUidDockerConnection, observeOwnedPeerUidImage, requirePeerUidContainerConsent } from './image.mjs';

requirePeerUidContainerConsent();
assert.equal(process.argv.length, 3, 'Usage: reconcile-offline-image.mjs ORIGINAL_OWNER_ARTIFACT');
const ownerPath = resolve(process.argv[2]), originalRun = dirname(dirname(ownerPath));
async function boundedJson(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 4 * 1024 * 1024);
  return JSON.parse(await readFile(path, 'utf8'));
}
await runE2E(import.meta.url, { testId: 'reconcile-original-offline-peer-uid-image', tier: 'platform-preparation', retainSuccessLogs: true,
  modelPolicy: 'Reconcile the original successful offline image after a metadata-parser failure. No rebuild, container/account/SSH/model execution.' }, async context => {
  const original = await boundedJson(ownerPath);
  assert.equal(original.schemaVersion, 1);
  assert.equal(original.source, 'apps/kcoder-studio/e2e/harness/peer-uid-container/Dockerfile.offline');
  const imageId = (await readFile(resolve(originalRun, 'state/peer-uid-image.id'), 'utf8')).trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const rootfs = await boundedJson(resolve(originalRun, 'artifacts/offline-rootfs-inventory.json'));
  assert.equal(rootfs.hostAccountDatabaseCopied, false); assert.equal(rootfs.hostKeysCopied, false); assert.equal(rootfs.hostEtcCopied, false);
  const execute = await createPeerUidDockerConnection(context);
  const handle = await observeOwnedPeerUidImage(context, { ...original, imageId }, execute);
  let handedOff = false;
  context.addCleanup('remove only unhanded reconciled peer UID image', () => handedOff ? undefined : cleanupOwnedPeerUidImage(context, handle));
  const receipt = { ...original, imageId, state: 'prepared_retained_for_later_uid_acceptance', base: 'scratch',
    originalFailedPreparationRun: originalRun, originalFailureRetained: true, reconciledWithoutRebuild: true,
    rootfsSha256: rootfs.rootfsSha256, rootfsFileCount: rootfs.fileCount, rootfsBytes: rootfs.bytes,
    nativeDependencyInput: rootfs.nativeDependencyInput, endpoint: 'unix:///var/run/docker.sock',
    hostAccountsModified: false, testContainersStarted: 0, sshServersStarted: 0, modelCalls: 0,
    note: 'Image preparation and reconciliation only; different UID SSH acceptance remains unexecuted.' };
  await context.writeArtifactJson('peer-uid-image.json', receipt);
  await context.writeArtifactJson('offline-rootfs-inventory.json', rootfs);
  handedOff = true;
  return receipt;
});
