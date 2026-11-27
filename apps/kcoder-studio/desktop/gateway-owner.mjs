/** Own both the pending start and its returned process until its original exit. */
export function createDesktopGatewayOwner({ start, signal, isQuitting }) {
  const pending = new Set(), owned = new Set(), stops = new WeakMap();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let stopping = false, receipt;
  const stop = instance => {
    if (!stops.has(instance)) stops.set(instance, Promise.resolve().then(() => instance.stop()));
    return stops.get(instance);
  };
  return Object.freeze({
    start(options) {
      if (stopping || isQuitting() || controller.signal.aborted) return Promise.resolve(null);
      let operation;
      // Register before invoking a producer that may spawn synchronously.
      operation = Promise.resolve().then(() => {
        if (stopping || isQuitting() || controller.signal.aborted) return null;
        return start({ ...options, signal: controller.signal });
      }).then(async instance => {
        if (!instance) return null;
        owned.add(instance);
        Promise.resolve(instance.exit).then(() => owned.delete(instance), () => {});
        if (stopping || isQuitting() || controller.signal.aborted) { await stop(instance); return null; }
        return instance;
      }, error => {
        // start() rejects only after its original process cleanup. Preserve an
        // unconfirmed cleanup rather than calling the producer a second time.
        if (stopping && !error?.cleanupError) return null;
        throw error;
      }).finally(() => pending.delete(operation));
      pending.add(operation);
      return operation;
    },
    stop() {
      if (receipt) return receipt;
      stopping = true;
      controller.abort(); signal.removeEventListener('abort', abort);
      const waits = [...owned].map(stop);
      for (const operation of pending) waits.push(operation.then(instance => instance ? stop(instance) : undefined));
      receipt = Promise.allSettled(waits).then(results => {
        if (results.some(result => result.status === 'rejected')) {
          throw Object.assign(new Error('DESKTOP_GATEWAY_STOP_UNCONFIRMED'), { code: 'DESKTOP_GATEWAY_STOP_UNCONFIRMED' });
        }
        return true;
      });
      return receipt;
    },
  });
}
