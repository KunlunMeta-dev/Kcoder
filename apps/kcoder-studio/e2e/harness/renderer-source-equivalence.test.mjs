import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertEquivalentRendererSources } from './settings-fingerprints.mjs';

function snapshot(copiedAt, changes = {}) {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, generatedBy: '@file-viewer/vite-plugin',
    copiedAt, rendererIds: ['pdf'], assets: [{ id: 'pdf-worker', to: '/owned/public/pdf', copied: true }], ...changes }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, source: { digest: sha256, entries: [
    { path: 'public/flyfish-viewer-assets.json', sha256, size: bytes.length },
    { path: 'src/main.ts', sha256: 'unchanged-source', size: 16 },
    { path: 'public/vendor/pdf/worker.js', sha256: 'unchanged-worker', size: 32 },
  ] } };
}
const first = () => snapshot('2026-11-23T00:00:00Z');
const next = () => snapshot('2026-11-23T01:00:00Z');

test('only the copy timestamp may differ; raw source identity remains explicitly changed', () => {
  const a = first(), b = next();
  assert.equal(assertEquivalentRendererSources(a.source, b.source, a.bytes, b.bytes), false);
  assert.equal(assertEquivalentRendererSources(a.source, a.source, a.bytes, a.bytes), true);
});

for (const path of ['src/main.ts', 'public/vendor/pdf/worker.js']) {
  test(`implementation/resource byte changes remain rejected: ${path}`, () => {
    const a = first(), b = next();
    b.source.entries.find(entry => entry.path === path).sha256 = 'changed';
    assert.throws(() => assertEquivalentRendererSources(a.source, b.source, a.bytes, b.bytes));
  });
}
for (const change of [
  { rendererIds: ['pdf', 'markdown'] },
  { assets: [{ id: 'pdf-worker', to: '/other/public/pdf', copied: true }] },
  { assets: [{ id: 'pdf-worker', to: '/owned/public/pdf', copied: false }] },
  { copiedAt: 'invalid' },
]) {
  test(`changed or invalid report fields remain rejected: ${JSON.stringify(change)}`, () => {
    const a = first(), b = snapshot('2026-11-23T01:00:00Z', change);
    assert.throws(() => assertEquivalentRendererSources(a.source, b.source, a.bytes, b.bytes));
  });
}
test('report replacement after fingerprinting and a missing report fail closed', () => {
  const a = first(), b = next();
  assert.throws(() => assertEquivalentRendererSources(a.source, b.source, a.bytes, a.bytes));
  b.source.entries.shift();
  assert.throws(() => assertEquivalentRendererSources(a.source, b.source, a.bytes, undefined));
});
