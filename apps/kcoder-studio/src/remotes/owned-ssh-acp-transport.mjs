import { TextDecoder } from 'node:util';

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 256;
const MAX_REQUESTS = 4096;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\x00-\x1f\x7f]/.test(value);

/** Bytes only: the existing selected-target owner supplies its actual SSH child,
 * verifies authentication/account/image around every operation, and stops only
 * its owned subtree. No command, process ID, permission or model loop lives here.
 */
export function captureOwnedNativeSshAcpTransport({ child, assertEndpointOwner, stopOwned,
  operationId, endpointInstanceId, deadlineAtMs, signal }) {
  if (!child?.stdin?.write || !child?.stdout?.on || typeof assertEndpointOwner !== 'function'
    || typeof stopOwned !== 'function' || !validId(operationId) || !validId(endpointInstanceId)
    || !Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= Date.now())
    throw new Error('REMOTE_HOST_ACTUAL_SSH_OWNER_REQUIRED');
  const binding = Object.freeze({ child, operationId, endpointInstanceId });
  assertEndpointOwner(binding);
  const requests = new Map();
  const queue = [];
  const waiters = new Set();
  const writes = new Set();
  let partial = Buffer.alloc(0);
  let bytesQueued = 0;
  let nextSequence = 1;
  let acknowledged = 0;
  let delivered = 0;
  let stopped = false;
  let cleanup;
  let reason;
  const wake = () => { for (const notify of waiters) notify(); waiters.clear(); };
  const close = (code = 'REMOTE_HOST_TRANSPORT_CLOSED') => {
    if (!stopped) {
      stopped = true; reason = code;
      for (const receipt of requests.values()) {
        if (receipt.state === 'write_pending') receipt.state = 'outcome_unknown';
      }
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onAbort);
      wake();
      for (const reject of writes) reject(new Error('REMOTE_HOST_RECONCILE_ORIGINAL'));
      writes.clear();
      // This callback retains the original owner even after execution authority
      // expires. It never selects a process by a cross-host PID or a peer name.
      cleanup = Promise.resolve().then(() => stopOwned(binding));
      cleanup.catch(() => {});
    }
    return cleanup;
  };
  const check = () => {
    if (stopped) throw new Error(reason);
    if (signal?.aborted || Date.now() >= deadlineAtMs) {
      close('REMOTE_HOST_ORIGINAL_DEADLINE_OR_CANCEL');
      throw new Error('REMOTE_HOST_ORIGINAL_DEADLINE_OR_CANCEL');
    }
    try { assertEndpointOwner(binding); }
    catch { close('REMOTE_HOST_ENDPOINT_OWNER_CHANGED'); throw new Error('REMOTE_HOST_ENDPOINT_OWNER_CHANGED'); }
  };
  const onAbort = () => { close('REMOTE_HOST_SOURCE_CLOSED'); };
  const deadlineTimer = setTimeout(() => close('REMOTE_HOST_ORIGINAL_DEADLINE_OR_CANCEL'), Math.min(deadlineAtMs - Date.now(), 2_147_483_647));
  deadlineTimer.unref?.();
  signal?.addEventListener('abort', onAbort, { once: true });
  child.once?.('close', () => close());
  child.once?.('error', () => close('REMOTE_HOST_SSH_OUTCOME_UNKNOWN'));
  child.stdin.on?.('error', () => close('REMOTE_HOST_SSH_OUTCOME_UNKNOWN'));
  const append = line => {
    if (!line.length) return;
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      if (!value || Array.isArray(value) || value.jsonrpc !== '2.0') throw new Error();
    } catch { close('REMOTE_HOST_INVALID_ACP_FRAME'); return; }
    if (queue.length >= MAX_QUEUED_FRAMES || bytesQueued + line.length > MAX_QUEUED_BYTES) {
      close('REMOTE_HOST_ACP_BACKPRESSURE'); return;
    }
    queue.push({ sequence: nextSequence++, bytes: line.length, frame: value });
    bytesQueued += line.length;
    wake();
  };
  child.stdout.on('data', input => {
    if (stopped) return;
    try { check(); } catch { return; }
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let offset = 0;
    for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, offset)) {
      const fragment = chunk.subarray(offset, end);
      if (partial.length + fragment.length > MAX_FRAME_BYTES) { close('REMOTE_HOST_ACP_FRAME_TOO_LARGE'); return; }
      const line = partial.length ? Buffer.concat([partial, fragment]) : fragment;
      partial = Buffer.alloc(0); offset = end + 1;
      append(line);
      if (stopped) return;
    }
    const tail = chunk.subarray(offset);
    if (partial.length + tail.length > MAX_FRAME_BYTES) { close('REMOTE_HOST_ACP_FRAME_TOO_LARGE'); return; }
    if (tail.length) partial = partial.length ? Buffer.concat([partial, tail]) : Buffer.from(tail);
  });
  child.stdout.once('end', () => {
    // Native JSONL must finish its last frame. A partial frame cannot be
    // repaired from replacement bytes or silently promoted to a known receipt.
    close(partial.length ? 'REMOTE_HOST_TRUNCATED_ACP_FRAME' : 'REMOTE_HOST_TRANSPORT_CLOSED');
  });
  if (signal?.aborted) onAbort();
  return Object.freeze({
    get closed() { return stopped; },
    async writeOnce(requestId, frame) {
      check();
      if (!validId(requestId) || requests.size >= MAX_REQUESTS) throw new Error('REMOTE_HOST_REQUEST_INVALID_OR_CAPACITY');
      if (requests.has(requestId)) throw new Error('REMOTE_HOST_RECONCILE_ORIGINAL');
      const bytes = Buffer.from(JSON.stringify(frame));
      if (!frame || Array.isArray(frame) || frame.jsonrpc !== '2.0' || bytes.length > MAX_FRAME_BYTES)
        throw new Error('REMOTE_HOST_INVALID_ACP_FRAME');
      const receipt = { state: 'write_pending' };
      // Persist the in-owner identity before handing any bytes to the pipe. A
      // failed callback or lost host reply must never cause an automatic write.
      requests.set(requestId, receipt);
      try {
        await new Promise((resolve, reject) => {
          writes.add(reject);
          child.stdin.write(Buffer.concat([bytes, Buffer.from('\n')]), error => { writes.delete(reject); error ? reject(error) : resolve(); });
        });
        check();
        receipt.state = 'transport_written';
      } catch {
        receipt.state = 'outcome_unknown';
        close('REMOTE_HOST_SSH_OUTCOME_UNKNOWN');
        throw new Error('REMOTE_HOST_RECONCILE_ORIGINAL');
      }
      return { operationId, endpointInstanceId, requestId, state: receipt.state };
    },
    observeWrite(requestId) {
      // Observation after shutdown retains the original uncertainty without
      // acquiring execution permission or writing another ACP frame.
      const value = requests.get(requestId);
      return { operationId, endpointInstanceId, requestId, state: value?.state ?? 'not_observed' };
    },
    async read({ acknowledgeThrough = acknowledged, maximumFrames = 16, maximumBytes = MAX_FRAME_BYTES, waitMs = 0 } = {}) {
      check();
      if (!Number.isSafeInteger(acknowledgeThrough) || acknowledgeThrough < acknowledged || acknowledgeThrough > delivered
        || !Number.isInteger(maximumFrames) || maximumFrames < 1 || maximumFrames > 64
        || !Number.isInteger(maximumBytes) || maximumBytes < MAX_FRAME_BYTES || maximumBytes > MAX_QUEUED_BYTES
        || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 1000)
        throw new Error('REMOTE_HOST_READ_CURSOR_INVALID');
      acknowledged = acknowledgeThrough;
      while (queue.length && queue[0].sequence <= acknowledged) bytesQueued -= queue.shift().bytes;
      if (!queue.length && waitMs) {
        await new Promise(resolve => {
          let timer;
          const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
          waiters.add(done);
          timer = setTimeout(done, Math.min(waitMs, Math.max(0, deadlineAtMs - Date.now())));
        });
        check();
      }
      const frames = []; let total = 0;
      for (const value of queue) {
        if (frames.length >= maximumFrames || total + value.bytes > maximumBytes) break;
        frames.push({ sequence: value.sequence, frame: value.frame }); total += value.bytes;
      }
      if (frames.length) delivered = Math.max(delivered, frames.at(-1).sequence);
      return { operationId, endpointInstanceId, acknowledgeThrough: acknowledged, frames };
    },
    close,
  });
}
