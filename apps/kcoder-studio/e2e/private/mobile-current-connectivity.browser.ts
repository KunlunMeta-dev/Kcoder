import { resolveGatewayRoute, getGatewayRouteSnapshot, invalidateGatewayRoute } from '../../mobile/src/gateway/connection-routes';
import { peerFetch, getPeerTransportDiagnostics, isPeerTransportUrl, releasePeerTransports } from '../../mobile/src/gateway/peer-transport';
import type { GatewayProfile } from '../../mobile/src/gateway/types';

/** Live acceptance owns one device authorization and revokes it after inventory reads. */
export async function inspectCurrentConnectivity(config: { baseUrl: string; token: string; label: string }) {
  let profile: GatewayProfile | undefined;
  let sessionDeleted = false;
  try {
    const paired = await fetch(`${config.baseUrl}/api/mobile/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: config.token, deviceLabel: config.label, durableDeviceAuthorization: true }),
    });
    if (!paired.ok) throw new Error(`Temporary session HTTP ${paired.status}`);
    const session = await paired.json();
    profile = { id: config.label, label: config.label, baseUrl: config.baseUrl,
      authMode: 'device', deviceId: session.deviceId, authorizationGeneration: session.authorizationGeneration,
      accessToken: session.accessToken, rpcToken: session.rpcToken,
      expiresAt: session.expiresAt, connectionRoutes: session.connectionRoutes };
    if (!profile.connectionRoutes) throw new Error('Current Gateway did not supply connection routes');
    if (!profile.connectionRoutes.endpoints.every(endpoint => endpoint.kind === 'public')) throw new Error('Gateway still advertises a retired direct HTTP endpoint');
    const selected = await resolveGatewayRoute(profile);
    const route = getGatewayRouteSnapshot(profile);
    const url = `${selected}/api/servers`;
    const options = { headers: { authorization: `Bearer ${profile.accessToken}` } };
    const response = isPeerTransportUrl(selected) ? await peerFetch(url, options) : await fetch(url, options);
    if (!response.ok) throw new Error(`Selected route inventory HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.servers)) throw new Error('Invalid inventory response');
    const peer = isPeerTransportUrl(selected) ? await getPeerTransportDiagnostics(selected) : undefined;
    if (peer && (peer.state !== 'open' || peer.dataChannelState !== 'open' || peer.bytesReceived <= 0 || peer.bytesSent <= 0)) {
      throw new Error('Selected P2P route has no bidirectional open DataChannel');
    }
    return { kind: route?.kind, endpoints: profile.connectionRoutes.endpoints, inventoryStatus: response.status,
      serverCount: payload.servers.length, peer: peer ?? null };
  } finally {
    if (profile) {
      try {
        const response = await fetch(`${config.baseUrl}/api/mobile/session`, {
          method: 'DELETE', headers: { authorization: `Bearer ${profile.accessToken}` },
        });
        sessionDeleted = response.status === 204;
      } finally {
        releasePeerTransports(profile);
        invalidateGatewayRoute(profile);
      }
      if (!sessionDeleted) throw new Error('Temporary session cleanup was not acknowledged; do not retry blindly');
    }
  }
}
