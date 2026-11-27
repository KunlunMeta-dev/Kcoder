import { ChannelError, requireValue } from '../errors.mjs';

/** One owned Native lease; every use still checks its current proof and deadline. */
export class ApplicationStoreLease {
  constructor(value, { call, connected, now = Date.now }) {
    this.call = call; this.connected = connected; this.now = now;
    this.leaseId = value.leaseId; this.namespaceId = value.namespaceId;
    this.current = value; this.serial = Promise.resolve(); this.pending = 0; this.stopped = false;
    this.validate(value); this.schedule();
  }

  validate(value) {
    requireValue(typeof this.leaseId === 'string' && this.leaseId.length > 0
      && typeof this.namespaceId === 'string' && this.namespaceId.length > 0
      && value?.leaseId === this.leaseId && value.namespaceId === this.namespaceId
      && Number.isSafeInteger(value.expiresAt) && value.expiresAt > this.now()
      && ['initializing', 'reconciling', 'ready'].includes(value.stage), 'NATIVE_STORE_LEASE_REQUIRED');
  }

  permits(stage) {
    return !this.stopped && this.connected() && this.current.stage === stage && this.current.expiresAt > this.now();
  }

  schedule() {
    if (this.stopped || this.pending || !this.connected()) return;
    const remaining = this.current.expiresAt - this.now();
    const delay = remaining > 0 ? Math.max(1, Math.min(10000, Math.floor(remaining / 3))) : 10000;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.update('private.store.renewLease').catch(() => {});
    }, delay);
    this.timer.unref?.();
  }

  update(method, fields = {}) {
    requireValue(['private.store.renewLease', 'private.store.commitReady'].includes(method), 'NATIVE_STORE_LEASE_METHOD_INVALID');
    clearTimeout(this.timer); this.timer = undefined; this.pending++;
    const operation = this.serial.then(async () => {
      requireValue(!this.stopped && this.connected(), 'NATIVE_STORE_LEASE_REQUIRED');
      try {
        const value = await this.call(method, { ...fields, leaseId: this.leaseId });
        this.validate(value);
        requireValue(method === 'private.store.commitReady' ? value.stage === 'ready' : value.stage === this.current.stage,
          'NATIVE_STORE_READY_UNCONFIRMED');
        this.current = value;
        return value;
      } catch (error) {
        this.current = { ...this.current, expiresAt: 0 };
        throw error;
      }
    });
    this.serial = operation.catch(() => {});
    operation.finally(() => { this.pending--; this.schedule(); }).catch(() => {});
    return operation;
  }

  async stop() {
    this.stopped = true; clearTimeout(this.timer); this.timer = undefined;
    await this.serial;
  }
}

/** Attempt each owned cleanup even when an earlier resource cannot confirm closure. */
export async function closeApplicationHost({ lease, service, store, peer, run }) {
  const errors = [];
  const attempt = async action => { try { await action(); } catch (error) { errors.push(error); } };
  await attempt(() => lease?.stop());
  await attempt(() => service?.close());
  await attempt(() => store?.close());
  if (lease && !peer.closed)
    await attempt(() => peer.call('private.store.releaseLease', { leaseId: lease.leaseId }, 3000));
  await attempt(() => peer.close());
  await run.catch(() => {});
  if (errors.length) {
    const error = new ChannelError('APPLICATION_HOST_CLEANUP_UNCONFIRMED', 'reconcile_original');
    error.causes = errors;
    throw error;
  }
}
