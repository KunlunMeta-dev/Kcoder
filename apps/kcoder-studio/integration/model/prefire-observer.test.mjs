import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrefireObserver, diagnoseRecall, diagnoseCompactionMarker } from './prefire-observer.mjs';

test('live prefire observation accepts split chunks without waiting for log flush', () => {
  const observer = createPrefireObserver();
  observer.consume('DEBUG kcoder_engine::compaction_runtime: background prefire compaction comp');
  assert.equal(observer.snapshot().completed, false);
  observer.consume('leted: 1 messages pre-summarized\n');
  assert.equal(observer.snapshot().completed, true);
  assert.equal(observer.snapshot().covered, 1);
});

test('neutral JSON recall separates unknown, malformed and reversed permissions', () => {
  assert.equal(diagnoseRecall('{"filename":"FILE.db","can_delete":false}', 'FILE.db').canDeleteIsFalse, true);
  assert.equal(diagnoseRecall('```json\n{"filename":"FILE.db","can_delete":false}\n```', 'FILE.db').filenameExactMatch, true);
  assert.equal(diagnoseRecall('{"filename":"FILE.db","can_delete":true}', 'FILE.db').canDeleteIsFalse, false);
  assert.equal(diagnoseRecall('{"filename":"FILE.db","can_delete":"false"}', 'FILE.db').schemaValid, false);
  assert.equal(diagnoseRecall('{"filename":null,"can_delete":null}', 'FILE.db').unknownPermission, true);
  assert.equal(diagnoseRecall('Do not use this: {"filename":"FILE.db","can_delete":false}', 'FILE.db').jsonParsed, false);
});

test('compaction marker evidence distinguishes retained tail from summary and missing records', () => {
  const records = [{ uuid: 'old', content: 'KEEP.db' }, { uuid: 'head', content: 'confirmation' },
    { uuid: 'tail', content: 'confirmation' }, { uuid: 'boundary', subtype: 'compact_boundary', compactMetadata: {
      trigger: 'auto', preservedSegment: { headUuid: 'head', tailUuid: 'tail', anchorUuid: 'summary' } } },
    { uuid: 'summary', parentUuid: 'boundary', isCompactSummary: true, content: 'KEEP.db must not be deleted' }];
  assert.deepEqual(diagnoseCompactionMarker(records, 'KEEP.db'), { boundaryFound: true, summaryMarker: true, tailMarker: false });
  records[1].content = 'KEEP.db';
  assert.equal(diagnoseCompactionMarker(records, 'KEEP.db').tailMarker, true);
  assert.equal(diagnoseCompactionMarker([], 'KEEP.db').tailMarker, null);
  records.push({ uuid: 'new-boundary', subtype: 'compact_boundary', compactMetadata: {
    trigger: 'auto', preservedSegment: { headUuid: 'head', tailUuid: 'tail', anchorUuid: 'new-summary' } } });
  assert.equal(diagnoseCompactionMarker(records, 'KEEP.db').summaryMarker, null);
  records.push({ uuid: 'new-summary', parentUuid: 'boundary', isCompactSummary: true, content: 'KEEP.db' });
  assert.equal(diagnoseCompactionMarker(records, 'KEEP.db').summaryMarker, null);
});

test('prefire metrics retain only allowed numbers, not incidental secret text', () => {
  const observer = createPrefireObserver();
  observer.consume('secret=PRIVATE\nDEBUG kcoder::transport_metrics: provider transport attempt status=Some(200) input_tokens=Some(6549) output_tokens=Some(873) endpoint=PRIVATE\n');
  assert.equal(observer.snapshot().attempts[0].input, 6549);
  assert.equal(observer.snapshot().attempts[0].cacheRead, null);
  assert.ok(!JSON.stringify(observer.snapshot()).includes('PRIVATE'));
  observer.consume('kcoder_engine::compaction_runtime: background prefire compaction failed (will use full pass): PRIVATE\n');
  assert.equal(observer.snapshot().failed, true);
  assert.ok(!JSON.stringify(observer.snapshot()).includes('PRIVATE'));
});
