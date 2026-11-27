import { createNativeSshEndpointFactory } from './native-ssh-endpoint.mjs';
import { createNativeRemoteHostBackchannel } from './host-backchannel.mjs';
import { nativeRemoteSourceClientForAttempt, nativeRemoteSourceClientForManagement } from './source-client-owner.mjs';
import { createAgentMessageRouterBackchannel } from '../agent-message-router-backchannel.js';

const peerParents = new WeakMap();

export function isWorkspaceNativePeerParent(channel, broker) {
  try { return peerParents.get(channel)?.(broker) === true; } catch { return false; }
}

/** The workspace factory supplies the exact tracked child and verified image
 * binding. Neither a public request nor a catalog display name can mint it.
 */
export function createWorkspaceNativeBackchannel({ child, spawnedProcess, targetId, expectedSignature,
  getCurrentTarget, targetSignature, trustedImageMatches, isTrackedChild, getBroker, endpointOwners, getAgentMessageRouter }) {
  const assertSourceNativeChild = ({ child: observed, serverId }) => {
    const current = getCurrentTarget();
    if (observed !== child || observed !== spawnedProcess || serverId !== targetId ||
        !isTrackedChild(child) || child.exitCode !== null || child.signalCode !== null ||
        getBroker()?.closed || !current || !trustedImageMatches(current) || targetSignature(current) !== expectedSignature)
      throw new Error('REMOTE_HOST_SOURCE_OWNER_CHANGED');
  };
  const owner = createNativeSshEndpointFactory({ assertSourceNativeChild,
    sourceClientForAttempt: attempt => nativeRemoteSourceClientForAttempt(getBroker(), attempt),
    sourceClientForManagement: reference => nativeRemoteSourceClientForManagement(getBroker(), reference) });
  let closingOwner;
  const closeOwner = () => closingOwner ??= owner.close().finally(() => endpointOwners.delete(closeOwner));
  endpointOwners.add(closeOwner);
  child.once('close', () => { void closeOwner(); });
  const backchannel = createNativeRemoteHostBackchannel({ child, serverId: targetId,
    assertSourceOwner: assertSourceNativeChild,
    handleOwnedRequest: context => owner.handleOwnedRequest(context),
    reply: message => getBroker().writeRaw(JSON.stringify(message), null) });
  const peer = createAgentMessageRouterBackchannel({ child, serverId: targetId, getBroker,
    getRouter: () => getAgentMessageRouter?.(), assertSourceOwner: assertSourceNativeChild,
    reply: message => getBroker().safeWriteMessage(message) });
  const channel = Object.freeze({
    receiveBackend: message => peer.receiveBackend(message) || backchannel.receiveBackend(message),
    close() { peerParents.delete(channel); peer.close(); backchannel.close(); void closeOwner(); },
  });
  // A verified local component can host Peer RPC without a retention parent.
  // Keep the original process and image checks live for forward requests too.
  peerParents.set(channel, broker => {
    if (!broker || getBroker() !== broker) return false;
    assertSourceNativeChild({ child: broker.child, serverId: broker.serverId });
    return true;
  });
  return channel;
}
