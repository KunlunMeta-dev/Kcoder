import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sdkWorkerEnvironment } from '../sdk-worker-env.mjs';
import { CHANNEL_WORKER_STATES as STATES, channelWorkerRpcErrorCode, channelWorkerReasonCode } from './worker-protocol.mjs';

function stateSnapshot(value, connectionId, generation, platform) {
  if (!value || typeof value !== 'object' || !STATES.has(value.state)) throw new Error('CHANNEL_WORKER_STATE_INVALID');
  const scoped = value.connectionId !== undefined || value.generation !== undefined;
  if (scoped && (value.connectionId !== connectionId || value.generation !== generation)) throw new Error('CHANNEL_WORKER_SCOPE_CHANGED');
  const reasonCode = scoped ? channelWorkerReasonCode(platform, value.reasonCode) : null;
  return { state: value.state, scoped, reasonCode,
    reasonObserved: scoped && (value.reasonCode === null || value.reasonCode === undefined || reasonCode !== null) };
}

/** One supervised SDK process, owned by the connection manager. */
export class ChannelWorker {
  constructor(connection, credentials, directory, { forkWorker = fork } = {}) {
    this.connection = connection;
    this.credentials = credentials;
    this.directory = directory;
    this.pending = new Map();
    this.sequence = 0;
    this.state = 'stopped';
    this.generation = 0;
    this.active = false;
    this.reasonCode = null;
    this.adapterReasonCode = null;
    this.forkWorker = forkWorker;
  }

  async start(ingest, onStateChanged = () => {}) {
    this.onStateChanged = onStateChanged;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) throw new Error('CHANNEL_WORKER_ALREADY_STARTED');
    const generation = ++this.generation;
    this.state = 'starting';
    this.notifyStateChanged();
    this.reasonCode = null;
    this.adapterReasonCode = null;
    this.active = true;
    let child;
    try {
      child = this.child = this.forkWorker(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
        env: sdkWorkerEnvironment(),
      });
    } catch (error) { this.active = false; this.state = 'stopped'; this.notifyStateChanged(); throw error; }
    const current = () => this.child === child && this.generation === generation;
    const live = () => current() && this.active && child.connected && child.exitCode === null && child.signalCode === null;
    const ingressFailed = () => { if (live() && this.reasonCode !== 'CHANNEL_INGRESS_FAILED') { this.reasonCode = 'CHANNEL_INGRESS_FAILED'; this.notifyStateChanged(); } };
    const reply = message => {
      if (!live()) return;
      // Receipt loss leaves the original durable Inbox record authoritative.
      try { child.send(message, error => { if (error) ingressFailed(); }); } catch { ingressFailed(); }
    };
    child.on('message', async message => {
      if (!live()) return;
      if (message?.method === 'state') {
        try {
          const snapshot = stateSnapshot(message.params, this.connection.id, generation, this.connection.platform);
          this.state = snapshot.state;
          this.observeReason(snapshot);
        } catch { /* A stale or invalid snapshot cannot replace this child's public state. */ }
        return;
      }
      if (message?.method === 'event') {
        try { reply({ id: message.id, result: await ingest(message.params.event) }); }
        catch { ingressFailed(); reply({ id: message.id, error: 'CHANNEL_INGRESS_FAILED' }); }
        return;
      }
      const request = this.pending.get(message?.id);
      if (!request || request.child !== child || request.generation !== generation) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error !== undefined && message.error !== null) {
        const code = channelWorkerRpcErrorCode(message.error);
        request.reject(Object.assign(new Error(code), { code,
          externalOutcome: code !== 'CHANNEL_WORKER_FAILED' && message.externalOutcome === 'failed' ? 'failed' : 'unknown' }));
      }
      else if (request.method === 'start' || request.method === 'state') {
        try {
          const snapshot = stateSnapshot(message.result, this.connection.id, generation, this.connection.platform);
          this.observeReason(snapshot);
          const reasonCode = this.connectionFailureReason();
          request.resolve({ state: snapshot.state, ...(reasonCode ? { reasonCode } : {}) });
        } catch (error) { request.reject(error); }
      } else request.resolve(message.result);
    });
    const closed = () => {
      for (const [id, request] of this.pending) {
        if (request.child !== child || request.generation !== generation) continue;
        clearTimeout(request.timer); this.pending.delete(id); request.reject(new Error('CHANNEL_WORKER_EXITED'));
      }
      if (!current()) return;
      this.active = false; this.state = 'stopped'; this.notifyStateChanged();
    };
    child.once('exit', closed);
    child.on('error', closed);
    try {
      const result = await this.request('start', { connection: this.connection, credentials: this.credentials, directory: this.directory, generation }, 60000);
      if (!live()) throw new Error('CHANNEL_WORKER_EXITED');
      this.credentials = undefined;
      this.state = result.state;
      this.notifyStateChanged();
    } catch (error) { if (current()) { try { await this.stop(); } catch {} } throw error; }
  }

  request(method, params, timeoutMs = 30000) {
    const child = this.child, generation = this.generation;
    if (!this.active || !child?.connected || child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error('CHANNEL_WORKER_DISCONNECTED'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CHANNEL_WORKER_TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child, generation, method });
      const failed = () => {
        clearTimeout(timer);
        if (this.pending.get(id)?.child === child && this.pending.get(id)?.generation === generation) this.pending.delete(id);
        reject(new Error('CHANNEL_WORKER_DISCONNECTED'));
      };
      try { child.send({ id, method, params }, error => { if (error) failed(); }); } catch { failed(); }
    });
  }

  notifyStateChanged() {
    const state = `${this.state}:${this.connectionFailureReason() ?? ''}`;
    if (this.notifiedState === state) return;
    this.notifiedState = state;
    this.onStateChanged?.();
  }
  connectionState() { return this.state; }
  observeReason(snapshot) {
    if (snapshot.reasonCode === 'CHANNEL_INGRESS_FAILED') this.reasonCode = snapshot.reasonCode;
    if (snapshot.reasonObserved) this.adapterReasonCode = snapshot.reasonCode === 'CHANNEL_INGRESS_FAILED' ? null : snapshot.reasonCode;
    this.notifyStateChanged();
  }
  connectionFailureReason() { return this.adapterReasonCode ?? this.reasonCode; }
  send(payload, { deliveryId }) { return this.request('send', { payload, deliveryId }, 60000); }

  async stop() {
    const child = this.child;
    const generation = this.generation;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    let onExit;
    const exited = new Promise(resolve => { onExit = resolve; child.once('exit', onExit); });
    try {
    await this.request('stop', {}, 3000).catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CHANNEL_WORKER_EXIT_UNCONFIRMED')), 3000);
      })]).finally(() => clearTimeout(timer));
    }
    if (this.child === child && this.generation === generation) { this.active = false; this.state = 'stopped'; this.notifyStateChanged(); }
    } finally { child.removeListener('exit', onExit); }
  }
}
