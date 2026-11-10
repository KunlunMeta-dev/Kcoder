import QRCode from 'qrcode';
import { requireValue, ChannelError } from '../errors.mjs';

/** Normalize official scan links locally; never fetch an upstream image URL. */
export async function normalizeWeixinQrImage(value) {
  requireValue(typeof value === 'string' && Buffer.byteLength(value) <= 256 * 1024, 'WEIXIN_QR_IMAGE_INVALID');
  if (value.startsWith('data:')) {
    requireValue(/^data:image\/png;base64,[a-zA-Z0-9+/]+=*$/.test(value), 'WEIXIN_QR_IMAGE_INVALID');
    const encoded = value.slice('data:image/png;base64,'.length), bytes = Buffer.from(encoded, 'base64');
    requireValue(encoded.length % 4 === 0 && bytes.length >= 24
      && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.toString('ascii', 12, 16) === 'IHDR'
      && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 2048
      && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 2048, 'WEIXIN_QR_IMAGE_INVALID');
    return value;
  }
  let url;
  try { url = new URL(value); } catch { throw new ChannelError('WEIXIN_QR_IMAGE_INVALID'); }
  requireValue(url.protocol === 'https:' && (!url.port || url.port === '443')
    && !url.username && !url.password && !url.hash, 'WEIXIN_QR_IMAGE_INVALID');
  if (url.hostname === 'liteapp.weixin.qq.com') {
    requireValue(url.pathname.startsWith('/q/') && url.pathname.length > 3
      && Buffer.byteLength(value) <= 2048, 'WEIXIN_QR_IMAGE_INVALID');
    try {
      // Encode the original bytes, preserving the platform's signed query exactly.
      return await QRCode.toDataURL(value, { type: 'image/png', width: 384, margin: 4, errorCorrectionLevel: 'M' });
    } catch { throw new ChannelError('WEIXIN_QR_IMAGE_INVALID'); }
  }
  requireValue(['ilinkai.weixin.qq.com', 'ilink.b.qq.com'].includes(url.hostname), 'WEIXIN_QR_IMAGE_INVALID');
  return url.href;
}
