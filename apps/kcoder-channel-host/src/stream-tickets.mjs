import { randomUUID, createHash } from 'node:crypto';
import { ChannelError, requireValue } from './errors.mjs';

const CHUNK = 64 * 1024;
const MAX_STREAM_BYTES = 100 * 1024 * 1024;
const MAX_EMPTY_PULLS = 32;
const CLEANUP_TIMEOUT_MS = 5000;

function failure(code, cause, recovery = 'none') {
  const error = new ChannelError(code, recovery);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}
const cleanupFailure = cause => failure('WORKER_STREAM_CLEANUP_UNCONFIRMED', cause, 'reconcile_original');
function attachCleanupFailure(original, cleanupError) {
  if (!original || typeof original !== 'object' || original === cleanupError) return;
  // Frozen errors still retain their original outcome; the close receipt records cleanup separately.
  try { Object.defineProperty(original, 'cleanupError', { value: cleanupError, configurable: true }); } catch {}
}
function metadata(value) {
  requireValue(value && typeof value.filename === 'string' && value.filename.length > 0 && value.filename.length <= 4096
    && !/[\u0000\r\n]/.test(value.filename), 'WORKER_STREAM_INVALID');
  const mediaType = value.mediaType ?? 'application/octet-stream';
  const expectedBytes = value.expectedBytes ?? null, sha256 = value.sha256 ?? null;
  requireValue(typeof mediaType === 'string' && mediaType.length > 0 && mediaType.length <= 256
    && !/[\u0000\r\n]/.test(mediaType), 'WORKER_STREAM_INVALID');
  requireValue(expectedBytes === null || Number.isSafeInteger(expectedBytes) && expectedBytes >= 0, 'WORKER_STREAM_INVALID');
  requireValue(sha256 === null || typeof sha256 === 'string' && /^[a-f0-9]{64}$/i.test(sha256), 'WORKER_STREAM_INVALID');
  return { filename: value.filename, mediaType, expectedBytes, sha256: sha256?.toLowerCase() ?? null };
}
function bounded(promise, milliseconds, onTimeout) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function assertTimeout(milliseconds) {
  requireValue(Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 2147483647, 'WORKER_STREAM_INVALID');
}
async function abortable(promise, signal, reason) {
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(reason());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([promise, cancelled]); }
  // A permanent unresolved Promise per stream would retain every past race result.
  finally { signal.removeEventListener('abort', abort); }
}

/** Private byte tickets belong to one IPC owner. A filename is metadata, never a write capability. */
export class StreamTickets {
  constructor({ maxStreams = 16, maxReservedBytes = 200 * 1024 * 1024, ttlMs = 60000,
    cleanupTimeoutMs = CLEANUP_TIMEOUT_MS, now = () => Date.now() } = {}) {
    requireValue(Number.isSafeInteger(maxStreams) && maxStreams > 0 && Number.isSafeInteger(maxStreams * 2)
      && Number.isSafeInteger(maxReservedBytes) && maxReservedBytes >= 0
      && Number.isSafeInteger(ttlMs) && ttlMs > 0 && typeof now === 'function', 'WORKER_STREAM_INVALID');
    assertTimeout(cleanupTimeoutMs);
    Object.assign(this, { maxStreams, maxReservedBytes, ttlMs, cleanupTimeoutMs, now });
    this.maxRetainedTickets = maxStreams * 2;
    this.items = new Map(); this.receipts = new Map(); this.reserved = 0;
    this.closed = false;
  }

  expiry() {
    const expiry = this.now() + this.ttlMs;
    requireValue(Number.isSafeInteger(expiry), 'WORKER_STREAM_INVALID');
    return expiry;
  }

