import { requireRouter } from './agent-message-router-private.js';

const held = new WeakMap();
const LEASE_MS = 30_000;
const MAX_LEASES = 32;

/** A bounded process borrow, never an authentication or execution grant. */
export function acquireAgentMessageRouteLease(broker) {
  requireRouter(broker && !broker.closed && !broker.idleShutdown.closing,
    'AGENT_MESSAGES_ENDPOINT_UNAVAILABLE');
  const leases = held.get(broker) ?? new Set();
  requireRouter(leases.size < MAX_LEASES, 'AGENT_MESSAGES_REQUEST_CAPACITY');
  const token = { expiresAt: Date.now() + LEASE_MS };
  let active = true;
  let timer;
  const release = () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    leases.delete(token);
    if (!leases.size) held.delete(broker);
    broker.onIdleStateChange?.(broker);
  };
  leases.add(token); held.set(broker, leases);
  timer = setTimeout(release, LEASE_MS);
  timer.unref?.();
  return Object.freeze({ release, verify() {
    requireRouter(active && Date.now() < token.expiresAt && !broker.closed && !broker.idleShutdown.closing,
      'AGENT_MESSAGES_DESTINATION_ROUTE_EXPIRED');
  } });
}

export function hasAgentMessageRouteLease(broker) {
  const now = Date.now();
  return [...(held.get(broker) ?? [])].some(token => token.expiresAt > now);
}
