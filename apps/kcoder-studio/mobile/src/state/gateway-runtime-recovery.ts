export interface GatewayRecoveryState {
  failed: boolean;
  refreshing: boolean;
  blocked: boolean;
}

const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];

/** Retry read-only runtime refreshes, retaining one timer and one active owner. */
export function createGatewayRuntimeRecovery(options: {
  read(): GatewayRecoveryState;
  isForeground(): boolean;
  refresh(): Promise<void>;
}) {
  let disposed = false;
  let running = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wakePending = false;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    wakePending = false;
  };
  const available = () => !disposed && !options.read().blocked && options.isForeground();
  const reconcile = () => {
    if (!available()) { cancel(); return; }
    const state = options.read();
    if (running || state.refreshing) return;
    if (!state.failed) {
      attempt = 0;
      if (!wakePending) cancel();
      return;
    }
    if (timer === undefined) schedule(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
  };
  const run = async () => {
    timer = undefined;
    wakePending = false;
    if (!available() || running || options.read().refreshing) return;
    running = true;
    attempt += 1;
    try { await options.refresh(); }
    catch { /* The runtime owns error publication and authorization denial. */ }
    finally { running = false; if (!disposed) reconcile(); }
  };
  const schedule = (delay: number) => { timer = setTimeout(() => { void run(); }, delay); };
  return {
    changed: reconcile,
    wake() {
      if (!available() || running || options.read().refreshing || wakePending) return;
      cancel();
      attempt = 0;
      wakePending = true;
      schedule(0);
    },
    sleep: cancel,
    dispose() { disposed = true; cancel(); },
  };
}
