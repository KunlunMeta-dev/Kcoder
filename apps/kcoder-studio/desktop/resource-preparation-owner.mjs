// One desktop host owns its startup verifiers independently from its Gateway child.
export function createResourcePreparationOwner({ timeoutMs = 5_000, warn = code => console.warn(code) } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid preparation stop timeout');
  const pending = new Set();
  let stopping = false, drain;
  return Object.freeze({
    run(operation) {
      if (stopping) return Promise.resolve(null);
      let preparation;
      try { preparation = Promise.resolve(operation()); }
      catch (error) { preparation = Promise.reject(error); }
      pending.add(preparation);
      preparation.then(() => pending.delete(preparation), () => pending.delete(preparation));
      return preparation.then(value => stopping ? null : value, error => {
        if (stopping) return null;
        throw error;
      });
    },
    stop() {
      if (drain) return drain;
      stopping = true;
      const waiting = [...pending];
      if (!waiting.length) return (drain = Promise.resolve(true));
      drain = new Promise(resolve => {
        let finished = false;
        const finish = completed => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (!completed) { try { warn('NATIVE_RESOURCE_PREPARATION_STOP_UNCONFIRMED'); } catch { /* Diagnostic only. */ } }
          resolve(completed);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        Promise.allSettled(waiting).then(() => finish(true));
      });
      return drain;
    },
  });
}
