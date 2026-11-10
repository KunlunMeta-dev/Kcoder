// Authentication leases must not wait for a renderer navigation to finish.
export function createDesktopSessionRenewal({
  getGateway, canRun, installSession, recoverLoginPages, warn,
  setTimer = setTimeout, clearTimer = clearTimeout, observe = () => {},
}) {
  const report = (stage, facts = {}) => {
    try { Promise.resolve(observe({ component: 'desktop_session', stage, at: Date.now(), ...facts })).catch(() => {}); } catch {}
  };
  let stopped = false;
  let timer;
  const pending = new Map();
  let recoveryPending;
  let recoveryRetry;
  const active = instance => !stopped && canRun() && instance && getGateway() === instance;
  const schedule = delay => {
    clearTimer(timer);
    timer = undefined;
    if (stopped || !canRun()) return;
    timer = setTimer(() => { timer = undefined; void renew(); }, delay);
    timer?.unref?.();
    report('timer_armed', { delayMs: delay });
  };
  const recover = instance => {
    if (!active(instance) || recoveryPending || recoveryRetry) return;
    recoveryPending = Promise.resolve().then(() => {
      if (active(instance)) return recoverLoginPages();
    }).catch(() => {
      if (!active(instance)) return;
      warn('KCoder Studio desktop login recovery failed; retrying');
      recoveryRetry = setTimer(() => {
        recoveryRetry = undefined;
        recover(getGateway());
      }, 30000);
      recoveryRetry?.unref?.();
    }).finally(() => { recoveryPending = undefined; });
  };
  const installed = instance => {
    if (!active(instance)) return;
    const halfLifetime = Math.max(50, Math.floor(instance.sessionTtlMs / 2));
    const observedDelay = instance.sessionRenewalDelayMs;
    schedule(Number.isFinite(observedDelay) ? Math.max(50, Math.min(halfLifetime, observedDelay)) : halfLifetime);
  };
  const renew = () => {
    if (stopped || !canRun()) return;
    const instance = getGateway();
    if (!instance) return;
    if (pending.has(instance)) return pending.get(instance).promise;
    const operation = {};
    pending.set(instance, operation);
    operation.promise = (async () => {
      const started = Date.now();
      report('started');
      try {
        await instance.renewSession();
        report('http_authenticated', { elapsedMs: Date.now() - started });
        if (!active(instance)) return;
        await installSession(instance);
        report('cookie_installed', { elapsedMs: Date.now() - started });
        if (!active(instance)) return;
        installed(instance);
        recover(instance);
      } catch {
        report('failed', { elapsedMs: Date.now() - started });
        if (active(instance)) {
          warn('KCoder Studio desktop session renewal failed; retrying');
          schedule(30000);
        }
      } finally {
        if (pending.get(instance) === operation) pending.delete(instance);
      }
    })();
    return operation.promise;
  };
  return {
    installed, renew,
    stop() {
      report('stopped');
      stopped = true;
      clearTimer(timer);
      clearTimer(recoveryRetry);
      timer = recoveryRetry = undefined;
    },
  };
}
