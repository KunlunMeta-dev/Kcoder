import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { archiveClient, readyExport } from '../../fixtures/wiki/archive-client.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
await runE2E(import.meta.url, { testId: 'wiki-stream-large-originals-owned-roundtrip', tier: 'full-integration',
  modelPolicy: 'No model calls: actual DOCX extraction, ownership and bounded persistence transfer', cleanupTimeoutMs: 60000 }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const client = await archiveClient(context, binary);
  const { rpc, gateway, token, library, workspace } = client;
  const input = resolve(workspace, 'originals');
  await mkdir(input);
  // Stored Office media tests near-32 MiB original preservation without huge text extraction.
  const generator = context.spawnOwned('owned-large-docx', '/usr/bin/python3', ['-c',
    `import sys,zipfile,pathlib\nr=pathlib.Path(sys.argv[1])\nfor i in range(4):\n p=r/f'original-{i}.docx'\n with zipfile.ZipFile(p,'w',compression=zipfile.ZIP_STORED) as z:\n  z.writestr('word/document.xml',f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Evidence {i}</w:t></w:r></w:p></w:body></w:document>')\n  z.writestr('word/media/owned.bin',bytes([i+1])*(31*1024*1024))`, input]);
  await waitFor(() => generator.exitCode !== null, 15000, 'large original fixture');
  assert.equal(generator.exitCode, 0);
  const staged = await rpc.request('knowledge/source/directoryStage', { directory: input });
  for (const file of staged.items) {
    const source = await rpc.request('knowledge/source/importAttachment', { libraryId: library.id, title: file.title,
      attachmentPath: file.attachmentPath, idempotencyKey: file.idempotencyKey }, 60000);
    assert.equal(source.extraction.format, 'docx');
    assert.ok(source.extraction.warnings.includes('docx_body_only'));
    await rpc.request('attachment/delete', { path: file.attachmentPath });
  }
  const ready = await readyExport(rpc, library.id);
  assert.ok(ready.totalBytes > 96 * 1024 * 1024);
  assert.equal(ready.manifest.segments.length, 2);
  const foreign = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close foreign archive RPC', () => foreign.close());
  await initializeRpc(foreign, 'foreign-archive-owner');
  await assert.rejects(foreign.request('knowledge/archiveTransfer/read', { transferId: ready.transferId, index: 0, offset: 0 }), /owned|connection|another Gateway client/);
  foreign.close();
  const ownAfterObserverDisconnect = await rpc.request('knowledge/archiveTransfer/read', { transferId: ready.transferId, index: 0, offset: 0 });
  assert.ok(ownAfterObserverDisconnect.nextOffset > 0, 'observer disconnect preserves the owner collection');
  const downloads = context.pathInState('archive-download');
  await mkdir(downloads);
  const whole = createHash('sha256');
  let maxChunk = 0;
  for (const segment of ready.manifest.segments) {
    const file = await open(resolve(downloads, segment.name), 'wx', 0o600);
    const digest = createHash('sha256');
    try {
      for (let offset = 0; offset < segment.size;) {
        const chunk = await rpc.request('knowledge/archiveTransfer/read', { transferId: ready.transferId, index: segment.index, offset });
        const bytes = Buffer.from(chunk.contentBase64, 'base64');
        maxChunk = Math.max(maxChunk, bytes.length);
        assert.ok(bytes.length > 0 && bytes.length <= 192 * 1024);
        assert.equal(chunk.nextOffset, offset + bytes.length);
        assert.equal(chunk.size, segment.size);
        assert.equal(chunk.eof, chunk.nextOffset === segment.size);
        digest.update(bytes); whole.update(bytes);
        await file.write(bytes); offset = chunk.nextOffset;
      }
      assert.equal(digest.digest('hex'), segment.sha256);
    } finally { await file.close(); }
    assert.equal((await stat(resolve(downloads, segment.name))).size, segment.size);
  }
  assert.equal(whole.digest('hex'), ready.manifest.sha256);
  await rpc.request('knowledge/archiveTransfer/cancel', { transferId: ready.transferId });
  const other = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close archive disconnect owner RPC', () => other.close());
  await initializeRpc(other, 'disconnect-archive-owner');
  const departing = await readyExport(other, library.id);
  other.close();
  let replacement;
  await waitFor(async () => {
    try {
      replacement = await rpc.request('knowledge/archiveTransfer/importStart', { manifest: ready.manifest, idempotencyKey: 'exact-public-import' });
      return replacement;
    } catch (error) {
      if (!/finish or cancel|busy/i.test(error.message)) throw error;
      return null;
    }
  }, 10000, 'departed owner collection cleanup');
  const upload = replacement;
  assert.notEqual(upload.transferId, departing.transferId);

  await assert.rejects(rpc.request('knowledge/archiveTransfer/importFinish', { transferId: upload.transferId }), /incomplete/);
  for (const segment of ready.manifest.segments) {
    const file = await open(resolve(downloads, segment.name), 'r');
    try {
      for (let offset = 0; offset < segment.size;) {
        const bytes = Buffer.alloc(Math.min(192 * 1024, segment.size - offset));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
        assert.equal(bytesRead, bytes.length);
        await rpc.request('knowledge/archiveTransfer/chunk', { transferId: upload.transferId, index: segment.index, offset, contentBase64: bytes.toString('base64') });
        offset += bytesRead;
      }
    } finally { await file.close(); }
  }
  await rpc.request('knowledge/archiveTransfer/importFinish', { transferId: upload.transferId });
  const imported = await waitFor(async () => {
    const state = await rpc.request('knowledge/archiveTransfer/status', { transferId: upload.transferId });
    if (state.phase === 'failed') throw new Error(state.error);
    return state.phase === 'completed' ? state.library : null;
  }, 60000, 'large original import publication');
  const sources = (await rpc.request('knowledge/source/list', { libraryId: imported.id })).items;
  assert.equal(sources.length, 5);
  for (const original of sources.filter(source => source.title.endsWith('.docx'))) {
    assert.equal(original.extraction.format, 'docx');
    const read = await rpc.request('knowledge/source/read', { libraryId: imported.id, sourceId: original.sourceId, revisionId: original.revisionId });
    assert.equal(read.extraction.format, 'docx');
    assert.match(read.items[0].text, /Evidence [0-3]/);
  }
  await context.writeArtifactJson('archive-boundaries.json', { totalBytes: ready.totalBytes, segments: ready.manifest.segments.map(({ size }) => size), maxChunk, exactHashVerified: true, originals: 4, sourceReports: 4 });
  return { largeOriginalRoundtrip: true, maxChunk, foreignOwnerRejected: true, incompleteNotPublished: true };
});
