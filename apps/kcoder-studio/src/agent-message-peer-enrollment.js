import { randomUUID } from 'node:crypto';
import { captureNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';
import { captureAuthenticatedPeerChannel } from './agent-message-peer-channel.js';
import { captureAuthenticatedPeerSourceAuthority } from './agent-message-peer-authority.js';
import { agentMessageId, validAgentMessageRequest, AGENT_MESSAGE_METHODS, AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY, AGENT_MESSAGE_RECEIPTS_CAPABILITY, AGENT_MESSAGE_REPLIES_CAPABILITY } from '../shared/agentMessageMethods.mjs';
import { requireRouter } from './agent-message-router-private.js';

/** The ordinary Gateway upgrader supplies its already-authenticated device,
 * real selected broker and live stores. This code never creates a thread.
 */
export async function attachAuthenticatedPeerEnrollment({ socket, initialData, broker, target, workspacePath,
  authorizationOwner, session, families, router, getTarget, targetSignature, loginContexts, scheduleIdle,
  maxMessageBytes, verifyFamilySession, originalDeviceOwner }) {
  requireRouter(session?.deviceId && session?.authorizationGeneration && families instanceof Map,
    'AGENT_MESSAGES_DEVICE_AUTHORIZATION_REQUIRED');
  const sourceTargetId = target.id;
  const family=families.get(session.deviceId),generation=session.authorizationGeneration;
  let selectedWorkspace = broker.initializeResponse?.result?.cwd ?? workspacePath;
  requireRouter(typeof selectedWorkspace === 'string' && broker.serverId === sourceTargetId,
    'AGENT_MESSAGES_WORKSPACE_UNKNOWN');
  let channel, authority, peerHandle, sourceHandle, enrolling = false, disposed = false;
  const initializeId = 'peer-management-' + randomUUID();
  let initialized, initializeFailed;
  const ready = new Promise((resolve, reject) => { initialized = resolve; initializeFailed = reject; });
  const client = {
    channel: 'control', authorizationOwner, nativeManagementOnly: true,
    send(value) {
      if (value.id === initializeId) { if (value.error) initializeFailed(new Error('AGENT_MESSAGES_MANAGEMENT_UNAVAILABLE')); else initialized(); }
      else if (['server/disconnected', 'server/transportError'].includes(value.method)) initializeFailed(new Error('AGENT_MESSAGES_MANAGEMENT_UNAVAILABLE'));
      return true;
    },
    pause() {}, resume() {}, close() { channel?.close(); },
  };
  const verifySession = () => {
    // This stable device-family check deliberately excludes socket/access-token
    // lifetime. Fixed accepted operations keep this actual revocable owner.
    requireRouter(family && families.get(session.deviceId)===family && family.authorizationGeneration===generation && family.expiresAt>Date.now() &&
      session.allowedServerIds?.has(sourceTargetId) && (verifyFamilySession===undefined || verifyFamilySession()===true), 'AGENT_MESSAGES_DEVICE_AUTHORIZATION_CHANGED');
    return true;
  };
  const close = () => {
    if (disposed) return;
    initializeFailed(new Error('AGENT_MESSAGES_DEVICE_CHANNEL_CLOSED'));
    disposed = true; channel?.close(); broker.detach(client); scheduleIdle?.();
  };
  socket.once('close', close); socket.once('error', close);
  broker.attach(client);
  const timer = setTimeout(() => initializeFailed(new Error('AGENT_MESSAGES_MANAGEMENT_UNAVAILABLE')), 15_000); timer.unref?.();
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: initializeId, method: 'initialize', params: {
    protocolVersion: '2026-07-27', clientInfo: { name: 'kcoder-authenticated-peer-management', version: '1' },
    capabilities: { experimental: { taskSourcesV1: false, threadRuntimeHandoffV1: false } },
  } }));
  try {
    await ready; clearTimeout(timer); verifySession();
    selectedWorkspace=broker.initializeResponse?.result?.cwd;
    requireRouter(typeof selectedWorkspace==='string' && selectedWorkspace.length>0,'AGENT_MESSAGES_WORKSPACE_UNKNOWN');
    requireRouter(!socket.destroyed && !disposed, 'AGENT_MESSAGES_DEVICE_CHANNEL_CLOSED');
    client.nativeRemoteSourceOwner = captureNativeRemoteSourceClient({ client, broker, sourceTarget: target,
      authorizationOwner, session, verifySession, getTarget, targetSignature,
      accountIdentity: (owner, serverId) => loginContexts.identity(owner, serverId),
      accountGeneration: (owner, serverId) => loginContexts.generation(owner, serverId), originalDeviceOwner });
    channel = captureAuthenticatedPeerChannel({ socket, initialData, nativeRemoteSourceOwner: client.nativeRemoteSourceOwner,
      maxMessageBytes, onRequest: async request => {
        verifySession();
        if (request.method === 'agentPeer/enroll') {
          requireRouter(!authority && !enrolling && request.params &&
            Object.keys(request.params).every(key => key === 'sourceThreadId') && agentMessageId(request.params.sourceThreadId),
          'AGENT_MESSAGES_INVALID_ENROLLMENT');
          enrolling = true;
          try {
            authority = await captureAuthenticatedPeerSourceAuthority({ socket, transport: channel, identityBroker: broker,
              nativeRemoteSourceOwner: client.nativeRemoteSourceOwner, authorizationOwner, session, verifySession, families,
              sourceSelector: { serverId: sourceTargetId, workspacePath: selectedWorkspace, threadId: request.params.sourceThreadId } });
            peerHandle = await router.registerAuthenticatedPeerEndpoint(authority);
            sourceHandle = await router.captureAuthenticatedPeer(peerHandle);
            const sourceAddress = await router.identityForSource(sourceHandle);
            const features = typeof router.capabilitiesForSource === 'function' ? await router.capabilitiesForSource(sourceHandle) : { receipts: false, replies: false };
            return { sourceAddress, logicalIdentity: authority.catalogIdentity(), capabilities: {
              targets: true, send: true, get: true, peerAgentMessagesV1: true, [AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY]: true,
              ...(features.receipts ? { listReceipts: true, [AGENT_MESSAGE_RECEIPTS_CAPABILITY]: true } : {}),
              ...(features.replies ? { [AGENT_MESSAGE_REPLIES_CAPABILITY]: true } : {}),
            } };
          } finally { enrolling = false; }
        }
        requireRouter(authority && sourceHandle, 'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
        authority.verifyCurrentDeviceGrant();
        const selector = authority.sourceSelector();
        if (request.method === 'agentPeer/targets') {
          const wire = { sourceThreadId: selector.threadId, ...request.params };
          requireRouter(validAgentMessageRequest(AGENT_MESSAGE_METHODS.targets, wire) && !Object.hasOwn(request.params, 'sourceThreadId'), 'AGENT_MESSAGES_INVALID_REQUEST');
          return router.targets(sourceHandle, request.params);
        }
        if (request.method === 'agentPeer/listReceipts') {
          const wire = { sourceThreadId: selector.threadId, ...request.params };
          requireRouter(validAgentMessageRequest(AGENT_MESSAGE_METHODS.listReceipts, wire) && !Object.hasOwn(request.params, 'sourceThreadId'), 'AGENT_MESSAGES_INVALID_REQUEST');
          return router.listReceipts(sourceHandle, request.params);
        }
        if (request.method === 'agentPeer/send') {
          requireRouter(validAgentMessageRequest(AGENT_MESSAGE_METHODS.send, { sourceThreadId: selector.threadId, message: request.params }), 'AGENT_MESSAGES_INVALID_REQUEST');
          return router.send(sourceHandle, request.params);
        }
        if (request.method === 'agentPeer/get') {
          requireRouter(validAgentMessageRequest(AGENT_MESSAGE_METHODS.get, { sourceThreadId: selector.threadId, query: request.params }), 'AGENT_MESSAGES_INVALID_REQUEST');
          return router.get(sourceHandle, request.params);
        }
        if (request.method === 'agentPeer/verifyOriginal') {
          requireRouter(request.params && Object.keys(request.params).every(key => ['attestation','access','message'].includes(key)), 'AGENT_MESSAGES_INVALID_REQUEST');
          return router.verifyOriginalOperation({ ...request.params, destinationPeerHandle: peerHandle,
            verifyCaller: () => { authority.sourceSelector(); return true; } });
        }
        throw new Error('AGENT_MESSAGES_METHOD_UNAVAILABLE');
      } });
    return Object.freeze({ close });
  } catch (error) { clearTimeout(timer); close(); throw error; }
}
