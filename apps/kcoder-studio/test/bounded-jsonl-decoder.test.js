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