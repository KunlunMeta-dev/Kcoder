import { endpointFeatureCapabilities as readEndpointFeatureCapabilities } from './agent-message-router-capabilities.js';
import { listAgentMessageReceipts } from './agent-message-router-receipts.js';
import { acquireAgentMessageRouteLease } from './broker-agent-message-route-lease.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { WorkspaceAppServerBroker } from './workspace-app-server-broker.js';
import { capturePeerReplyOperationOwner, requireCapturedNativeRemoteSourceClient, requireCapturedPeerOperationOwner } from './remotes/source-client-owner.mjs';
import { isTargetWorkspaceAbsolute } from './remotes/target-workspace-path.mjs';
import { AGENT_MESSAGE_METHODS, AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY, AGENT_MESSAGE_TARGET_FILTER_FIELDS,
  agentMessageDiscoveryRequiresSearch, agentMessageDiscoveryErrorData, agentMessageTargetQuery, validAgentMessageTargetQuery,
  AGENT_MESSAGE_RECEIPTS_CAPABILITY, AGENT_MESSAGE_REPLIES_CAPABILITY, agentMessageReceiptQuery, validAgentMessageReceiptQuery, agentMessageReceiptErrorData,
  agentMessageId, validAgentMessageAddress, validAgentMessageRequest, validAgentMessageTargetSelector } from '../shared/agentMessageMethods.mjs';
import { isContract } from '../shared/generated/validator.mjs';
import { agentMessageDiagnosticData } from '../shared/agentMessageReadDiagnostic.mjs';
import { NativeAgentMessageOutbox } from './agent-message-router-outbox.js';
import { readForOriginalWake } from './agent-message-router-wake-read.js';
import { SESSION_READ_CAPABILITY, routeSessionRead, sessionReadUnsupported } from './agent-message-router-session-read.js';
import { ROUTER_METHODS, AgentMessageRouterError, identityContains, requireRouter, requireRouterOperation, requireRouterReceipt,
  requireSameOperation, routeProof, routerIdentity, routerOperationId, sameAddress, messageBodySha256 } from './agent-message-router-private.js';

const handles = new WeakMap();
const MAX_ENDPOINTS = 128;
const MAX_CURSORS = 128;
const CURSOR_TTL_MS = 120_000;
const MAX_EMPTY_DISCOVERY_PAGES = 256;
const MAX_NATIVE_DISCOVERY_BYTES = 96 * 1024;
const MAX_GATEWAY_DISCOVERY_BYTES = 112 * 1024;
const UNAVAILABLE_DISCOVERY_ENDPOINT = new Set(['AGENT_MESSAGES_NATIVE_RESULT_UNCONFIRMED',
  'AGENT_MESSAGES_ROUTER_UNSUPPORTED', 'AGENT_MESSAGES_ENDPOINT_UNAVAILABLE', 'AGENT_MESSAGES_ENDPOINT_CHANGED']);
const principalId = identity => identity?.principalId ?? null;
const addressFor = (identity, threadId) => Object.freeze({ targetId: identity.targetId, workspaceId: identity.workspaceId, threadId });
const samePhysicalIdentity = (a, b) => a.targetId === b.targetId && a.workspaceId === b.workspaceId &&
  a.identityEpoch === b.identityEpoch && isDeepStrictEqual(a.publicKey, b.publicKey);
const publicError = (error, method) => {
  const readData = method === ROUTER_METHODS.targets ? agentMessageDiscoveryErrorData(error) :
    method === ROUTER_METHODS.sourceList ? agentMessageReceiptErrorData(error) : undefined;
  const message = readData ? { cursor_invalid: 'AGENT_MESSAGES_CURSOR_INVALID',
    cursor_filter_mismatch: 'AGENT_MESSAGES_CURSOR_FILTER_MISMATCH', search_unsupported: 'AGENT_MESSAGES_DISCOVERY_SEARCH_UNSUPPORTED', receipts_unsupported: 'AGENT_MESSAGES_RECEIPTS_UNSUPPORTED' }[readData.reason] :
    error?.code === -32601 ? 'AGENT_MESSAGES_ROUTER_UNSUPPORTED' : 'AGENT_MESSAGES_NATIVE_RESULT_UNCONFIRMED';
  const code = ['search_unsupported', 'receipts_unsupported'].includes(readData?.reason) ? -32601 : readData && [-32601, -32602].includes(error?.code) ? error.code :
    error?.code === -32601 ? -32601 : -32034;
  return Object.assign(new AgentMessageRouterError(message, code),
    method === ROUTER_METHODS.targets ? { data: readData ?? agentMessageDiagnosticData(error) } :
      method === ROUTER_METHODS.sourceList && readData ? { data: readData } : {});
};

/** Composition-root service. Catalog aliases are never Native identity grants.
 * Endpoint factories must reuse the real authenticated target broker factory;
 * all target/account/session fences below are checked around every await.
 */