  async open(owner, source) {
    requireValue(!this.closed, 'WORKER_STREAM_CLOSED');
    const stream = source?.byteStream, dispose = source?.dispose, createIterator = stream?.[Symbol.asyncIterator];
    requireValue(typeof owner === 'string' && owner.length > 0 && owner.length <= 512
      && typeof createIterator === 'function'
      && (dispose === undefined || typeof dispose === 'function'), 'WORKER_STREAM_INVALID');
    const declared = metadata(source), reservation = declared.expectedBytes ?? MAX_STREAM_BYTES;
    requireValue(reservation <= MAX_STREAM_BYTES, 'MEDIA_CAPACITY_EXCEEDED');
    // Expired owners are reconciled independently; uncertain cleanup retains its quota.
    await this.reapExpired();
    requireValue(!this.closed, 'WORKER_STREAM_CLOSED');
    requireValue(this.items.size < this.maxStreams && this.items.size + this.receipts.size < this.maxRetainedTickets
      && this.reserved + reservation <= this.maxReservedBytes, 'MEDIA_CAPACITY_EXCEEDED');
    const expiresAt = this.expiry();
    requireValue(!this.closed, 'WORKER_STREAM_CLOSED');
    const id = randomUUID();
    const item = { id, owner, declared, reservation, expiresAt, index: 0, remainder: null,
      bytes: 0, hash: createHash('sha256'), reading: false, last: null, terminal: false, error: null,
      closeRequested: false, cleaned: false, next: null, finish: null, initializationFailed: false,
      dispose: dispose?.bind(source), stop: new AbortController() };
    // A factory may synchronously request shutdown. Register its owned admission
    // first so the original close observes its quota and eventual cleanup ports.
    this.items.set(id, item); this.reserved += reservation;
    let factoryReturned = false, initialized = false;
    try {
      const iterator = createIterator.call(stream); factoryReturned = true;
      const finish = iterator?.return;
      item.finish = typeof finish === 'function' ? finish.bind(iterator) : null;
      const next = iterator?.next;
      item.next = typeof next === 'function' ? next.bind(iterator) : null;
      requireValue(item.next && (finish === undefined || typeof finish === 'function'),
        'WORKER_STREAM_INVALID', 'reconcile_original');
      initialized = true;
      requireValue(!this.closed && !item.closeRequested, 'WORKER_STREAM_CLOSED', 'reconcile_original');
      return { streamId: id, ...declared };
    } catch (cause) {
      item.initializationFailed = !initialized;
      const error = factoryReturned && cause instanceof ChannelError ? cause
        : failure('WORKER_STREAM_SOURCE_FAILED', cause, 'reconcile_original');
      try { await this.close(owner, id); }
      catch (cleanupError) { attachCleanupFailure(error, cleanupError); }
      throw error;
    }
  }

  get(owner, id) {
    const item = this.items.get(id) ?? this.receipts.get(id);
    requireValue(item && item.owner === owner, 'WORKER_STREAM_NOT_FOUND');
    requireValue(item.expiresAt > this.now(), 'WORKER_STREAM_EXPIRED');
    return item;
  }

  retire(item) {
    item.cleaned = true;
    if (this.items.get(item.id) === item) {
      this.items.delete(item.id); this.reserved -= item.reservation;
    }
    if (!item.closeRequested) {
      // Only small receipts survive cleanup; source buffers/iterators are not replay caches.
      const error = item.error && !(item.error.code === 'WORKER_STREAM_CLEANUP_UNCONFIRMED' && item.last?.done)
        ? failure(item.error.code, undefined, item.error.recovery) : null;
      this.receipts.set(item.id, { owner: item.owner, expiresAt: item.expiresAt,
        last: item.last, terminal: true, error });
    }
    item.remainder = null; item.hash = null; item.next = null; item.finish = null; item.dispose = null;
    item.pendingNext = null;
  }

  cleanup(item) {
    if (!item.cleanupTask) {
      const disposing = Promise.resolve().then(() => item.dispose?.()).then(() => {});
      // Either hook may interrupt a pull; quota stays held until that original pull also settles.
      const returning = Promise.resolve().then(async () => {
        if (!item.finish) {
          requireValue(!item.initializationFailed || item.dispose,
            'WORKER_STREAM_CLEANUP_UNCONFIRMED', 'reconcile_original');
          return;
        }
        const result = await item.finish();
        requireValue(result && typeof result === 'object' && result.done === true,
          'WORKER_STREAM_CLEANUP_UNCONFIRMED', 'reconcile_original');
      });
      const settledPull = Promise.resolve(item.pendingNext).then(() => {}, () => {});
      item.cleanupTask = Promise.allSettled([disposing, returning, settledPull]).then(results => {
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw cleanupFailure(new AggregateError(failures));
        this.retire(item);
      });
      item.cleanupReceipt = bounded(item.cleanupTask, this.cleanupTimeoutMs,
        () => cleanupFailure()).catch(error => { item.cleanupError = error; throw error; });
    }
    return item.cleaned ? Promise.resolve() : item.cleanupReceipt;
  }

