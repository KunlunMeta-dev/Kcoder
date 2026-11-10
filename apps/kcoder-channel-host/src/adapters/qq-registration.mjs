import { fork } from 'node:child_process';
import { requireValue } from '../errors.mjs';
import { sdkWorkerEnvironment } from '../sdk-worker-env.mjs';

/** Adapt the official SDK callback flow to the shared private registration contract. */
export class QQRegistration {
  constructor({ forkImpl = fork, now = Date.now } = {}) {
    this.fork = forkImpl; this.now = now; this.state = { state: 'creating' };
  }
  async create() {
    requireValue(this.state.state === 'creating', 'CHANNEL_AUTHENTICATION_ALREADY_STARTED');
    this.state = { state: 'unknown', expiresAtMs: this.now() + 300000, intervalMs: 2000 };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(startup); resolve(this.state); } };
      const child = this.fork(new URL('./qq-registration-worker.mjs', import.meta.url), [], {
        execArgv: ['--max-old-space-size=64'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true, env: sdkWorkerEnvironment(),
      });
      this.child = child;
      const startup = setTimeout(() => { this.stop('unavailable'); finish(); }, 15000);
      this.expiry = setTimeout(() => this.stop('expired'), 300000); this.expiry.unref?.();
      child.on('message', message => {
        if (this.child !== child) return;
        try {
          if (message?.state === 'waiting') {
            const url = new URL(message.verificationUrl);
            requireValue(url.origin === 'https://q.qq.com' && url.pathname === '/qqbot/openclaw/connect.html'
              && !url.username && !url.password && url.href.length <= 8192, 'QQ_QR_URL_INVALID');
            this.state = { ...this.state, state: 'waiting', verificationUrl: url.href };
          } else if (message?.state === 'ready') {
            requireValue(Array.isArray(message.credentials) && message.credentials.length === 1, 'QQ_QR_CREDENTIALS_INVALID');
            const value = message.credentials[0];
            requireValue(typeof value.appId === 'string' && value.appId.length > 0 && value.appId.length <= 256
              && typeof value.appSecret === 'string' && value.appSecret.length > 0 && value.appSecret.length <= 4096, 'QQ_QR_CREDENTIALS_INVALID');
            this.configuration = { appId: value.appId }; this.credentials = { appSecret: value.appSecret }; this.stop('ready');
          } else this.stop(message?.state === 'expired' ? 'expired' : 'unavailable');
          finish();
        } catch { this.stop('unavailable'); finish(); }
      });
      child.on('error', () => { if (this.child === child) this.stop('unavailable'); finish(); });
      child.once('exit', () => { if (this.child === child) this.stop('unavailable'); finish(); });
      this.reject = () => { if (!settled) { settled = true; clearTimeout(startup); reject(new Error('QQ_QR_CANCELLED')); } };
    });
  }
  poll() { if (this.now() >= this.state.expiresAtMs && this.state.state === 'waiting') this.stop('expired'); return this.state; }
  stop(state) {
    clearTimeout(this.expiry); const child = this.child; this.child = undefined;
    child?.kill(); this.state = { ...this.state, state }; delete this.state.verificationUrl;
  }
  cancel() { this.reject?.(); this.stop('cancelled'); this.configuration = undefined; this.credentials = undefined; }
}
