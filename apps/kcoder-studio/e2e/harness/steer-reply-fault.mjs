// Owned Gateway preload drops exactly one complete committed Agent reply.
// It never changes acceptance, receipts or tool inputs and keeps observation RPCs connected.
import { Server } from 'node:http';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export function committedSteerFrame(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes[0] !== 0x81 || bytes[1] & 0x80) return null;
  let length = bytes[1] & 0x7f, offset = 2;
  if (length === 126) { if (bytes.length < 4) return null; length = bytes.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (bytes.length < 10) return null; const wide = bytes.readBigUInt64BE(2); if (wide > 2n * 1024n * 1024n) return null; length = Number(wide); offset = 10; }
  if (bytes.length !== offset + length) return null;
  try { const value = JSON.parse(bytes.subarray(offset).toString('utf8')); return value.id !== undefined && !value.error ? value.result : null; } catch { return null; }
}
export function isAgentSteerReply(value) {
  return typeof value?.queued === 'boolean' && typeof value.agentId === 'string' && typeof value.clientMessageId === 'string' && value.clientMessageId.startsWith('cmd:');
}
export function isCommittedSteerReceipt(value) {
  return value?.queued === true && typeof value.agentId === 'string' && Boolean(value.agentId) && typeof value.messageId === 'string' && Boolean(value.messageId) && typeof value.clientMessageId === 'string' && /^cmd:0:[a-zA-Z0-9-]+$/.test(value.clientMessageId) && ['queued_live', 'queued_paused', 'queued_behind_blocked', 'resuming'].includes(value.status);
}
if (process.env.KCODER_E2E_DROP_STEER_REPLY === '1') {
  const proof = { committedReplyDropped: false, journalObservations: 0, steerReplies: 0, droppedClientMessageId: null, droppedAgentId: null };
  const evidence = process.env.KCODER_E2E_STEER_REPLY_FAULT_EVIDENCE;
  if (!evidence || !isAbsolute(evidence)) throw new Error('Owned steer reply fault requires an absolute evidence file');
  // Reserve the owned receipt before touching the Gateway's write path.
  writeFileSync(evidence, JSON.stringify(proof), { mode: 0o600, flag: 'wx' });
  const publish = () => {
    const temporary = `${evidence}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(proof), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, evidence);
      return true;
    } catch {
      try { unlinkSync(temporary); } catch {}
      console.error('Owned steer reply fault evidence publication failed');
      return false;
    }
  };
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (event, ...args) {
    const request = args[0];
    if (event === 'upgrade' && request?.url?.startsWith('/rpc?') && new URL(request.url, 'http://localhost').searchParams.get('server') === 'local') {
      const socket = args[1], write = socket.write;
      socket.write = function (bytes, ...rest) {
        const value = committedSteerFrame(bytes);
        if (isAgentSteerReply(value)) {
          proof.steerReplies += 1;
          if (!proof.committedReplyDropped && isCommittedSteerReceipt(value)) {
            proof.committedReplyDropped = true; proof.droppedClientMessageId = value.clientMessageId; proof.droppedAgentId = value.agentId;
            if (!publish()) { proof.committedReplyDropped = false; return write.call(this, bytes, ...rest); }
            const callback = rest.find(item => typeof item === 'function'); if (callback) queueMicrotask(callback);
            return true;
          }
          if (proof.committedReplyDropped) publish(false);
        } else if (proof.committedReplyDropped && (value?.receipt?.clientMessageId === proof.droppedClientMessageId || value?.receipts?.some(item => item.clientMessageId === proof.droppedClientMessageId))) {
          proof.journalObservations += 1; publish(false);
        }
        return write.call(this, bytes, ...rest);
      };
    }
    return emit.call(this, event, ...args);
  };
}
