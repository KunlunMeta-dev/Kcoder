import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const credential = value => typeof value === 'string' && /^[A-Za-z0-9-]{32,128}$/.test(value);

// Use the device store's private, atomic, cross-process transaction. Persist
// hashes and the original ACL only; neither Cookies nor target logins go to disk.
export async function createBrowserSessionPersistence({ transaction, inspect = transaction, maximumSessions, now }) {
  let records = new Map();
  function rows(data) {
    const values = data.browserSessions ?? [];
    if (!Array.isArray(values) || values.length > maximumSessions || values.some(row =>
      !row || !/^[a-f0-9]{64}$/.test(row.idHash) || !/^[a-f0-9]{64}$/.test(row.identityHash) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt < 0 ||
      !Array.isArray(row.allowedServerIds) || row.allowedServerIds.length > 1024 ||
      row.allowedServerIds.some(id => typeof id !== 'string' || !id || id.length > 256)) ||
      new Set(values.map(row => row.idHash)).size !== values.length) throw new Error('Invalid browser session store');
    return values.filter(row => row.identityHash === data.identityHash && row.expiresAt > now());
  }
  const remember = values => { records = new Map(values.map(row => [row.idHash, row])); };
  remember(await transaction(async data => rows(data)));
  return {
    async restore(id) {
      if (!credential(id)) return null;
      const idHash = digest(id);
      if (!records.has(idHash)) return null;
      // A sibling process can log out or revoke this Cookie after our startup
      // snapshot. Inspect the authoritative store before accepting it again.
      const row = await inspect(async data => rows(data).find(item => item.idHash === idHash));
      return row && row.expiresAt > now()
        ? { browserAdmin: true, expiresAt: row.expiresAt, allowedServerIds: new Set(row.allowedServerIds), expiryTimer: null }
        : null;
    },
    async save(id, session, ttlMs) {
      if (!credential(id) || session.browserAdmin !== true || session.deviceId) throw new Error('Invalid browser session');
      const row = { idHash: digest(id), expiresAt: session.expiresAt, allowedServerIds: [...session.allowedServerIds] };
      remember(await transaction(async data => {
        row.identityHash = data.identityHash;
        if (ttlMs !== undefined) row.expiresAt = now() + ttlMs;
        const values = rows(data).filter(item => item.idHash !== row.idHash);
        while (values.length >= maximumSessions) values.shift();
        data.browserSessions = [...values, row];
        return data.browserSessions;
      }));
      return row.expiresAt;
    },
    async renew(id, ttlMs) {
      if (!credential(id)) return null;
      const idHash = digest(id);
      let renewed = null;
      remember(await transaction(async data => {
        const values = rows(data), index = values.findIndex(row => row.idHash === idHash);
        // Only an unexpired authoritative row can renew; never upsert a revoked Cookie.
        if (index >= 0) {
          renewed = { ...values[index], expiresAt: now() + ttlMs };
          values[index] = renewed;
        }
        data.browserSessions = values;
        return values;
      }, 'renew'));
      return renewed ? { browserAdmin: true, expiresAt: renewed.expiresAt,
        allowedServerIds: new Set(renewed.allowedServerIds), expiryTimer: null } : null;
    },
    async remove(id, expiredAt) {
      if (!credential(id)) return;
      const idHash = digest(id);
      if (!records.has(idHash)) return;
      remember(await transaction(async data => {
        data.browserSessions = rows(data).filter(row => row.idHash !== idHash ||
          (expiredAt !== undefined && row.expiresAt > expiredAt));
        return data.browserSessions;
      }));
    },
    async updateAccess(previousIds, currentIds, reconcile, reductions = new Map()) {
      const current = await transaction(async data => {
        // Reconcile only existing current rows; revoked or expired Cookies stay absent.
        data.browserSessions = rows(data).map(row => ({ ...row,
          allowedServerIds: reconcile
            ? [...reconcile({ allowedServerIds: new Set(row.allowedServerIds) }, previousIds, currentIds)]
            : row.allowedServerIds.filter(id => !reductions.has(row.idHash) || reductions.get(row.idHash).has(id)),
        }));
        return data.browserSessions;
      });
      remember(current);
      return new Map(current.map(row => [row.idHash, row]));
    },
  };
}

