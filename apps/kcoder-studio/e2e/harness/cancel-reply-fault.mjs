// Owned-test preload only: hold a genuine interrupt ACK until a new turn starts,
// then defer its first delta so the prior UI await/refresh can settle first.
import { Server } from 'node:http';
import { writeFileSync } from 'node:fs';
function frame(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes[0] !== 0x81 || bytes[1] & 0x80) return null;
  let length = bytes[1] & 127, offset = 2;
  if (length === 126) { if (bytes.length < 4) return null; length = bytes.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (bytes.length < 10) return null; const wide = bytes.readBigUInt64BE(2); if (wide > 2097152n) return null; length = Number(wide); offset = 10; }
  if (bytes.length !== offset + length) return null;
  try { return JSON.parse(bytes.subarray(offset).toString('utf8')); } catch { return null; }
}
if (process.env.KCODER_E2E_DELAY_CANCEL_REPLY === '1') {
  const turns = new Set(); let held, delayed = false;
  const evidence = { ackHeld: false, ackReleasedAfterNewTurn: false, delayedNewTurnDelta: false, deltaReleased: false };
  const record = () => writeFileSync(process.env.KCODER_E2E_CANCEL_REPLY_EVIDENCE, JSON.stringify(evidence), { mode: 0o600 });
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (event, ...args) {
    if (event === 'upgrade' && args[0]?.url?.startsWith('/rpc?')) {
      const socket = args[1], write = socket.write;
      socket.write = function (bytes, ...rest) {
        const value = frame(bytes);
        const send = () => { if (!socket.destroyed) write.call(socket, bytes, ...rest); };
        if (value?.method === 'turn/started') {
          turns.add(value.params?.turnId ?? value.params?.turn?.id);
          if (turns.size === 2 && held) {
            const release = held; held = undefined;
            queueMicrotask(() => { release(); evidence.ackReleasedAfterNewTurn = true; record(); });
          }
        }
        if (!evidence.ackHeld && value?.result?.interrupted === true) {
          evidence.ackHeld = true; held = send; record(); return true;
        }
        if (turns.size === 2 && !delayed && value?.method === 'item/delta') {
          delayed = true; evidence.delayedNewTurnDelta = true; record();
          setTimeout(() => { send(); evidence.deltaReleased = true; record(); }, 2500);
          return true;
        }
        return write.call(this, bytes, ...rest);
      };
    }
    return emit.call(this, event, ...args);
  };
}
