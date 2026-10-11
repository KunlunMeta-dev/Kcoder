import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit owned Tauri binary required');
await runE2E(import.meta.url, {
  testId: 'native-workspace-upload-binary-chunks-conflict-cancel-and-overwrite',
  retainSuccessEvidence: true, evidenceReason: 'Batch recovery feedback and confirmed remaining-file retry need native evidence',
  tier: 'manual-live', modelPolicy: 'model-independent native file selection, Gateway RPC and actual owned disk bytes',
}, async context => {
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const workspace = resolve(dirname(dirname(client.settingsPath)), 'workspaces/tauri-verification');
  const filename = '上传 binary owned.bin';
  const destination = resolve(workspace, filename);
  const original = Buffer.from(Array.from({ length: 256 * 1024 + 37 }, (_, index) => index % 251));
  const replacement = Buffer.from('OVERWRITTEN_OWNED_BYTES\0\xff', 'latin1');
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  const select = bytes => cmd('fill', 'workspace-upload-input', { value: JSON.stringify([{ name: filename, contentBase64: bytes.toString('base64') }]) });
  const disk = () => readFile(destination).catch(() => null);
  try {
    await client.command('navigate', { value: '/' });
    await cmd('waitFor', 'desktop-sidebar');
    await cmd('click', 'toggle-right-workspace-panel-button');
    await cmd('waitFor', 'right-workspace-file-option');
    await cmd('click', 'right-workspace-file-option');
    await cmd('waitFor', 'workspace-upload-button');
    await select(original);
    await waitFor(async () => (await disk())?.equals(original), 15000, 'multi-chunk binary upload on owned disk');
    await cmd('waitFor', 'workspace-upload-status', { text: '已上传 1' });
    const shown = await cmd('getAttribute', 'workspace-upload-destination', { value: 'title' });
    assert.ok([workspace, await realpath(workspace)].includes(shown), 'upload displays its actual captured directory');
    await client.capture('workspace-upload-saved.png');
    await select(replacement);
    await cmd('waitFor', 'workspace-upload-conflict');
    assert.equal((await disk()).equals(original), true, 'conflict cannot overwrite without confirmation');
    // The verification bridge observes DOM before WebKit's next compositor
    // frame; allow the confirmed dialog to paint before its evidence capture.
    await new Promise(done => setTimeout(done, 150));
    await client.capture('workspace-upload-overwrite-confirmation.png');
    await cmd('click', 'workspace-upload-cancel');
    await cmd('waitFor', 'workspace-upload-status', { text: '已取消上传' });
    assert.equal((await disk()).equals(original), true, 'cancel preserves every original byte');
    await select(replacement);
    await cmd('waitFor', 'workspace-upload-conflict');
    await cmd('click', 'workspace-upload-overwrite');
    await waitFor(async () => (await disk())?.equals(replacement), 15000, 'confirmed overwrite bytes');
    await cmd('waitFor', 'workspace-upload-status', { text: '已上传 1' });
    await client.capture('workspace-upload-overwritten.png');
    await mkdir(resolve(workspace, 'directory-conflict.bin'));
    await cmd('fill', 'workspace-upload-input', { value: JSON.stringify([
      { name: 'partial-success.txt', text: 'CONFIRMED_PARTIAL_SUCCESS' },
      { name: 'directory-conflict.bin', text: 'MUST_NOT_REPLACE_DIRECTORY' },
    ]) });
    await cmd('waitFor', 'workspace-upload-status', { text: '其余上传尚未确认' });
    assert.equal(await readFile(resolve(workspace, 'partial-success.txt'), 'utf8'), 'CONFIRMED_PARTIAL_SUCCESS');
    assert.equal((await stat(resolve(workspace, 'directory-conflict.bin'))).isDirectory(), true);
    assert.match(await cmd('getText', 'workspace-upload-status'), /已上传 1/);
    await cmd('waitFor', 'workspace-upload-retry', {enabled:true});
    const committed=resolve(workspace,'partial-success.txt');
    const beforeRetry=await stat(committed,{bigint:true});
    await client.capture('workspace-upload-partial-confirmed.png');
    // Only remove the owned empty obstacle, then let the user action resume
    // the remaining file. Replaying the confirmed first file would conflict.
    await rm(resolve(workspace,'directory-conflict.bin'),{recursive:true});
    await cmd('click','workspace-upload-retry');
    await cmd('waitFor','workspace-upload-status',{text:'已上传 2'});
    assert.equal(await readFile(resolve(workspace,'directory-conflict.bin'),'utf8'),'MUST_NOT_REPLACE_DIRECTORY');
    assert.equal((await stat(committed,{bigint:true})).mtimeNs,beforeRetry.mtimeNs);
    assert.equal(await readFile(committed,'utf8'),'CONFIRMED_PARTIAL_SUCCESS');
    assert.equal(Number(await cmd('getElementCount','workspace-upload-conflict')),0);
    assert.equal(Number(await cmd('getElementCount','workspace-upload-retry')),0);
    await client.capture('workspace-upload-recovered.png');
    await cmd('click', 'workspace-upload-dismiss');
    assert.equal(await cmd('getElementCount', 'workspace-upload-status'), '0');
    return { binaryBytes: original.length, binarySha256: createHash('sha256').update(original).digest('hex'),
      exactDiskBytes: true, capturedDestination: true, cancelPreservedOriginal: true, confirmedOverwrite: true,
      partialSuccessCountHonest: true, remainingRetryConfirmed:true, confirmedFileNotReplayed:true, cumulativeCount:2, statusDismissible: true };
  } catch (error) {
    client.markFailed();
    await context.writeArtifactJson('failure-ui.json', { status: await cmd('getText', 'workspace-upload-status').catch(() => 'unavailable') });
    await client.capture('failure.png').catch(() => {});
    throw error;
  } finally { assert.equal((await client.stop()).cleaned, true); }
});