export function createGatewayAuthSessionRegistry({ authRequired, getServerIds, maximumSessions, ttlMs,
  persistence, sessionSockets, invalidateOwner, expireDevice, now = Date.now, observe = () => {} }) {
  const report = (stage, facts = {}) => {
    try { Promise.resolve(observe({ component: 'gateway_session', stage, at: Date.now(), ...facts })).catch(() => {}); } catch {}
  };
  const remaining = session => Number.isFinite(session?.expiresAt) ? session.expiresAt - now() : -1;
  const sessions = new Map();
  const enqueue = createBrowserSessionOperationQueue();
  const pendingReads = new Map();
  const serialize = (operation, kind = 'write') => {
    // Every admitted mutation fences read coalescing, including failed writes.
    if (kind !== 'read') pendingReads.clear();
    return enqueue(operation, kind);
  };
  function detach(id) {
    const session = sessions.get(id);
    invalidateOwner(session?.stableLoginOwner || id);
    if (session?.deviceId) { expireDevice(session.deviceId); return; }
    clearTimeout(session?.expiryTimer);
    sessions.delete(id);
    const sockets = sessionSockets.get(id);
    sessionSockets.delete(id);
    for (const socket of sockets ?? []) socket.destroy();
  }
  async function remove(id) {
    detach(id);
    await persistence?.remove(id);
  }
  const removeLater = id => {
    const expected = sessions.get(id), expiredAt = expected?.expiresAt;
    void serialize(async () => {
      // An old timer must wait for an admitted renewal's durable outcome.
      if (!expected || sessions.get(id) !== expected || expected.expiresAt !== expiredAt || expiredAt > now()) return;
      detach(id);
      await persistence?.remove(id, expiredAt);
    }).catch(() => {
      console.warn('Browser session expiry persistence unavailable');
    });
  };
  function schedule(id, session) {
    clearTimeout(session.expiryTimer);
    session.expiryTimer = setTimeout(() => removeLater(id), Math.max(0, session.expiresAt - now()));
    session.expiryTimer.unref?.();
  }
  return {
    sessions,
    get(id) {
      // Only merge not-yet-started reads. Once inspection starts, later
      // requests need their own authoritative check; this is not an auth TTL.
      const existing = pendingReads.get(id);
      if (existing) return existing;
      const queued = Date.now(); report('read_queued');
      const pending = serialize(async () => {
      if (pendingReads.get(id) === pending) pendingReads.delete(id);
      const started = Date.now(); let result = null, failed = false;
      report('read_started', { queueMs: started - queued, remainingMs: remaining(sessions.get(id)) });
      try {
      if (!authRequired) return result = { allowedServerIds: new Set(getServerIds()) };
      for (const [key, session] of sessions) if (session.expiresAt <= now()) removeLater(key);
      let session = id ? sessions.get(id) : null;
      if ((!session || session.browserAdmin) && id) {
        const restored = await persistence?.restore(id);
        if (restored) {
          if (!session && sessions.size >= maximumSessions) return null;
          const currentIds = new Set(getServerIds());
          session ??= restored;
          session.expiresAt = restored.expiresAt;
          session.allowedServerIds = new Set([...restored.allowedServerIds].filter(key => currentIds.has(key)));
          sessions.set(id, session);
          schedule(id, session);
        } else {
          if (session) detach(id);
          return null;
        }
      }
      return result = session && (session.accessExpiresAt ?? session.expiresAt) > now() ? session : null;
      } catch (error) { failed = true; throw error; }
      finally { report('read_completed', { elapsedMs: Date.now() - started, remainingMs: remaining(result), valid: Boolean(result), failed }); }
    }, 'read');
      pendingReads.set(id, pending);
      return pending;
    },
    create({ browserAdmin = false } = {}) {
      return serialize(async () => {
        for (const [id, session] of sessions) if (session.expiresAt <= now()) await remove(id);
        const neededSlots = Math.max(0, sessions.size - maximumSessions + 1);
        if (neededSlots > 0 && [...sessions.values()].filter(session => !session.deviceId).length < neededSlots) {
          const error = new Error('Gateway session limit reached'); error.status = 429; throw error;
        }
        while (sessions.size >= maximumSessions) {
          const candidate = [...sessions].find(([, session]) => !session.deviceId);
          if (!candidate) { const error = new Error('Gateway session limit reached'); error.status = 429; throw error; }
          await remove(candidate[0]);
        }
        const id = randomUUID();
        const session = { expiresAt: now() + ttlMs, allowedServerIds: new Set(getServerIds()), browserAdmin, expiryTimer: null };
        if (browserAdmin && persistence) session.expiresAt = await persistence.save(id, session, ttlMs);
        if (session.expiresAt <= now()) {
          await persistence?.remove(id, session.expiresAt);
          const error = new Error('Browser session persistence exceeded its lifetime'); error.status = 503; throw error;
        }
        sessions.set(id, session);
        schedule(id, session);
        return { id, session };
      });
    },
    delete(id) { return serialize(() => remove(id)); },
    renew(id) {
      const queued = Date.now(); report('renew_queued');
      return serialize(async () => {
        const started = Date.now(); let valid = false, failed = false;
        report('renew_started', { queueMs: started - queued, remainingMs: remaining(sessions.get(id)) });
        try {
        let session = sessions.get(id);
        if (session && (!session.browserAdmin || session.deviceId)) return false;
        if (!session && sessions.size >= maximumSessions) return false;
        const renewed = await persistence?.renew(id, ttlMs);
        if (!renewed || renewed.expiresAt <= now()) {
          if (session) detach(id);
          return false;
        }
        const currentIds = new Set(getServerIds());
        session ??= renewed;
        session.expiresAt = renewed.expiresAt;
        session.allowedServerIds = new Set([...renewed.allowedServerIds].filter(key => currentIds.has(key)));
        sessions.set(id, session);
        schedule(id, session);
        valid = true; return true;
        } catch (error) { failed = true; throw error; }
        finally { report('renew_completed', { elapsedMs: Date.now() - started, remainingMs: remaining(sessions.get(id)), valid, failed }); }
      }, 'renew');
    },
    saveAccess(previousIds, currentIds, reconcile) {
      return serialize(async () => {
        const reductions = new Map([...sessions].filter(([, session]) => session.browserAdmin && !session.deviceId)
          .map(([id, session]) => [digest(id), new Set(session.allowedServerIds)]));
        const current = await persistence?.updateAccess(previousIds, currentIds, reconcile, reductions);
        for (const [id, session] of sessions) {
          if (session.browserAdmin && !session.deviceId && persistence) {
            const row = current.get(digest(id));
            if (!row || row.expiresAt <= now()) { detach(id); continue; }
            session.allowedServerIds = new Set(row.allowedServerIds);
            session.expiresAt = row.expiresAt;
            schedule(id, session);
          } else if (reconcile) session.allowedServerIds = reconcile(session, previousIds, currentIds);
        }
      });
    },
  };
}

// Only an already-admitted renewal may pass unstarted reads. Other mutations
// remain FIFO barriers; the active operation and its authoritative guard finish first.
export function createBrowserSessionOperationQueue() {
  const pending = [];
  let running = false;
  return (operation, kind = 'write') => new Promise((resolve, reject) => {
    pending.push({ operation, kind, resolve, reject });
    if (running) return;
    running = true;
    queueMicrotask(async () => {
      while (pending.length) {
        const boundary = pending.findIndex(item => item.kind !== 'read');
        const index = boundary >= 0 && pending[boundary].kind === 'renew' ? boundary : 0;
        const item = pending.splice(index, 1)[0];
        try { item.resolve(await item.operation()); } catch (error) { item.reject(error); }
      }
      running = false;
    });
  });
}
