import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { unzipSync, strFromU8 } from 'fflate';
import { generateOffice, inspectOffice, inspectDependencies } from '../src/index.mjs';
import { sample } from './fixtures.mjs';

for (const kind of ['docx', 'xlsx', 'pptx']) {
  test('creates a real ' + kind + ' package with exact material content', async () => {
    const result = await generateOffice(sample(kind));
    assert.equal(result.kind, kind);
    assert.equal(result.sha256, createHash('sha256').update(result.bytes).digest('hex'));
    assert.ok(result.bytes.byteLength > 1000);
    const parts = unzipSync(result.bytes);
    assert.ok(parts['[Content_Types].xml']);
    const xml = Object.keys(parts).filter(name => name.endsWith('.xml'))
      .map(name => strFromU8(parts[name])).join('\n');
    assert.match(xml, /1234\.56/);
    const inspection = inspectOffice(result.bytes, kind);
    assert.equal(inspection.kind, kind);
    assert.equal(result.verification.readerStatus, 'unverified');
    assert.equal(result.generator.component, '@kcoder/office-components');
    assert.equal(result.generator.version, '0.1.0');
    assert.equal(result.generator.schemaRevision, 'office-generation/v1');
    assert.match(result.generator.implementationSha256, /^[a-f0-9]{64}$/);
    assert.match(result.generator.dependencyLockSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.generator, (await inspectDependencies()).generator);
    if (kind === 'docx') assert.match(xml, /&lt;原文&gt;.*&amp;/);
    if (kind === 'xlsx') {
      assert.match(strFromU8(parts['xl/worksheets/sheet1.xml']), /<f>SUM\(B2:B3\)<\/f>/);
      assert.equal(result.verification.formulaCalculation, 'not_performed');
    }
  });
}

test('rejects unknown keys, nonfinite numbers and unsafe formulas before generation', async () => {
  await assert.rejects(generateOffice({ ...sample('docx'), command: 'do-not-run' }), { code: 'OFFICE_INVALID_INPUT' });
  const invalid = sample('xlsx');
  invalid.sheets[0].rows[0][1] = Number.POSITIVE_INFINITY;
  await assert.rejects(generateOffice(invalid), { code: 'OFFICE_INVALID_INPUT' });
  const unsafe = sample('xlsx');
  unsafe.sheets[0].formulas[0].formula = 'WEBSERVICE("https://example.invalid")';
  await assert.rejects(generateOffice(unsafe), { code: 'OFFICE_UNSAFE_FORMULA' });
});

test('cancellation and wait budgets leave no generated file or background worker', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateOffice(sample('docx'), { signal: controller.signal }), { code: 'OFFICE_CANCELLED' });
  await assert.rejects(generateOffice(sample('pptx'), { timeoutMs: 1 }), { code: 'OFFICE_TIMEOUT' });
});

test('reports exact pinned dependency versions without assuming external reader readiness', async () => {
  const report = await inspectDependencies();
  assert.equal(report.status, 'available');
  assert.equal(report.components.docx.version, '9.5.1');
  assert.equal(report.components.exceljs.version, '4.4.0');
  assert.equal(report.components.pptxgenjs.version, '4.0.1');
  assert.equal(report.readerStatus, 'not_checked');
});

test('rejects a corrupted or wrong-kind archive', () => {
  assert.throws(() => inspectOffice(new Uint8Array([80, 75, 0, 0]), 'docx'), { code: 'OFFICE_INVALID_ARCHIVE' });
});


test('PPTX has real editable chart data and a real embedded PNG with explicit alt text', async () => {
  const spec=sample('pptx');
  spec.slides.push({title:'材料图示',paragraphs:['来源：测试合成材料'],images:[{data:pngFixture(),alt:'合成1像素标记'}]});
  const result=await generateOffice(spec);const parts=unzipSync(result.bytes);
  const charts=Object.keys(parts).filter(name=>/^ppt\/charts\/chart\d+\.xml$/.test(name));assert.equal(charts.length,1);
  assert.match(strFromU8(parts[charts[0]]),/1234\.56/);
  assert.ok(Object.keys(parts).some(name=>/^ppt\/embeddings\/.*\.xlsx$/.test(name)));
  assert.ok(Object.keys(parts).some(name=>/^ppt\/media\/.*\.png$/.test(name)));
  assert.match(strFromU8(parts['ppt/slides/slide3.xml']),/合成1像素标记/);
});
test('invalid calendar dates, unsafe integer writes, excessive slide text and active images are rejected', async () => {
  const date=sample('xlsx');date.sheets[0].columns[0].type='date';date.sheets[0].rows=[['2026-02-30',1]];
  await assert.rejects(generateOffice(date),{code:'OFFICE_INVALID_INPUT'});
  const integer=sample('xlsx');integer.sheets[0].rows[0][1]=Number.MAX_SAFE_INTEGER+1;await assert.rejects(generateOffice(integer),{code:'OFFICE_INVALID_INPUT'});
  const slide=sample('pptx');slide.slides[0].paragraphs=['长'.repeat(401)];await assert.rejects(generateOffice(slide),{code:'OFFICE_LAYOUT_LIMIT'});
  const image=sample('pptx');image.slides[0].images=[{data:'file:///private/image.png',alt:'unsafe'}];await assert.rejects(generateOffice(image),{code:'OFFICE_UNSAFE_IMAGE'});
});
test('well-formed XML, relationship targets, traversal and embedded archives are inspected', async () => {
  const {zipSync,strToU8}=await import('fflate');
  const generated=await generateOffice(sample('docx'));const parts=unzipSync(generated.bytes);
  parts['word/document.xml']=strToU8('<broken>');assert.throws(()=>inspectOffice(zipSync(parts),'docx'),{code:'OFFICE_INVALID_ARCHIVE'});
  const valid=unzipSync(generated.bytes);valid['_rels/.rels']=strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="x" Target="../../private"/></Relationships>');assert.throws(()=>inspectOffice(zipSync(valid),'docx'),{code:'OFFICE_INVALID_ARCHIVE'});
});

function pngFixture(){
 const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit+=1)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type),data]);const checksum=Buffer.alloc(4);checksum.writeUInt32BE(crc(body));return Buffer.concat([length,body,checksum]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
 return'data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,50,100,150,255]))),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}

test('corrupt PNG CRC and decompression shape are not accepted as a rendered image',async()=>{
 const spec=sample('pptx');const valid=Buffer.from(pngFixture().split(',')[1],'base64');valid[20]^=1;spec.slides[0].images=[{data:'data:image/png;base64,'+valid.toString('base64'),alt:'corrupt'}];await assert.rejects(generateOffice(spec),{code:'OFFICE_UNSAFE_IMAGE'});
});

test('packaging contribution records exact runtime files, fixed lock and retained license files',async()=>{
 const {createOfficePackageManifest,verifyOfficePackageManifest}=await import('../src/package-manifest.mjs');const manifest=await createOfficePackageManifest();assert.equal(manifest.entry,'src/cli.mjs');assert.ok(manifest.files.some(file=>file.path==='src/png.mjs'));assert.ok(manifest.files.some(file=>file.legal));assert.ok(manifest.dependencies.find(dep=>dep.path==='node_modules/saxes'&&dep.version==='6.0.0'));assert.equal((await verifyOfficePackageManifest(manifest)).status,'verified');
 const altered=structuredClone(manifest);altered.files[0].sha256='f'.repeat(64);await assert.rejects(verifyOfficePackageManifest(altered));
});
