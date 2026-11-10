/** Owns peer lifetimes through the Gateway's existing session and account sets. */
export function createMobilePeerOwnership({
  authSessionById,
  authSessions,
  mobileDeviceFamilies,
  sessionSockets,
  registerTargetContext,
}) {
  const owners = new WeakMap();
  const closedHandles = new WeakSet();
  const activeHandles = new Set();

  function ownerFor(handle) {
    if (closedHandles.has(handle)) return null;
    let owner = owners.get(handle);
    if (!owner) {
      owner = { identity: null, generation: null, tokens: new Map(), targets: new Map(), closed: false };
      owners.set(handle, owner);
      activeHandles.add(handle);
      const close = () => release(handle, owner);
      handle.once?.('close', close);
      handle.once?.('closed', close);
      handle.onClose?.(close);
    }
    return owner;
  }

  function release(handle, owner = owners.get(handle)) {
    closedHandles.add(handle);
    if (!owner || owner.closed) { activeHandles.delete(handle); return; }
    owner.closed = true;
    for (const [token, entry] of owner.tokens) {
      entry.sockets.delete(handle);
      if (!entry.sockets.size && sessionSockets.get(token) === entry.sockets) sessionSockets.delete(token);
    }
    owner.tokens.clear();
    for (const cleanup of owner.targets.values()) {
      try { cleanup(); } catch { /* Cleanup is best-effort after the owner has closed. */ }
    }
    owner.targets.clear();
    if (owner.family) owner.family.sockets.delete(handle);
    activeHandles.delete(handle);
    owners.delete(handle);
  }

  async function bind(handle, token, targetId = null) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9-]{32,128}$/.test(token)) return null;
    if (closedHandles.has(handle)) return null;
    const session = await authSessionById(token);
    if (closedHandles.has(handle)) return null;
    if (!session || authSessions.get(token) !== session) return null;
    const accessExpiresAt = session.accessExpiresAt ?? session.expiresAt;
    if (!session.allowedServerIds || typeof session.allowedServerIds.has !== 'function' ||
        !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now() ||
        !Number.isSafeInteger(accessExpiresAt) || accessExpiresAt <= Date.now() ||
        (session.wsLeaseExpiresAt !== undefined && (!Number.isSafeInteger(session.wsLeaseExpiresAt) || session.wsLeaseExpiresAt <= Date.now()))) return null;
    let family = null;
    if (session.deviceId) {
      family = mobileDeviceFamilies.get(session.deviceId);
      if (!family || !(family.sockets instanceof Set) || !Number.isSafeInteger(family.expiresAt) || family.expiresAt <= Date.now() ||
          typeof session.authorizationGeneration !== 'string' || family.authorizationGeneration !== session.authorizationGeneration ||
          (session.wsLeaseExpiresAt !== undefined && (!Number.isSafeInteger(session.wsLeaseExpiresAt) || session.wsLeaseExpiresAt <= Date.now()))) return null;
    }
    if (targetId && !session.allowedServerIds.has(targetId)) return null;
    const identity = session.deviceId ? `device:${session.deviceId}` : `session:${token}`;
    const owner = ownerFor(handle);
    if (!owner || owner.closed || (owner.identity && owner.identity !== identity) || (owner.family && owner.family !== family) ||
        (owner.generation && owner.generation !== session.authorizationGeneration)) return null;
    owner.identity ??= identity;
    owner.family ??= family;
    owner.generation ??= session.authorizationGeneration ?? null;
    let entry = owner.tokens.get(token);
    if (!entry) {
      let sockets = sessionSockets.get(token);
      if (!sockets) sessionSockets.set(token, sockets = new Set());
      sockets.add(handle);
      owner.tokens.set(token, { sockets });
    }
    if (family) {
      if (owner.family && owner.family !== family) return null;
      family.sockets.add(handle);
    }
    if (targetId && !owner.targets.has(targetId)) {
      let cleanup;
      try { cleanup = registerTargetContext?.(handle, session, targetId, token); }
      catch { release(handle, owner); return null; }
      if (cleanup === false) { release(handle, owner); return null; }
      if (typeof cleanup === 'function') owner.targets.set(targetId, cleanup);
    }
    return session;
  }

  function close(handle) {
    if (handle && typeof handle === 'object') closedHandles.add(handle);
    const owner = owners.get(handle);
    release(handle, owner);
    handle?.close?.();
    handle?.destroy?.();
  }

  function closeAll() {
    for (const handle of activeHandles) close(handle);
  }

  // `bind` uses trackedOwnerFor so owned peers can be closed during Gateway shutdown.
  return {
    bind,
    close,
    closeAll,
  };
}
