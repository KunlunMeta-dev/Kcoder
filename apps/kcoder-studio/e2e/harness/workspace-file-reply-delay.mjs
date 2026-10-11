// Owned-test preload: hold one genuine first-chunk reply until the suite has
// selected a directory. No file contents or protocol response are fabricated.
import { Server } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';

export function isOwnedFirstFileChunkFrame(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes[0] !== 0x81 || bytes[1] & 0x80) return false;
  let length = bytes[1] & 127, offset = 2;
  if (length === 126) { if (bytes.length < 4) return false; length = bytes.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (bytes.length < 10) return false; const wide = bytes.readBigUInt64BE(2); if (wide > 2097152n) return false; length = Number(wide); offset = 10; }
  if (bytes.length !== offset + length) return false;
  try {
    const value = JSON.parse(bytes.subarray(offset).toString('utf8'));
    if (value.id === undefined || value.error || !value.result?.stdout) return false;
    const chunk = typeof value.result.stdout === 'string' ? JSON.parse(value.result.stdout) : value.result.stdout;
    return chunk.offset === 0 && typeof chunk.content_base64 === 'string' &&
      /(?:^|[\\/])owned-pending-preview\.pdf$/.test(chunk.path);
  } catch { return false; }
}

if (process.env.KCODER_E2E_DELAY_WORKSPACE_FILE_REPLY === '1') {
  let held = false;
  const evidence = { held: false, released: false, cancelled: false, timedOut: false };
  const record = () => writeFileSync(process.env.KCODER_E2E_WORKSPACE_FILE_REPLY_EVIDENCE, JSON.stringify(evidence), { mode: 0o600 });
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (event, ...args) {
    if (event === 'upgrade' && args[0]?.url?.startsWith('/rpc?')) {
      const socket = args[1], write = socket.write;
      socket.write = function (bytes, ...rest) {
        if (!held && isOwnedFirstFileChunkFrame(bytes)) {
          held = true; evidence.held = true; record();
          const deadline = Date.now() + 20000;
          const cancel = () => { clearInterval(timer); evidence.cancelled = true; record(); };
          const timer = setInterval(() => {
            if (!existsSync(process.env.KCODER_E2E_WORKSPACE_FILE_REPLY_RELEASE) && Date.now() < deadline) return;
            clearInterval(timer); socket.off('close', cancel);
            evidence.timedOut = !existsSync(process.env.KCODER_E2E_WORKSPACE_FILE_REPLY_RELEASE);
            if (!socket.destroyed) { write.call(socket, bytes, ...rest); evidence.released = true; }
            record();
          }, 50);
          socket.once('close', cancel);
          return true;
        }
        return write.call(this, bytes, ...rest);
      };
    }
    return emit.call(this, event, ...args);
  };
}
