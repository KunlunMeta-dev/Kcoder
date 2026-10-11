const MAX_ATTEMPTS = 8;

function limit(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  return value;
}

// Budgets select candidates, not shutdown authority. Only stopWhenIdle may release a process.
export class IdleResourceBudget {
  constructor({ maxProcesses = null, maxResidentBytes = null, maxSampleAgeMs = 30_000,
    now = () => performance.now() } = {}) {
    this.maxProcesses = limit(maxProcesses, 'maxProcesses');
    this.maxResidentBytes = limit(maxResidentBytes, 'maxResidentBytes');
    this.maxSampleAgeMs = limit(maxSampleAgeMs, 'maxSampleAgeMs');
    if (this.maxSampleAgeMs === null) throw new Error('maxSampleAgeMs is required');
    this.now = now;
    this.retryAfter = new WeakMap();
    this.lastRefusedSweep = new WeakMap();
    this.sweepNumber = 0;
  }

  enforce(brokers, maxAttempts = MAX_ATTEMPTS) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > MAX_ATTEMPTS)
      throw new Error('invalid idle budget attempt limit');
    if (this.operation) return this.operation;
    const operation = this.run([...new Set(brokers)], maxAttempts);
    this.operation = operation;
    const clear = () => { if (this.operation === operation) this.operation = null; };
    operation.then(clear, clear);
    return operation;
  }

  async run(brokers, maxAttempts) {
    const sweep = ++this.sweepNumber;
    const exited = new Set();
    const attempted = new Set();
    const gone = broker => exited.has(broker) || Boolean(broker.idleShutdown.exit);
    const accounted = broker => !gone(broker) &&
      !broker.hasProtectedIdleResources &&
      broker.initializeResponse?.result?.capabilities?.experimental?.serverIdleShutdownV1 === true;
    const candidate = broker => accounted(broker) && !broker.closed && !broker.idleShutdown.closing;
    const bytes = broker => {
      const sample = broker.idleShutdown.resourceSample;
      const age = sample ? this.now() - sample.receivedAt : NaN;
      return sample && Number.isFinite(age) && age >= 0 && age <= this.maxSampleAgeMs &&
        Number.isSafeInteger(sample.residentBytes) && sample.residentBytes >= 0 ? BigInt(sample.residentBytes) : null;
    };
    const summarize = () => {
      const candidates = brokers.filter(accounted);
      let known = 0n;
      let unknown = 0;
      for (const broker of candidates) {
        const size = bytes(broker);
        if (size === null) unknown++;
        else known += size;
      }
      return { candidates, known, unknown };
    };
    for (;;) {
      const current = summarize();
      const countPressure = this.maxProcesses !== null && current.candidates.length > this.maxProcesses;
      const memoryPressure = this.maxResidentBytes !== null && current.known > BigInt(this.maxResidentBytes);
      if ((!countPressure && !memoryPressure) || attempted.size >= maxAttempts) break;
      const next = current.candidates.filter(broker => candidate(broker) && !attempted.has(broker) &&
        (this.retryAfter.get(broker) ?? 0) <= this.now() &&
        (countPressure || bytes(broker) !== null))
        .sort((left, right) => (this.lastRefusedSweep.get(left) ?? 0) - (this.lastRefusedSweep.get(right) ?? 0) ||
          left.lastUsedAt - right.lastUsedAt)[0];
      if (!next) break;
      attempted.add(next);
      // Recheck after every awaited shutdown; newly protected peers must not be reclaimed.
      if (!candidate(next)) continue;
      let result;
      try { result = await next.stopWhenIdle(); }
      catch { result = { status: 'unknown' }; }
      if (result?.status === 'stopped') exited.add(next);
      else {
        this.retryAfter.set(next, this.now() + 1_000);
        this.lastRefusedSweep.set(next, sweep);
      }
    }
    const final = summarize();
    return {
      scope: 'locally-idle-candidates',
      attempted: attempted.size, stopped: exited.size,
      retainedOutsideBudget: brokers.filter(broker => !gone(broker) && !accounted(broker)).length,
      remainingIdleProcesses: final.candidates.length,
      remainingIdleCandidates: final.candidates.filter(candidate).length,
      knownIdleResidentBytes: final.known <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(final.known) : null,
      unknownIdleMemoryCount: final.unknown,
      countSatisfied: this.maxProcesses === null || final.candidates.length <= this.maxProcesses,
      memorySatisfied: this.maxResidentBytes === null ? true : final.known > BigInt(this.maxResidentBytes)
        ? false : final.unknown > 0 ? null : true,
    };
  }
}
