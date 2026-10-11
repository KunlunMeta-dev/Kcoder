import assert from 'node:assert/strict';
import test from 'node:test';
import { isOwnedFirstFileChunkFrame } from './workspace-file-reply-delay.mjs';

function frame(chunk, override = {}) {
  const body = Buffer.from(JSON.stringify({ id: 12, result: { stdout: JSON.stringify(chunk) }, ...override }));
  assert.ok(body.length < 65536);
  const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}
const first = { path: '/owned/workspace/owned-pending-preview.pdf', offset: 0, content_base64: 'AQI=' };

test('identifies only the owned successful first-chunk reply', () => {
  assert.equal(isOwnedFirstFileChunkFrame(frame(first)), true);
  assert.equal(isOwnedFirstFileChunkFrame(frame(first, { result: { stdout: first } })), true);
  for (const chunk of [{ ...first, offset: 2 }, { ...first, path: '/owned/workspace/other.pdf' }, { ...first, content_base64: undefined }]) {
    assert.equal(isOwnedFirstFileChunkFrame(frame(chunk)), false);
  }
  assert.equal(isOwnedFirstFileChunkFrame(frame(first, { error: { code: -1 } })), false);
  assert.equal(isOwnedFirstFileChunkFrame(frame(first, { id: undefined })), false);
});

test('rejects masked, truncated and combined WebSocket writes', () => {
  const reply = frame(first);
  const masked = Buffer.from(reply); masked[1] |= 0x80;
  for (const bytes of [Buffer.alloc(0), masked, reply.subarray(0, reply.length - 1), Buffer.concat([reply, reply])]) {
    assert.equal(isOwnedFirstFileChunkFrame(bytes), false);
  }
});
