import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWeixinQrImage } from '../src/adapters/weixin-qr-image.mjs';

test('official Weixin scan links are encoded locally and safe PNGs can be reused', async () => {
  const link = 'https://liteapp.weixin.qq.com/q/controlled?ticket=original%2Bbytes';
  const image = await normalizeWeixinQrImage(link);
  assert.match(image, /^data:image\/png;base64,/);
  const bytes = Buffer.from(image.split(',')[1], 'base64');
  assert.equal(bytes.readUInt32BE(16), 384);
  assert.equal(bytes.readUInt32BE(20), 384);
  assert.equal(await normalizeWeixinQrImage(image), image);
  assert.equal(await normalizeWeixinQrImage('https://ilinkai.weixin.qq.com/owned-image.png'), 'https://ilinkai.weixin.qq.com/owned-image.png');
});

test('Weixin image normalization rejects HTML, malformed data and foreign scan URLs', async () => {
  for (const image of ['<img src=x onerror=alert(1)>', 'https://unapproved.example.invalid/qr.png',
    'data:image/png;base64,aW5lcnQ=', 'https://liteapp.weixin.qq.com.evil.invalid/q/test',
    'https://evil.invalid@liteapp.weixin.qq.com/q/test', 'http://liteapp.weixin.qq.com/q/test',
    'https://liteapp.weixin.qq.com:444/q/test', 'https://liteapp.weixin.qq.com/q/test#fragment',
    'https://liteapp.weixin.qq.com/not-a-scan/test']) {
    await assert.rejects(normalizeWeixinQrImage(image), /WEIXIN_QR_IMAGE_INVALID/);
  }
});
