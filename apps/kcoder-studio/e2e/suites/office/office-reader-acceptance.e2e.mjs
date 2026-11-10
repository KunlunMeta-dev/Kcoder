import assert from 'node:assert/strict';
import { mkdir, open, lstat, readFile, writeFile, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { runE2E } from '../../harness/run-context.mjs';
import { generateOffice, inspectDependencies } from '../../../../kcoder-office-components/src/index.mjs';
import { sample } from '../../../../kcoder-office-components/test/fixtures.mjs';

async function waitExit(context, label, command, args, env) {
  const child = context.spawnOwned(label, command, args, { env });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned reader timed out: ' + label)), 40_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Owned reader failed: ' + label + ' code=' + code + ' signal=' + signal));
    });
  });
}

await runE2E(import.meta.url, {
  testId: 'office-real-libreoffice-roundtrip',
  tier: 'manual-live',
  modelPolicy: 'model-independent'
}, async context => {
  if (process.env.KCODER_OFFICE_READER_EXISTING_DOCX) {
    return readOriginalClaimedDocx(context);
  }
  const components = await inspectDependencies();
  assert.equal(components.status, 'available');
  const reader = process.env.KCODER_OFFICE_READER ?? '/usr/bin/soffice';
  assert.ok(isAbsolute(reader), 'Reader override must be an explicit absolute test program');
  const pdfDirectory = context.pathInArtifacts('reader-pdf');
  await mkdir(pdfDirectory, { recursive: true });
  const env = context.isolatedEnvironment({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', SAL_USE_VCLPLUGIN: 'svp' });
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  if (process.env.KCODER_OFFICE_READER_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.KCODER_OFFICE_READER_LIBRARY_PATH;
  const cases = [];
  for (const kind of ['docx', 'xlsx', 'pptx']) {
    const generated = await generateOffice(sample(kind));
    const source = context.pathInArtifacts('sample-' + kind + '.' + kind);
    await writeFile(source, generated.bytes, { mode: 0o600 });
    const profile = pathToFileURL(context.pathInState('libreoffice-' + kind)).href;
    await waitExit(context, 'reader-' + kind, reader, [
      '-env:UserInstallation=' + profile, '--headless', '--nologo', '--nodefault',
      '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', pdfDirectory, source
    ], env);
    const pdf = pdfDirectory + '/sample-' + kind + '.pdf';
    const textPath = context.pathInArtifacts('reader-' + kind + '.txt');
    await waitExit(context, 'extract-' + kind, '/usr/bin/pdftotext', [pdf, textPath], env);
    const text = await readFile(textPath, 'utf8');
    assert.match(text, /1,?234\.56/);
    if (kind === 'xlsx') {
      assert.match(text, /1,?434\.56/);
      assert.match(text, /普通文本/);
    } else assert.match(text, /待确认/);
    cases.push({ kind, sha256: generated.sha256, structuralStatus: generated.verification.structuralStatus,
      readerStatus: 'passed', numericMaterialReadBack: true,
      formulaCalculation: kind === 'xlsx' ? 'observed_in_libreoffice_export' : 'not_applicable',
      nativeHost: process.platform });
    const bytes = await readFile(pdf);
    await writeFile(context.pathInArtifacts('reader-' + kind + '.pdf'), bytes, { mode: 0o600 });
  }
  await context.writeArtifactJson('office-reader-evidence.json', {
    schemaVersion: 1,
    reader,
    modelCalls: 0,
    components,
    cases,
    limitations: ['Linux LibreOffice acceptance does not prove Windows Office layout or all document features.']
  });
  return { passed: true, cases: cases.length, formats: cases.map(item => item.kind) };
});

// Test-only observation of the already claimed Native file. This mode never
// calls the generator or changes its original artifact/ACK verification state.
async function readOriginalClaimedDocx(context) {
  const path = process.env.KCODER_OFFICE_READER_EXISTING_DOCX;
  const expected = process.env.KCODER_OFFICE_READER_EXISTING_DOCX_SHA256;
  assert.ok(isAbsolute(path), 'Original claimed file must be explicit and absolute');
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'Original Native output SHA is required');
  assert.equal(await realpath(path), path, 'Original input may not traverse symlinks');
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  let source;
  try {
    const before = await file.stat({ bigint: true });
    assert.ok(before.isFile() && before.size > 0n && before.size <= 20n * 1024n * 1024n);
    assert.equal(before.uid, BigInt(process.getuid()), 'Original file must belong to this test owner');
    bytes = await file.readFile();
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    for (const key of ['dev', 'ino', 'uid', 'size', 'mtimeNs']) {
      assert.equal(after[key], before[key], 'Original input changed while read');
      assert.equal(current[key], before[key], 'Original input identity was replaced');
    }
    source = { path, sha256: expected, bytes: bytes.length, uid: before.uid.toString(),
      dev: before.dev.toString(), ino: before.ino.toString() };
  } finally { await file.close(); }
  const copied = context.pathInArtifacts('original-claimed.docx');
  await writeFile(copied, bytes, { mode: 0o600 });
  const reader = process.env.KCODER_OFFICE_READER ?? '/usr/bin/soffice';
  assert.ok(isAbsolute(reader));
  const pdfDirectory = context.pathInArtifacts('reader-pdf');
  await mkdir(pdfDirectory, { recursive: true });
  const env = context.isolatedEnvironment({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', SAL_USE_VCLPLUGIN: 'svp' });
  delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
  if (process.env.KCODER_OFFICE_READER_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.KCODER_OFFICE_READER_LIBRARY_PATH;
  await waitExit(context, 'reader-original-docx', reader, [
    '-env:UserInstallation=' + pathToFileURL(context.pathInState('libreoffice-original-docx')).href,
    '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', pdfDirectory, copied
  ], env);
  const textPath = context.pathInArtifacts('reader-original-docx.txt');
  await waitExit(context, 'extract-original-docx', '/usr/bin/pdftotext', [pdfDirectory + '/original-claimed.pdf', textPath], env);
  const text = await readFile(textPath, 'utf8');
  const compact = text.replace(/\s+/g, ' ').trim();
  assert.ok(compact.includes('TWD12_ORDINARY_MATERIAL: approved amount 1234.56; responsible person remains unknown.'),
    'Actual original Native literal material must survive the real reader');
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), expected,
    'Reader observation cannot change the original received file');
  await context.writeArtifactJson('original-native-file-reader-evidence.json', {
    schemaVersion: 1, mode: 'existing_original_native_docx', source, reader,
    originalSourceSha256: expected, copiedInputSha256: createHash('sha256').update(bytes).digest('hex'),
    readerStatus: 'passed', originalLiteralReadBack: true, regeneratedArtifacts: 0, modelCalls: 0,
    formulaCalculation: 'not_applicable', limitations: [
      'Linux Writer observation of this exact original file; no Windows Office or complete visual/semantic quality claim.',
      'Does not change product verification metadata, disk-save or viewed status.'
    ]
  });
  return { passed: true, cases: 1, mode: 'existing_original_native_docx', sha256: expected };
}
