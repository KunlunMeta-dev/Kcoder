import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { sdkWorkerEnvironment } from '../sdk-worker-env.mjs';

/** One supervised SDK process, owned by the connection manager. */
export class ChannelWorker {
  constructor(connection, credentials, directory) {
    this.connection = connection;
    this.credentials = credentials;
    this.directory = directory;
    this.pending = new Map();
    this.sequence = 0;
    this.state = 'stopped';
  }

  async start(ingest) {
    this.state = 'starting';
    this.child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      env: sdkWorkerEnvironment(),
    });
    this.child.on('message', async message => {
      if (message?.method === 'state') { this.state = message.params.state; return; }
      if (message?.method === 'event') {
        try { this.child.send({ id: message.id, result: await ingest(message.params.event) }); }
        catch { if (this.child.connected) this.child.send({ id: message.id, error: 'CHANNEL_INGRESS_FAILED' }); }
        return;
      }
      const request = this.pending.get(message?.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(Object.assign(new Error(message.error), { code: message.error,
        ...(message.externalOutcome === 'failed' ? { externalOutcome: 'failed' } : {}) })) : request.resolve(message.result);
    });
    const closed = () => {
      this.state = 'stopped';
      for (const request of this.pending.values()) {
        clearTimeout(request.timer); request.reject(new Error('CHANNEL_WORKER_EXITED'));
      }
      this.pending.clear();
    };
    this.child.once('exit', closed);
    this.child.once('error', closed);
    try {
      const result = await this.request('start', { connection: this.connection, credentials: this.credentials, directory: this.directory }, 60000);
      this.credentials = undefined;
      this.state = result.state;
    } catch (error) { await this.stop(); throw error; }
  }

  request(method, params, timeoutMs = 30000) {
    if (!this.child?.connected) return Promise.reject(new Error('CHANNEL_WORKER_DISCONNECTED'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CHANNEL_WORKER_TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, method, params }, error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(new Error('CHANNEL_WORKER_DISCONNECTED'));
      });
    });
  }

  connectionState() { return this.state; }
  send(payload, { deliveryId }) { return this.request('send', { payload, deliveryId }, 60000); }

  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit').catch(() => {});
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
    this.state = 'stopped';
  }
}
