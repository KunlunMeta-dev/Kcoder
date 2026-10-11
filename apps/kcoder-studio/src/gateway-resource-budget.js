import { IdleResourceBudget } from './idle-resource-budget.js';

export class GatewayResourceBudget {
  constructor({ policy, getBrokers, onResult = () => {}, onError = () => {}, now = () => performance.now() }) {
    this.policy = policy;
    this.getBrokers = getBrokers;
    this.onResult = onResult;
    this.onError = onError;
    this.now = now;
    this.budgets = new Map();
    this.lastSampleAttempt = new WeakMap();
    this.groupCursor = 0;
    this.stopped = false;
  }

  start() {
    if (!this.policy.enabled || this.stopped || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { this.onResult(await this.sweep()); }
      catch {
        try { this.onError(); } catch { /* Diagnostics must not interrupt the Gateway. */ }
      }
      finally { this.start(); }
    }, this.policy.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; }

  sweep() {
    if (this.operation) return this.operation;
    const operation = this.run();
    this.operation = operation;
    const clear = () => { if (this.operation === operation) this.operation = null; };
    operation.then(clear, clear);
    return operation;
  }

  async run() {
    if (this.stopped || !this.policy.enabled) return [];
    if (this.policy.maxResidentBytes !== null) {
      const samples = [...this.getBrokers()].filter(broker => {
        const sample = broker.idleShutdown.resourceSample;
        const age = sample ? this.now() - sample.receivedAt : Infinity;
        return !broker.closed && !broker.idleShutdown.closing && !broker.hasProtectedIdleResources &&
          broker.initializeResponse?.result?.capabilities?.experimental?.serverResourceSnapshotV1 === true &&
          (!sample || age < 0 || age > this.policy.maxSampleAgeMs);
      }).sort((left, right) => (this.lastSampleAttempt.get(left) ?? -1) - (this.lastSampleAttempt.get(right) ?? -1))
        .slice(0, this.policy.sampleLimit);
      for (let index = 0; index < samples.length && !this.stopped; index += 4) {
        await Promise.all(samples.slice(index, index + 4).map(async broker => {
          this.lastSampleAttempt.set(broker, this.now());
          try { await broker.readResourceSnapshot(); } catch { /* Unknown memory stays unknown. */ }
        }));
      }
    }
    if (this.stopped) return [];
    const groups = new Map();
    for (const broker of this.getBrokers()) {
      if (broker.idleShutdown.exit) continue;
      if (!groups.has(broker.serverId)) groups.set(broker.serverId, []);
      groups.get(broker.serverId).push(broker);
    }
    for (const key of this.budgets.keys()) if (!groups.has(key)) this.budgets.delete(key);
    const keys = [...groups.keys()];
    const start = keys.length ? this.groupCursor++ % keys.length : 0;
    const results = [];
    let remainingAttempts = 8;
    for (let index = 0; index < keys.length && !this.stopped; index++) {
      const key = keys[(start + index) % keys.length];
      if (!this.budgets.has(key)) this.budgets.set(key, new IdleResourceBudget({ ...this.policy, now: this.now }));
      const result = await this.budgets.get(key).enforce(groups.get(key), remainingAttempts);
      remainingAttempts -= result.attempted;
      results.push({ targetId: key, ...result });
    }
    return results;
  }
}
