// Test-only preload: discard one complete successful provider save frame before
// the owned Gateway socket writes it. No application response is fabricated.
import { Server } from 'node:http';
import { writeFileSync } from 'node:fs';

export function isCommittedProviderSaveFrame(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes[0] !== 0x81 || bytes[1] & 0x80) return false;
  let length = bytes[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (bytes.length < 4) return false;
    length = bytes.readUInt16BE(2); offset = 4;
  } else if (length === 127) {
    if (bytes.length < 10) return false;
    const wide = bytes.readBigUInt64BE(2);
    if (wide > 2n * 1024n * 1024n) return false;
    length = Number(wide); offset = 10;
  }
  if (bytes.length !== offset + length) return false;
  try {
    const value = JSON.parse(bytes.subarray(offset).toString('utf8'));
    return value.id !== undefined && !value.error &&
      typeof value.result?.savedRevision === 'string' && Array.isArray(value.result?.profiles);
  } catch { return false; }
}

if (process.env.KCODER_E2E_DROP_SAVE_REPLY === '1') {
  let dropped = false;
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (event, ...args) {
    if (event === 'upgrade' && args[0]?.url?.startsWith('/rpc?')) {
      const socket = args[1];
      const write = socket.write;
      socket.write = function (bytes, ...rest) {
        if (!dropped && isCommittedProviderSaveFrame(bytes)) {
          dropped = true;
          writeFileSync(process.env.KCODER_E2E_SAVE_REPLY_FAULT_EVIDENCE,
            JSON.stringify({ committedReplyDropped: true }), { mode: 0o600, flag: 'wx' });
          process.stderr.write('E2E: committed provider save reply dropped\n');
          socket.destroy();
          const callback = rest.find(value => typeof value === 'function');
          if (callback) queueMicrotask(callback);
          return true;
        }
        return write.call(this, bytes, ...rest);
      };
    }
    return emit.call(this, event, ...args);
  };
}
