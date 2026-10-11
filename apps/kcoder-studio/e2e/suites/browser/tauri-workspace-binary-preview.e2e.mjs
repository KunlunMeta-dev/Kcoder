import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

function pngFixture() {
  const chunk = (kind, data) => {
    const tag = Buffer.from(kind), body = Buffer.concat([tag, data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const footer = Buffer.alloc(4); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, footer]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * (128 * 3 + 1));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
    const offset = y * 385 + 1 + x * 3; pixels[offset] = 20 + x; pixels[offset + 1] = 60 + y; pixels[offset + 2] = 180;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function pdfFixture() {
  // A valid content-stream comment makes this fixture span two real chunk RPCs.
  const body = `%${' '.repeat(1024 * 1024)}\nBT /F1 18 Tf 50 120 Td (Owned PDF binary preview) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`];
  let result = '%PDF-1.4\n'; const offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(result);
}

await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit owned Tauri binary required');
await runE2E(import.meta.url, {
  testId: 'native-owned-workspace-image-and-pdf-binary-preview', tier: 'manual-live',
  modelPolicy: 'model-independent real Gateway/app-server file chunks and native WebKit File/Blob preview and DOCX error recovery',
  retainSuccessEvidence: true, evidenceReason: 'Source ownership and caught rendering errors require native DOCX retry and image/PDF recovery evidence',
}, async context => {
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
    delayWorkspaceFileReply: true,
  });
  const workspace = resolve(dirname(dirname(client.settingsPath)), 'workspaces/tauri-verification');
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await writeFile(resolve(workspace, 'owned-preview.png'), pngFixture());
    await writeFile(resolve(workspace, 'owned-preview.pdf'), pdfFixture());
    await writeFile(resolve(workspace, 'owned-pending-preview.pdf'), pdfFixture());
    await writeFile(resolve(workspace, 'owned-invalid-preview.docx'), 'owned invalid DOCX, not an OOXML ZIP package');
    await cmd('waitFor', 'desktop-sidebar');
    await cmd('click', 'toggle-right-workspace-panel-button');
    await cmd('waitFor', 'right-workspace-file-option');
    await cmd('click', 'right-workspace-file-option');
    const pendingSelector = '[data-testid="workspace-file-tree-pierre"] >>> button[data-item-path$="owned-pending-preview.pdf"]';
    await client.command('waitFor', { selector: pendingSelector });
    await client.command('click', { selector: pendingSelector });
    await cmd('waitFor', 'workspace-file-preview-progress');
    const delayPath = resolve(client.runRoot, 'artifacts/workspace-file-reply-delay.json');
    const delayedReply = async () => JSON.parse(await readFile(delayPath, 'utf8').catch(() => '{}'));
    await waitFor(async () => (await delayedReply()).held, 10000, 'genuine first chunk reply held');
    const directory = '[data-testid="workspace-file-tree-pierre"] >>> button[data-item-path="src/"]';
    await client.command('click', { selector: directory });
    await waitFor(async () => /选择文件查看内容|Select a file/.test(await cmd('getText', 'workspace-file-split')), 5000, 'directory navigation clears pending preview');
    assert.doesNotMatch(await cmd('getText', 'workspace-file-split'), /正在加载|Loading file/i);
    assert.match(await cmd('getText', 'workspace-file-path'), /[\\/]src$/);
    assert.deepEqual(await delayedReply(), { held: true, released: false, cancelled: false, timedOut: false });
    await client.capture('owned-directory-during-pending-preview.png');
    await writeFile(resolve(client.runRoot, 'artifacts/workspace-file-reply-release'), 'release', { flag: 'wx', mode: 0o600 });
    await waitFor(async () => (await delayedReply()).released, 5000, 'late genuine chunk reply released');
    assert.equal((await delayedReply()).timedOut, false);
    assert.match(await cmd('getText', 'workspace-file-path'), /[\\/]src$/);
    assert.match(await cmd('getText', 'workspace-file-split'), /选择文件查看内容|Select a file/);
    const open = async name => {
      const selector = `[data-testid="workspace-file-tree-pierre"] >>> button[data-item-path$="${name}"]`;
      await client.command('waitFor', { selector }); await client.command('click', { selector });
      await cmd('waitFor', 'workspace-binary-file-preview');
    };
    await open('owned-pending-preview.pdf');
    await client.command('waitFor', { selector: '[data-testid="workspace-binary-file-preview"] canvas' });
    await open('owned-invalid-preview.docx');
    await cmd('waitFor', 'workspace-document-viewer-error');
    assert.match(await cmd('getText', 'workspace-document-viewer-error'), /无法预览|Could not preview/);
    const inertSurface = '[data-testid="workspace-document-viewer-surface"][inert]';
    assert.equal(Number(await client.command('getElementCount', { selector: inertSurface })), 1);
    await cmd('click', 'workspace-document-viewer-retry');
    await cmd('waitFor', 'workspace-document-viewer-error');
    assert.match(await cmd('getText', 'workspace-document-viewer-error'), /无法预览|Could not preview/);
    await client.capture('owned-docx-render-error-after-retry.png');
    await open('owned-preview.png');
    const image = '[data-testid="workspace-binary-file-preview"] img';
    await client.command('waitFor', { selector: image });
    assert.match(await client.command('getAttribute', { selector: image, value: 'src' }), /^(blob:|data:)/);
    assert.doesNotMatch(await cmd('getText', 'workspace-binary-file-preview'), /无法预览|Could not preview/);
    await waitFor(async () => await cmd('getAttribute', 'workspace-document-viewer-surface', { value: 'aria-hidden' }) === 'false', 5000, 'recovered preview accepts interaction');
    assert.equal(Number(await client.command('getElementCount', { selector: inertSurface })), 0);
    await client.capture('owned-image-preview.png');
    await open('owned-preview.pdf');
    const canvas = '[data-testid="workspace-binary-file-preview"] canvas';
    await client.command('waitFor', { selector: canvas });
    await waitFor(async () => Number(await client.command('getAttribute', { selector: canvas, value: 'width' })) > 0, 10000, 'native PDF canvas rendered');
    await client.capture('owned-pdf-preview.png');
    // Model-independent ownership regression: real document sessions must keep
    // loading after pane unmount/reopen, using the same real workspace RPCs.
    // The shell toggle only collapses a pane and preserves its tabs. Close the
    // actual Files tab to exercise the component-unmount boundary instead.
    await cmd('click', 'right-workspace-file-tab-close-button');
    await waitFor(async () => Number(await client.command('getElementCount', { selector: '[data-testid="workspace-document-viewer"]' })) === 0, 5000, 'closing the Files tab unmounts its viewer');
    // Closing the last tab also collapses the panel; reopen its launcher.
    await cmd('click', 'toggle-right-workspace-panel-button');
    await cmd('waitFor', 'right-workspace-file-option');
    await cmd('click', 'right-workspace-file-option');
    await open('owned-preview.png');
    await client.command('waitFor', { selector: image });
    await open('owned-preview.pdf');
    await client.command('waitFor', { selector: canvas });
    await waitFor(async () => Number(await client.command('getAttribute', { selector: canvas, value: 'width' })) > 0, 10000, 'PDF session renders after reopening');
    assert.doesNotMatch(await cmd('getText', 'workspace-binary-file-preview'), /无法预览|Could not preview/);
    return { native: true, source: 'owned real chunk RPC', image: true, pdf: true, invalidDocxError: true, invalidDocxRetry: true, docxToImageRecovery: true, directoryPendingRecovery: true, delayedFirstReply: true, paneReopenRecovery: true, modelRequests: 0 };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { assert.equal((await client.stop()).cleaned, true); }
});
