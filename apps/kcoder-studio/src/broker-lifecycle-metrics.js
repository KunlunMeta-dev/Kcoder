import { performance } from "node:perf_hooks";

// Internal passive aggregates only: no request data, sample lists, or timers.
export class BrokerLifecycleMetrics {
  #now;
  #createdAt;
  #clientFreeAt = null;
  #values = {
    initializeMs: null,
    initializeFailureCount: 0,
    attachCount: 0,
    reuseCount: 0,
    clientFreeMsSum: 0,
    clientFreeMsMax: null,
    resumeStartedCount: 0,
    resumeSuccessCount: 0,
    resumeSuccessMsSum: 0,
    resumeSuccessMsMax: null,
    resumeErrorCount: 0,
    resumeErrorMsSum: 0,
    resumeErrorMsMax: null,
    resumeAbandonedCount: 0,
    closedCount: 0,
    lifetimeMs: null,
  };

  constructor(now = () => performance.now()) {
    this.#now = now;
    this.#createdAt = now();
  }

  initialize(success) {
    if (this.#values.closedCount) return;
    if (!success) this.#values.initializeFailureCount += 1;
    else if (this.#values.initializeMs === null)
      this.#values.initializeMs = this.#now() - this.#createdAt;
  }

  attach(wasClientFree) {
    if (this.#values.closedCount) return;
    this.#values.attachCount += 1;
    if (wasClientFree && this.#clientFreeAt !== null && this.#values.initializeMs !== null) {
      const ms = this.#now() - this.#clientFreeAt;
      this.#values.reuseCount += 1;
      this.#values.clientFreeMsSum += ms;
      this.#values.clientFreeMsMax = Math.max(this.#values.clientFreeMsMax ?? 0, ms);
    }
    this.#clientFreeAt = null;
  }

  clientFree() {
    if (!this.#values.closedCount) this.#clientFreeAt = this.#now();
  }

  timestamp() {
    return this.#now();
  }

  resumeStarted(startedAt) {
    this.#values.resumeStartedCount += 1;
    return startedAt;
  }

  resumeFinished(startedAt, success) {
    if (startedAt === undefined || this.#values.closedCount) return;
    const prefix = success ? "resumeSuccess" : "resumeError";
    const ms = this.#now() - startedAt;
    this.#values[`${prefix}Count`] += 1;
    this.#values[`${prefix}MsSum`] += ms;
    this.#values[`${prefix}MsMax`] = Math.max(this.#values[`${prefix}MsMax`] ?? 0, ms);
  }

  resumeAbandoned(startedAt) {
    if (startedAt !== undefined && !this.#values.closedCount)
      this.#values.resumeAbandonedCount += 1;
  }

  close() {
    if (this.#values.closedCount) return false;
    this.#values.closedCount = 1;
    this.#values.lifetimeMs = this.#now() - this.#createdAt;
    return true;
  }

  snapshot() {
    return { ...this.#values };
  }
}
