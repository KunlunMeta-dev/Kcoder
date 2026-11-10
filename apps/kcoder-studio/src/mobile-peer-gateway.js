import { createMobilePeerOwnership } from './mobile-peer-ownership.js';
import { createMobilePeerTransport } from './mobile-peer-transport.js';

/** Composes peer transport with Gateway session, device-family, and account owners. */
export function createMobilePeerGateway({
  enabled,
  stunUrls,
  mobileDeviceAuth,
  authSessionById,
  authSessions,
  mobileDeviceFamilies,
  sessionSockets,
  contextSockets,
  loginContexts,
  contextSocketKey,
  getServers,
  getTarget,
  jsonResponse,
  getLocalBase,
  rpcToken,
  loadRtc,
  loadWebSocket,
  allowsSurface,
}) {
  const ownership = createMobilePeerOwnership({
    authSessionById,
    authSessions,
    mobileDeviceFamilies,
    sessionSockets,
    registerTargetContext(handle, session, targetId, token) {
      const target = getTarget(targetId);
      if (!target || !session.allowedServerIds?.has(targetId)) return false;
      if (!target.security) return undefined;
      const loginOwner = session.stableLoginOwner || token;
      if (!loginContexts.identity(loginOwner, targetId)) return false;
      const key = contextSocketKey(loginOwner, targetId);
      let sockets = contextSockets.get(key);
      if (!sockets) contextSockets.set(key, (sockets = new Set()));
      sockets.add(handle);
      return () => {
        sockets.delete(handle);
        if (!sockets.size && contextSockets.get(key) === sockets) contextSockets.delete(key);
      };
    },
  });
  const transport = createMobilePeerTransport({
    enabled,
    stunUrls,
    mobileDeviceAuth,
    getIdentity: () => mobileDeviceAuth.getConnectionIdentity(),
    jsonResponse,
    getLocalBase,
    rpcToken,
    authSessionById,
    authSessions,
    mobileDeviceFamilies,
    ownership,
    allowsSurface,
    getDeviceFamily: deviceId => mobileDeviceFamilies.get(deviceId),
    getTarget,
    getDefaultTarget: () => getServers()[0],
    getTargetIds: () => getServers().map(server => server.id),
    ...(loadRtc ? { loadRtc } : {}),
    ...(loadWebSocket ? { loadWebSocket } : {}),
  });
  return {
    handleHttp: transport.handleHttp,
    closeDisabled: transport.closeDisabled,
    async close() {
      await transport.close();
      ownership.closeAll();
    },
  };
}
