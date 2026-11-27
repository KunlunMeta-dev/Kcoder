import { randomBytes, createPublicKey, verify as verifySignature } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Socket } from 'node:net';
import { WorkspaceAppServerBroker } from './workspace-app-server-broker.js';
import { requireCapturedNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';
import { ROUTER_METHODS, privateRouterFrame, routerIdentity, requireRouter } from './agent-message-router-private.js';
import { validAgentMessageAddress, agentMessageId } from '../shared/agentMessageMethods.mjs';
import { requireAuthenticatedPeerChannel } from './agent-message-peer-channel.js';

const captured = new WeakSet();
const PURPOSE = 'kcoder.peer-source.presence.v1';
const signingBytes = claims => Buffer.concat([Buffer.from(PURPOSE + '\0'), Buffer.from(JSON.stringify({
  version: claims.version, purpose: claims.purpose, nonce: claims.nonce,
  source: { targetId: claims.source.targetId, workspaceId: claims.source.workspaceId, threadId: claims.source.threadId },
  identityEpoch: claims.identityEpoch, leaseId: claims.leaseId,
}))]);
const physical = identity => [identity.targetId, identity.workspaceId, identity.identityEpoch, identity.publicKey];
const octets = (value, size) => Array.isArray(value) && value.length === size && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);

/** Called by the authenticated device socket composition, never public JSON.
 * The actual identity broker corroborates location/account. Native Bound owns
 * execution authority; signed presence itself grants no operation permission.
 */
export async function captureAuthenticatedPeerSourceAuthority({ socket, transport, identityBroker, nativeRemoteSourceOwner,
  authorizationOwner, session, verifySession, families, sourceSelector }) {
  const owner = requireCapturedNativeRemoteSourceClient(nativeRemoteSourceOwner);
  transport=requireAuthenticatedPeerChannel(transport);
  requireRouter(transport.socket===socket && transport.hasManagementOwner(owner), 'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
  requireRouter(socket instanceof Socket && !socket.destroyed && identityBroker instanceof WorkspaceAppServerBroker &&
    typeof authorizationOwner === 'string' && session?.allowedServerIds instanceof Set &&
    typeof verifySession === 'function' && families instanceof Map && typeof transport?.request === 'function' &&
    typeof transport?.currentLease === 'function', 'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
  const selector = Object.freeze({ ...sourceSelector });
  requireRouter(Object.keys(selector).every(key => ['serverId', 'workspacePath', 'threadId'].includes(key)) &&
    selector.serverId === identityBroker.serverId && agentMessageId(selector.threadId) &&
    typeof selector.workspacePath === 'string' && selector.workspacePath.length > 0 &&
    Buffer.byteLength(selector.workspacePath) <= 32768 && !/[\p{Cc}]/u.test(selector.workspacePath), 'AGENT_MESSAGES_INVALID_ADDRESS');
  requireRouter(typeof session.deviceId === 'string' && typeof session.authorizationGeneration === 'string',
    'AGENT_MESSAGES_DEVICE_AUTHORIZATION_REQUIRED');
  const deviceId = session.deviceId, generation = session.authorizationGeneration;
  const family = families.get(deviceId);
  const verifyDevice = () => {
    owner.verify();
    requireRouter(family && families.get(deviceId) === family && family.authorizationGeneration === generation &&
      family.expiresAt > Date.now() && family.sockets.has(socket) && verifySession() === true &&
      session.allowedServerIds.has(selector.serverId), 'AGENT_MESSAGES_DEVICE_AUTHORIZATION_CHANGED');
  };
  verifyDevice();
  const nativeFrame = await identityBroker.sendAgentMessageRouterRequest(ROUTER_METHODS.identity, {});
  verifyDevice();
  requireRouter(nativeFrame && !nativeFrame.error && nativeFrame.result, 'AGENT_MESSAGES_ENDPOINT_UNAVAILABLE');
  const catalogIdentity = routerIdentity(nativeFrame.result);
  const nonce = randomBytes(32).toString('hex');
  const response = await transport.request('agentPeer/sourcePresence', { nonce, sourceThreadId: selector.threadId });
  verifyDevice();
  requireRouter(response && !response.error && response.result, 'AGENT_MESSAGES_NATIVE_PRESENCE_UNCONFIRMED');
  const { identity: rawIdentity, presence } = response.result;
  const nativeIdentity = routerIdentity(rawIdentity);
  requireRouter(isDeepStrictEqual(physical(nativeIdentity), physical(catalogIdentity)), 'AGENT_MESSAGES_SOURCE_PROFILE_MISMATCH');
  const claims = presence?.claims;
  requireRouter(claims && claims.version === 1 && claims.purpose === PURPOSE && claims.nonce === nonce &&
    validAgentMessageAddress(claims.source) && claims.source.targetId === nativeIdentity.targetId &&
    claims.source.workspaceId === nativeIdentity.workspaceId && claims.source.threadId === selector.threadId &&
    claims.identityEpoch === nativeIdentity.identityEpoch && agentMessageId(claims.leaseId) && octets(presence.signature, 64),
  'AGENT_MESSAGES_NATIVE_PRESENCE_INVALID');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(nativeIdentity.publicKey)]), format: 'der', type: 'spki' });
  requireRouter(verifySignature(null, signingBytes(claims), key, Buffer.from(presence.signature)), 'AGENT_MESSAGES_NATIVE_PRESENCE_INVALID');
  const leaseId = claims.leaseId;
  const verifyCurrent = () => {
    verifyDevice();
    requireRouter(!socket.destroyed && transport.currentLease() === leaseId, 'AGENT_MESSAGES_SOURCE_LEASE_CHANGED');
  };
  verifyCurrent();
  const authority = Object.freeze({
    sourceSelector: () => { verifyCurrent(); return selector; },
    identity: () => { verifyCurrent(); return nativeIdentity; },
    catalogIdentity: () => { verifyCurrent(); return catalogIdentity; },
    verifyCurrentDeviceGrant: verifyDevice,
    ownsSource: threadId => { verifyCurrent(); return threadId === selector.threadId; },
    currentAccountAuthorization: () => { verifyDevice(); return { authorizationOwner, session, verifySession,
      broker: identityBroker, nativeRemoteSourceOwner: owner }; },
    async requestPrivate(method, params, proof) {
      verifyCurrent();
      const frame = privateRouterFrame({ jsonrpc: '2.0', id: 'peer-native', method, params }, proof);
      const result = await transport.request('agentPeer/nativeRequest', { request: frame });
      verifyCurrent();
      requireRouter(result && (Object.hasOwn(result, 'result') || Object.hasOwn(result, 'error')), 'AGENT_MESSAGES_NATIVE_RESULT_UNCONFIRMED');
      return result;
    },
  });
  captured.add(authority);
  return authority;
}

export function requireAuthenticatedPeerSourceAuthority(value) {
  requireRouter(captured.has(value), 'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
  value.verifyCurrentDeviceGrant();
  return value;
}
