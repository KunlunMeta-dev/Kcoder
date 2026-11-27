import test from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';
import{generateOffice}from'../src/index.mjs';import{verifyMaterialContent}from'../src/acceptance.mjs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { sample } from './fixtures.mjs';
import { randomUUID } from 'node:crypto';
const fixtures=JSON.parse(await readFile(new URL('./fixtures/office-scenarios.json',import.meta.url),'utf8'));
assert.ok(Array.isArray(fixtures.cases)&&fixtures.cases.length>0,'material fixtures must register at least one scenario');
for(const item of fixtures.cases)test(item.id+' real bytes satisfy the frozen material oracle (no model claim)',async()=>{assert.ok(item.criteria&&typeof item.criteria==='object','scenario requires material criteria');const artifact=await generateOffice(item.specification);const report=await verifyMaterialContent(artifact.bytes,item.specification.kind,item.criteria);assert.equal(report.status,'passed',JSON.stringify(report.checks.filter(check=>!check.passed)));const sentinel='missing-'+randomUUID();const poisoned=await verifyMaterialContent(artifact.bytes,item.specification.kind,{...item.criteria,requiredText:[...(item.criteria.requiredText??[]),sentinel]});assert.equal(poisoned.status,'failed');assert.deepEqual(poisoned.checks.filter(check=>!check.passed),[{id:'required_text',passed:false,expected:sentinel}]);});

test('material criteria reject malformed, empty and format-incompatible checks', async () => {
  const { bytes } = await generateOffice(sample('xlsx'));
  const circular = {}; circular.requiredText = [circular];
  for (const criteria of [{}, { requiredText: [] }, { forbiddenText: 'secret' }, { requiredSourceRefs: [null] },
    { expectedSlides: '3' }, { expectedSlides: 3 }, { minimumCharts: -1 }, { expectedCells: [null] },
    { expectedCells: [{}] }, { expectedCells: [{ sheet: '核对明细', cell: 'B2' }] },
    { expectedCells: [{ sheet: '核对明细', cell: 'A0', value: null }] }, circular]) {
    await assert.rejects(verifyMaterialContent(bytes, 'xlsx', criteria), { name: 'OfficeError', code: 'OFFICE_INVALID_INPUT' });
  }
});

test('cell checks preserve scalar types and fail for missing worksheets', async () => {
  const { bytes } = await generateOffice(sample('xlsx'));
  for (const [sheet, value, status] of [['核对明细', 1234.56, 'passed'], ['核对明细', '1234.56', 'failed'], ['missing', null, 'failed']]) {
    assert.equal((await verifyMaterialContent(bytes, 'xlsx', { expectedCells: [{ sheet, cell: 'B2', value }] })).status, status);
  }
  const docx = await generateOffice(sample('docx'));
  await assert.rejects(verifyMaterialContent(docx.bytes, 'docx', { expectedCells: [{ sheet: 'missing', cell: 'A1', value: null }] }), { code: 'OFFICE_INVALID_INPUT' });
});

test('material text spans formatting runs while paragraph boundaries remain separate', async () => {
  const { bytes } = await generateOffice({ schemaVersion: 1, kind: 'docx', title: 'fixture',
    paragraphs: [{ text: 'quarterly revenue' }, { text: 'second paragraph' }] });
  const parts = unzipSync(bytes);
  const xml = strFromU8(parts['word/document.xml']);
  assert.ok(xml.includes('quarterly revenue'));
  parts['word/document.xml'] = strToU8(xml.replace('quarterly revenue', 'quarterly</w:t></w:r><w:r><w:t xml:space="preserve"> revenue'));
  const report = await verifyMaterialContent(zipSync(parts), 'docx', {
    requiredText: ['quarterly revenue'], forbiddenText: ['revenuesecond paragraph'],
  });
  assert.equal(report.status, 'passed', JSON.stringify(report.checks));
});
