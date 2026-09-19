import { normalizeBrokerResourceSnapshot } from './broker-resource-snapshot.js';

// This controller never sends signals: acceptance must be followed by actual child exit.
export class BrokerIdleShutdown {
  constructor(broker, now = () => performance.now()) {
    this.broker = broker;
    this.now = now;
    this.resourceSample = null;
    this.resourceEpoch = 0;
    this.closing = false;
    this.requests = new Map();
    this.exit = null;
    this.exitWaiters = new Set();
    broker.child.once('close', (code, signal) => {
      this.exit = { code, signal };
      this.resourceSample = null;
      this.resourceEpoch++;
      for (const request of this.requests.values()) request.reject(new Error('process exited'));
      for (const resolve of this.exitWaiters) resolve();
    });
  }

  readResources(timeoutMs = 10_000) {
    if (this.resourceProbe) return this.resourceProbe;
    if (this.closing || this.exit || this.broker.closed ||
        this.broker.initializeResponse?.result?.capabilities?.experimental?.serverResourceSnapshotV1 !== true) {
      this.resourceSample = null;
      this.resourceEpoch++;
      return Promise.resolve(null);
    }
    this.resourceSample = null;
    const epoch = ++this.resourceEpoch;
    const probe = this.request('server/resources/read', {}, timeoutMs).then(value => {
      return this.publishResourceSample(value, epoch);
    }, () => {
      if (epoch === this.resourceEpoch) this.resourceSample = null;
      return null;
    });
    this.resourceProbe = probe;
    probe.then(() => { if (this.resourceProbe === probe) this.resourceProbe = null; });
    return probe;
  }

  publishResourceSample(value, epoch) {
    if (epoch !== this.resourceEpoch || this.exit || this.broker.closed) return null;
    this.resourceSample = normalizeBrokerResourceSnapshot(value, this.now());
    return this.resourceSample;
  }

  response(message) {
    if (message.method || message.id === undefined) return false;
    const pending = this.requests.get(message.id);
    if (!pending) return false;
    if (message.error) pending.reject(new Error('lifecycle request rejected'));
    else pending.resolve(message.result);
    return true;
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.broker.nextRequestId++;
      const finish = callback => value => {
        clearTimeout(timer);
        this.requests.delete(id);
        callback(value);
      };
      const timer = setTimeout(() => finish(reject)(new Error('lifecycle request timed out')), timeoutMs);
      this.requests.set(id, { resolve: finish(resolve), reject: finish(reject) });
      try {
        this.broker.writeMessage({ jsonrpc: '2.0', id, method, params });
      } catch (error) { finish(reject)(error); }
    });
  }

  waitForExit(timeoutMs) {
    if (this.exit) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.exitWaiters.delete(done); resolve(); };
      const timer = setTimeout(() => {
        this.exitWaiters.delete(done);
        reject(new Error('process exit timed out'));
      }, timeoutMs);
      this.exitWaiters.add(done);
    });
  }

  stop(timeoutMs = 10_000) {
    if (this.operation) return this.operation;
    const operation = this.run(timeoutMs);
    this.operation = operation;
    operation.then(() => { if (this.operation === operation) this.operation = null; });
    return operation;
  }

  async run(timeoutMs) {
    const broker = this.broker;
    if (this.exit) return { status: this.exit.code === 0 ? 'stopped' : 'unknown' };
    if (this.closing || broker.closed) return { status: 'unknown' };
    if (broker.hasProtectedIdleResources) return { status: 'busy' };
    if (broker.initializeResponse?.result?.capabilities?.experimental?.serverIdleShutdownV1 !== true)
      return { status: 'unsupported' };
    this.closing = true;
    let shutdownSent = false;
    this.resourceSample = null;
    const sampleEpoch = ++this.resourceEpoch;
    try {
      const snapshot = await this.request('server/resources/read', {}, timeoutMs);
      this.publishResourceSample(snapshot, sampleEpoch);
      if (typeof snapshot?.instanceId !== 'string' || !snapshot.instanceId) throw new Error('missing instance');
      if (broker.hasProtectedIdleResources) {
        this.closing = false;
        return { status: 'busy' };
      }
      shutdownSent = true;
      const response = await this.request('server/shutdown/idle', { instanceId: snapshot.instanceId }, timeoutMs);
      if (response?.accepted === false) {
        this.closing = false;
        return ['resources', 'workspace', 'automations', 'turn_gate', 'turn_admission', 'resident_activity', 'turn_tail', 'workspace_tasks', 'background_workers', 'ephemeral', 'running_turn', 'tasks', 'interactions', 'projection_lock', 'projection_active', 'projection_jobs', 'projection_tools', 'projection_pending'].includes(response.reason)
          ? { status: 'busy', reason: response.reason } : { status: 'busy' };
      }
      if (response?.accepted !== true) throw new Error('unconfirmed shutdown');
      await this.waitForExit(timeoutMs);
      return { status: this.exit?.code === 0 ? 'stopped' : 'unknown' };
    } catch {
      if (sampleEpoch === this.resourceEpoch) this.resourceSample = null;
      if (this.exit) return { status: this.exit.code === 0 ? 'stopped' : 'unknown' };
      // Once shutdown may have been accepted, never attach a client to this process again.
      if (!shutdownSent) this.closing = false;
      return { status: 'unknown' };
    }
  }
}