  async read(owner, id, index) {
    let item;
    try { item = this.get(owner, id); }
    catch (error) {
      if (error.code === 'WORKER_STREAM_EXPIRED' && this.items.get(id)?.owner === owner) {
        try { await this.close(owner, id); }
        catch (cleanupError) { attachCleanupFailure(error, cleanupError); }
      }
      throw error;
    }
    requireValue(!item.closeRequested, 'WORKER_STREAM_CLOSED');
    if (item.error) throw item.error;
    if (item.last?.index === index) { item.expiresAt = this.expiry(); return item.last; }
    requireValue(!item.terminal && !item.reading && Number.isSafeInteger(index) && index === item.index, 'WORKER_STREAM_INDEX_CONFLICT');
    item.expiresAt = this.expiry();
    item.reading = true;
    try {
      let next, emptyPulls = 0;
      do {
        if (item.remainder) next = { done: false, value: item.remainder };
        else {
          item.pendingNext = Promise.resolve().then(() => {
            requireValue(!item.closeRequested, 'WORKER_STREAM_CLOSED');
            return item.next();
          }).catch(error => { throw item.closeRequested ? failure('WORKER_STREAM_CLOSED') : failure('WORKER_STREAM_SOURCE_FAILED', error); });
          next = await abortable(item.pendingNext, item.stop.signal, () => failure('WORKER_STREAM_CLOSED'));
        }
        requireValue(!item.closeRequested, 'WORKER_STREAM_CLOSED');
        requireValue(next && typeof next === 'object' && (next.done === undefined || typeof next.done === 'boolean'), 'WORKER_STREAM_CHUNK_INVALID');
        if (next.done || !(next.value instanceof Uint8Array) || next.value.length !== 0) break;
        requireValue(++emptyPulls <= MAX_EMPTY_PULLS, 'WORKER_STREAM_SOURCE_STALLED');
      } while (true);
      if (next.done) {
        requireValue(item.declared.expectedBytes === null || item.bytes === item.declared.expectedBytes, 'WORKER_STREAM_LENGTH_MISMATCH');
        const sha256 = item.hash.digest('hex');
        requireValue(item.declared.sha256 === null || item.declared.sha256 === sha256, 'WORKER_STREAM_HASH_MISMATCH');
        item.terminal = true; item.expiresAt = this.expiry();
        item.last = { streamId: id, index, done: true, bytes: item.bytes, sha256 };
        await this.cleanup(item);
        return item.last;
      }
      requireValue(next.value instanceof Uint8Array && next.value.length > 0 && next.value.length <= MAX_STREAM_BYTES, 'WORKER_STREAM_CHUNK_INVALID');
      const chunk = next.value.subarray(0, CHUNK), bytes = item.bytes + chunk.length;
      requireValue(bytes <= item.reservation, 'WORKER_STREAM_LENGTH_MISMATCH');
      item.hash.update(chunk); item.bytes = bytes;
      item.remainder = next.value.length > CHUNK ? next.value.subarray(CHUNK) : null;
      item.index++; item.expiresAt = this.expiry();
      item.last = { streamId: id, index, done: false, contentBase64: Buffer.from(chunk).toString('base64') };
      return item.last;
    } catch (error) {
      if (item.closeRequested) throw failure('WORKER_STREAM_CLOSED');
      item.error = error instanceof ChannelError ? error : failure('WORKER_STREAM_SOURCE_FAILED', error);
      item.terminal = true;
      try { await this.cleanup(item); }
      catch (cleanupError) { attachCleanupFailure(item.error, cleanupError); }
      throw item.error;
    } finally { item.reading = false; }
  }

  async close(owner, id) {
    const item = this.items.get(id), receipt = this.receipts.get(id);
    if (!item) {
      if (receipt) {
        requireValue(receipt.owner === owner, 'WORKER_STREAM_NOT_FOUND');
        this.receipts.delete(id);
      }
      return Promise.resolve({ closed: true });
    }
    requireValue(item.owner === owner, 'WORKER_STREAM_NOT_FOUND');
    item.closeRequested = true; item.stop.abort();
    return item.closeReceipt ??= this.cleanup(item).then(() => ({ closed: true }));
  }

  reapExpired() {
    const now = this.now();
    for (const [id, item] of this.receipts) if (item.expiresAt <= now) this.receipts.delete(id);
    return Promise.allSettled([...this.items].filter(([, item]) => item.expiresAt <= now)
      .map(([id, item]) => this.close(item.owner, id)));
  }

  async reap() {
    const results = await this.reapExpired();
    if (results.some(result => result.status === 'rejected'))
      throw cleanupFailure(new AggregateError(results.filter(result => result.status === 'rejected').map(result => result.reason)));
  }

