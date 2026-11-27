import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedReceiveBuffer } from './bounded-receive-buffer.js';

test('pending bytes are owned and compaction preserves only the parser remainder', () => {
  const buffer = new BoundedReceiveBuffer(8);
  const first = Buffer.from('abc');
  buffer.append(first); first.fill(0);
  buffer.append(Buffer.from('def'));
  assert.equal(buffer.bytes.toString(), 'abcdef');
  buffer.retain(buffer.bytes.subarray(2));
  assert.equal(buffer.bytes.toString(), 'cdef');
  buffer.append(Buffer.from('gh'));
  assert.equal(buffer.bytes.toString(), 'cdefgh');
  buffer.clear();
  assert.equal(buffer.length, 0);
  buffer.append(Buffer.from('new'));
  assert.equal(buffer.bytes.toString(), 'new');
});

test('a coalesced input batch can exceed carry-over capacity while its remainder stays bounded', () => {
  const buffer = new BoundedReceiveBuffer(4);
  buffer.append(Buffer.from('first|second|end'));
  buffer.retain(buffer.bytes.subarray(-3));
  assert.equal(buffer.bytes.toString(), 'end');
  buffer.append(Buffer.from('!'));
  assert.equal(buffer.bytes.toString(), 'end!');
  assert.throws(() => buffer.retain(Buffer.alloc(5)), /Receive buffer is too large/);
});

test('pending input already at the beginning is not recopied after each parser read', t => {
  const buffer = new BoundedReceiveBuffer(8);
  buffer.append(Buffer.from('pending'));
  const copy = t.mock.method(Buffer.prototype, 'copy');
  for (let index = 0; index < 20; index++) buffer.retain(buffer.bytes);
  assert.equal(copy.mock.callCount(), 0);
  assert.equal(buffer.bytes.toString(), 'pending');
});
