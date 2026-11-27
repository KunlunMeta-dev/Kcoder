import { registerMobileDeviceGrantState } from './retention-context.js';
import { requireOriginalOperationDeviceAuthorization } from './gateway-device-auth.js';

const originalOwners = new WeakSet();
const fail = () => { throw new Error('ORIGINAL_OPERATION_DEVICE_OWNER_CHANGED'); };

export function requireOriginalOperationDeviceOwner(value) {
  if (!originalOwners.has(value)) fail();
  value.verifyScopeFacts();
  return value;
}

/** Transport families may expire while a previously admitted operation still
 * has a durable device owner. Only the real grant registrar mints this scope.
 */
export function createGatewayDeviceLifecycle({ families, authSessions, sessionSockets, loginContexts,
  gatewayDeviceAuth, getServerIds, allowsSurface = () => true, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const authorities = new Map();
  const expireTransport = deviceId => {
    const family = families.get(deviceId);
    if (family) {
      clearTimer(family.timer); families.delete(deviceId);
      for (const socket of family.sockets) socket.destroy();
      family.sockets.clear();
    }
    for (const [id, session] of authSessions) if (session.deviceId === deviceId) {
      authSessions.delete(id); sessionSockets.delete(id);
    }
  };
  const invalidateOwner = deviceId => {
    expireTransport(deviceId);
    authorities.delete(deviceId);
    loginContexts.invalidateOwner(`mobile-device:${deviceId}`);
  };
  return Object.freeze({
    expireTransport, invalidateOwner,
    registerGrant(payload) {
      const { family, session, publicPayload } = registerMobileDeviceGrantState({ families, payload,
        allowedServerIds: getServerIds() });
      let authority = authorities.get(payload.deviceId);
      if (!authority || authority.generation !== payload.authorizationGeneration ||
          authority.namespace !== payload.retentionNamespaceId) {
        if (authority) loginContexts.invalidateOwner(`mobile-device:${payload.deviceId}`);
        authority = { generation: payload.authorizationGeneration, namespace: payload.retentionNamespaceId,
          surface: payload.surface || 'terminal', allowedServerIds: new Set(getServerIds()) };
        authorities.set(payload.deviceId, authority);
      }
      session.allowedServerIds = new Set(authority.allowedServerIds);
      clearTimer(family.timer);
      for (const [id, previous] of authSessions) if (previous.deviceId === payload.deviceId) {
        authSessions.delete(id); sessionSockets.delete(id);
      }
      const expire = () => {
        // A callback from an old family cannot close a refreshed replacement.
        if (families.get(payload.deviceId) !== family) return;
        const remaining = family.expiresAt - now();
        if (remaining <= 0) expireTransport(payload.deviceId);
        else { family.timer = setTimer(expire, Math.min(remaining, 2_147_000_000)); family.timer.unref?.(); }
      };
      authSessions.set(payload.accessToken, session);
      expire();
      return { family, session, publicPayload };
    },
    reconcileAccess(previousIds, currentIds, reconcile) {
      for (const authority of authorities.values()) {
        authority.allowedServerIds = reconcile({ allowedServerIds: authority.allowedServerIds }, previousIds, currentIds);
      }
    },
    async captureOriginalOperationOwner(accessToken, session) {
      const live = () => {
        const family = families.get(session?.deviceId);
        if (authSessions.get(accessToken) !== session || !family ||
            family.authorizationGeneration !== session.authorizationGeneration || family.expiresAt <= now() ||
            (session.accessExpiresAt ?? session.expiresAt) <= now()) fail();
      };
      live();
      const ledger = requireOriginalOperationDeviceAuthorization(
        await gatewayDeviceAuth.captureOriginalOperationDeviceAuthorization(accessToken));
      live();
      const authority = authorities.get(ledger.deviceId);
      const verifyScopeFacts = () => {
        if (!authority || authorities.get(ledger.deviceId) !== authority ||
            authority.generation !== ledger.authorizationGeneration || authority.namespace !== ledger.namespaceId ||
            session.deviceId !== ledger.deviceId || session.authorizationGeneration !== ledger.authorizationGeneration ||
            !allowsSurface(authority.surface)) fail();
      };
      verifyScopeFacts();
      const owner = Object.freeze({ verifyScopeFacts,
        isTargetAllowed(id) { verifyScopeFacts(); return authority.allowedServerIds.has(id); },
        currentAllowedServerIds() { verifyScopeFacts(); return new Set(authority.allowedServerIds); },
        async checkCurrent() {
          verifyScopeFacts();
          await ledger.checkCurrent();
          verifyScopeFacts();
        },
      });
      originalOwners.add(owner);
      await owner.checkCurrent(); live();
      return owner;
    },
  });
}