  async closeAll() {
    // Shutdown is terminal even when an original cleanup receipt remains unknown.
    this.closed = true;
    const owned = [...this.items, ...this.receipts];
    const results = await Promise.allSettled(owned.map(([id, item]) => this.close(item.owner, id)));
    if (results.some(result => result.status === 'rejected'))
      throw cleanupFailure(new AggregateError(results.filter(result => result.status === 'rejected').map(result => result.reason)));
  }
}

export function privateTicketSource(call, { owner, ticket, signal, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS }) {
  requireValue(typeof call === 'function' && typeof owner === 'string' && owner.length > 0
    && typeof ticket?.streamId === 'string' && ticket.streamId.length > 0, 'WORKER_STREAM_INVALID');
  const declared = metadata(ticket);
  const streamId = ticket.streamId;
  requireValue(declared.expectedBytes === null || declared.expectedBytes <= MAX_STREAM_BYTES, 'WORKER_STREAM_INVALID');
  assertTimeout(cleanupTimeoutMs);
  let closeReceipt, confirmed = false, closed = false;
  const stop = new AbortController();
  const cancellation = () => signal?.aborted ? signal.reason : failure('WORKER_STREAM_CLOSED');
  const aborted = () => { close().catch(() => {}); };
  function close() {
    if (confirmed) return Promise.resolve({ closed: true });
    if (!closeReceipt) {
      closed = true; stop.abort(); signal?.removeEventListener('abort', aborted);
      const operation = Promise.resolve().then(() => call('close', { owner, streamId })).then(receipt => {
        requireValue(receipt?.closed === true, 'WORKER_STREAM_CLEANUP_UNCONFIRMED', 'reconcile_original');
        confirmed = true; return receipt;
      });
      closeReceipt = bounded(operation, cleanupTimeoutMs, () => cleanupFailure()).catch(error => {
        throw error instanceof ChannelError && error.code === 'WORKER_STREAM_CLEANUP_UNCONFIRMED' ? error : cleanupFailure(error);
      });
    }
    return closeReceipt;
  }
  async function* byteStream() {
    let index = 0, bytes = 0, originalError, failed = false;
    const hash = createHash('sha256');
    try {
      while (true) {
        signal?.throwIfAborted(); requireValue(!closed, 'WORKER_STREAM_CLOSED');
        const reading = Promise.resolve().then(() => {
          signal?.throwIfAborted(); requireValue(!closed, 'WORKER_STREAM_CLOSED');
          return call('read', { owner, streamId, index });
        });
        const chunk = await abortable(reading, stop.signal, cancellation);
        signal?.throwIfAborted(); requireValue(!closed, 'WORKER_STREAM_CLOSED');
        requireValue(chunk?.streamId === streamId && chunk.index === index && typeof chunk.done === 'boolean', 'WORKER_STREAM_RECEIPT_INVALID');
        if (chunk.done) {
          const actual = hash.digest('hex');
          requireValue(chunk.bytes === bytes && chunk.sha256 === actual
            && (declared.expectedBytes === null || declared.expectedBytes === bytes)
            && (declared.sha256 === null || declared.sha256 === actual), 'WORKER_STREAM_HASH_MISMATCH');
          break;
        }
        requireValue(typeof chunk.contentBase64 === 'string' && chunk.contentBase64.length <= 4 * Math.ceil(CHUNK / 3), 'WORKER_STREAM_CHUNK_INVALID');
        const part = Buffer.from(chunk.contentBase64, 'base64');
        requireValue(part.length > 0 && part.length <= CHUNK && part.toString('base64') === chunk.contentBase64, 'WORKER_STREAM_CHUNK_INVALID');
        bytes += part.length;
        requireValue(bytes <= MAX_STREAM_BYTES && (declared.expectedBytes === null || bytes <= declared.expectedBytes), 'WORKER_STREAM_LENGTH_MISMATCH');
        hash.update(part); yield part; index++;
      }
    } catch (error) { originalError = error; failed = true; throw error; }
    finally {
      try { await close(); }
      catch (cleanupError) {
        if (!failed) throw cleanupError;
        attachCleanupFailure(originalError, cleanupError);
      }
    }
  }
  if (signal) {
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  }
  const iterator = byteStream(), finish = iterator.return.bind(iterator);
  // Native generator return queues behind next(); interrupt our IPC wait first.
  iterator.return = value => Promise.all([close(), finish(value)]).then(([, result]) => result);
  return { filename: declared.filename, mediaType: declared.mediaType,
    ...(declared.expectedBytes !== null ? { expectedBytes: declared.expectedBytes } : {}),
    ...(declared.sha256 !== null ? { sha256: declared.sha256 } : {}), byteStream: iterator, dispose: close };
}
