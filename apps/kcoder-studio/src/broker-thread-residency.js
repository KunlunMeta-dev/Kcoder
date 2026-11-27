// Resident-thread eviction and per-thread maintenance projection.
//
// The shared broker always negotiates both capabilities with its app-server.
// Each Gateway client sees the typed notifications and errors only after it
// declared the same capability; other clients keep the legacy codes they
// already handle. The broker never retries on a client's behalf: whether a
// rejected request is safe to resend is decided by the client that owns it.

export const THREAD_RESIDENCY_CAPABILITY = 'threadResidencyV1';
export const THREAD_MAINTENANCE_CAPABILITY = 'threadMaintenanceV1';
export const THREAD_MAINTENANCE_CANCEL_CAPABILITY = 'threadMaintenanceCancelV1';
export const THREAD_EVICTED_METHOD = 'thread/evicted';
export const THREAD_MAINTENANCE_METHOD = 'thread/maintenance';
export const THREAD_MAINTENANCE_CANCEL_METHOD = 'thread/maintenance/cancel';
export const THREAD_NOT_RESIDENT = -32027;
export const THREAD_MAINTENANCE_BUSY = -32028;

const LEGACY_BUSY = {
  'thread/compact': { code: -32030 },
  'thread/rollback': { code: -32031 },
  'turn/start': { code: -32003, message: 'Turn already running' },
};

export function allowsThreadResidencyNotification(message, client) {
  if (message?.method === THREAD_EVICTED_METHOD) return client?.[THREAD_RESIDENCY_CAPABILITY] === true;
  if (message?.method === THREAD_MAINTENANCE_METHOD) return client?.[THREAD_MAINTENANCE_CAPABILITY] === true;
  return true;
}

/** A capability-older subscriber still receives the original payload shape. */
export function projectThreadResidencyNotification(message, client) {
  if (!allowsThreadResidencyNotification(message, client)) return null;
  if (message?.method === THREAD_MAINTENANCE_METHOD && message.params?.maintenanceId !== undefined &&
      client?.[THREAD_MAINTENANCE_CANCEL_CAPABILITY] !== true) {
    const { maintenanceId: _maintenanceId, ...params } = message.params;
    return { ...message, params };
  }
  return message;
}

/** Map a typed rejection back to the pre-capability code for clients that did not opt in. */
export function projectThreadResidencyResponse(message, pending) {
  const code = message?.error?.code;
  if (pending.method === 'thread/compact' && message?.error?.data?.kind === 'thread_compaction_cancelled' &&
      pending.client?.[THREAD_MAINTENANCE_CANCEL_CAPABILITY] !== true) {
    const { data: _data, ...error } = message.error;
    return { ...message, error };
  }
  if (code === THREAD_NOT_RESIDENT && pending.client?.[THREAD_RESIDENCY_CAPABILITY] !== true) {
    const legacy = pending.method === 'turn/start'
      ? { code: -32025, message: 'turn threadId does not match active thread' }
      : { code: -32022, message: 'thread/start or thread/resume is required' };
    return { ...message, error: legacy };
  }
  if (code === THREAD_MAINTENANCE_BUSY && pending.client?.[THREAD_MAINTENANCE_CAPABILITY] !== true) {
    const legacy = LEGACY_BUSY[pending.method] ?? { code: -32003 };
    return { ...message, error: { code: legacy.code, message: legacy.message ?? message.error.message } };
  }
  return message;
}

export function projectThreadResidencyCapabilities(experimental, backend, client) {
  for (const capability of [THREAD_RESIDENCY_CAPABILITY, THREAD_MAINTENANCE_CAPABILITY, THREAD_MAINTENANCE_CANCEL_CAPABILITY]) {
    if (Object.hasOwn(backend ?? {}, capability) || Object.hasOwn(experimental, capability))
      experimental[capability] = client?.[capability] === true && backend?.[capability] === true &&
        (capability !== THREAD_MAINTENANCE_CANCEL_CAPABILITY || experimental[THREAD_MAINTENANCE_CAPABILITY] === true);
  }
  return experimental;
}
