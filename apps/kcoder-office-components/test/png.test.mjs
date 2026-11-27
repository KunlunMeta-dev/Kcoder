import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { validatePngData } from '../src/png.mjs';

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
function png(color, chunks, depth = 8) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = depth; header[9] = color;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...chunks, chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const raw = deflateSync(Buffer.from([0, 127]));

test('PNG chunk names retain their actual bytes, and grayscale cannot have a palette', () => {
  assert.deepEqual(validatePngData(png(0, [chunk('IDAT', raw)])), { width: 1, height: 1 });
  for (const chunks of [[chunk('\xf4EXt', Buffer.from('key\0value')), chunk('IDAT', raw)], [chunk('PLTE', Buffer.from([0, 0, 0])), chunk('IDAT', raw)]]) {
    assert.throws(() => validatePngData(png(0, chunks)), { code: 'OFFICE_UNSAFE_IMAGE' });
  }
});

test('PNG palette order, uniqueness, depth and consecutive IDAT chunks are enforced', () => {
  const palette = chunk('PLTE', Buffer.alloc(6)), indexed = chunk('IDAT', deflateSync(Buffer.from([0, 0])));
  assert.deepEqual(validatePngData(png(3, [palette, indexed], 1)), { width: 1, height: 1 });
  for (const chunks of [[indexed, palette], [palette, palette, indexed], [chunk('PLTE', Buffer.alloc(9)), indexed]]) {
    assert.throws(() => validatePngData(png(3, chunks, 1)), { code: 'OFFICE_UNSAFE_IMAGE' });
  }
  const split = [chunk('IDAT', raw.subarray(0, 3)), chunk('tEXt', Buffer.from('key\0value')), chunk('IDAT', raw.subarray(3))];
  assert.throws(() => validatePngData(png(0, split)), { code: 'OFFICE_UNSAFE_IMAGE' });
});

test('PNG CRC corruption and incorrect inflated scanline lengths are independently rejected', () => {
  const encoded = png(0, [chunk('IDAT', raw)]), bytes = Buffer.from(encoded.split(',')[1], 'base64');
  bytes[29] ^= 1;
  assert.equal(bytes.readUInt32BE(16), 1); assert.equal(bytes.readUInt32BE(20), 1);
  assert.throws(() => validatePngData('data:image/png;base64,' + bytes.toString('base64')), { code: 'OFFICE_UNSAFE_IMAGE' });
  assert.throws(() => validatePngData(png(0, [chunk('IDAT', deflateSync(Buffer.from([0, 127, 127])))])), { code: 'OFFICE_UNSAFE_IMAGE' });
});
