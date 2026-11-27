import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, win32 as windowsPath } from 'node:path';

const sha = data => createHash('sha256').update(data).digest('hex');
const partBytes = 192 * 1024;

export function ownedWindowsEvidencePath(root, path) {
  const localPath = /^(?:\\\\\?\\)?[A-Za-z]:\\[^:\0\r\n]*$/;
  assert.match(root, localPath);
  assert.match(path, localPath);
  const child = windowsPath.relative(windowsPath.toNamespacedPath(root), windowsPath.toNamespacedPath(path));
  assert.ok(child && !child.startsWith('..') && !windowsPath.isAbsolute(child),
    `owned evidence path escaped fixture: ${JSON.stringify({ root, path })}`);
  return path;
}

export function runtimeSeedAttachmentDescriptors(rows) {
  // State HistoryEntry flattens Message; source vendor rows instead nest their message.
  const seeds = rows.filter(row => row.role === 'user' && row.origin === 'runtime');
  assert.equal(seeds.length, 1);
  return seeds[0].content.flatMap(block => {
    if (block.type !== 'text') return [];
    try { const parsed = JSON.parse(block.text); return parsed.historical_attachment ? [parsed.historical_attachment] : []; }
    catch { return []; }
  });
}

/** Exercises explicit browser-style bytes inside the existing owned Windows RPC worker. */
export async function runWindowsLocalAttachmentCase({ root, profile, workspace, jobId, viewId, rpc, raw, settle, restart }) {
  const selection = { jobId, viewId, position: 4, blockIndex: 0 };
  const operationId = randomUUID();
  const originalFile = join(workspace, 'selected current supplement 中文.txt');
  const bytes = Buffer.from('Current explicit supplement only. '.repeat(12500)).subarray(0, 400000);
  assert.equal(bytes.length, 400000);
  await writeFile(originalFile, bytes);
  const expectedSha256 = sha(bytes);
  const method = name => `migration/history/local-attachment/${name}`;
  const state = () => settle(method('read'), { operationId }, value => value.workerRunning === false);
  assert.deepEqual((await rpc(method('list'), { selection })).items, []);
  let current = await rpc(method('prepare'), { requestId: operationId, selection });
  assert.equal(current.upload.operationId, operationId);
  assert.equal(current.upload.stage, 'prepared');
  assert.equal(current.upload.localJob, null);
  const begin = { operationId, expectedSequence: current.upload.sequence,
    filename: 'explicit supplement.txt', bytes: bytes.length, sha256: expectedSha256 };
  const forbidden = await raw(method('begin'), { ...begin, sourcePath: originalFile });
  assert.equal(forbidden.error?.message, 'migration_invalid_parameters');
  assert.equal((await rpc(method('read'), { operationId })).upload.stage, 'prepared');
  current = await rpc(method('begin'), begin);
  let sentParts = 0;
  for (let offset = 0; offset < bytes.length; offset += partBytes) {
    const part = bytes.subarray(offset, offset + partBytes);
    current = await rpc(method('part'), { operationId, expectedSequence: current.upload.sequence,
      index: sentParts++, contentBase64: part.toString('base64') });
    assert.equal(current.upload.receivedBytes, offset + part.length);
    assert.equal(current.upload.receivedParts, sentParts);
    assert.equal(current.upload.localJob, null);
    if (sentParts === 1) {
      await restart();
      const restored = await rpc(method('read'), { operationId });
      assert.equal(restored.upload.receivedBytes, partBytes);
      assert.equal(restored.upload.sha256, expectedSha256);
      current = restored;
    }
  }
  assert.equal(sentParts, 3);
  await unlink(originalFile);
  assert.equal(await access(originalFile).then(() => true, () => false), false);
  const beforeCancelSequence = current.upload.sequence;
  current = await rpc(method('cancel'), { operationId });
  assert.equal(current.upload.cancelRequested, true);
  await restart();
  current = await rpc(method('read'), { operationId });
  assert.equal(current.upload.receivedBytes, bytes.length);
  assert.equal(current.upload.receivedParts, 3);
  assert.equal(current.upload.cancelRequested, true);
  const staleResume = await raw(method('resume'), { operationId, expectedSequence: beforeCancelSequence });
  assert.equal(staleResume.error?.message, 'local_upload_revision_conflict');
  current = await rpc(method('resume'), { operationId, expectedSequence: current.upload.sequence });
  assert.equal(current.upload.cancelRequested, false);
  assert.equal(current.upload.stage, 'receiving');
  await rpc(method('finish'), { operationId, expectedSequence: current.upload.sequence });
  const authorized = await state();
  assert.equal(authorized.upload.stage, 'authorized', JSON.stringify(authorized));
  assert.equal(authorized.upload.localJob.historicalContentVerified, false);
  const cancelledCopy = await rpc(method('cancel'), { operationId });
  assert.equal(cancelledCopy.upload.cancelRequested, true);
  assert.equal(cancelledCopy.upload.localJob.state.cancelRequested, true);
  const resumedCopy = await rpc(method('resume'), { operationId, expectedSequence: cancelledCopy.upload.sequence });
  assert.equal(resumedCopy.upload.cancelRequested, false);
  assert.equal(resumedCopy.upload.localJob.state.cancelRequested, true,
    'upload resume must not pretend the separately owned copy cancellation was acknowledged');
  await rpc(method('run'), { operationId, expectedSequence: resumedCopy.upload.localJob.state.sequence });
  let ready;
  try { ready = await state(); }
  catch (error) {
    // Preserve the original failure; a delayed observation diagnoses contention, never passes it.
    await new Promise(accept => setTimeout(accept, 250));
    const later = await raw(method('read'), { operationId });
    throw Error(`initial copy observation failed: ${error.message}; delayed observation: ${JSON.stringify(later.error ?? {
      workerRunning: later.result?.workerRunning, workerError: later.result?.workerError,
      uploadStage: later.result?.upload?.stage, localStage: later.result?.upload?.localJob?.state?.stage,
      bytes: later.result?.upload?.localJob?.state?.processedBytes,
      localError: later.result?.upload?.localJob?.state?.failureCode,
    })}`);
  }
  assert.equal(ready.upload.localJob.state.stage, 'ready', JSON.stringify(ready));
  assert.equal(ready.upload.localJob.state.cancelRequested, false);
  assert.equal(ready.upload.localJob.historicalContentVerified, false);
  assert.equal(ready.upload.localJob.info.kind, 'local_reference');
  const receipt = ready.upload.localJob.state.receipt;
  assert.equal(receipt.bytes, bytes.length);
  assert.equal(receipt.sha256, expectedSha256);
  let offset = 0, downloaded = Buffer.alloc(0);
  do {
    const value = await rpc(method('chunk'), { operationId, selection, expectedReceipt: receipt,
      offset, limit: 256 * 1024 });
    assert.equal(value.offset, offset);
    assert.deepEqual(value.receipt, receipt);
    const part = Buffer.from(value.dataBase64, 'base64');
    assert.equal(sha(part), value.dataSha256);
    downloaded = Buffer.concat([downloaded, part]);
    offset = value.nextOffset;
  } while (offset != null);
  assert.deepEqual(downloaded, bytes);
  assert.ok((await raw(method('chunk'), { operationId, selection: { ...selection, blockIndex: 1 },
    expectedReceipt: receipt, offset: 0, limit: 16 })).error);
  assert.ok((await raw(method('chunk'), { operationId, selection,
    expectedReceipt: { ...receipt, sha256: 'a'.repeat(64) }, offset: 0, limit: 16 })).error);
  const binding = { operationId, selection, receipt };
  const requestId = randomUUID();
  const request = { requestId, sourceJobId: jobId, viewId,
    policy: { maxContextBytes: 4194304, maxEntries: 2048, maxAttachments: 256, maxAttachmentBytes: 536870912 },
    options: { model: null, settingsTemplate: null, studioWorkMode: 'kworker', localAttachments: [binding] } };
  const planned = await rpc('migration/history/continuation/create', request);
  assert.deepEqual(planned.job.options.localAttachments, [binding]);
  assert.ok((await raw('migration/history/continuation/create', { ...request,
    options: { ...request.options, localAttachments: [{ ...binding, receipt: { ...receipt, sha256: 'b'.repeat(64) } }] } })).error);
  await rpc('migration/history/continuation/run', { jobId: requestId, expectedSequence: planned.job.sequence });
  const imported = await settle('migration/history/continuation/read', { jobId: requestId },
    value => value.workerRunning === false && value.job.stage === 'imported');
  assert.equal(imported.job.projection.files, 1);
  assert.equal(imported.job.projection.images, 0);
  const threadId = imported.job.threadId;
  const thread = await rpc('thread/read', { threadId });
  assert.equal(thread.thread.status, 'idle');
  assert.equal(thread.thread.studioWorkMode, 'kworker');
  assert.deepEqual(thread.messages, []);
  const journal = JSON.parse(await readFile(join(profile, 'migrations/history-continuations', `${requestId}.json`), 'utf8'));
  assert.equal(journal.target.session_id, threadId);
  const contained = path => ownedWindowsEvidencePath(root, path);
  const history = contained(join(journal.target.history_directory, `${threadId}.jsonl`));
  const historyBytes = await readFile(history);
  assert.ok(historyBytes.length < 4 * 1024 * 1024);
  const rows = historyBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const descriptors = runtimeSeedAttachmentDescriptors(rows);
  assert.equal(descriptors.length, 1);
  const descriptor = descriptors[0];
  assert.equal(descriptor.historicalContentVerified, false);
  assert.equal(descriptor.provenance.kind, 'user_supplied_local');
  assert.equal(descriptor.provenance.operationId, operationId);
  assert.equal(descriptor.sha256, expectedSha256);
  assert.equal(descriptor.mimeType, 'text/plain');
  assert.deepEqual(await readFile(contained(descriptor.path)), bytes);
  const seedSha256 = sha(historyBytes);
  await restart();
  assert.equal((await rpc('migration/history/continuation/read', { jobId: requestId })).job.threadId, threadId);
  assert.equal((await rpc('migration/history/continuation/create', request)).job.threadId, threadId);
  assert.equal(sha(await readFile(history)), seedSha256, 'reconciliation must not append another historical seed');
  assert.deepEqual((await rpc('thread/read', { threadId })).messages, []);
  return { passed: true, bytes: bytes.length, sha256: expectedSha256, sentParts, partialUploadRestartRead: true,
    completeUploadWithoutOriginalFileRecovered: true, staleCancelSequenceRejected: true,
    safeUploadErrorCodePreserved: true,
    authorizedCancelResumeRun: true, childCancelAcknowledgedOnlyByRun: true,
    originalPathParameterRejected: true, wrongSelectionAndReceiptRejected: true,
    historicalContentVerified: false, userSuppliedLocalProvenance: true,
    explicitBindingContinuation: true, currentPayloadBytesVerified: true,
    idleThread: true, hiddenRuntimeSeed: true, seedStableAfterRestart: true,
    ownedHistoryRelativePath: windowsPath.relative(windowsPath.toNamespacedPath(root), windowsPath.toNamespacedPath(history)),
    historyUsesWindowsNamespace: history.startsWith('\\\\?\\'),
    contentClass: 'ordinary historical local document, current safe UTF-8 supplement' };
}
