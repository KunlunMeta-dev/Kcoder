import { randomBytes } from 'node:crypto';

// A transport lease, not a model request or permission to kill the backend.
export class WebSocketLivenessLease {
  constructor({ sendPing, onExpired, canProbe = () => true, now = () => performance.now(),
    intervalMs = 30_000, timeoutMs = 30_000 }) {
    if (![intervalMs, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647))
      throw new Error('invalid WebSocket lease duration');
    Object.assign(this, { sendPing, onExpired, canProbe, now, intervalMs, timeoutMs });
    this.stopped = false;
    this.pending = null;
  }

  start() { if (!this.stopped && !this.timer) this.arm(this.intervalMs, () => this.probe()); }

  arm(delay, callback) {
    clearTimeout(this.timer);
    const due = this.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      // A suspended event loop has not had a fair chance to consume its pending pong.
      if (this.now() > due + this.timeoutMs) {
        this.pending = null;
        this.start();
        return;
      }
      callback();
    }, delay);
    this.timer.unref?.();
  }

  probe() {
    if (!this.canProbe()) { this.start(); return; }
    this.pending = randomBytes(8);
    this.arm(this.timeoutMs, () => {
      if (!this.canProbe()) {
        this.pending = null;
        this.start();
      } else this.expire();
    });
    try { this.sendPing(this.pending); }
    catch { this.expire(); }
  }

  pong(payload) {
    if (this.stopped || !this.pending || !Buffer.isBuffer(payload) || !this.pending.equals(payload)) return;
    this.pending = null;
    this.arm(this.intervalMs, () => this.probe());
  }

  expire() {
    if (this.stopped) return;
    this.stop();
    try { this.onExpired(); } catch { /* A cleanup failure must not crash unrelated clients. */ }
  }

  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; this.pending = null; }
}
