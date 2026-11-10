import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const REMOTE_TRANSPORT_OBSERVATIONS_PATH = '/api/runtime/remotes/observations';
function relayEntry(state, reasonCode, id = null) {
  return {
    id: 'gateway:relay-registration', capability: 'relay.registration', purpose: 'relay_transport_registration', targetId: 'gateway',
    transport: 'relay', protocol: 'kcoder_relay', protocolVersion: null, implementationVersion: null,
    state, identityState: id ? 'observed' : 'unknown', businessState: 'unknown', nativeOwner: null,
    schemas: [{ name: 'RelayRegisteredClientIdentity/v1', protocolVersion: '1', producerRevision: null }],
    boundary: { resource: id ? { kind: 'connection', id } : null, location: 'relay_registration_on_gateway',
      authorization: 'gateway_admin_metadata_only', allowedModels: 'not_applicable_transport', budget: 'not_reserved',
      tools: 'not_applicable_transport', confirmation: 'native_request_policy', inputTransfer: 'not_business_verified', resultTransfer: 'not_business_verified' },
    observedAt: id ? new Date().toISOString() : null, reasonCode,
  };
}

/** Capture only explicit native startup configuration. Reading never enrolls or probes a tunnel. */
export function captureGatewayRemoteTransportObservations({ env = process.env, gatewaySecret } = {}) {
  const take = name => {
    const entries = Object.entries(env).filter(([key]) => key.toUpperCase() === name);
    for (const [key] of entries) delete env[key];
    return new Set(entries.map(([, value]) => value)).size === 1 ? entries[0]?.[1] : undefined;
  };
  const identityFile = take('KCODER_STUDIO_RELAY_IDENTITY_FILE');
  const relayUrl = take('KCODER_STUDIO_RELAY_ORIGIN');
  const configured = typeof identityFile === 'string' && isAbsolute(identityFile)
    && typeof relayUrl === 'string' && typeof gatewaySecret === 'string' && gatewaySecret.length >= 32;
  return async () => {
    let entry = relayEntry('unknown', 'RELAY_REGISTRATION_NOT_CONFIGURED');
    if (configured) {
      try {
        // The existing private reader enforces mode/UID/no-follow, origin and internal-secret binding.
        // Installed Gateways without Relay resources keep this provider unavailable.
        const { readRegisteredClientId } = await import('../../../kcoder-relay/src/client-identity.mjs');
        const id = await readRegisteredClientId({ identityFile, relayUrl, gatewaySecret, requireSingleLink: true });
        entry = relayEntry('observed', 'RELAY_DURABLE_REGISTRATION_OBSERVED_NOT_ONLINE_VERIFIED', id);
      } catch {
        entry = relayEntry('unavailable', 'RELAY_REGISTRATION_UNAVAILABLE');
      }
    }
    return { snapshotId: randomUUID(), observedAt: new Date().toISOString(), entries: [entry], nextCursor: null, total: 1 };
  };
}

export function createRemoteTransportObservationRoute({ observe, canRead, jsonResponse }) {
  return async (request, response, requestUrl, authSession) => {
    if (requestUrl.pathname !== REMOTE_TRANSPORT_OBSERVATIONS_PATH) return false;
    if (request.method !== 'GET') { jsonResponse(response, 405, { error: 'Read-only metadata route' }); return true; }
    if (requestUrl.search) { jsonResponse(response, 400, { error: 'Metadata selectors are not accepted' }); return true; }
    if (!canRead(request, authSession)) { jsonResponse(response, 403, { error: 'Gateway metadata authorization required' }); return true; }
    const observations = await observe();
    if (!canRead(request, authSession)) { jsonResponse(response, 403, { error: 'Gateway metadata authorization required' }); return true; }
    jsonResponse(response, 200, observations);
    return true;
  };
}
