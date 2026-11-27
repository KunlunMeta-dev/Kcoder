import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { generateOffice, inspectOffice } from '../src/index.mjs';
import { validateSpec } from '../src/spec.mjs';
import { verifyMaterialContent } from '../src/acceptance.mjs';
import { sample } from './fixtures.mjs';

test('XLSX rejects holes, undeclared formula columns and apostrophe-delimited worksheet names', () => {
  const hole = sample('xlsx'); hole.sheets[0].rows = [new Array(2)];
  assert.throws(() => validateSpec(hole), { code: 'OFFICE_INVALID_INPUT' });
  for (const cell of ['C2', 'XFD2', 'ZZZ2']) {
    const spec = sample('xlsx'); spec.sheets[0].formulas = [{ cell, formula: 'SUM(B2:B3)' }];
    assert.throws(() => validateSpec(spec), { code: 'OFFICE_INVALID_INPUT' });
  }
  for (const name of ["'fixture", "fixture'"]) {
    const spec = sample('xlsx'); spec.sheets[0].name = name;
    assert.throws(() => validateSpec(spec), { code: 'OFFICE_INVALID_INPUT' });
  }
  const valid = sample('xlsx'); valid.sheets[0].name = "Fixture's sheet";
  assert.equal(validateSpec(valid), valid);
  assert.throws(() => sample('unknown'), /Unknown Office fixture kind/);
});

test('OOXML rejects ambiguous part names, misplaced relationships and unsupported embedded payloads', async () => {
  const { bytes } = await generateOffice(sample('docx'));
  for (const suffix of ['zip', 'jar', 'js', 'scr', 'com', 'hta', 'bin']) {
    const parts = unzipSync(bytes); parts['word/embeddings/payload.' + suffix] = strToU8('synthetic payload');
    assert.throws(() => inspectOffice(zipSync(parts), 'docx'), { code: 'OFFICE_INVALID_ARCHIVE' });
  }
  const duplicate = unzipSync(bytes); duplicate['Word/Document.xml'] = duplicate['word/document.xml'];
  assert.throws(() => inspectOffice(zipSync(duplicate), 'docx'), { code: 'OFFICE_INVALID_ARCHIVE' });
  const alternateCase = unzipSync(bytes);
  alternateCase['_rels/.rels'] = strToU8(strFromU8(alternateCase['_rels/.rels']).replace('word/document.xml', 'WORD/Document.XML'));
  assert.equal(inspectOffice(zipSync(alternateCase), 'docx').kind, 'docx');
  const misplaced = unzipSync(bytes);
  misplaced['word/misplaced.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="x" Target="word/document.xml"/></Relationships>');
  assert.throws(() => inspectOffice(zipSync(misplaced), 'docx'), { code: 'OFFICE_INVALID_ARCHIVE' });
  const nested = unzipSync(bytes); nested['word/embeddings/payload.DOCX'] = bytes;
  assert.equal(inspectOffice(zipSync(nested), 'docx').kind, 'docx');
  nested['word/embeddings/payload.DOCX'] = strToU8('not an archive');
  assert.throws(() => inspectOffice(zipSync(nested), 'docx'), { code: 'OFFICE_INVALID_ARCHIVE' });
});

test('a CLI whose parent closes stdout exits without an uncaught EPIPE', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
  child.stdout.destroy(); let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; }); child.stdin.on('error', () => {});
  const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  child.stdin.end('{malformed');
  assert.deepEqual(await result, { code: 1, signal: null }); assert.equal(stderr, '');
});

test('fragment-only relationships refer to their owning part and protocol-relative targets fail closed', async () => {
  const { bytes } = await generateOffice(sample('docx'));
  for (const target of ['#bookmark', '//external.invalid/file']) {
    const parts = unzipSync(bytes);
    parts['word/_rels/document.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="x" Target="' + target + '"/></Relationships>');
    if (target.startsWith('#')) assert.equal(inspectOffice(zipSync(parts), 'docx').kind, 'docx');
    else assert.throws(() => inspectOffice(zipSync(parts), 'docx'), { code: 'OFFICE_INVALID_ARCHIVE' });
  }
});

test('a structurally valid workbook with an invalid shared-string index returns an OfficeError with a private cause', async () => {
  const { bytes } = await generateOffice(sample('xlsx'));
  const parts = unzipSync(bytes), original = strFromU8(parts['xl/worksheets/sheet1.xml']);
  assert.ok(original.includes('<v>0</v>'));
  parts['xl/worksheets/sheet1.xml'] = strToU8(original.replace('<v>0</v>', '<v>99999</v>'));
  await assert.rejects(verifyMaterialContent(zipSync(parts), 'xlsx', { requiredText: ['fixture'] }), error => {
    assert.equal(error.code, 'OFFICE_INVALID_ARCHIVE'); assert.equal(error.name, 'OfficeError'); assert.ok(error.cause instanceof Error); return true;
  });
});

test('worker termination uncertainty has a bounded wait and never becomes a successful artifact', async t => {
  const original = Worker.prototype.terminate;
  const mocked = t.mock.method(Worker.prototype, 'terminate', function () {
    // Stop the real owned worker, then inject a lost termination acknowledgement.
    void original.call(this);
    return new Promise(() => {});
  });
  try {
    for (const options of [{ timeoutMs: 1 }, {}]) {
      const started = performance.now();
      await assert.rejects(generateOffice(sample('docx'), options), { code: 'OFFICE_CLEANUP_UNCONFIRMED', recovery: 'reconcile_original' });
      assert.ok(performance.now() - started < 8000, 'cleanup acknowledgement must have a separate finite budget');
    }
  } finally { mocked.mock.restore(); }
});

test('malformed CLI JSON is invalid input and date serials remain identical across host timezones', () => {
  const cli = new URL('../src/cli.mjs', import.meta.url);
  const malformed = spawnSync(process.execPath, [fileURLToPath(cli)], { input: '{malformed', encoding: 'utf8', timeout: 5000 });
  assert.ifError(malformed.error); assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stdout).error.code, 'OFFICE_INVALID_INPUT');
  const generator = new URL('../src/generator.mjs', import.meta.url).href;
  const spec = { schemaVersion: 1, kind: 'xlsx', title: 'calendar fixture', sheets: [{ name: 'Dates', columns: [{ key: 'date', title: 'Date', type: 'date' }], rows: [['2026-01-01']] }] };
  const code = `Promise.all([import(${JSON.stringify(generator)}),import('fflate')]).then(async ([g,z])=>{const p=z.unzipSync(await g.generateBytes(${JSON.stringify(spec)}));process.stdout.write(z.strFromU8(p['xl/worksheets/sheet1.xml']).match(new RegExp('<c r="A2"[^>]*><v>([^<]+)</v>'))[1]);});`;
  const serials = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'].map(TZ => {
    const result = spawnSync(process.execPath, ['-e', code], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout;
  });
  assert.deepEqual(serials, ['46023', '46023', '46023']);
});
