import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { agentMessageId, AGENT_MESSAGE_RECEIPTS_CAPABILITY, validAgentMessageAddress } from '../shared/agentMessageMethods.mjs';
import { acquireAgentMessageRouteLease } from './broker-agent-message-route-lease.js';
import { requireCapturedPeerOperationOwner } from './remotes/source-client-owner.mjs';
import { readSessionAtEndpoint, SESSION_READ_CAPABILITY } from './agent-message-router-session-read.js';
import { listAgentMessageReceipts } from './agent-message-router-receipts.js';
import { listWakeTargets } from './agent-message-router-wake-targets.js';
import { ROUTER_METHODS as methods, WAKE_READ_CAPABILITY, identityContains,
  requireRouter, requireRouterOperation, requireRouterReceipt, requireSameOperation, routeProof, routerOperationId, sameAddress } from './agent-message-router-private.js';

/** A pending Native wake read can address only the two threads of its original operation. */
export async function readForOriginalWake({ broker, requestId, attempt, kind, payload, verifyCaller }, {
  endpoints, nativeRequest, endpointFeatureCapabilities, findOwner, operationEndpoint, verifyOriginalOperation, now, wakeDiscoveryCursors,
}) {
  verifyCaller();
  const held = [...endpoints].find(endpoint => endpoint.broker === broker && (() => {
    try { endpoint.verify(); return true; } catch { return false; }
  })());
  requireRouter(held && (await endpointFeatureCapabilities(held)).has(WAKE_READ_CAPABILITY), 'AGENT_MESSAGES_NATIVE_SOURCE_UNAVAILABLE');
  const localProof = routeProof(held.identity, held.identity, randomUUID());
  const challenge = { requestId, attempt, kind, payload };
  const verifyNativeRead = async () => {
    verifyCaller();
    const origin = await nativeRequest(held, methods.sourceCheckWakeRead, challenge, localProof);
    verifyCaller();
    requireRouter(validAgentMessageAddress(origin?.sender) && validAgentMessageAddress(origin.recipient) &&
      origin.recipient.threadId === attempt.threadId && identityContains(held.identity, origin.recipient) &&
      agentMessageId(origin.messageId) && agentMessageId(origin.clientMessageId) && /^[a-f0-9]{64}$/.test(origin.bodySha256),
    'AGENT_MESSAGES_NATIVE_ATTEMPT_CHANGED');
    return origin;
  };
  const origin = await verifyNativeRead();
  const owner = findOwner(origin.sender, routerOperationId(origin.sender, origin.clientMessageId));
  requireRouter(owner, 'AGENT_MESSAGES_ORIGINAL_OWNER_UNAVAILABLE');
  requireCapturedPeerOperationOwner(owner);
  const original = owner.operation;
  requireRouter(sameAddress(original.sourceAddress, origin.sender) && sameAddress(original.destination, origin.recipient) &&
    original.attestation.claims.mode === 'wake_if_idle' && original.bodySha256 === origin.bodySha256 &&
    isDeepStrictEqual(owner.destinationIdentity, held.identity), 'AGENT_MESSAGES_ORIGINAL_RECEIPT_UNKNOWN');
  const verify = () => { verifyCaller(); requireCapturedPeerOperationOwner(owner); held.verify(); };
  const checkOriginal = () => verifyOriginalOperation({ destinationBroker: broker, attestation: original.attestation, access: 'wake', verifyCaller: verify });
  const verifyWake = async () => {
    verify();
    await checkOriginal();
    requireRouter(isDeepStrictEqual(await verifyNativeRead(), origin), 'AGENT_MESSAGES_NATIVE_ATTEMPT_CHANGED');
    verify();
  };
  const currentOriginal = await checkOriginal();
  verify();
  const receiving = await operationEndpoint(owner, 'destination', verify);
  requireRouter(receiving.broker === broker, 'AGENT_MESSAGES_DESTINATION_HOLDER_MISMATCH');
  const forward = routeProof(owner.sourceIdentity, owner.destinationIdentity, randomUUID());
  const reverse = routeProof(owner.destinationIdentity, owner.sourceIdentity, randomUUID());
  const incoming = await nativeRequest(receiving, methods.queryOriginal,
    { attestation: original.attestation, query: { clientMessageId: origin.clientMessageId } }, forward);
  requireRouter(incoming && Object.keys(incoming).length === 1 && Object.hasOwn(incoming, 'receipt'));
  requireRouterReceipt(incoming?.receipt, original);
  requireSameOperation(currentOriginal, { ...currentOriginal, stage: 'receipted', receipt: incoming.receipt });
  requireRouter(incoming.receipt.status === 'applied' && incoming.receipt.messageId === origin.messageId,
    'AGENT_MESSAGES_ORIGINAL_RECEIPT_UNKNOWN');
  const peer = await operationEndpoint(owner, 'source', verify);
  const lease = acquireAgentMessageRouteLease(peer.broker);
  const check = async () => { lease.verify(); verify(); await owner.checkCurrentAuthority(); lease.verify(); verify(); };
  const own = (method, params) => nativeRequest(receiving, method, params, localProof);
  const other = (method, params) => nativeRequest(peer, method, params, reverse);
  const assertOwnOperation = row => requireRouterOperation(row, owner.destinationIdentity, origin.recipient);
  const endpointForReceipt = operation => {
    if (identityContains(held.identity, operation.destination)) return own;
    requireRouter(sameAddress(operation.destination, origin.sender), 'AGENT_MESSAGES_TARGET_NOT_AUTHORIZED');
    return other;
  };
  const checkReceipt = (operation, receipt) => {
    requireRouterReceipt(receipt, operation);
    requireSameOperation(operation, { ...operation, stage: 'receipted', receipt });
  };
  try {
    await check();
    const features = await endpointFeatureCapabilities(peer);
    let result;
    if (kind === 'read') {
      requireRouter(sameAddress(payload.targetAddress, origin.sender), 'AGENT_MESSAGES_TARGET_NOT_AUTHORIZED');
      requireRouter(features.has(SESSION_READ_CAPABILITY), 'AGENT_MESSAGES_SESSION_READ_UNSUPPORTED');
      result = await readSessionAtEndpoint({ sourceThreadId: attempt.threadId, verify }, payload, { request: other, verify });
    } else if (kind === 'targets') {
      return await listWakeTargets({ cursors: wakeDiscoveryCursors, now, owner, broker, attempt, origin, query: payload,
        localIdentity: receiving.identity, peerSupported: features.has(WAKE_READ_CAPABILITY),
        readLocal: (query, authorizationId) => nativeRequest(receiving, methods.targets,
          { sourceThreadId: attempt.threadId, ...query }, routeProof(receiving.identity, receiving.identity, authorizationId)),
        readPeer: query => nativeRequest(peer, methods.sourceWakeReadTarget, { attestation: original.attestation, query }, forward),
        verify: async () => { await verifyWake(); await check(); },
      });
    } else if (kind === 'get') {
      const row = await own(methods.sourceFind, { sourceThreadId: attempt.threadId, query: payload });
      if (row == null) {
        requireRouter(!payload.messageId, 'AGENT_MESSAGES_ORIGINAL_OPERATION_UNKNOWN');
        result = { receipt: null };
      } else {
        const operation = assertOwnOperation(row);
        const reader = endpointForReceipt(operation);
        requireRouter((!payload.clientMessageId || payload.clientMessageId === operation.attestation.claims.clientMessageId) &&
          (!payload.messageId || payload.messageId === operation.receipt?.messageId), 'AGENT_MESSAGES_ORIGINAL_OPERATION_UNKNOWN');
        if (operation.stage === 'prepared') result = { receipt: null };
        else {
          const value = await reader(methods.queryOriginal, { attestation: operation.attestation, query: payload });
          requireRouter(value && Object.keys(value).length === 1 && Object.hasOwn(value, 'receipt'));
          checkReceipt(operation, value.receipt);
          result = { receipt: value.receipt };
        }
      }
    } else {
      requireRouter(kind === 'listReceipts', 'AGENT_MESSAGES_INVALID_REQUEST');
      result = await listAgentMessageReceipts({ query: payload, verify: check, validateOperation: assertOwnOperation,
        fetchPage: query => own(methods.sourceList, { sourceThreadId: attempt.threadId, query }),
        refresh: async operation => {
          const reader = endpointForReceipt(operation);
          requireRouter(reader !== other || features.has(AGENT_MESSAGE_RECEIPTS_CAPABILITY), 'AGENT_MESSAGES_RECEIPTS_UNSUPPORTED');
          const value = await reader(methods.queryOriginalDetails, { attestation: operation.attestation,
            query: { clientMessageId: operation.attestation.claims.clientMessageId } });
          if (value?.receipt) checkReceipt(operation, value.receipt);
          else requireRouter(!operation.receipt, 'AGENT_MESSAGES_ORIGINAL_RECEIPT_UNKNOWN');
          return value;
        } });
    }
    await verifyWake(); await check();
    return result;
  } finally { lease.release(); }
}
