import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Exercise public attachment channels only. An execution-target locator never
// becomes a local desktop file by relabelling its path or changing a target ID.
export async function verifyFormalDesktopMaterialTransfer(context, { local, remote, localThreadId, remoteThreadId }) {
  const original = Buffer.from('OWNED_REMOTE_DESKTOP_MATERIAL\nformal byte transfer only\n');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const owned = [];
  const cleanup = async () => {
    while (owned.length) {
      const { rpc, path, uploadId } = owned.at(-1);
      await rpc.request(path ? 'attachment/delete' : 'attachment/upload/cancel',
        path ? { path } : { upload_id: uploadId }); owned.pop();
    }
  };
  context.addCleanup('release only owned desktop material uploads', cleanup);
  const upload = async (rpc, bytes) => {
    const start = await rpc.request('attachment/upload/start', { filename: 'desktop-material.txt', size: bytes.length });
    const receipt = { rpc, uploadId: start.upload_id }; owned.push(receipt);
    await rpc.request('attachment/upload/chunk', { upload_id: start.upload_id, index: 0, content_base64: bytes.toString('base64') });
    const finished = await rpc.request('attachment/upload/finish', { upload_id: start.upload_id });
    assert.equal(typeof finished.path, 'string'); receipt.path = finished.path; return finished.path;
  };
  const remoteLocator = await upload(remote, original);
  await assert.rejects(local.request('attachment/read', { threadId: localThreadId, path: remoteLocator }),
    /attachment|thread|resource/i, 'remote locator alone must not grant local material access');
  const received = await remote.request('attachment/read', { threadId: remoteThreadId, path: remoteLocator });
  assert.equal(typeof received.contentBase64, 'string');
  const transported = Buffer.from(received.contentBase64, 'base64');
  assert.equal(received.size, original.length); assert.deepEqual(transported, original);
  const localLocator = await upload(local, transported);
  assert.notEqual(localLocator, remoteLocator);
  await assert.rejects(remote.request('attachment/read', { threadId: remoteThreadId, path: localLocator }),
    /attachment|thread|resource/i, 'local material locator cannot be read through the remote owner');
  const localRead = await local.request('attachment/read', { threadId: localThreadId, path: localLocator });
  assert.deepEqual(Buffer.from(localRead.contentBase64, 'base64'), original);
  const proof = { bytes: original.length, originalSha256: sha(original), receivedSha256: sha(transported),
    localSha256: sha(Buffer.from(localRead.contentBase64, 'base64')), remotePathRejectedLocally: true,
    localPathRejectedRemotely: true, separateOwnedLocators: true, publicChunkUploadReadRoundtrip: true,
    desktopLeaseGranted: false, fileSystemPathsReadByHarness: false, actualCrossHostFilesystemClaim: false };
  await cleanup();
  return proof;
}
