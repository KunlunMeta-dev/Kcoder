import { isContract } from '../shared/generated/validator.mjs';
import { AgentMessageRouterError, ROUTER_METHODS, requireRouter, sameAddress } from './agent-message-router-private.js';

/** Router feature fact shared by the Gateway initialize and Native targets. */
export const SESSION_READ_CAPABILITY = 'sessionReadV1';
// The target bounds its window to 96 KiB; allow JSON framing slack, never more.
export const AGENT_MESSAGE_MAX_READ_BYTES = 112 * 1024;

/** Shape-only check of a ReadSession routed from the actual source attempt. */
export function validSessionReadRequest(sourceThreadId, read) {
  return isContract('CrossSessionMessageSessionReadRpcParams', { sourceThreadId, read }) &&
    read.targetAddress != null && read.targetAddress.threadId === read.threadId;
}

/** Route one read to the target owner. The Gateway never authorizes the read: the
 * target decides from its own read_access on each call. Reachability, account and
 * endpoint fences are the same as for discovery and delivery.
 */
export async function routeSessionRead({ source, read, refreshEndpoint, destinationFor, requireEndpointFeature }) {
  await source.checkCurrentAuthority(); source.verify();
  requireRouter(validSessionReadRequest(source.sourceThreadId, read), 'AGENT_MESSAGES_INVALID_REQUEST');
  requireRouter(!sameAddress(source.address, read.targetAddress), 'AGENT_MESSAGES_SELF_READ');
  await refreshEndpoint(source, source.endpoint);
  const destination = await destinationFor(source, read.targetAddress);
  await requireEndpointFeature(destination, SESSION_READ_CAPABILITY);
  source.verify(); destination.verify();
  return readSessionAtEndpoint(source, read, destination);
}

export async function readSessionAtEndpoint(source, read, destination) {
  const release = destination.acquire?.();
  try {
    const outcome = await destination.request(ROUTER_METHODS.read, { sourceThreadId: source.sourceThreadId, read });
    source.verify(); destination.verify();
    requireRouter(isContract('CrossSessionMessageSessionReadOutcome', outcome) &&
      Buffer.byteLength(JSON.stringify(outcome)) <= AGENT_MESSAGE_MAX_READ_BYTES, 'AGENT_MESSAGES_INVALID_READ_RESPONSE');
    if (outcome.result) {
      const turns = read.turns ?? 3;
      requireRouter(outcome.result.threadId === read.threadId && sameAddress(outcome.result.address, read.targetAddress) &&
        outcome.result.turns.length <= turns, 'AGENT_MESSAGES_INVALID_READ_RESPONSE');
    }
    return outcome;
  } finally { release?.(); }
}

export function sessionReadUnsupported() {
  return new AgentMessageRouterError('AGENT_MESSAGES_SESSION_READ_UNSUPPORTED', -32601);
}
