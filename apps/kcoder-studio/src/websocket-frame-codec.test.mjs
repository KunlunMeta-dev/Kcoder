import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSocketFrameCodec } from './websocket-frame-codec.js';

function clientFrame(codec, payload, opcode, fin = true) {
  const encoded = codec.frame(payload, opcode);
  const header = Buffer.from(encoded.subarray(0, encoded.length - payload.length));
  if (!fin) header[0] &= 0x7f;
  header[1] |= 0x80;
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([header, mask, payload.map((byte, index) => byte ^ mask[index % 4])]);
}

for (const coalesced of [false, true]) test(`fragment size checks do not rescan earlier frames (coalesced=${coalesced})`, t => {
  const codec = createWebSocketFrameCodec({ maxMessageBytes: 1024 * 1024 });
  const count = 2048, payload = Buffer.alloc(256, 0x61), fragments = [];
  const frames = Array.from({ length: count }, (_, index) =>
    clientFrame(codec, payload, index ? 0 : 1, index === count - 1));
  const batches = coalesced ? [Buffer.concat(frames)] : frames;
  const reduce = fragments.reduce;
  let visitedFragments = 0;
  Object.defineProperty(fragments, 'reduce', { value(callback, initial) {
    return reduce.call(this, (...args) => { visitedFragments++; return callback(...args); }, initial);
  } });
  const messages = batches.flatMap(bytes => codec.decodeFrames(bytes, fragments).messages);
  assert.deepEqual(messages, ['a'.repeat(count * payload.length)]);
  assert.equal(fragments.length, 0);
  t.diagnostic(JSON.stringify({ frames: count, payloadBytes: count * payload.length, visitedFragments, coalesced }));
  assert.ok(visitedFragments <= count, `fragment size checks revisited ${visitedFragments} earlier fragments`);
});

test('fragment budgets belong to their own arrays and reset after completion or caller retirement', () => {
  const codec = createWebSocketFrameCodec({ maxMessageBytes: 6 }), first = [], second = [];
  const send = (fragments, value, opcode, fin) => codec.decodeFrames(clientFrame(codec, Buffer.from(value), opcode, fin), fragments);
  send(first, 'abcd', 1, false);
  send(second, 'a', 1, false);
  assert.deepEqual(send(second, 'bc', 0, true).messages, ['abc']);
  assert.throws(() => send(first, 'efg', 0, true), /message is too large/);
  first.length = 0;
  send(first, 'x', 1, false);
  assert.deepEqual(send(first, 'yz', 0, true).messages, ['xyz']);
  send(first, 'abc', 1, false);
  assert.deepEqual(send(first, 'def', 0, true).messages, ['abcdef']);
});

test('a carried fragment array is charged before its first continuation', () => {
  const codec = createWebSocketFrameCodec({ maxMessageBytes: 6 });
  const fragments = [Buffer.from('abc')];
  assert.throws(() => codec.decodeFrames(clientFrame(codec, Buffer.from('defg'), 0), fragments), /message is too large/);
});
