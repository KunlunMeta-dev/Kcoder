import { Agent } from 'node:http';

export const GET_POOL_IDLE_MS = 10_000;
const unavailable = () => Object.assign(new Error('Relay GET lease unavailable'), { code: 'RELAY_UNAVAILABLE' });

/** At most two independent serial HTTP parsers per exact grant/control generation.
 * Prefer an existing idle connection; never pipeline or automatically replay.
 */
export class GrantGetPool {
  constructor({ validate, createConnection, expiresAt, admitWaiter, releaseWaiter, queueTimeoutMs, maxSockets = 1 }) {
    if (!Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1 || !Number.isFinite(expiresAt) ||
        !Number.isSafeInteger(maxSockets) || maxSockets < 1 || maxSockets > 2)
      throw new Error('Invalid Relay GET pool budget or expiry');
    this.validate = validate;
    this.admitWaiter = admitWaiter;
    this.releaseWaiter = releaseWaiter;
    this.queueTimeoutMs = Math.min(queueTimeoutMs, 10_000);
    this.queue = [];
    this.retired = false;
    this.retirementError = null;
    this.expiryTimer = null;
    this.slots = Array.from({ length: maxSockets }, () => {
      const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, scheduling: 'fifo' });
      agent.createConnection = () => createConnection(() => this.assertCurrent());
      return { agent, active: false, forwarded: false, idleTimer: null };
    });
    const expire = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) this.retire(Object.assign(new Error('Relay access grant expired'), { code: 'RELAY_UNAUTHORIZED' }));
      else { this.expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_000_000)); this.expiryTimer.unref?.(); }
    };
    expire();
  }

  get active() { return this.slots.some(slot => slot.active); }
  hasConnection(slot) {
    return [...Object.values(slot.agent.freeSockets), ...Object.values(slot.agent.sockets)]
      .some(sockets => sockets.some(socket => !socket.destroyed));
  }
  availableSlot() {
    return this.slots.find(slot => !slot.active && this.hasConnection(slot)) || this.slots.find(slot => !slot.active);
  }
  /** Management admission may evict idle slots without interrupting a sibling request. */
  evictIdle() {
    for (const slot of this.slots) if (!slot.active) {
      clearTimeout(slot.idleTimer); slot.idleTimer = null; slot.agent.destroy();
    }
  }
  assertCurrent() {
    const error = this.retirementError || this.validate();
    if (this.retired || error) throw error || unavailable();
  }

  acquire(signal) {
    try { this.assertCurrent(); } catch (error) { return Promise.reject(error); }
    if (signal?.aborted) return Promise.reject(unavailable());
    const slot = this.availableSlot();
    if (slot) return Promise.resolve(this.claim(slot));
    if (!this.admitWaiter()) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, timer: null, abort: null };
      const remove = error => {
        const index = this.queue.indexOf(item);
        if (index === -1) return;
        this.queue.splice(index, 1); this.finishWaiter(item); reject(error);
      };
      item.abort = () => remove(unavailable());
      item.timer = setTimeout(() => remove(Object.assign(new Error('Relay GET queue timed out'), { code: 'RELAY_TIMEOUT' })), this.queueTimeoutMs);
      item.timer.unref?.();
      signal?.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item);
      if (signal?.aborted) item.abort();
    });
  }
  finishWaiter(item) {
    clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.abort); this.releaseWaiter();
  }
  claim(slot) {
    this.assertCurrent();
    clearTimeout(slot.idleTimer); slot.idleTimer = null;
    slot.active = true; slot.forwarded = false;
    let released = false;
    return {
      agent: slot.agent,
      markForwarded: () => {
        if (released) throw unavailable();
        this.assertCurrent(); slot.forwarded = true;
      },
      release: reusable => {
        if (released) return;
        released = true; slot.active = false; slot.forwarded = false;
        if (this.retired) { slot.agent.destroy(); return; }
        if (!reusable) {
          // This request failed: destroy its own channel, without poisoning a
          // concurrent sibling. A later independently admitted GET is not a retry.
          slot.agent.destroy();
        }
        try { this.assertCurrent(); } catch (error) { this.retire(error); return; }
        while (this.queue.length) {
          const item = this.queue.shift(); this.finishWaiter(item);
          try {
            if (item.signal?.aborted) throw unavailable();
            item.resolve(this.claim(slot)); return;
          } catch (error) { item.reject(error); }
        }
        slot.idleTimer = setTimeout(() => { slot.idleTimer = null; slot.agent.destroy(); }, GET_POOL_IDLE_MS);
        slot.idleTimer.unref?.();
      },
    };
  }

  /** Refresh/expiry cancels idle/queued/not-yet-forwarded work. Only already
   * forwarded exchanges settle once; revoke/control close always close now.
   */
  retire(error = unavailable(), hard = false) {
    this.retired = true; this.retirementError ||= error;
    clearTimeout(this.expiryTimer); this.expiryTimer = null;
    for (const item of this.queue.splice(0)) { this.finishWaiter(item); item.reject(this.retirementError); }
    for (const slot of this.slots) {
      clearTimeout(slot.idleTimer); slot.idleTimer = null;
      if (hard || !slot.active || !slot.forwarded) slot.agent.destroy();
    }
  }
}
