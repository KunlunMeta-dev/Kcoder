import { createHash, randomBytes } from 'node:crypto';

/** Failures share a bounded peer budget; valid credentials are checked before this budget. */
export function createLoginFailureBudget({ now = Date.now, windowMs = 60_000, maximumPeers = 1024 } = {}) {
  const peers = new Map();
  const key = request => request.socket.remoteAddress || 'unknown';
  function recent(request) {
    const time = now();
    for (const [peer, attempts] of peers) {
      const remaining = attempts.filter(value => time - value < windowMs);
      if (remaining.length) peers.set(peer, remaining); else peers.delete(peer);
    }
    return peers.get(key(request)) || [];
  }
  return {
    retryAfter(request) {
      const attempts = recent(request);
      return attempts.length >= 5 ? Math.max(1, Math.ceil((attempts[0] + windowMs - now()) / 1000)) : 0;
    },
    record(request) {
      const attempts = recent(request), peer = key(request);
      if (!peers.has(peer) && peers.size >= maximumPeers) peers.delete(peers.keys().next().value);
      if (attempts.length < 5) attempts.push(now());
      peers.set(peer, attempts);
    },
  };
}

/** Process-owned, purpose-specific links never contain the reusable Gateway password. */
export function createLoginTickets({ now = Date.now, ttlMs = 5 * 60_000, maximumTickets = 128 } = {}) {
  const issued = new Map();
  const digest = value => createHash('sha256').update(value).digest('hex');
  const valid = value => typeof value === 'string' && /^kclog1_[A-Za-z0-9_-]{43}$/.test(value);
  function prune() { for (const [key, entry] of issued) if (entry.expiresAt <= now()) issued.delete(key); }
  return {
    issue() {
      prune();
      while (issued.size >= maximumTickets) issued.delete(issued.keys().next().value);
      const token = `kclog1_${randomBytes(32).toString('base64url')}`, expiresAt = now() + ttlMs;
      issued.set(digest(token), { expiresAt });
      return { token, expiresAt, linkKind: 'single-use' };
    },
    consume(value) {
      prune();
      if (!valid(value)) return false;
      // Consume before asynchronous admission. Unknown storage results must never create a second session.
      return issued.delete(digest(value));
    },
  };
}
