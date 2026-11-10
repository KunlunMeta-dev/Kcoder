import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateOffice } from '../src/index.mjs';
import { LIMITS, validateSpec } from '../src/spec.mjs';

function entropyDocument() {
  const paragraphs = [];
  for (let paragraph = 0; paragraph < 48; paragraph++) {
    let text = '';
    for (let block = 0; text.length < 9600; block++) text += createHash('sha256').update(`bounded-docx:${paragraph}:${block}`).digest('base64');
    paragraphs.push({ text: text.slice(0, 9600) });
  }
  return { schemaVersion: 1, kind: 'docx', title: 'Long literal document', paragraphs, sourceRefs: [] };
}
function exactByteDocument(size) {
  const specification = { schemaVersion: 1, kind: 'docx', title: 'Exact canonical byte boundary',
    paragraphs: Array.from({ length: 120 }, () => ({ text: '' })), sourceRefs: [] };
  let remaining = size - Buffer.byteLength(JSON.stringify(specification));
  assert.ok(remaining >= 0 && remaining < 120 * 10000);
  for (const paragraph of specification.paragraphs) {
    const count = Math.min(10000, remaining); paragraph.text = 'a'.repeat(count); remaining -= count;
  }
  assert.equal(remaining, 0); assert.equal(Buffer.byteLength(JSON.stringify(specification)), size);
  return specification;
}
test('long valid literal DOCX exceeds 100k text and actual 256KiB download boundary', async () => {
  const specification = entropyDocument();
  assert.ok(specification.paragraphs.reduce((n, item) => n + item.text.length, 0) > 100000);
  assert.ok(Buffer.byteLength(JSON.stringify(specification)) < LIMITS.inputBytes);
  const generated = await generateOffice(specification);
  assert.ok(generated.bytes.byteLength > 256 * 1024);
  assert.equal(createHash('sha256').update(generated.bytes).digest('hex'), generated.sha256);
  assert.deepEqual(Array.from(generated.bytes.subarray(0, 2)), [80, 75]);
});
test('exact canonical 1MiB fits fixed CLI envelope and 1MiB plus one is rejected', () => {
  const specification = exactByteDocument(LIMITS.inputBytes);
  assert.equal(validateSpec(specification), specification);
  const envelope = JSON.stringify({ method: 'generate', specification, timeoutMs: 30000 });
  assert.ok(Buffer.byteLength(envelope) > LIMITS.inputBytes);
  const run = spawnSync(process.execPath, ['--max-old-space-size=256', '--disable-proto=throw', fileURLToPath(new URL('../src/cli.mjs', import.meta.url))],
    { input: envelope, encoding: 'utf8', timeout: 35000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  assert.ifError(run.error);
  const reply = JSON.parse(run.stdout);
  assert.equal(run.status, 0, JSON.stringify(reply)); assert.equal(reply.ok, true);
  assert.ok(Buffer.from(reply.result.bytesBase64, 'base64').subarray(0, 2).equals(Buffer.from('PK')));
  const over = exactByteDocument(LIMITS.inputBytes + 1);
  assert.throws(() => validateSpec(over), { code: 'OFFICE_INPUT_TOO_LARGE' });
});
