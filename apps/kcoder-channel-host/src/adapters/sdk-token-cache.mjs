import { ChannelError, requireValue } from '../errors.mjs';

function waitForToken(pending, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); callback(value);
    };
    const abort = () => finish(reject, signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort();
  });
}

/** One connection owns lookup cancellation; individual callers own only their wait. */
export class SdkTokenCache {
  constructor() { this.owner = { controller: new AbortController(), value: null, pending: null }; }

  invalidate() {
    const previous = this.owner;
    this.owner = { controller: new AbortController(), value: null, pending: null };
    previous.controller.abort(new ChannelError('STALE_PLATFORM_SOURCE'));
  }

  get(fetchToken, signal) {
    signal?.throwIfAborted();
    const owner = this.owner;
    const waiting = signal ? AbortSignal.any([signal, owner.controller.signal]) : owner.controller.signal;
    if (owner.value && owner.value.expiresAt > Date.now() + 30000) {
      return waitForToken(Promise.resolve(owner.value.value), waiting);
    }
    if (!owner.pending) {
      const lookup = AbortSignal.any([owner.controller.signal, AbortSignal.timeout(15000)]);
      const received = Promise.resolve().then(() => {
        lookup.throwIfAborted(); return fetchToken(lookup);
      }).then(value => {
        requireValue(this.owner === owner && !lookup.aborted, 'STALE_PLATFORM_SOURCE');
        owner.value = value;
        return value.value;
      });
      const pending = waitForToken(received, lookup).finally(() => {
        if (owner.pending === pending) owner.pending = null;
      });
      owner.pending = pending;
    }
    return waitForToken(owner.pending, waiting);
  }
}