export function createAgentMessageRouter({ getTarget, targetSignature, loginContexts,
  listEndpointCandidates, openEndpoint, authenticatePeer, now = Date.now } = {}) {
  if (typeof getTarget !== 'function' || typeof targetSignature !== 'function' ||
      typeof loginContexts?.identity !== 'function' || typeof loginContexts?.generation !== 'function')
    throw new TypeError('Agent message router requires live Gateway target/account stores');
  const endpoints = new Set();
  const cursors = new Map();
  const flights = new Map();
  const operationOwners = new Map();
  const wakeDiscoveryCursors = new Map();
  const receiptsByOperation = new Map();
  const peerEndpoints = new WeakMap();
  const routerOwner = {};
  const requireHandle = handle => {
    const source = handles.get(handle);
    requireRouter(source?.routerOwner === routerOwner, 'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
    source.verify();
    return source;
  };
  const verifyPrincipal = (target, identity, authorizationOwner) => {
    const current = loginContexts.identity(authorizationOwner, target.id);
    if (target.security) requireRouter(identity.principal.kind === 'verifiedAccount' &&
      identity.principal.principalId === current?.principalId, 'AGENT_MESSAGES_ACCOUNT_CHANGED');
    else requireRouter(identity.principal.kind === 'localOs', 'AGENT_MESSAGES_ACCOUNT_CHANGED');
  };
  const nativeRequest = async (endpoint, method, params, proof) => {
    endpoint.verify();
    await endpoint.broker?.peerSshTransport?.revalidate?.(); endpoint.verify();
    const response = endpoint.requestPrivate ? await endpoint.requestPrivate(method, params, proof) :
      await endpoint.broker.sendAgentMessageRouterRequest(method, params, proof);
    endpoint.verify();
    await endpoint.broker?.peerSshTransport?.revalidate?.(); endpoint.verify();
    if (!response || response.error || !Object.hasOwn(response, 'result')) throw publicError(response?.error, method);
    if (method === ROUTER_METHODS.identity && endpoint.broker?.peerSshTransport)
      endpoint.broker.peerSshTransport.verifyIdentity(routerIdentity(response.result));
    return response.result;
  };
  const endpointFeatureCapabilities = endpoint => readEndpointFeatureCapabilities(endpoint, nativeRequest);
  async function requireEndpointFeature(endpoint, capability) {
    const features = await endpointFeatureCapabilities(endpoint);
    endpoint.verify();
    if (!features.has(capability)) throw capability === SESSION_READ_CAPABILITY ? sessionReadUnsupported() :
      new AgentMessageRouterError(capability === AGENT_MESSAGE_RECEIPTS_CAPABILITY ?
        'AGENT_MESSAGES_RECEIPTS_UNSUPPORTED' : 'AGENT_MESSAGES_REPLIES_UNSUPPORTED', -32601);
  }
  async function capabilitiesForSource(handle) {
    const source = requireHandle(handle); await source.checkCurrentAuthority(); source.verify();
    const features = await endpointFeatureCapabilities(source.endpoint);
    await source.checkCurrentAuthority(); source.verify();
    return { receipts: features.has(AGENT_MESSAGE_RECEIPTS_CAPABILITY), replies: features.has(AGENT_MESSAGE_REPLIES_CAPABILITY) };
  }
  async function registerEndpoint({ broker, serverId, workspacePath, authorizationOwner }) {
    requireRouter(broker instanceof WorkspaceAppServerBroker && !broker.closed && broker.serverId === serverId &&
      typeof authorizationOwner === 'string' && authorizationOwner.length > 0, 'AGENT_MESSAGES_ENDPOINT_UNAVAILABLE');
    const target = getTarget(serverId);
    requireRouter(target?.runtime === 'kcoder', 'AGENT_MESSAGES_ENDPOINT_UNAVAILABLE');
    requireRouter(typeof workspacePath === 'string' && Buffer.byteLength(workspacePath) <= 32768 &&
      !/[\p{Cc}]/u.test(workspacePath) && isTargetWorkspaceAbsolute(target, workspacePath), 'AGENT_MESSAGES_WORKSPACE_UNKNOWN');
    if (target.security) requireRouter(broker.loginOwner === authorizationOwner, 'AGENT_MESSAGES_ACCOUNT_CHANGED');
    const signature = targetSignature(target);
    requireRouter(broker.agentMessageTargetSignature === signature, 'AGENT_MESSAGES_ENDPOINT_CHANGED');
    const generation = loginContexts.generation(authorizationOwner, serverId);
    const principal = principalId(loginContexts.identity(authorizationOwner, serverId));
    if (target.security) requireRouter(broker.agentMessageAccountGeneration === generation, 'AGENT_MESSAGES_ACCOUNT_CHANGED');
    const verify = () => {
      const current = getTarget(serverId);
      requireRouter(!broker.closed && !broker.idleShutdown.closing && broker.serverId === serverId && current && targetSignature(current) === signature &&
        loginContexts.generation(authorizationOwner, serverId) === generation &&
        principalId(loginContexts.identity(authorizationOwner, serverId)) === principal &&
        (!current.security || broker.loginOwner === authorizationOwner && principal !== null &&
          broker.agentMessageAccountGeneration === generation),
      'AGENT_MESSAGES_ENDPOINT_CHANGED');
      if (broker.peerSshTransport) broker.peerSshTransport.assertCurrent();
      requireRouter(broker.supportsAgentMessageRouter(), 'AGENT_MESSAGES_ROUTER_UNSUPPORTED');
    };
    verify();
    const endpoint = { broker, serverId, workspacePath, authorizationOwner, signature, generation, verify };
    endpoint.identity = routerIdentity(await nativeRequest(endpoint, ROUTER_METHODS.identity, {}));
    verifyPrincipal(target, endpoint.identity, authorizationOwner); verify();
    // Keep only held process identities, never an allow verdict. Closed/replaced
    // brokers are removed without signalling or disposing any peer resources.
    for (const old of endpoints) {
      try { old.verify(); } catch { endpoints.delete(old); continue; }
      if (old.broker === broker && old.authorizationOwner === authorizationOwner) {
        requireRouter(isDeepStrictEqual(old.identity, endpoint.identity) && old.workspacePath === workspacePath,
          'AGENT_MESSAGES_ENDPOINT_CHANGED');
        return old;
      }
    }
    requireRouter(endpoints.size < MAX_ENDPOINTS, 'AGENT_MESSAGES_ENDPOINT_LIMIT');
    endpoints.add(endpoint);
    return endpoint;
  }
  function authorizedEndpoint(source, endpoint) {
    source.verify(); endpoint.verify();
    requireRouter(endpoint.authorizationOwner === source.authorizationOwner &&
      source.session.allowedServerIds?.has(endpoint.serverId), 'AGENT_MESSAGES_TARGET_NOT_AUTHORIZED');
    verifyPrincipal(getTarget(endpoint.serverId), endpoint.identity, source.authorizationOwner);
  }
  async function refreshEndpoint(source, endpoint) {
    authorizedEndpoint(source, endpoint);
    const actual = routerIdentity(await nativeRequest(endpoint, ROUTER_METHODS.identity, {}));
    authorizedEndpoint(source, endpoint);
    requireRouter(isDeepStrictEqual(actual, endpoint.nativeIdentity ?? endpoint.identity) &&
      samePhysicalIdentity(actual, endpoint.identity), 'AGENT_MESSAGES_ENDPOINT_CHANGED');
    return endpoint;
  }
  async function candidateEndpoints(source, targetId) {
    source.verify();
    let complete = false;
    let issues = 0;
    if (typeof listEndpointCandidates === 'function') {
      const enumeration = await listEndpointCandidates({ authorizationOwner: source.authorizationOwner,
        allowedServerIds: new Set(source.session.allowedServerIds),
        isTargetAllowed: id => source.session.allowedServerIds?.has(id) === true, verify: source.verify });
      source.verify();
      requireRouter(enumeration && Array.isArray(enumeration.entries) && enumeration.entries.length <= MAX_ENDPOINTS,
        'AGENT_MESSAGES_ENDPOINT_ENUMERATION_UNKNOWN');
      complete = enumeration.completeness === 'complete';
      for (const candidate of enumeration.entries) {
        source.verify();
        if (!source.session.allowedServerIds?.has(candidate?.serverId)) continue;
        try {
          let endpoint;
          if (candidate.broker) endpoint = await registerEndpoint({ ...candidate, authorizationOwner: source.authorizationOwner });
          else {
            requireRouter(typeof openEndpoint === 'function', 'AGENT_MESSAGES_ENDPOINT_UNAVAILABLE');
            const target = getTarget(candidate.serverId);
            requireRouter(target?.runtime === 'kcoder', 'AGENT_MESSAGES_ENDPOINT_UNAVAILABLE');
            const signature = targetSignature(target);
            const generation = loginContexts.generation(source.authorizationOwner, candidate.serverId);
            const verify = () => {
              source.verify();
              const current = getTarget(candidate.serverId);
              requireRouter(source.session.allowedServerIds?.has(candidate.serverId) && current &&
                targetSignature(current) === signature && loginContexts.generation(source.authorizationOwner, candidate.serverId) === generation,
              'AGENT_MESSAGES_ENDPOINT_CHANGED');
            };
            verify();
            const opened = await openEndpoint({ target, serverId: candidate.serverId, workspacePath: candidate.workspacePath,
              authorizationOwner: source.authorizationOwner, verify });
            verify();
            endpoint = await registerEndpoint({ ...opened, serverId: candidate.serverId,
              workspacePath: opened.workspacePath ?? candidate.workspacePath, authorizationOwner: source.authorizationOwner });
          }
          authorizedEndpoint(source, endpoint);
        } catch {
          source.verify(); issues++; complete = false;
        }
      }
    }
    const result = [];
    const seen = new Map();
    for (const endpoint of endpoints) {
      try { authorizedEndpoint(source, endpoint); } catch { continue; }
      if (targetId != null && endpoint.identity.targetId !== targetId) continue;
      const key = JSON.stringify([endpoint.identity.targetId, endpoint.identity.workspaceId]);
      const previous = seen.get(key);
      if (previous) {
        requireRouter(isDeepStrictEqual(previous.identity, endpoint.identity), 'AGENT_MESSAGES_IDENTITY_AMBIGUOUS');
        continue;
      }
      seen.set(key, endpoint); result.push(endpoint);
    }
    result.sort((a, b) => JSON.stringify([a.identity.targetId, a.identity.workspaceId]).localeCompare(
      JSON.stringify([b.identity.targetId, b.identity.workspaceId])));
    source.verify();
    return { entries: result, complete, issues };
  }
  async function destinationFor(source, address) {
    requireRouter(validAgentMessageAddress(address), 'AGENT_MESSAGES_INVALID_ADDRESS');
    source.verify();
    let matches = [...endpoints].filter(endpoint => {
      if (!identityContains(endpoint.identity, address) || endpoint.authorizationOwner !== source.authorizationOwner ||
          !source.session.allowedServerIds?.has(endpoint.serverId)) return false;
      // An exited process is a stale locator, not a reason to skip the live
      // authorized factory for this original canonical destination.
      try { endpoint.verify(); return true; } catch { return false; }
    });
    source.verify();
    if (!matches.length) matches = (await candidateEndpoints(source)).entries.filter(endpoint => identityContains(endpoint.identity, address));
    requireRouter(matches.length > 0, 'AGENT_MESSAGES_DESTINATION_UNAVAILABLE');
    const eligible = [];
    for (const endpoint of matches) {
      try { authorizedEndpoint(source, endpoint); eligible.push(endpoint); } catch { /* No cached allow. */ }
    }
    requireRouter(eligible.length > 0, 'AGENT_MESSAGES_DESTINATION_UNAVAILABLE');
    requireRouter(eligible.every(endpoint => isDeepStrictEqual(endpoint.identity, eligible[0].identity)),
      'AGENT_MESSAGES_IDENTITY_AMBIGUOUS');
    const endpoint = await refreshEndpoint(source, eligible[0]);
    let lease;
    const verify = () => { lease?.verify(); authorizedEndpoint(source, endpoint); };
    return { ...endpoint, verify, acquire() {
      verify();
      requireRouter(!lease, 'AGENT_MESSAGES_REQUEST_CAPACITY');
      lease = acquireAgentMessageRouteLease(endpoint.broker);
      return lease.release;
    },
      request: async (method, params) => {
        verify(); await source.checkCurrentAuthority(); verify();
        const result = await nativeRequest(endpoint, method, params,
          routeProof(source.endpoint.identity, endpoint.identity, source.authorizationId));
        verify(); await source.checkCurrentAuthority(); verify(); return result;
      } };
  }
  async function captureAuthority(authority, verifySource) {
    const { broker, authorizationOwner, session, sourceThreadId, workspacePath } = authority;
    requireRouter(agentMessageId(sourceThreadId) && session?.allowedServerIds instanceof Set,
      'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
    const sourceSession = authority.currentAllowedServerIds ? {
      get allowedServerIds() { return authority.currentAllowedServerIds(); },
    } : session;
    const source = { routerOwner, broker, authorizationOwner, session: sourceSession, sourceThreadId,
      capturePeerOperationOwner: authority.capturePeerOperationOwner,
      authorizationId: randomUUID() };
    source.verify = () => {
      verifySource();
      requireRouter(sourceSession.allowedServerIds?.has(broker.serverId), 'AGENT_MESSAGES_SOURCE_NOT_AUTHORIZED');
      source.endpoint?.verify();
    };
    source.checkCurrentAuthority = async () => {
      source.verify();
      await authority.checkCurrentAuthority?.();
      source.verify();
    };
    source.verify();
    source.endpoint = authority.endpoint ?? await registerEndpoint({ broker, serverId: broker.serverId, workspacePath, authorizationOwner });
    source.messagingAvailable = () => {
      source.verify();
      const capabilities = broker.initializeResponse?.result?.capabilities?.experimental;
      return capabilities?.crossSessionMessagesV1 === true && capabilities?.peerAgentMessagesV1 === true &&
        (!authority.client || authority.client.crossSessionMessagesV1 === true && authority.client.peerAgentMessagesV1 === true);
    };
    source.verify(); authorizedEndpoint(source, source.endpoint);
    source.address = addressFor(source.endpoint.identity, sourceThreadId);
    const handle = Object.freeze({});
    source.bindingHandle = handle;
    source.persistentVerify = source.verify;
    handles.set(handle, source);
    return handle;
  }
  function guardSource(handle, verify) {
    const source = requireHandle(handle);
    requireRouter(typeof verify === 'function', 'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
    const guarded = { ...source, verify: () => {
      source.verify();
      const result = verify();
      requireRouter(result !== false && typeof result?.then !== 'function', 'AGENT_MESSAGES_AUTHORIZATION_CHANGED');
    } };
    guarded.verify();
    const guardedHandle = Object.freeze({});
    handles.set(guardedHandle, guarded);
    return guardedHandle;
  }
  async function captureClient({ broker, client, session, verifySession, sourceThreadId, workspacePath }) {
    requireRouter(typeof verifySession === 'function' && broker instanceof WorkspaceAppServerBroker,
      'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
    const owner = requireCapturedNativeRemoteSourceClient(client?.nativeRemoteSourceOwner);
    const authorizationOwner = client.authorizationOwner;
    const verify = () => {
      owner.verify();
      requireRouter(verifySession() === true && !broker.closed && client.initialized && broker.clients.has(client) &&
        client.authorizationOwner === authorizationOwner && !client.nativeManagementOnly &&
        !broker.ephemeralThreadOwners.has(sourceThreadId) &&
        (broker.threadOwners.get(sourceThreadId) === client || broker.sharedThreads.has(sourceThreadId, client)),
      'AGENT_MESSAGES_SOURCE_OWNER_REQUIRED');
    };
    return captureAuthority({ broker, client, session, authorizationOwner, sourceThreadId, workspacePath,
      capturePeerOperationOwner: args => owner.capturePeerOperationOwner(args),
      checkCurrentAuthority: () => owner.checkCurrentAuthority(),
      currentAllowedServerIds: () => owner.currentAllowedServerIds() }, verify);
  }
  async function registerAuthenticatedPeerEndpoint(authority) {
    const { requireAuthenticatedPeerSourceAuthority } = await import('./agent-message-peer-authority.js');
    requireAuthenticatedPeerSourceAuthority(authority);
    authority.verifyCurrentDeviceGrant();
    const selector = Object.freeze({ ...authority.sourceSelector() });
    const auth = authority.currentAccountAuthorization();
    requireRouter(agentMessageId(selector.threadId) && auth && typeof auth.verifySession === 'function' &&
      auth.verifySession() === true && auth.session?.allowedServerIds?.has(selector.serverId),
    'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
    const nativeOwner = requireCapturedNativeRemoteSourceClient(auth.nativeRemoteSourceOwner);
    const catalog = await registerEndpoint({ broker: auth.broker, serverId: selector.serverId,
      workspacePath: auth.broker.initializeResponse?.result?.cwd ?? selector.workspacePath,
      authorizationOwner: auth.authorizationOwner });
    const nativeIdentity = routerIdentity(await authority.identity());
    requireRouter(samePhysicalIdentity(nativeIdentity, catalog.identity), 'AGENT_MESSAGES_PEER_IDENTITY_MISMATCH');
    const verify = () => {
      requireAuthenticatedPeerSourceAuthority(authority); authority.verifyCurrentDeviceGrant(); nativeOwner.verify(); catalog.verify();
      const current = authority.currentAccountAuthorization();
      const selected = authority.sourceSelector();
      requireRouter(current.authorizationOwner === auth.authorizationOwner && current.broker === auth.broker &&
        current.verifySession() === true && current.session.allowedServerIds?.has(selector.serverId) &&
        selected.serverId === selector.serverId && selected.threadId === selector.threadId &&
        selected.workspacePath === selector.workspacePath, 'AGENT_MESSAGES_PEER_SOURCE_CHANGED');
    };
    verify();
    const sourceMethods = new Set([ROUTER_METHODS.sourcePrepare, ROUTER_METHODS.sourceRead, ROUTER_METHODS.sourceFind, ROUTER_METHODS.sourceList,
      ROUTER_METHODS.sourceMarkDispatch, ROUTER_METHODS.sourceRecordReceipt, ROUTER_METHODS.sourceCheckOriginal]);
    const endpoint = { ...catalog, nativeIdentity, identity: catalog.identity, verify,
      requestPrivate: (method, params, proof) => {
        verify();
        // Preserve the actual Runtime identity. Logical account ownership was
        // derived from the real catalog login, never from Runtime JSON labels.
        const nativeProof = proof === undefined ? undefined : sourceMethods.has(method) ?
          routeProof(nativeIdentity, proof.destination, proof.authorizationId) :
          routeProof(proof.source, nativeIdentity, proof.authorizationId);
        return authority.requestPrivate(method, params, nativeProof);
      } };
    const handle = Object.freeze({});
    peerEndpoints.set(handle, { authority, selector, auth, nativeOwner, endpoint, verify });
    return handle;
  }
  async function captureAuthenticatedPeer(peer) {
    let entry = peerEndpoints.get(peer);
    if (!entry && typeof authenticatePeer === 'function') {
      const enrolled = await registerAuthenticatedPeerEndpoint(await authenticatePeer(peer));
      entry = peerEndpoints.get(enrolled);
    }
    requireRouter(entry, 'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
    const { authority, selector, auth, nativeOwner, endpoint } = entry;
    const verify = () => {
      entry.verify();
      requireRouter(authority.ownsSource(selector.threadId) === true, 'AGENT_MESSAGES_SOURCE_OWNER_REQUIRED');
    };
    return captureAuthority({ broker: auth.broker, endpoint, authorizationOwner: auth.authorizationOwner, session: auth.session,
      sourceThreadId: selector.threadId, workspacePath: endpoint.workspacePath,
      capturePeerOperationOwner: args => nativeOwner.capturePeerOperationOwner(args),
      checkCurrentAuthority: () => nativeOwner.checkCurrentAuthority(),
      currentAllowedServerIds: () => nativeOwner.currentAllowedServerIds() }, verify);
  }
  function identityForSource(handle) {
    const source = requireHandle(handle);
    return { ...source.address };
  }
  const operationKey = (address, operationId) => JSON.stringify([address.targetId, address.workspaceId, address.threadId, operationId]);
  function forgetReceipt(key) {
    receiptsByOperation.delete(key);
  }
  // A receipt ID is only a bounded locator. Every use still reads the original
  // Native receipt and rechecks the current operation and account permissions.
  function rememberReceipt(owner, receipt) {
    requireCapturedPeerOperationOwner(owner);
    requireRouterReceipt(receipt, owner.operation);
    const key = operationKey(owner.operation.sourceAddress, owner.operation.operationId);
    const previous = receiptsByOperation.get(key);
    requireRouter(!previous || previous === receipt.messageId, 'AGENT_MESSAGES_RECEIPT_MISMATCH');
    if (previous) return;
    if (receiptsByOperation.size >= 256) forgetReceipt(receiptsByOperation.keys().next().value);
    receiptsByOperation.set(key, receipt.messageId);
  }
  function rememberSourceReceipt(address, clientMessageId, receipt) {
    // A locator must never change the result of an already completed send.
    try {
      const owner = operationOwners.get(operationKey(address, routerOperationId(address, clientMessageId)));
      if (owner) rememberReceipt(owner, receipt);
    } catch { /* Fall back to the current Native receipt scan. */ }
  }
  function pruneInvalidOperationOwners() {
    for (const [key, owner] of operationOwners) {
      try { requireCapturedPeerOperationOwner(owner); }
      catch { operationOwners.delete(key); forgetReceipt(key); }
    }
  }
  async function bindOperationOwner(source, operation, destination) {
    source.verify();
    const key = operationKey(operation.sourceAddress, operation.operationId);
    const existing = operationOwners.get(key);
    if (existing) {
      requireRouter(isDeepStrictEqual(existing.operation.attestation, operation.attestation), 'AGENT_MESSAGES_OPERATION_CONFLICT');
      try {
        requireCapturedPeerOperationOwner(existing);
        await existing.checkCurrentAuthority(); source.verify();
        return;
      } catch { /* A fresh real Source may reconcile this fixed accepted operation. */ }
    }
    requireRouter(typeof source.capturePeerOperationOwner === 'function', 'AGENT_MESSAGES_BACKGROUND_OWNER_UNAVAILABLE');
    destination ??= await destinationFor(source, operation.destination);
    source.verify(); destination.verify();
    const owner = requireCapturedPeerOperationOwner(await source.capturePeerOperationOwner({ operation,
      sourceIdentity: source.endpoint.identity, destinationIdentity: destination.identity,
      destinationServerId: destination.serverId, sourceWorkspacePath: source.endpoint.workspacePath,
      destinationWorkspacePath: destination.workspacePath }));
    pruneInvalidOperationOwners();
    requireRouter(operationOwners.has(key) || operationOwners.size < 256, 'AGENT_MESSAGES_OPERATION_OWNER_CAPACITY');
    operationOwners.set(key, owner);
  }
  async function operationEndpoint(owner, side, verifyCaller) {
    const verify = () => { verifyCaller?.(); requireCapturedPeerOperationOwner(owner); };
    const check = async () => { verify(); await owner.checkCurrentAuthority(); verify(); };
    await check();
    const selector = owner[side];
    const expected = side === 'source' ? owner.sourceIdentity : owner.destinationIdentity;
    let endpoint = [...endpoints].find(candidate => candidate.serverId === selector.serverId &&
      candidate.workspacePath === selector.workspacePath && candidate.authorizationOwner === owner.authorizationOwner &&
      isDeepStrictEqual(candidate.identity, expected) && (() => { try { candidate.verify(); return true; } catch { return false; } })());
    if (!endpoint) {
      requireRouter(typeof openEndpoint === 'function', 'AGENT_MESSAGES_ORIGINAL_ENDPOINT_UNAVAILABLE');
      const target = getTarget(selector.serverId);
      const opened = await openEndpoint({ target, serverId: selector.serverId, workspacePath: selector.workspacePath,
        authorizationOwner: owner.authorizationOwner, verify });
      await check();
      endpoint = await registerEndpoint({ ...opened, serverId: selector.serverId,
        workspacePath: opened.workspacePath ?? selector.workspacePath, authorizationOwner: owner.authorizationOwner });
      await check();
    }
    const actual = routerIdentity(await nativeRequest(endpoint, ROUTER_METHODS.identity, {}));
    await check();
    requireRouter(isDeepStrictEqual(actual, expected), 'AGENT_MESSAGES_ORIGINAL_ENDPOINT_CHANGED');
    return endpoint;
  }
  /** Only the actual destination's owned Native backchannel may call this.
   * The stored operation owner permits this one immutable check, never a new
   * send/discovery, and remains tied to live authentication after UI closure.
   */
  async function verifyOriginalOperation({ destinationBroker, destinationPeerHandle, attestation, access, message, verifyCaller }) {
    requireRouter(['observe', 'append', 'wake'].includes(access) && typeof verifyCaller === 'function' &&
      validAgentMessageAddress(attestation?.claims?.sourceAddress) && agentMessageId(attestation?.claims?.operationId),
    'AGENT_MESSAGES_ORIGINAL_CHECK_INVALID');
    const owner = operationOwners.get(operationKey(attestation.claims.sourceAddress, attestation.claims.operationId));
    requireRouter(owner, 'AGENT_MESSAGES_ORIGINAL_OWNER_UNAVAILABLE');
    requireCapturedPeerOperationOwner(owner);
    requireRouter(isDeepStrictEqual(owner.operation.attestation, attestation), 'AGENT_MESSAGES_OPERATION_CONFLICT');
    if (message != null) {
      const claims = attestation.claims;
      requireRouter(message && typeof message === 'object' && !Array.isArray(message) &&
        Object.keys(message).every(key => ['clientMessageId', 'mode', 'expectedTurnId', 'replyToMessageId', 'text'].includes(key)) &&
        validAgentMessageRequest(AGENT_MESSAGE_METHODS.send, { sourceThreadId: claims.sourceAddress.threadId,
          message: { ...message, targetThreadId: claims.destination.threadId, targetAddress: claims.destination } }) &&
        message.clientMessageId === claims.clientMessageId && message.mode === claims.mode &&
        (message.expectedTurnId ?? null) === (claims.expectedTurnId ?? null) &&
        (message.replyToMessageId ?? null) === (claims.replyToMessageId ?? null) &&
        messageBodySha256(message.text) === claims.bodySha256, 'AGENT_MESSAGES_OPERATION_CONFLICT');
    }
    const verify = () => { verifyCaller(); requireCapturedPeerOperationOwner(owner); };
    const check = async () => { verify(); await owner.checkCurrentAuthority(); verify(); };
    await check();
    let destination;
    if (destinationPeerHandle) {
      const peer = peerEndpoints.get(destinationPeerHandle);
      requireRouter(peer, 'AGENT_MESSAGES_DESTINATION_HOLDER_UNAVAILABLE');
      peer.verify();
      requireRouter(peer.selector.threadId === attestation.claims.destination.threadId &&
        peer.authority.ownsSource(peer.selector.threadId) === true, 'AGENT_MESSAGES_DESTINATION_HOLDER_MISMATCH');
      const actual = routerIdentity(await nativeRequest(peer.endpoint, ROUTER_METHODS.identity, {}));
      peer.verify(); await check();
      requireRouter(isDeepStrictEqual(actual, peer.endpoint.nativeIdentity) && samePhysicalIdentity(actual, peer.endpoint.identity),
        'AGENT_MESSAGES_DESTINATION_HOLDER_MISMATCH');
      destination = peer.endpoint;
    } else {
      requireRouter(destinationBroker instanceof WorkspaceAppServerBroker && destinationBroker.supportsAgentMessageRouter(),
      'AGENT_MESSAGES_DESTINATION_HOLDER_UNAVAILABLE');
      const target = getTarget(destinationBroker.serverId);
      requireRouter(target, 'AGENT_MESSAGES_DESTINATION_HOLDER_UNAVAILABLE');
      destination = await registerEndpoint({ broker: destinationBroker, serverId: destinationBroker.serverId,
        workspacePath: destinationBroker.initializeResponse.result.cwd,
        authorizationOwner: target.security ? destinationBroker.loginOwner : owner.authorizationOwner });
      await check();
    }
    verify();
    requireRouter(isDeepStrictEqual(destination.identity, owner.destinationIdentity) &&
      identityContains(destination.identity, attestation.claims.destination), 'AGENT_MESSAGES_DESTINATION_HOLDER_MISMATCH');
    const sourceEndpoint = await operationEndpoint(owner, 'source', verifyCaller);
    await check(); destination.verify();
    const operation = requireRouterOperation(await nativeRequest(sourceEndpoint, ROUTER_METHODS.sourceCheckOriginal,
      { attestation, access, ...(message == null ? {} : { message }) }, routeProof(owner.sourceIdentity, destination.identity, randomUUID())),
    owner.sourceIdentity, owner.operation.sourceAddress);
    await check(); destination.verify();
    requireSameOperation(owner.operation, operation);
    requireRouter(operation.stage !== 'prepared', 'AGENT_MESSAGES_ORIGINAL_NOT_DISPATCHED');
    return operation;
  }

  /** Reply from the actual Native turn that received a previously admitted message. */
  async function sendBackgroundReply({ broker, attempt, message, verifyCaller }) {
    requireRouter(typeof verifyCaller === 'function' && broker instanceof WorkspaceAppServerBroker &&
      validAgentMessageRequest(AGENT_MESSAGE_METHODS.send, { sourceThreadId: attempt?.threadId, message }) &&
      message.replyToMessageId && message.targetAddress, 'AGENT_MESSAGES_INVALID_REQUEST');
    verifyCaller();
    const candidates = [...operationOwners.entries()].filter(([key, owner]) =>
      owner.destination.serverId === broker.serverId && owner.operation.destination.threadId === attempt.threadId &&
      sameAddress(owner.operation.sourceAddress, message.targetAddress) &&
      (!receiptsByOperation.has(key) || receiptsByOperation.get(key) === message.replyToMessageId)).map(([, owner]) => owner);
    let matched;
    for (const candidate of candidates) {
      verifyCaller();
      let endpoint, result;
      try {
        requireCapturedPeerOperationOwner(candidate);
        await candidate.checkCurrentAuthority();
        endpoint = await operationEndpoint(candidate, 'destination', verifyCaller);
        requireRouter(endpoint.broker === broker, 'AGENT_MESSAGES_DESTINATION_HOLDER_MISMATCH');
        const original = candidate.operation;
        result = await nativeRequest(endpoint, ROUTER_METHODS.queryOriginal,
          { attestation: original.attestation, query: { clientMessageId: original.attestation.claims.clientMessageId } },
          routeProof(candidate.sourceIdentity, candidate.destinationIdentity, randomUUID()));
        verifyCaller(); await candidate.checkCurrentAuthority();
      } catch {
        verifyCaller();
        continue;
      }
      const original = candidate.operation;
      if (!result?.receipt) continue;
      requireRouterReceipt(result.receipt, original);
      rememberReceipt(candidate, result.receipt);
      if (result.receipt.messageId !== message.replyToMessageId) continue;
      requireRouter(result.receipt.status === 'applied' && !matched, 'AGENT_MESSAGES_ORIGINAL_RECEIPT_UNKNOWN');
      matched = { owner: candidate, endpoint };
    }
    requireRouter(matched, 'AGENT_MESSAGES_ORIGINAL_OWNER_UNAVAILABLE');
    const { owner, endpoint } = matched;
    const sourceAddress = owner.operation.destination;
    const targetAddress = owner.operation.sourceAddress;
    const authorizationId = randomUUID();
    const verify = () => {
      verifyCaller(); requireCapturedPeerOperationOwner(owner); endpoint.verify();
    };
    const check = async () => {
      verify(); await owner.checkCurrentAuthority(); verify();
      const observed = await nativeRequest(endpoint, ROUTER_METHODS.sourceCheckReplyAttempt,
        { attempt, message }, routeProof(owner.destinationIdentity, owner.sourceIdentity, authorizationId));
      requireRouter(observed?.current === true && Object.keys(observed).length === 1,
        'AGENT_MESSAGES_NATIVE_ATTEMPT_CHANGED');
      verify(); await owner.checkCurrentAuthority(); verify();
    };
    await check();
    await requireEndpointFeature(endpoint, AGENT_MESSAGE_REPLIES_CAPABILITY);
    const intent = { clientMessageId: message.clientMessageId, mode: message.mode,
      ...(message.expectedTurnId == null ? {} : { expectedTurnId: message.expectedTurnId }),
      replyToMessageId: message.replyToMessageId, text: message.text };
    const replyOutbox = new NativeAgentMessageOutbox({
      sourceIdentity: owner.destinationIdentity, sourceAddress, verify,
      connectDestination: async address => {
        requireRouter(sameAddress(address, targetAddress), 'AGENT_MESSAGES_DESTINATION_CHANGED');
        await check();
        const destination = await operationEndpoint(owner, 'source', verifyCaller);
        await requireEndpointFeature(destination, AGENT_MESSAGE_REPLIES_CAPABILITY);
        let lease;
        const verifyDestination = () => { lease?.verify(); verify(); destination.verify(); };
        return { ...destination, verify: verifyDestination,
          acquire() {
            verifyDestination();
            requireRouter(!lease, 'AGENT_MESSAGES_REQUEST_CAPACITY');
            lease = acquireAgentMessageRouteLease(destination.broker);
            return lease.release;
          },
          async request(method, params) {
            await check(); verifyDestination();
            const value = await nativeRequest(destination, method, params,
              routeProof(owner.destinationIdentity, owner.sourceIdentity, authorizationId));
            await check(); verifyDestination(); return value;
          } };
      },
      requestSource: async (method, params, destination) => {
        await check(); destination?.verify();
        const value = await nativeRequest(endpoint, method, params,
          routeProof(owner.destinationIdentity, owner.sourceIdentity, authorizationId));
        await check(); destination?.verify(); return value;
      },
      onOperation: async operation => {
        await check();
        const captured = await capturePeerReplyOperationOwner(owner, operation, message.replyToMessageId);
        await check();
        const key = operationKey(operation.sourceAddress, operation.operationId);
        const existing = operationOwners.get(key);
        if (existing) requireSameOperation(existing.operation, operation);
        pruneInvalidOperationOwners();
        requireRouter(existing || operationOwners.size < 256, 'AGENT_MESSAGES_OPERATION_OWNER_CAPACITY');
        operationOwners.set(key, captured);
      },
    });
    const key = JSON.stringify([sourceAddress.targetId, sourceAddress.workspaceId, sourceAddress.threadId, message.clientMessageId]);
    requireRouter(flights.has(key) || flights.size < 256, 'AGENT_MESSAGES_REQUEST_CAPACITY');
    const previous = flights.get(key) ?? Promise.resolve();
    const promise = previous.catch(() => {}).then(() => replyOutbox.send(targetAddress, intent));
    flights.set(key, promise);
    try { const result = await promise; await check(); rememberSourceReceipt(sourceAddress, message.clientMessageId, result); return result; }
    finally { if (flights.get(key) === promise) flights.delete(key); }
  }
  function outbox(source, feature) {
    return new NativeAgentMessageOutbox({ sourceIdentity: source.endpoint.identity, sourceAddress: source.address,
      verify: source.verify,
      connectDestination: async address => {
        const destination = await destinationFor(source, address);
        if (feature) await requireEndpointFeature(destination, feature);
        source.verify(); destination.verify(); return destination;
      },
      onOperation: (operation, destination) => bindOperationOwner(source, operation, destination),
      requestSource: async (method, params, destination) => {
        source.verify(); await source.checkCurrentAuthority(); source.verify(); source.endpoint.verify(); destination?.verify();
        const result = await nativeRequest(source.endpoint, method, params,
          routeProof(source.endpoint.identity, destination?.identity ?? source.endpoint.identity, source.authorizationId));
        source.verify(); await source.checkCurrentAuthority(); source.verify(); destination?.verify(); return result;
      } });
  }
  async function send(handle, message) {
    const source = requireHandle(handle);
    await source.checkCurrentAuthority(); source.verify();
    requireRouter(validAgentMessageRequest(AGENT_MESSAGE_METHODS.send, { sourceThreadId: source.sourceThreadId, message }),
      'AGENT_MESSAGES_INVALID_REQUEST');
    if (message.replyToMessageId != null) await requireEndpointFeature(source.endpoint, AGENT_MESSAGE_REPLIES_CAPABILITY);
    const destination = message.targetAddress ?? addressFor(source.endpoint.identity, message.targetThreadId);
    requireRouter(!sameAddress(source.address, destination), 'AGENT_MESSAGES_SELF_SEND');
    await refreshEndpoint(source, source.endpoint);
    const intent = { clientMessageId: message.clientMessageId, mode: message.mode,
      ...(message.expectedTurnId == null ? {} : { expectedTurnId: message.expectedTurnId }),
      ...(message.replyToMessageId == null ? {} : { replyToMessageId: message.replyToMessageId }), text: message.text };
    const key = JSON.stringify([source.endpoint.identity.targetId, source.endpoint.identity.workspaceId, source.sourceThreadId,
      message.clientMessageId]);
    requireRouter(flights.has(key) || flights.size < 256, 'AGENT_MESSAGES_REQUEST_CAPACITY');
    // Serialize conflicting local callers, but always re-read Native durable state.
    const previous = flights.get(key) ?? Promise.resolve();
    const promise = previous.catch(() => {}).then(() => outbox(source, message.replyToMessageId == null ? undefined : AGENT_MESSAGE_REPLIES_CAPABILITY).send(destination, intent));
    flights.set(key, promise);
    try { const result = await promise; source.verify(); rememberSourceReceipt(source.address, message.clientMessageId, result); return result; }
    finally { if (flights.get(key) === promise) flights.delete(key); }
  }
  async function get(handle, query) {
    const source = requireHandle(handle);
    await source.checkCurrentAuthority(); source.verify();
    requireRouter(validAgentMessageRequest(AGENT_MESSAGE_METHODS.get, { sourceThreadId: source.sourceThreadId, query }),
      'AGENT_MESSAGES_INVALID_REQUEST');
    await refreshEndpoint(source, source.endpoint);
    const result = await outbox(source).get(query); source.verify();
    if (result.receipt) rememberSourceReceipt(source.address, result.receipt.clientMessageId, result.receipt);
    return result;
  }
  async function listReceipts(handle, input = {}) {
    const source = requireHandle(handle);
    requireRouter(validAgentMessageReceiptQuery(input), 'AGENT_MESSAGES_INVALID_REQUEST');
    await source.checkCurrentAuthority(); source.verify();
    await requireEndpointFeature(source.endpoint, AGENT_MESSAGE_RECEIPTS_CAPABILITY);
    const verify = async () => { source.verify(); await source.checkCurrentAuthority(); source.verify(); };
    return listAgentMessageReceipts({ query: agentMessageReceiptQuery(input), verify,
      validateOperation: operation => requireRouterOperation(operation, source.endpoint.nativeIdentity ?? source.endpoint.identity, source.address),
      fetchPage: async query => {
        await verify();
        const page = await nativeRequest(source.endpoint, ROUTER_METHODS.sourceList,
          { sourceThreadId: source.sourceThreadId, query }, routeProof(source.endpoint.identity, source.endpoint.identity, source.authorizationId));
        await verify(); return page;
      },
      refresh: async operation => {
        await verify();
        const destination = await destinationFor(source, operation.destination);
        await requireEndpointFeature(destination, AGENT_MESSAGE_RECEIPTS_CAPABILITY);
        await verify(); destination.verify();
        const release = destination.acquire?.();
        try {
          const query = operation.receipt?.messageId ? { messageId: operation.receipt.messageId } :
            { clientMessageId: operation.attestation.claims.clientMessageId };
          return await destination.request(ROUTER_METHODS.queryOriginalDetails, { attestation: operation.attestation, query });
        } finally { release?.(); }
      },
    });
  }
  /** ReadSession on another runtime target; the target owner authorizes every read. */
  async function read(handle, params) {
    return routeSessionRead({ source: requireHandle(handle), read: params, refreshEndpoint, destinationFor, requireEndpointFeature });
  }
  function readForWake(request) {
    return readForOriginalWake(request, {
      endpoints, nativeRequest, endpointFeatureCapabilities, operationEndpoint, verifyOriginalOperation, now, wakeDiscoveryCursors,
      findOwner: (sender, operationId) => operationOwners.get(operationKey(sender, operationId)),
    });
  }
  async function resolveAddress(handle, address) {
    const source = requireHandle(handle);
    await source.checkCurrentAuthority(); source.verify();
    const endpoint = await destinationFor(source, address);
    source.verify(); await source.checkCurrentAuthority(); source.verify(); endpoint.verify();
    return { serverId: endpoint.serverId, workspacePath: endpoint.workspacePath, threadId: address.threadId,
      address: { targetId: address.targetId, workspaceId: address.workspaceId, threadId: address.threadId } };
  }
  const authorityStamp = (source, searchProtocol = false) => {
    const scope = [...source.session.allowedServerIds].sort().map(serverId => {
      const target = getTarget(serverId);
      return [serverId, target ? targetSignature(target) : null, loginContexts.generation(source.authorizationOwner, serverId),
        principalId(loginContexts.identity(source.authorizationOwner, serverId))];
    });
    return JSON.stringify(searchProtocol ? [source.messagingAvailable(), ...scope] : scope);
  };
  async function targets(handle, query = {}) {
    const source = requireHandle(handle);
    await source.checkCurrentAuthority(); source.verify();
    requireRouter(validAgentMessageTargetQuery(query), 'AGENT_MESSAGES_INVALID_REQUEST');
    const requested = agentMessageTargetQuery(query);
    const { cursor } = requested;
    let state, originalCursor;
    if (cursor != null) {
      const previous = cursors.get(cursor);
      requireRouter(previous && previous.handle === source.bindingHandle && previous.expires > now() && previous.authorityStamp === authorityStamp(source, previous.searchProtocol),
        'AGENT_MESSAGES_CURSOR_INVALID');
      previous.sourceVerify();
      for (const field of AGENT_MESSAGE_TARGET_FILTER_FIELDS)
        requireRouter(requested[field] == null || requested[field] === previous.filters[field], 'AGENT_MESSAGES_CURSOR_FILTER_MISMATCH');
      originalCursor = previous;
      // A rejected read must not consume the caller's original cursor.
      state = { ...previous, limit: requested.limit ?? previous.limit };
      state.searchProtocol = previous.searchProtocol || agentMessageDiscoveryRequiresSearch({ ...state.filters, limit: state.limit });
      if (state.searchProtocol !== previous.searchProtocol) state.authorityStamp = authorityStamp(source, state.searchProtocol);
    } else {
      const filters = Object.freeze(Object.fromEntries(AGENT_MESSAGE_TARGET_FILTER_FIELDS
        .filter(field => requested[field] != null).map(field => [field, requested[field]])));
      const candidates = await candidateEndpoints(source, filters.targetId);
      const searchProtocol = agentMessageDiscoveryRequiresSearch({ ...filters, limit: requested.limit });
      state = { handle: source.bindingHandle, entries: candidates.entries, index: 0, targetCursor: null, complete: candidates.complete,
        filters, searchProtocol, limit: requested.limit ?? 10, issues: candidates.issues, targetIssues: 0,
        authorityStamp: authorityStamp(source, searchProtocol), sourceVerify: source.persistentVerify, expires: now() + CURSOR_TTL_MS };
    }
    source.verify();
    if (state.filters.allowedMode != null && !source.messagingAvailable()) {
      // A read-only outer source projects every allowedModes list to empty.
      // Such rows cannot match a requested delivery mode.
      state.index = state.entries.length; state.targetCursor = null;
    }
    let page = { coverage: 'workspace_history', completeness: state.complete ? 'complete' : 'partial',
      observedAtMs: now(), targets: [] };
    const visited = new Set();
    let reads = 0;
    // Keep V1 default pagination unchanged. Searches skip empty pages/targets
    // and stop at the first nonempty page without consuming unreturned rows.
    while (state.index < state.entries.length && page.targets.length === 0 && reads < MAX_EMPTY_DISCOVERY_PAGES && (state.searchProtocol || reads === 0)) {
      const endpoint = state.entries[state.index];
      const position = JSON.stringify([state.index, state.targetCursor]);
      requireRouter(!visited.has(position), 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
      visited.add(position); reads++;
      let result, unavailable = false;
      let searchReady;
      const limit = state.limit;
      try {
        await refreshEndpoint(source, endpoint);
        searchReady = endpoint.broker?.initializeResponse?.result?.capabilities?.experimental?.[AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY] === true;
        if (state.searchProtocol && !searchReady)
          throw new AgentMessageRouterError('AGENT_MESSAGES_DISCOVERY_SEARCH_UNSUPPORTED', -32601);
        const selectors = state.targetCursor == null ? state.filters : { cursor: state.targetCursor };
        result = await nativeRequest(endpoint, ROUTER_METHODS.targets,
          { sourceThreadId: source.sourceThreadId, ...selectors, ...(state.searchProtocol ? { limit } : {}) },
          routeProof(source.endpoint.identity, endpoint.identity, source.authorizationId));
        authorizedEndpoint(source, endpoint);
      } catch (error) {
        const optionalOlderTarget = state.filters.targetId == null && error?.message === 'AGENT_MESSAGES_DISCOVERY_SEARCH_UNSUPPORTED';
        if (samePhysicalIdentity(endpoint.identity, source.endpoint.identity) ||
            !(error instanceof AgentMessageRouterError) ||
            !optionalOlderTarget && !UNAVAILABLE_DISCOVERY_ENDPOINT.has(error.message)) throw error;
        source.verify(); await source.checkCurrentAuthority(); source.verify();
        requireRouter(state.authorityStamp === authorityStamp(source, state.searchProtocol), 'AGENT_MESSAGES_AUTHORIZATION_CHANGED');
        state.complete = false; state.issues++; state.index++; state.targetCursor = null; state.targetIssues = 0;
        unavailable = true;
      }
      if (!unavailable) {
        requireRouter(isContract('CrossSessionMessageTargetsResult', result) && result.targets.length <= limit &&
          Buffer.byteLength(JSON.stringify(result)) <= MAX_NATIVE_DISCOVERY_BYTES, 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
        requireRouter(result.nextCursor == null || validAgentMessageRequest(AGENT_MESSAGE_METHODS.targets,
          { sourceThreadId: source.sourceThreadId, cursor: result.nextCursor }), 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
        const seen = new Set();
        const messaging = !state.searchProtocol || source.messagingAvailable();
        const targets = result.targets.map(target => {
          const address = addressFor(endpoint.identity, target.threadId);
          const allowedModes = messaging ? target.allowedModes : [];
          requireRouter(validAgentMessageTargetSelector(target) && validAgentMessageAddress(address) && !seen.has(target.threadId) && !sameAddress(source.address, address) &&
            (!state.searchProtocol && target.address == null || sameAddress(target.address, address)) &&
            (state.filters.status == null || target.status === state.filters.status) &&
            (state.filters.presence == null || target.presence === state.filters.presence) &&
            (state.filters.allowedMode == null || allowedModes.includes(state.filters.allowedMode)), 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
          seen.add(target.threadId);
          return { ...target, address, allowedModes,
            ...(typeof target.title === 'string' ? { title: [...target.title.replace(/[\p{Cc}]/gu, '')].slice(0, 200).join('') } : {}) };
        });
        if (['partial', 'unknown'].includes(result.completeness) || result.coverage !== 'workspace_history' ||
            result.completeness === 'indexing' && !result.nextCursor) state.complete = false;
        // Native issue counts are cumulative within one cursor snapshot.
        const targetIssues = result.issueCount ?? state.targetIssues;
        requireRouter(targetIssues >= state.targetIssues, 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
        state.issues += targetIssues - state.targetIssues; state.targetIssues = targetIssues;
        page = { ...result, targets };
        requireRouter(Buffer.byteLength(JSON.stringify(page)) <= MAX_GATEWAY_DISCOVERY_BYTES - 512,
          'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
        if (result.nextCursor) state.targetCursor = result.nextCursor;
        else { state.index++; state.targetCursor = null; state.targetIssues = 0; }
      }
    }
    source.verify(); await source.checkCurrentAuthority(); source.verify();
    requireRouter(state.authorityStamp === authorityStamp(source, state.searchProtocol), 'AGENT_MESSAGES_AUTHORIZATION_CHANGED');
    if (cursor != null) requireRouter(cursors.get(cursor) === originalCursor, 'AGENT_MESSAGES_CURSOR_INVALID');
    const { nextCursor: _nativeCursor, ...result } = page;
    if (state.index < state.entries.length) {
      for (const [key, item] of cursors) if (item.expires <= now()) cursors.delete(key);
      requireRouter(cursors.size < MAX_CURSORS || cursor != null, 'AGENT_MESSAGES_CURSOR_LIMIT');
      const nextCursor = randomBytes(24).toString('hex');
      if (cursor != null) cursors.delete(cursor);
      cursors.set(nextCursor, { ...state }); result.nextCursor = nextCursor;
    } else if (cursor != null) cursors.delete(cursor);
    const response = { ...result, completeness: state.complete ? state.index < state.entries.length ? 'indexing' : 'complete' : 'partial',
      ...(state.issues ? { issueCount: Math.min(state.issues, 0xffff_ffff) } : {}) };
    requireRouter(Buffer.byteLength(JSON.stringify(response)) <= MAX_GATEWAY_DISCOVERY_BYTES, 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
    return response;
  }

  return Object.freeze({ registerEndpoint, registerAuthenticatedPeerEndpoint, captureClient, captureAuthenticatedPeer, identityForSource,
    guardSource, send, sendBackgroundReply, get, listReceipts, targets, read, readForWake, resolveAddress, verifyOriginalOperation, capabilitiesForSource });
}
