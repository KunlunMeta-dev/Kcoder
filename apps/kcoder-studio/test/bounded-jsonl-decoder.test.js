import assert from "node:assert/strict";
import test from "node:test";
import { BoundedJsonlDecoder } from "../src/bounded-jsonl-decoder.js";

test("decodes split JSONL lines and strips CRLF", () => {
  const decoder = new BoundedJsonlDecoder(32);
  assert.deepEqual(decoder.push(Buffer.from('{"id":')), { lines: [], dropped: [] });
  assert.deepEqual(decoder.push(Buffer.from('1}\r\n{"id":2}\n')), {
    lines: ['{"id":1}', '{"id":2}'],
    dropped: [],
  });
  assert.deepEqual(decoder.finish(), { lines: [], dropped: [] });
});

test("reports an unterminated oversized line as dropped instead of throwing", () => {
  const decoder = new BoundedJsonlDecoder(4, 16);
  assert.deepEqual(decoder.push(Buffer.from("1234")), { lines: [], dropped: [] });
  assert.deepEqual(decoder.push(Buffer.from("5")), { lines: [], dropped: [] });
  assert.deepEqual(decoder.finish(), {
    lines: [],
    dropped: [{ bytes: 5, preview: "12345" }],
  });
});

test("oversized lines are dropped without throwing and later lines still parse", () => {
  const decoder = new BoundedJsonlDecoder(16, 32);
  const batch = decoder.push(Buffer.from(`{"id":123,"pad":"x".repeat(64)}\n{"id":2}\n`));
  assert.deepEqual(batch.lines, ['{"id":2}']);
  assert.equal(batch.dropped.length, 1);
  assert.match(batch.dropped[0].preview, /"id":123/);
  assert.ok(batch.dropped[0].bytes > 16);
});

test("an oversized line split across chunks resyncs at the next newline", () => {
  const decoder = new BoundedJsonlDecoder(16, 32);
  const first = decoder.push(Buffer.from('{"id":9,"pad":"'));
  assert.deepEqual(first, { lines: [], dropped: [] });
  const second = decoder.push(Buffer.from('xxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n{"id":3}\n'));
  assert.deepEqual(second.lines, ['{"id":3}']);
  assert.equal(second.dropped.length, 1);
});

test("returns one final unterminated line on EOF", () => {
  const decoder = new BoundedJsonlDecoder(16);
  assert.deepEqual(decoder.push(Buffer.from("final")), { lines: [], dropped: [] });
  assert.deepEqual(decoder.finish(), { lines: ["final"], dropped: [] });
});

test("partial-line copying stays linear in the received bytes", t => {
  const size = 1024 * 1024, chunkSize = 4096;
  const payload = Buffer.alloc(size, 0x61);
  const decoder = new BoundedJsonlDecoder(size);
  const concat = Buffer.concat, copy = Buffer.prototype.copy, allocUnsafe = Buffer.allocUnsafe;
  let copiedBytes = 0, largestAllocation = 0;
  t.mock.method(Buffer, 'allocUnsafe', function (length) {
    largestAllocation = Math.max(largestAllocation, length);
    return allocUnsafe.call(this, length);
  });
  t.mock.method(Buffer, 'concat', function (parts, length) {
    copiedBytes += length ?? parts.reduce((sum, part) => sum + part.length, 0);
    return concat.call(this, parts, length);
  });
  t.mock.method(Buffer.prototype, 'copy', function (...args) {
    const copied = copy.apply(this, args);
    copiedBytes += copied;
    return copied;
  });
  for (let offset = 0; offset < size; offset += chunkSize)
    assert.deepEqual(decoder.push(payload.subarray(offset, offset + chunkSize)), { lines: [], dropped: [] });
  const result = decoder.push(Buffer.from('\n'));
  const measured = copiedBytes;
  t.mock.restoreAll();
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0], payload.toString());
  assert.deepEqual(result.dropped, []);
  t.diagnostic(JSON.stringify({ bytes: size, chunkSize, copiedBytes: measured, largestAllocation }));
  assert.ok(measured <= 8 * size, `copy budget exceeded: ${measured} bytes for ${size} input bytes`);
  assert.ok(largestAllocation <= size, 'partial-line capacity must stay within the line limit');
});

test("byte-split UTF-8, CRLF and EOF retain private input bytes and can restart after finish", () => {
  const decoder = new BoundedJsonlDecoder(32);
  const expected = '{"text":"🙂"}\r\n{"next":1}\nfinal\r';
  const lines = [];
  for (const byte of Buffer.from(expected)) {
    const chunk = Buffer.from([byte]);
    const result = decoder.push(chunk);
    chunk[0] = 0;
    assert.deepEqual(result.dropped, []);
    lines.push(...result.lines);
  }
  assert.deepEqual(lines, ['{"text":"🙂"}', '{"next":1}']);
  assert.deepEqual(decoder.finish(), { lines: ['final\r'], dropped: [] });
  assert.deepEqual(decoder.finish(), { lines: [], dropped: [] });
  const complete = Buffer.from('again\n');
  const result = decoder.push(complete);
  complete.fill(0);
  assert.deepEqual(result, { lines: ['again'], dropped: [] });
});

test("partial overflow preserves its bounded preview and the order of following lines", () => {
  const decoder = new BoundedJsonlDecoder(6, 4);
  assert.deepEqual(decoder.push(Buffer.from('ab')), { lines: [], dropped: [] });
  assert.deepEqual(decoder.push(Buffer.from('cdefghi\nok\n1234567\nlast')), {
    lines: ['ok'],
    dropped: [
      { bytes: 9, preview: 'abcd', precedingLines: 0 },
      { bytes: 7, preview: '1234', precedingLines: 1 },
    ],
  });
  assert.deepEqual(decoder.finish(), { lines: ['last'], dropped: [] });
});
