import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { waitFor } from './run-context.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

/** Test observation only: inspect the canonical native record inside this run's
 * isolated Receiver fixture. Product recovery cannot use a shared filesystem. */
async function originalReceiverRecord(receiverProfile, accepted) {
  const identity = accepted?.identity;
  assert.ok(identity && Object.values(identity).every(identifier), 'actual native Accepted identity required');
  const root = join(receiverProfile, 'projects');
  const projects = await readdir(root, { withFileTypes: true });
  assert.ok(projects.length <= 8, 'bounded fresh owned Receiver projects');
  const candidates = [];
  for (const project of projects) {
    assert.ok(project.isDirectory() && !project.isSymbolicLink(), 'only owned project directories');
    const leaf = `${sha(identity.attemptId)}.attempt.json`;
    const parts = [project.name, 'client-sessions', identity.threadId, 'turn-attempts', leaf];
    let path = root;
    let missing = false;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      const meta = await lstat(path).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!meta) { missing = true; break; }
      assert.ok(!meta.isSymbolicLink() && meta.uid === process.getuid(), 'owned native record path identity');
      if (index === parts.length - 1) assert.ok(meta.isFile() && meta.nlink === 1 && meta.size <= 1024 * 1024);
      else assert.ok(meta.isDirectory());
    }
    if (!missing) candidates.push({ path, bytes: await readFile(path) });
  }
  assert.equal(candidates.length, 1, 'exact original native record, never latest selection');
  const record = JSON.parse(candidates[0].bytes);
  assert.deepEqual(record.identity, identity);
  const normalized = { ...record, status: 'accepted', completion: null };
  assert.equal(sha(JSON.stringify(normalized)), accepted.acceptedReceiptSha256, 'original native Accepted body hash');
  return { record, recordSha256: sha(candidates[0].bytes) };
}

export async function prepareRemoteNativeDisconnect(context, kind = 'completion') {
  assert.ok(['completion', 'artifact_chunk'].includes(kind));
  const directory = context.pathInArtifacts('owned-remote-disconnect');
  await mkdir(directory, { mode: 0o700 });
  return { directory, kind };
}

export async function disconnectAfterActualReceiverCompletion(context, fixture, receiverProfile) {
  const held = await waitFor(async () => {
    const value = await readFile(join(fixture.directory, 'remote-transport-disconnect.json'), 'utf8')
      .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return value?.held ? value : null;
  }, 120_000, 'actual Receiver ACP final reply held before Source receives it');
  assert.ok(held.operationId && held.endpointInstanceId && held.accepted?.identity);
  const canonical = await originalReceiverRecord(receiverProfile, held.accepted);
  assert.equal(canonical.record.status, 'completed');
  assert.equal(canonical.record.completion?.status, 'completed');
  await context.writeArtifactJson('receiver-completed-before-ssh-disconnect.json', {
    operationId: held.operationId, endpointInstanceId: held.endpointInstanceId,
    accepted: held.accepted, canonicalStatus: canonical.record.status,
    canonicalRecordSha256: canonical.recordSha256, originalReplyWasForwarded: held.replyWasForwarded,
    actualOriginalPromptId: held.promptId, actualOriginalArtifactChunkId: held.artifactChunkId,
    partialReplyBytesForwarded: held.partialReplyBytesForwarded, testFilesystemObservationOnly: true,
  });
  await writeFile(join(fixture.directory, 'remote-disconnect-plan.json'), JSON.stringify({
    operationId: held.operationId, endpointInstanceId: held.endpointInstanceId, disconnect: true,
  }), { mode: 0o600 });
  return { held, canonicalRecordSha256: canonical.recordSha256 };
}
