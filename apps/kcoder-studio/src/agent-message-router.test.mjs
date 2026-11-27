import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAppServerBroker } from './workspace-app-server-broker.js';
import { createAccountLoginContexts } from './account-login-context.js';
import { createGatewayDeviceAuth } from './gateway-device-auth.js';
import { createGatewayDeviceLifecycle } from './gateway-device-lifecycle.js';
import { captureNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';
import { createWorkspaceNativeBackchannel } from './remotes/workspace-backchannel.mjs';
import { createAgentMessageRouter } from './agent-message-router.js';
import { createGatewayAgentMessageRouter, createAgentMessageClientDispatcher, initializeAgentMessageEndpoint } from './agent-message-router-gateway.js';
import { PEER_ROUTER_HOST_METHOD, createAgentMessageRouterBackchannel } from './agent-message-router-backchannel.js';
import { AgentMessageRouterError, ROUTER_CAPABILITY, ROUTER_METHODS, ROUTER_PRIVATE_FIELD, ROUTER_PURPOSE, attestationSigningBytes,
  messageBodySha256, routeProof, routerOperationId } from './agent-message-router-private.js';

const copy = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
function nativeEndpoint(t, alias, { secured = false, threadId = 'same-thread', workspacePath = '/workspace/' + alias, persisted, componentParent = false, messageFeatures = false } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const target = { id: alias, runtime: 'kcoder', transport: 'local', cwd: workspacePath, ...(secured ? { security: {} } : {}) };
  const key = persisted?.key ?? generateKeyPairSync('ed25519');
  const identity = { targetId: 'native-' + alias, workspaceId: 'workspace-' + alias,
    principal: secured ? { kind: 'verifiedAccount', principalId: 'principal-' + alias } : { kind: 'localOs' },
    publicKey: [...key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)], identityEpoch: 'epoch-' + alias };
  const requests = [];
  const operations = persisted?.operations ?? new Map();
  const receipts = persisted?.receipts ?? new Map();
  const hooks = {};
  let reverse;
  const nativeRemoteHostBackchannel = componentParent ? createWorkspaceNativeBackchannel({
    child, spawnedProcess: child, targetId: alias, expectedSignature: JSON.stringify(target),
    getCurrentTarget: () => target, targetSignature: JSON.stringify, trustedImageMatches: () => hooks.imageCurrent !== false,
    isTrackedChild: observed => observed === child, getBroker: () => broker, endpointOwners: new Set(),
    getAgentMessageRouter: () => hooks.router,
  }) : { receiveBackend: message => reverse?.receiveBackend(message) ?? false, close: () => reverse?.close() };
  const broker = new WorkspaceAppServerBroker({ child, serverId: alias, targetTransport: 'local', residentThreads: true,
    retentionParentV1: !componentParent, maxMessageBytes: 1024 * 1024, nativeRemoteHostBackchannel,
    adapter: { rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.agentMessageTargetSignature = JSON.stringify(target);
  broker.loginOwner = secured ? 'login-owner' : undefined;
  t.after(() => { broker.clearTransientState(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const handle = async request => {
    const params = request.params;
    const proof = request[ROUTER_PRIVATE_FIELD];
    if (request.method === 'initialize') return { protocolVersion: '2026-07-27', cwd: workspacePath,
      capabilities: { experimental: { residentThreads: true, [ROUTER_CAPABILITY]: true,
        crossSessionDiscoveryV1: true, crossSessionMessagesV1: true, peerAgentMessagesV1: true,
        ...(hooks.idleShutdown ? { serverIdleShutdownV1: true } : {}),
        ...(messageFeatures ? { crossSessionMessageReceiptsV1: true, crossSessionMessageRepliesV1: true } : {}) } } };
    if (request.method === ROUTER_METHODS.identity) { assert.equal(proof, undefined); return identity; }
    if (request.method === ROUTER_METHODS.capabilities) { assert.equal(proof, undefined); return { capabilities: messageFeatures ? ['crossSessionMessageReceiptsV1', 'crossSessionMessageRepliesV1'] : [] }; }
    if (request.method === 'runtime.workspaces.list') return { success: true, items: [] };
    if (hooks.idleShutdown && request.method === 'server/resources/read') return { instanceId: 'owned-fixture-' + alias };
    if (hooks.idleShutdown && request.method === 'server/shutdown/idle') {
      setImmediate(() => child.emit('close', 0, null));
      return { accepted: true };
    }
    if (!request.method.startsWith('agentMessage/router/')) throw new Error('Unexpected public passthrough');
    assert.equal(proof.purpose, ROUTER_PURPOSE);
    if ([ROUTER_METHODS.acceptForwarded, ROUTER_METHODS.queryOriginal, ROUTER_METHODS.queryOriginalDetails, ROUTER_METHODS.targets].includes(request.method))
      assert.deepEqual(proof.destination, identity);
    else assert.deepEqual(proof.source, identity);
    if (hooks.before) await hooks.before(request);
    switch (request.method) {
      case ROUTER_METHODS.sourceRead: return operations.get(params.operationId) ?? null;
      case ROUTER_METHODS.sourceFind: return [...operations.values()].find(operation =>
        operation.sourceAddress.threadId === params.sourceThreadId && (params.query.messageId ? operation.receipt?.messageId === params.query.messageId :
          operation.attestation.claims.clientMessageId === params.query.clientMessageId)) ?? null;
      case ROUTER_METHODS.sourceCheckReplyAttempt:
        assert.equal(params.attempt.threadId, threadId);
        if (hooks.checkReplyAttempt) await hooks.checkReplyAttempt(params);
        return { current: true };
      case ROUTER_METHODS.sourceCheckWakeRead:
        return hooks.checkWakeRead(params);
      case ROUTER_METHODS.sourceCheckOriginal: {
        const operation = operations.get(params.attestation.claims.operationId);
        assert.ok(operation && operation.stage !== 'prepared');
        assert.deepEqual(operation.attestation, params.attestation);
        if (hooks.checkOriginal) await hooks.checkOriginal(params);
        return operation;
      }
      case ROUTER_METHODS.sourceList: {
        if (hooks.sourceList) return hooks.sourceList(params);
        const rows = [...operations.values()].filter(op => op.sourceAddress.threadId === params.sourceThreadId &&
          (params.query.targetThreadId == null || op.destination.threadId === params.query.targetThreadId));
        const offset = params.query.cursor ? Number(params.query.cursor.slice(1)) : 0;
        const selected = rows.slice(offset, offset + (params.query.limit ?? 10));
        return { items: selected.map((operation, i) => ({ operation, cursor: 'p' + (offset + i + 1) })),
          ...(offset + selected.length < rows.length ? { nextCursor: 'p' + (offset + selected.length) } : {}), unconfirmedCount: 0 };
      }
      case ROUTER_METHODS.queryOriginalDetails: {
        if (hooks.queryOriginalDetails) return hooks.queryOriginalDetails(params);
        const receipt = receipts.get(params.attestation.claims.operationId) ?? null;
        return { receipt, ...(receipt ? { createdAtMs: 100, expiresAtMs: 1000 } : {}) };
      }
      case ROUTER_METHODS.sourcePrepare: {
        if (operations.has(params.operationId)) return operations.get(params.operationId);
        const claims = { version: 1, purpose: ROUTER_PURPOSE, operationId: params.operationId,
          sourceAddress: { targetId: identity.targetId, workspaceId: identity.workspaceId, threadId: params.sourceThreadId },
          destination: params.destination, sourceIdentityEpoch: identity.identityEpoch,
          clientMessageId: params.message.clientMessageId, mode: params.message.mode,
          ...(params.message.expectedTurnId == null ? {} : { expectedTurnId: params.message.expectedTurnId }),
          bodySha256: messageBodySha256(params.message.text),
          ...(params.message.replyToMessageId == null ? {} : { replyToMessageId: params.message.replyToMessageId }) };
        const operation = { operationId: params.operationId, sourceAddress: claims.sourceAddress, destination: params.destination,
          bodySha256: claims.bodySha256, stage: 'prepared', attestation: { claims,
            signature: [...sign(null, attestationSigningBytes(claims), key.privateKey)] } };
        operations.set(params.operationId, copy(operation)); return operation;
      }
      case ROUTER_METHODS.sourceMarkDispatch: {
        const operation = operations.get(params.operationId);
        if (operation.stage === 'prepared') operation.stage = 'dispatching';
        if (hooks.markUnknown) throw new Error('Lost checkpoint response');
        return operation;
      }
      case ROUTER_METHODS.acceptForwarded: {
        const c = params.attestation.claims;
        const receipt = receipts.get(c.operationId) ?? { messageId: 'message-' + receipts.size,
          clientMessageId: c.clientMessageId, targetThreadId: c.destination.threadId, status: 'queued', revision: 1,
          sourceAddress: c.sourceAddress, targetAddress: c.destination,
          ...(c.replyToMessageId == null ? {} : { replyToMessageId: c.replyToMessageId }) };
        receipts.set(c.operationId, copy(receipt));
        if (hooks.afterAccept) await hooks.afterAccept(request);
        if (hooks.acceptUnknown) throw new Error('Lost acceptance response');
        return receipt;
      }
      case ROUTER_METHODS.queryOriginal: return { receipt: receipts.get(params.attestation.claims.operationId) ?? null };
      case ROUTER_METHODS.sourceRecordReceipt: {
        const operation = operations.get(params.operationId);
        operation.stage = 'receipted'; operation.receipt = params.receipt; return operation;
      }
      case ROUTER_METHODS.targets: return { coverage: 'workspace_history', completeness: 'complete', observedAtMs: 123,
        targets: threadId === params.sourceThreadId && proof.source.targetId === identity.targetId ? [] :
          [{ threadId, title: 'Peer', status: 'unknown', presence: 'unknown', allowedModes: [] }] };
      default: throw new Error('Unsupported private method');
    }
  };
  child.stdin.on('data', bytes => {
    for (const line of bytes.toString().trim().split('\n')) {
      const request = JSON.parse(line); requests.push(copy(request));
      if (!request.method) continue;
      void Promise.resolve().then(() => handle(request)).then(result => {
        if (hooks.result) result = hooks.result(request, copy(result));
        child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      }, () => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32034, message: 'Bounded Native fixture failure',
          ...(hooks.failureData ? { data: hooks.failureData } : {}) } }) + '\n'));
    }
  });
  return { target, broker, child, identity, requests, operations, receipts, hooks, key,
    installReverse(value) { reverse = value; },
    descriptor: { broker, serverId: alias, workspacePath, authorizationOwner: 'login-owner' } };
}

async function fixture(t, { secured = false, gateway = false, device = false, componentParent = false, messageFeatures = false } = {}) {
  const options = { secured, componentParent, messageFeatures };
  const a = nativeEndpoint(t, 'alias-a', options);
  const b = nativeEndpoint(t, 'alias-b', options);
  const c = nativeEndpoint(t, 'alias-c', options);
  const all = [a, b, c];
  const targets = new Map(all.map(endpoint => [endpoint.target.id, endpoint.target]));
  const loginContexts = createAccountLoginContexts();
  let session = { allowedServerIds: new Set(targets.keys()) }, originalDeviceOwner, deviceState, authorizationOwner = 'login-owner';
  if (device) {
    const directory = await mkdtemp(join(tmpdir(), 'kcoder-router-device-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let time = Date.now();
    const auth = createGatewayDeviceAuth({ directory, identity: 'owned-router-device', accessTtlMs: 1_000,
      socketGraceMs: 500, now: () => time });
    const families = new Map(), sessions = new Map();
    const lifecycle = createGatewayDeviceLifecycle({ families, authSessions: sessions, sessionSockets: new Map(),
      loginContexts, gatewayDeviceAuth: auth, getServerIds: () => [...targets.keys()], now: () => time });
    const grant = await auth.pair();
    session = lifecycle.registerGrant(grant).session;
    authorizationOwner = grant.stableLoginOwner;
    originalDeviceOwner = await lifecycle.captureOriginalOperationOwner(grant.accessToken, session);
    deviceState = { auth, grant, lifecycle, families, sessions,
      expireTransport() { time = grant.wsLeaseExpiresAt + 1; lifecycle.expireTransport(grant.deviceId); } };
    t.after(() => lifecycle.expireTransport(grant.deviceId));
  }
  if (secured) for (const endpoint of all) loginContexts.publish(authorizationOwner, endpoint.target.id,
    { principalId: endpoint.identity.principal.principalId, username: 'fixture-user' }, { password: 'isolated-fixture-only' });
  if (secured) for (const endpoint of all) endpoint.broker.agentMessageAccountGeneration = loginContexts.generation(authorizationOwner, endpoint.target.id);
  let sessionActive = true;
  const verifySession = () => sessionActive && (!deviceState || deviceState.families.has(deviceState.grant.deviceId));
  const getTarget = id => targets.get(id);
  const targetSignature = JSON.stringify;
  const makeRouter = () => gateway ? createGatewayAgentMessageRouter({ getTarget, getTargets: () => [...targets.values()],
    targetSignature, loginContexts, getBrokers: () => all.map(endpoint => endpoint.broker),
    reusableWorkspaceBroker: async target => ({ broker: all.find(endpoint => endpoint.target.id === target.id).broker, key: target.id }),
  }) : createAgentMessageRouter({ getTarget, targetSignature, loginContexts,
    listEndpointCandidates: async () => ({ entries: all.map(endpoint => endpoint.descriptor), completeness: 'complete' }) });
  for (const endpoint of all) await initializeAgentMessageEndpoint(endpoint.broker);
  const client = { channel: 'runtime', authorizationOwner, messages: [],
    send(message) { this.messages.push(copy(message)); return true; }, pause() {}, resume() {}, close() {} };
  a.broker.attach(client);
  client.nativeRemoteSourceOwner = captureNativeRemoteSourceClient({ client, broker: a.broker, sourceTarget: a.target,
    authorizationOwner: client.authorizationOwner, session, verifySession, getTarget, targetSignature,
    accountIdentity: loginContexts.identity, accountGeneration: loginContexts.generation, originalDeviceOwner });
  a.broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 'init-client', method: 'initialize', params: {
    protocolVersion: '2026-07-27', clientInfo: { name: 'isolated-router-client', version: '1' },
    capabilities: { experimental: { crossSessionDiscoveryV1: true, crossSessionMessagesV1: true, peerAgentMessagesV1: true,
      ...(messageFeatures ? { crossSessionMessageReceiptsV1: true, crossSessionMessageRepliesV1: true } : {}) } },
  } }));
  a.broker.threadOwners.set('same-thread', client);
  const capture = router => router.captureClient({ broker: a.broker, client, session, verifySession,
    sourceThreadId: 'same-thread', workspacePath: a.descriptor.workspacePath });
  const router = makeRouter();
  if (componentParent) for (const endpoint of all) endpoint.hooks.router = router;
  const source = await capture(router);
  const address = endpoint => ({ targetId: endpoint.identity.targetId, workspaceId: endpoint.identity.workspaceId, threadId: 'same-thread' });
  const message = (endpoint = b, overrides = {}) => ({ targetThreadId: 'same-thread', targetAddress: address(endpoint),
    clientMessageId: 'client-message-1', mode: 'enqueue_only', expectedTurnId: null, text: '跨目标正文', ...overrides });
  return { a, b, c, all, targets, session, client, loginContexts, router, source, address, message, makeRouter, capture, deviceState,
    revoke() { sessionActive = false; } };
}

test('private capability is requested internally and hidden publicly; raw proof escapes and private methods never forward', async t => {
  const f = await fixture(t);
  assert.equal(f.a.requests.find(request => request.method === 'initialize').params.capabilities.experimental[ROUTER_CAPABILITY], true);
  assert.equal(f.client.messages.find(message => message.id === 'init-client').result.capabilities.experimental[ROUTER_CAPABILITY], undefined);
  const before = f.a.requests.length;
  for (const raw of [
    '{"jsonrpc":"2.0","id":1,"method":"agentMessage/router/identity","params":{}}',
    '{"jsonrpc":"2.0","method":"agentMessage/router/sourcePrepare","params":{}}',
    '{"jsonrpc":"2.0","id":2,"method":"thread/read","params":{"kcoderPrivateAgentMessageRoute":{}}}',
    '{"jsonrpc":"2.0","id":3,"method":"thread/read","kcoderPrivateAgentMessageRoute":{},"kcoderPrivateAgentMessageRoute":null}',
    '{"jsonrpc":"2.0","id":4,"method":"thread/read","params":{"kcoderPrivateAgentMessage\\u0052oute":null}}',
    '{"jsonrpc":"2.0","id":5,"method":"peerSsh/auth/offerV1","params":{"enrollmentId":"forged"}}',
    '{"jsonrpc":"2.0","method":"peerSsh/auth/nativeProofV1","params":{"claims":{}}}',
    '{"jsonrpc":"2.0","id":6,"method":"peerSsh\\u002fauth\\u002fcompleteV1","params":{"proof":{}}}',
  ]) f.a.broker.receive(f.client, raw);
  assert.equal(f.a.requests.length, before);
  assert.ok(f.client.messages.slice(-8).every(message => message.error?.code === -32602));
  assert.throws(() => f.a.broker.sendAgentMessageRouterRequest(ROUTER_METHODS.sourceRead, { operationId: 'x' },
    { version: 1, purpose: ROUTER_PURPOSE, source: f.a.identity, destination: f.b.identity, authorizationId: 'forged' }));
  const proof = routeProof(f.a.identity, f.b.identity, 'actual-route');
  assert.deepEqual((await f.a.broker.sendAgentMessageRouterRequest(ROUTER_METHODS.sourceRead, { operationId: 'unknown' }, proof)).result, null);
});

function reverseFixture(f, { deadline } = {}) {
  const active = { owner: f.client, turnId: 'actual-turn', attemptId: 'actual-attempt' };
  f.a.broker.activeTurns.set('same-thread', active);
  f.client.routeAgentMessage = createAgentMessageClientDispatcher({ router: f.router, broker: f.a.broker, client: f.client,
    session: f.session, verifySession: () => true, workspacePath: '/workspace/alias-a' });
  const backchannel = createAgentMessageRouterBackchannel({ child: f.a.child, serverId: f.a.target.id,
    getBroker: () => f.a.broker, getRouter: () => f.router,
    assertSourceOwner: ({ child, serverId }) => {
      assert.equal(child, f.a.child); assert.equal(serverId, f.a.target.id);
      assert.equal(f.a.broker.child, child); assert.equal(f.a.broker.closed, false);
    }, reply: message => f.a.broker.safeWriteMessage(message), ...(deadline ? { deadline } : {}) });
  f.a.installReverse(backchannel);
  const frame = (kind, payload, sequence = 1, attempt = {}) => ({ jsonrpc: '2.0', id: 'peer-router-owned-namespace-' + sequence,
    method: PEER_ROUTER_HOST_METHOD, params: { kind, sourceAttempt: { threadId: 'same-thread', turnId: active.turnId,
      attemptId: active.attemptId, ...attempt }, payload } });
  const emit = request => f.a.child.stdout.write(JSON.stringify(request) + '\n');
  const waitReply = async id => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const response = f.a.requests.find(request => request.id === id && !request.method);
      if (response) return response;
      await tick();
    }
    assert.fail('Owned Native reverse request did not settle');
  };
  return { active, backchannel, frame, emit, waitReply };
}

function destinationVerifier(f, endpoint = f.b) {
  const backchannel = createAgentMessageRouterBackchannel({ child: endpoint.child, serverId: endpoint.target.id,
    getBroker: () => endpoint.broker, getRouter: () => f.router,
    assertSourceOwner: ({ child, serverId }) => {
      assert.equal(child, endpoint.child); assert.equal(serverId, endpoint.target.id);
      assert.equal(endpoint.broker.closed, false);
    }, reply: message => endpoint.broker.safeWriteMessage(message) });
  endpoint.installReverse(backchannel);
  let sequence = 0;
  return async (attestation, access = 'observe', message) => {
    const id = 'peer-router-destination-namespace-' + (++sequence);
    endpoint.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method: PEER_ROUTER_HOST_METHOD,
      params: { kind: 'verifyOriginal', sourceAttempt: null, payload: { attestation, access, ...(message == null ? {} : { message }) } } }) + '\n');
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = endpoint.requests.find(request => request.id === id && !request.method);
      if (result) return result;
      await tick();
    }
    assert.fail('Owned destination verification did not settle');
  };
}

function backgroundReplyFixture(f, endpoint = f.b) {
  const backchannel = createAgentMessageRouterBackchannel({ child: endpoint.child, serverId: endpoint.target.id,
    getBroker: () => endpoint.broker, getRouter: () => f.router,
    assertSourceOwner: ({ child, serverId }) => {
      assert.equal(child, endpoint.child); assert.equal(serverId, endpoint.target.id);
      assert.equal(endpoint.broker.child, child); assert.equal(endpoint.broker.closed, false);
    }, reply: message => endpoint.broker.safeWriteMessage(message) });
  endpoint.installReverse(backchannel);
  let sequence = 0;
  return async message => {
    const id = 'peer-router-background-reply-' + (++sequence);
    endpoint.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method: PEER_ROUTER_HOST_METHOD,
      params: { kind: 'sendReply', sourceAttempt: { threadId: 'same-thread', turnId: 'peer-turn', attemptId: 'peer-attempt' },
        payload: message } }) + '\n');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = endpoint.requests.find(request => request.id === id && !request.method);
      if (result) return result;
      await tick();
    }
    assert.fail('Background peer reply did not settle');
  };
}

test('background reads release results only while the exact Native request and original sender remain authorized', async t => {
  for (const fault of ['none', 'wrong-original-message', 'not-applied', 'retired-attempt', 'revoked-sender']) {
    const f = await fixture(t, { messageFeatures: true });
    const receipt = await f.router.send(f.source, f.message(f.b, { mode: 'wake_if_idle' }));
    const operation = [...f.a.operations.values()][0];
    const incoming = f.b.receipts.get(operation.operationId);
    if (fault !== 'not-applied') { incoming.status = 'applied'; incoming.revision++; }
    f.b.broker.initializeResponse.result.capabilities.experimental.agentMessageWakeReadV1 = true;
    const attempt = { threadId: 'same-thread', turnId: 'wake', attemptId: 'original-attempt' };
    const payload = { clientMessageId: 'never-sent' };
    let checks = 0;
    f.b.hooks.checkWakeRead = params => {
      checks++;
      assert.deepEqual(params, { requestId: 'owned-read', attempt, kind: 'get', payload });
      if (fault === 'retired-attempt' && checks > 1) throw new Error('Original read retired');
      return { sender: f.address(f.a), recipient: f.address(f.b), clientMessageId: receipt.clientMessageId,
        messageId: fault === 'wrong-original-message' ? 'different' : receipt.messageId, bodySha256: operation.bodySha256 };
    };
    if (fault === 'revoked-sender') f.b.hooks.before = request => {
      if (request.method === ROUTER_METHODS.sourceFind) f.revoke();
    };
    const read = f.router.readForWake({ broker: f.b.broker, requestId: 'owned-read', attempt, kind: 'get', payload, verifyCaller() {} });
    if (fault === 'none') {
      assert.deepEqual(await read, { receipt: null });
      assert.ok(checks >= 2);
    } else await assert.rejects(read);
    assert.equal(f.c.requests.some(row => row.method === ROUTER_METHODS.sourceFind), false);
  }
});

test('background peer replies reach the original sender without a receiver viewer and keep the original identity', async t => {
  const f = await fixture(t, { messageFeatures: true });
  const incoming = await f.router.send(f.source, f.message());
  const original = [...f.a.operations.values()][0];
  const received = f.b.receipts.get(original.operationId);
  received.status = 'applied'; received.revision++;
  const send = backgroundReplyFixture(f);
  const reply = { targetThreadId: original.sourceAddress.threadId, targetAddress: original.sourceAddress,
    clientMessageId: 'owned-return', replyToMessageId: incoming.messageId, mode: 'enqueue_only', text: 'Actual peer reply' };
  const first = await send(reply);
  assert.equal(first.result?.replyToMessageId, incoming.messageId, JSON.stringify(first.error));
  assert.equal(first.result?.targetThreadId, original.sourceAddress.threadId);
  const again = await send(reply);
  assert.equal(again.result?.messageId, first.result.messageId);
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);
  assert.ok(f.b.requests.some(row => row.method === ROUTER_METHODS.sourceCheckReplyAttempt));
  assert.equal(f.b.broker.clients.size, 0);
});

test('background peer replies reject an unrelated message or revoked source before forwarding', async t => {
  for (const fault of ['wrong-message', 'wrong-target', 'revoked', 'changed-attempt', 'not-applied']) {
    const f = await fixture(t, { messageFeatures: true });
    const incoming = await f.router.send(f.source, f.message());
    const original = [...f.a.operations.values()][0];
    if (fault !== 'not-applied') f.b.receipts.get(original.operationId).status = 'applied';
    const send = backgroundReplyFixture(f);
    const reply = { targetThreadId: original.sourceAddress.threadId, targetAddress: original.sourceAddress,
      clientMessageId: 'owned-return', replyToMessageId: incoming.messageId, mode: 'enqueue_only', text: 'Reply' };
    if (fault === 'wrong-message') reply.replyToMessageId = 'unrelated-message';
    if (fault === 'wrong-target') reply.targetAddress = f.address(f.c);
    if (fault === 'revoked') f.b.hooks.checkReplyAttempt = () => f.revoke();
    if (fault === 'changed-attempt') f.b.hooks.checkReplyAttempt = () => { throw new Error('turn changed'); };
    const result = await send(reply);
    assert.ok(result.error, fault);
    assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 0, fault);
    assert.equal(f.c.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 0, fault);
  }
});

test('a background reply can itself receive an explicitly requested follow-up', async t => {
  const f = await fixture(t, { messageFeatures: true });
  const incoming = await f.router.send(f.source, f.message());
  const original = [...f.a.operations.values()][0];
  f.b.receipts.get(original.operationId).status = 'applied';
  const bToA = backgroundReplyFixture(f);
  const reply = await bToA({ targetThreadId: original.sourceAddress.threadId, targetAddress: original.sourceAddress,
    clientMessageId: 'first-reply', replyToMessageId: incoming.messageId, mode: 'enqueue_only', text: 'Can you confirm?' });
  assert.ok(reply.result?.messageId, JSON.stringify(reply.error));
  const reverseOperation = [...f.b.operations.values()].find(row => row.attestation.claims.clientMessageId === 'first-reply');
  f.a.receipts.get(reverseOperation.operationId).status = 'applied';
  const aToB = backgroundReplyFixture(f, f.a);
  const followup = await aToB({ targetThreadId: original.destination.threadId, targetAddress: original.destination,
    clientMessageId: 'second-reply', replyToMessageId: reply.result.messageId, mode: 'enqueue_only', text: 'Confirmed.' });
  assert.equal(followup.result?.replyToMessageId, reply.result.messageId, JSON.stringify(followup.error));
  assert.equal(f.b.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 2);
});

test('long background exchanges locate the original receipt with bounded reads and recheck revocation', async t => {
  const f = await fixture(t, { messageFeatures: true });
  let previous = await f.router.send(f.source, f.message());
  let original = [...f.a.operations.values()][0];
  f.b.receipts.get(original.operationId).status = 'applied';
  const sendA = backgroundReplyFixture(f, f.a);
  const sendB = backgroundReplyFixture(f, f.b);
  for (let n = 0; n < 12; n++) {
    const from = n % 2 ? f.a : f.b;
    const destination = n % 2 ? f.b : f.a;
    const send = n % 2 ? sendA : sendB;
    const before = from.requests.filter(row => row.method === ROUTER_METHODS.queryOriginal).length;
    const response = await send({ targetThreadId: 'same-thread', targetAddress: f.address(destination),
      clientMessageId: `owned-long-reply-${n}`, replyToMessageId: previous.messageId, mode: 'enqueue_only', text: `Reply ${n}` });
    assert.ok(response.result?.messageId, JSON.stringify(response.error));
    assert.equal(response.result.replyToMessageId, previous.messageId);
    const reads = from.requests.filter(row => row.method === ROUTER_METHODS.queryOriginal).length - before;
    assert.equal(reads, 1, 'only the original receipt should be queried on the warm path');
    original = [...from.operations.values()].find(row => row.attestation.claims.clientMessageId === `owned-long-reply-${n}`);
    destination.receipts.get(original.operationId).status = 'applied';
    previous = response.result;
  }
  f.revoke();
  const forwarded = f.a.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length;
  const denied = await sendB({ targetThreadId: 'same-thread', targetAddress: f.address(f.a),
    clientMessageId: 'owned-after-revocation', replyToMessageId: previous.messageId, mode: 'enqueue_only', text: 'Denied' });
  assert.ok(denied.error);
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, forwarded);
});

test('background reply prunes invalid owners before enforcing the 256-owner capacity', async t => {
  const f = await fixture(t, { messageFeatures: true });
  let staleReceipt;
  for (let n = 0; n < 255; n++) {
    const result = await f.router.send(f.source, f.message(f.c, {
      clientMessageId: `capacity-revoked-${n}`, text: `Capacity entry ${n}`,
    }));
    assert.ok(result.messageId);
    if (n === 254) staleReceipt = result;
  }
  const live = await f.router.send(f.source, f.message(f.b, {
    clientMessageId: 'capacity-live-original', text: 'Live original',
  }));
  const liveOperation = [...f.a.operations.values()].find(row =>
    row.attestation.claims.clientMessageId === 'capacity-live-original');
  assert.ok(liveOperation && live.messageId);
  f.b.receipts.get(liveOperation.operationId).status = 'applied';

  f.targets.set(f.c.target.id, { ...f.targets.get(f.c.target.id), cwd: '/workspace/replaced-c' });
  const sendC = backgroundReplyFixture(f, f.c);
  const staleReply = await sendC({ targetThreadId: 'same-thread', targetAddress: f.address(f.a),
    clientMessageId: 'reply-to-revoked-owner', replyToMessageId: staleReceipt.messageId,
    mode: 'enqueue_only', text: 'Must remain denied' });
  assert.ok(staleReply.error, 'a revoked operation owner cannot authorize a reply');
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 0);

  const sendB = backgroundReplyFixture(f, f.b);
  const reply = await sendB({ targetThreadId: 'same-thread', targetAddress: f.address(f.a),
    clientMessageId: 'reply-after-prune', replyToMessageId: live.messageId,
    mode: 'enqueue_only', text: 'Live reply after pruning' });
  assert.ok(reply.result?.messageId, JSON.stringify(reply.error));
  assert.equal(reply.result.replyToMessageId, live.messageId);
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);

  const staleAgain = await sendC({ targetThreadId: 'same-thread', targetAddress: f.address(f.a),
    clientMessageId: 'reply-to-pruned-owner', replyToMessageId: staleReceipt.messageId,
    mode: 'enqueue_only', text: 'Must remain denied after pruning' });
  assert.ok(staleAgain.error);
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);
});

test('a fixed accepted operation remains verifiable after its source turn and UI socket end, with a fresh Source RPC each time', async t => {
  const f = await fixture(t);
  const origin = reverseFixture(f);
  const send = origin.frame('send', f.message());
  origin.emit(send); assert.ok((await origin.waitReply(send.id)).result);
  const operation = copy([...f.a.operations.values()][0]);
  f.a.broker.activeTurns.delete('same-thread');
  f.a.broker.detach(f.client);
  const verify = destinationVerifier(f);
  for (const access of ['observe', 'append', 'wake']) {
    const response = await verify(operation.attestation, access);
    assert.equal(response.result?.operationId, operation.operationId, JSON.stringify(response.error));
  }
  assert.equal(f.a.requests.filter(request => request.method === ROUTER_METHODS.sourceCheckOriginal).length, 3);
  await assert.rejects(f.router.send(f.source, f.message(f.c)), /SOURCE|CLIENT|OWNER/);
  assert.equal(f.c.receipts.size, 0);
});

test('device access/family expiry preserves only accepted original verification and current ACL remains authoritative', async t => {
  const f = await fixture(t, { device: true });
  await f.router.send(f.source, f.message());
  const operation = copy([...f.a.operations.values()][0]);
  const verify = destinationVerifier(f);
  f.deviceState.expireTransport();
  f.a.broker.detach(f.client);
  for (const access of ['observe', 'append', 'wake']) {
    const frame = await verify(operation.attestation, access);
    assert.equal(frame.result?.operationId, operation.operationId, JSON.stringify(frame.error));
  }
  const prepared = f.a.requests.filter(request => request.method === ROUTER_METHODS.sourcePrepare).length;
  await assert.rejects(f.router.send(f.source, f.message(f.c, { clientMessageId: 'new-operation' })));
  await assert.rejects(f.router.targets(f.source));
  assert.equal(f.a.requests.filter(request => request.method === ROUTER_METHODS.sourcePrepare).length, prepared);
  f.deviceState.lifecycle.reconcileAccess(['alias-a', 'alias-b', 'alias-c'], ['alias-a', 'alias-c'],
    () => new Set(['alias-a', 'alias-c']));
  assert.equal(f.session.allowedServerIds.has('alias-b'), true, 'expired session keeps an intentionally stale projection');
  assert.ok((await verify(operation.attestation, 'append')).error);
});

test('fresh durable device revoke and account change during a Native await reject original-operation publication', async t => {
  for (const revoke of [async f => f.deviceState.auth.revoke(f.deviceState.grant.deviceId),
    async f => f.loginContexts.invalidate(f.client.authorizationOwner, 'alias-b')]) {
    const f = await fixture(t, { device: true });
    await f.router.send(f.source, f.message());
    const operation = copy([...f.a.operations.values()][0]);
    f.deviceState.expireTransport();
    f.a.broker.detach(f.client);
    f.a.hooks.checkOriginal = () => revoke(f);
    assert.ok((await destinationVerifier(f)(operation.attestation, 'append')).error);
    assert.equal(f.a.requests.filter(request => request.method === ROUTER_METHODS.sourceCheckOriginal).length, 1,
      'the real authority changes after the owned Native request started');
  }
});

test('background operation ownership never caches account, target or authentication revocation and checks the actual destination holder', async t => {
  for (const revoke of [f => f.revoke(), f => f.session.allowedServerIds.delete('alias-b'),
    f => f.loginContexts.invalidate('login-owner', 'alias-a'), f => f.loginContexts.invalidate('login-owner', 'alias-b'),
    f => f.targets.set('alias-b', { ...f.b.target, command: 'changed-native' })]) {
    const f = await fixture(t, { secured: true });
    await f.router.send(f.source, f.message());
    const operation = copy([...f.a.operations.values()][0]);
    const verify = destinationVerifier(f);
    assert.ok((await verify(operation.attestation)).result);
    const count = f.a.requests.filter(request => request.method === ROUTER_METHODS.sourceCheckOriginal).length;
    revoke(f);
    assert.ok((await verify(operation.attestation, 'append')).error);
    assert.equal(f.a.requests.filter(request => request.method === ROUTER_METHODS.sourceCheckOriginal).length, count);
  }
  const f = await fixture(t);
  await f.router.send(f.source, f.message());
  const operation = copy([...f.a.operations.values()][0]);
  const wrong = destinationVerifier(f, f.c);
  assert.ok((await wrong(operation.attestation)).error);
  assert.equal(f.a.requests.filter(request => request.method === ROUTER_METHODS.sourceCheckOriginal).length, 0);
  const actual = destinationVerifier(f);
  f.a.hooks.checkOriginal = () => { throw new Error('Original Source permissions changed'); };
  assert.ok((await actual(operation.attestation, 'append')).error);
});

test('a background fixed-operation check reopens only the frozen original Source after its broker exits', async t => {
  const f = await fixture(t);
  let opened = 0;
  let replacement;
  const router = createAgentMessageRouter({ getTarget: id => f.targets.get(id), targetSignature: JSON.stringify,
    loginContexts: f.loginContexts,
    listEndpointCandidates: async () => ({ entries: f.all.map(endpoint => endpoint.descriptor), completeness: 'complete' }),
    openEndpoint: async ({ serverId, workspacePath, authorizationOwner, verify }) => {
      verify();
      assert.equal(serverId, 'alias-a'); assert.equal(workspacePath, '/workspace/alias-a'); assert.equal(authorizationOwner, 'login-owner');
      opened++;
      replacement = nativeEndpoint(t, 'alias-a', { persisted: { key: f.a.key, operations: f.a.operations } });
      await initializeAgentMessageEndpoint(replacement.broker); verify();
      return replacement.descriptor;
    } });
  f.router = router;
  const source = await f.capture(router);
  await router.send(source, f.message());
  const operation = copy([...f.a.operations.values()][0]);
  f.a.child.emit('close', 0, null);
  const response = await destinationVerifier(f)(operation.attestation, 'append');
  assert.equal(response.result?.operationId, operation.operationId, JSON.stringify(response.error));
  assert.equal(opened, 1);
  assert.equal(replacement.requests.filter(request => request.method === ROUTER_METHODS.sourceCheckOriginal).length, 1);
  assert.equal(f.c.requests.filter(request => request.method === ROUTER_METHODS.sourceCheckOriginal).length, 0);
});

test('authentication revoked while the real Source check is pending prevents a stale operation result from escaping', async t => {
  const f = await fixture(t);
  await f.router.send(f.source, f.message());
  const operation = copy([...f.a.operations.values()][0]);
  let release;
  f.a.hooks.checkOriginal = () => new Promise(resolve => { release = resolve; });
  const result = destinationVerifier(f)(operation.attestation, 'append');
  for (let i = 0; i < 100 && !release; i++) await tick();
  assert.equal(typeof release, 'function'); f.revoke(); release();
  assert.ok((await result).error);
});

test('the immutable destination body is checked against original signed intent before forwarding a current Source permission check', async t => {
  const f = await fixture(t);
  await f.router.send(f.source, f.message());
  const operation = copy([...f.a.operations.values()][0]);
  const verify = destinationVerifier(f);
  const message = { clientMessageId: 'client-message-1', mode: 'enqueue_only', text: f.message().text };
  f.a.hooks.checkOriginal = params => assert.deepEqual(params.message, message);
  assert.ok((await verify(operation.attestation, 'append', message)).result);
  const reads = f.a.requests.filter(request => request.method === ROUTER_METHODS.sourceCheckOriginal).length;
  for (const changed of [{ ...message, text: 'changed' }, { ...message, mode: 'wake_if_idle' },
    { ...message, clientMessageId: 'other-client' }, { ...message, expectedTurnId: 'other-turn' },
    { ...message, targetThreadId: 'self-reported-selector' }]) {
    assert.ok((await verify(operation.attestation, 'append', changed)).error);
  }
  assert.equal(f.a.requests.filter(request => request.method === ROUTER_METHODS.sourceCheckOriginal).length, reads);
});

test('real backend reverse frames select the actual active socket owner and never reach public clients', async t => {
  const f = await fixture(t);
  const r = reverseFixture(f);
  const messages = f.client.messages.length;
  const request = r.frame('send', f.message());
  r.emit(request);
  const response = await r.waitReply(request.id);
  assert.deepEqual(response.result.targetAddress, f.address(f.b));
  assert.equal(f.client.messages.length, messages);
  assert.equal(f.b.receipts.size, 1);
  const get = r.frame('get', { clientMessageId: 'client-message-1' }, 2);
  r.emit(get);
  assert.deepEqual((await r.waitReply(get.id)).result.receipt, response.result);
});

test('packaged Windows component parent lists targets and routes both directions without retention authority', async t => {
  const f = await fixture(t, { gateway: true, componentParent: true });
  const r = reverseFixture(f);
  const publicPage = async (id, cursor) => {
    f.a.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id, method: 'thread/agentMessage/targets',
      params: { sourceThreadId: 'same-thread', ...(cursor ? { cursor } : {}) } }));
    for (let i = 0; i < 100 && !f.client.messages.some(frame => frame.id === id); i++) await tick();
    return f.client.messages.find(frame => frame.id === id);
  };
  const first = await publicPage('peers-first');
  assert.ok(first?.result?.nextCursor, JSON.stringify(first));
  const next = await publicPage('peers-next', first.result.nextCursor);
  assert.deepEqual(next?.result?.targets[0]?.address, f.address(f.b));
  assert.equal(f.a.broker.retentionParentV1, false);
  assert.equal(f.a.broker.migrationSourceParentV1, false);
  const send = r.frame('send', f.message());
  r.emit(send);
  assert.deepEqual((await r.waitReply(send.id)).result?.targetAddress, f.address(f.b));
  const verifyOriginal = destinationVerifier(f);
  const operation = [...f.a.operations.values()][0];
  assert.equal((await verifyOriginal(operation.attestation)).result?.operationId, operation.operationId);

  f.a.hooks.imageCurrent = false;
  const before = f.a.requests.length;
  assert.equal((await publicPage('peers-revoked'))?.error?.message, 'AGENT_MESSAGES_ROUTER_UNSUPPORTED');
  assert.equal(f.a.requests.length, before, 'revoked image cannot submit another private request');
  const projected = f.a.broker.projectWorkspaceReceiptCapability(f.a.broker.initializeResponse, f.client);
  assert.equal(projected.result.capabilities.experimental.crossSessionDiscoveryV1, false);
  assert.equal(projected.result.capabilities.experimental.sessionAddressExpectationV1, false);
});

test('public reverse frames, stale attempts, unsupported parents and unknown source selectors cannot dispatch', async t => {
  const f = await fixture(t);
  const r = reverseFixture(f);
  const forged = r.frame('send', f.message());
  f.a.broker.receive(f.client, JSON.stringify(forged));
  f.a.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id: 'peer-router-forged-2', method: 'thread/read', params: { threadId: 'same-thread' } }));
  assert.ok(f.client.messages.slice(-2).every(message => message.error));
  const old = r.frame('send', f.message(), 2, { attemptId: 'old-attempt' });
  r.emit(old); assert.ok((await r.waitReply(old.id)).error);
  const other = r.frame('send', f.message(), 3, { threadId: 'other-thread' });
  r.emit(other); assert.ok((await r.waitReply(other.id)).error);
  f.a.broker.retentionParentV1 = false;
  const unsupported = r.frame('send', f.message(), 4);
  r.emit(unsupported); assert.ok((await r.waitReply(unsupported.id)).error);
  assert.equal(f.b.receipts.size, 0);
  assert.equal(f.a.operations.size, 0);
});

test('reverse transport IDs cannot replay sends and out-of-order distinct IDs retain source-ledger idempotency', async t => {
  const f = await fixture(t);
  const r = reverseFixture(f);
  const first = r.frame('send', f.message(), 3);
  r.emit(first); await r.waitReply(first.id);
  const before = f.a.requests.length;
  r.emit(first); await tick(); await tick();
  assert.equal(f.a.requests.slice(before).find(response => response.id === first.id)?.error?.message, 'AGENT_MESSAGES_NATIVE_REQUEST_INVALID');
  const late = r.frame('send', f.message(), 2);
  r.emit(late); assert.ok((await r.waitReply(late.id)).result);
  assert.equal(f.b.requests.filter(request => request.method === ROUTER_METHODS.acceptForwarded).length, 1);
});

test('reverse origin matches the actual Native attempt contract without imposing message-ID syntax on turn IDs', async t => {
  const f = await fixture(t);
  const r = reverseFixture(f);
  r.active.turnId = '运行/turn:1';
  r.active.attemptId = '尝试:1';
  const request = r.frame('get', { clientMessageId: 'not-yet-created' });
  r.emit(request);
  assert.deepEqual((await r.waitReply(request.id)).result, { receipt: null });
});

test('reverse timeout cancels future dispatch even if the earlier durable prepare completes late', async t => {
  const f = await fixture(t);
  let expire;
  const r = reverseFixture(f, { deadline: callback => { expire = callback; return () => {}; } });
  let release;
  f.a.hooks.before = request => request.method === ROUTER_METHODS.sourcePrepare ? new Promise(resolve => { release = resolve; }) : undefined;
  const request = r.frame('send', f.message());
  r.emit(request);
  for (let i = 0; i < 100 && !release; i++) await tick();
  assert.equal(typeof release, 'function');
  expire();
  assert.match((await r.waitReply(request.id)).error.message, /OUTCOME_UNKNOWN/);
  release(); await tick(); await tick();
  assert.equal(f.b.receipts.size, 0);
  assert.equal(f.a.requests.filter(value => value.method === ROUTER_METHODS.sourceMarkDispatch).length, 0);
  assert.equal(f.a.requests.filter(value => value.id === request.id && !value.method).length, 1);
});

test('ending the original attempt during prepare prevents target dispatch and cursor pages use each new live guard', async t => {
  const f = await fixture(t);
  const r = reverseFixture(f);
  let cursor;
  const rows = [];
  for (let sequence = 1; sequence <= 3; sequence++) {
    const request = r.frame('targets', cursor ? { cursor } : {}, sequence);
    r.emit(request);
    const response = await r.waitReply(request.id);
    assert.ok(response.result, JSON.stringify(response)); rows.push(...response.result.targets); cursor = response.result.nextCursor;
  }
  assert.equal(rows.length, 2);
  let release;
  f.a.hooks.before = request => request.method === ROUTER_METHODS.sourcePrepare ? new Promise(resolve => { release = resolve; }) : undefined;
  const send = r.frame('send', f.message(), 4);
  r.emit(send);
  for (let i = 0; i < 100 && !release; i++) await tick();
  assert.equal(typeof release, 'function');
  f.a.broker.activeTurns.delete('same-thread');
  release();
  assert.ok((await r.waitReply(send.id)).error);
  assert.equal(f.b.receipts.size, 0);
});

test('closing the owned source child aborts the reverse request without late replies or stopping peer targets', async t => {
  const f = await fixture(t);
  const r = reverseFixture(f);
  let release;
  f.a.hooks.before = request => request.method === ROUTER_METHODS.sourcePrepare ? new Promise(resolve => { release = resolve; }) : undefined;
  const send = r.frame('send', f.message());
  r.emit(send);
  for (let i = 0; i < 100 && !release; i++) await tick();
  assert.equal(typeof release, 'function');
  f.a.child.emit('close', 0, null);
  release(); await tick(); await tick();
  assert.equal(f.a.requests.filter(value => value.id === send.id && !value.method).length, 0);
  assert.equal(f.client.messages.filter(value => value.id === send.id).length, 0);
  assert.equal(f.b.receipts.size, 0);
  assert.equal(f.b.broker.closed, false);
  assert.equal(f.c.broker.closed, false);
});

test('same thread ID on distinct canonical targets sends through real private brokers with one stable signed operation', async t => {
  const f = await fixture(t);
  const receipt = await f.router.send(f.source, f.message());
  assert.deepEqual(receipt.sourceAddress, f.address(f.a));
  assert.deepEqual(receipt.targetAddress, f.address(f.b));
  const operation = [...f.a.operations.values()][0];
  assert.equal(operation.operationId, routerOperationId(f.address(f.a), 'client-message-1'));
  assert.equal(operation.stage, 'receipted');
  assert.equal(JSON.stringify(operation).includes('跨目标正文'), false);
  assert.equal(f.b.requests.filter(request => request.method === ROUTER_METHODS.acceptForwarded).length, 1);
  assert.equal(f.c.receipts.size, 0);
  assert.ok(!f.all.flatMap(endpoint => endpoint.requests).some(request => request.method === 'thread/agentMessage/send'));
});

test('lost receipt and router recreation query the frozen original destination without replaying acceptance', async t => {
  const f = await fixture(t);
  f.b.hooks.acceptUnknown = true;
  const receipt = await f.router.send(f.source, f.message());
  assert.equal(receipt.status, 'queued');
  const replacement = f.makeRouter();
  const source = await f.capture(replacement);
  const recovered = await replacement.get(source, { clientMessageId: 'client-message-1' });
  assert.deepEqual(recovered.receipt, receipt);
  assert.deepEqual((await replacement.get(source, { messageId: receipt.messageId })).receipt, receipt);
  assert.equal(f.b.requests.filter(request => request.method === ROUTER_METHODS.acceptForwarded).length, 1);
  assert.equal(f.c.requests.filter(request => request.method === ROUTER_METHODS.queryOriginal).length, 0);
});

test('a changed body or destination conflicts before dispatch, and concurrent retries retain one destination effect', async t => {
  const f = await fixture(t);
  await Promise.all([f.router.send(f.source, f.message()), f.router.send(f.source, f.message())]);
  for (const changed of [f.message(f.c), f.message(f.b, { text: 'changed' }), f.message(f.b, { mode: 'wake_if_idle' })])
    await assert.rejects(f.router.send(f.source, changed), /OPERATION_CONFLICT/);
  assert.equal(f.b.requests.filter(request => request.method === ROUTER_METHODS.acceptForwarded).length, 1);
  assert.equal(f.c.receipts.size, 0);
});

test('ambiguous dispatch checkpoint never forwards and later absence stays unknown', async t => {
  const f = await fixture(t);
  f.a.hooks.markUnknown = true;
  await assert.rejects(f.router.send(f.source, f.message()), /DISPATCH_CHECKPOINT_UNKNOWN/);
  f.a.hooks.markUnknown = false;
  await assert.rejects(f.router.send(f.source, f.message()), /ORIGINAL_RECEIPT_UNKNOWN/);
  assert.equal(f.b.requests.filter(request => request.method === ROUTER_METHODS.acceptForwarded).length, 0);
  assert.equal([...f.a.operations.values()][0].stage, 'dispatching');
  await assert.rejects(f.router.get(f.source, { messageId: 'not-recorded' }), /ORIGINAL_OPERATION_UNKNOWN/);
});

test('source JSON lookalikes, unpaired TUI peers and replaced target configurations cannot become source authority', async t => {
  const f = await fixture(t);
  await assert.rejects(f.router.send({}, f.message()), /AUTHENTICATED_SOURCE_REQUIRED/);
  await assert.rejects(f.router.captureAuthenticatedPeer({ authenticated: true, sourceThreadId: 'same-thread' }), /AUTHENTICATED_SOURCE_REQUIRED/);
  f.targets.set('alias-a', { ...f.a.target, command: 'replaced-native' });
  await assert.rejects(f.capture(f.makeRouter()));
  assert.equal(f.b.receipts.size, 0);
});

test('source detachment, target removal and account revocation fail closed around actual target effects', async t => {
  for (const revoke of [f => f.a.broker.clients.delete(f.client), f => f.session.allowedServerIds.delete('alias-b'),
    f => f.loginContexts.invalidate('login-owner', 'alias-b'), f => f.revoke()]) {
    const f = await fixture(t, { secured: true });
    revoke(f);
    await assert.rejects(f.router.send(f.source, f.message()));
    assert.equal(f.b.receipts.size, 0);
  }
  const f = await fixture(t, { secured: true });
  f.b.hooks.afterAccept = () => f.loginContexts.invalidate('login-owner', 'alias-b');
  await assert.rejects(f.router.send(f.source, f.message()));
  assert.equal(f.b.receipts.size, 1);
  assert.equal([...f.a.operations.values()][0].stage, 'dispatching');
  assert.equal(f.b.requests.filter(request => request.method === ROUTER_METHODS.queryOriginal).length, 0);
});

test('discovery pages retain global addresses, reject stale cursors and expose authorized navigation paths only', async t => {
  const f = await fixture(t);
  const rows = [];
  let cursor;
  do {
    const page = await f.router.targets(f.source, { cursor });
    rows.push(...page.targets); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(rows.map(row => row.address.targetId).sort(), [f.b.identity.targetId, f.c.identity.targetId].sort());
  assert.equal(new Set(rows.map(row => row.threadId)).size, 1);
  assert.deepEqual(await f.router.resolveAddress(f.source, f.address(f.b)), { serverId: 'alias-b', workspacePath: '/workspace/alias-b',
    threadId: 'same-thread', address: f.address(f.b) });
  const first = await f.router.targets(f.source);
  f.session.allowedServerIds.delete('alias-c');
  await assert.rejects(f.router.targets(f.source, { cursor: first.nextCursor }), /CURSOR_INVALID/);
  await assert.rejects(f.router.resolveAddress(f.source, f.address(f.c)), /DESTINATION_UNAVAILABLE/);
});

test('unavailable peer directory pages stay partial and preserve the remaining authorized targets', async t => {
  for (const reason of ['peer_message_policy_denied', 'unknown']) {
    const f = await fixture(t);
    f.b.hooks.before = request => {
      if (request.method === ROUTER_METHODS.targets) throw new Error('isolated unavailable directory');
    };
    f.b.hooks.failureData = { reason };
    const first = await f.router.targets(f.source);
    const unavailable = await f.router.targets(f.source, { cursor: first.nextCursor });
    assert.deepEqual(unavailable.targets, []);
    assert.equal(unavailable.completeness, 'partial');
    assert.equal(unavailable.issueCount, 1);
    assert.ok(unavailable.nextCursor);
    const remaining = await f.router.targets(f.source, { cursor: unavailable.nextCursor });
    assert.deepEqual(remaining.targets.map(row => row.address), [f.address(f.c)]);
    assert.equal(remaining.completeness, 'partial');
    assert.equal(remaining.issueCount, 1);
    assert.equal(remaining.nextCursor, undefined);
    assert.equal(f.b.requests.filter(request => request.method === ROUTER_METHODS.targets).length, 1);
    assert.ok(f.all.every(endpoint => endpoint.operations.size === 0 && endpoint.receipts.size === 0));
  }
});

test('partial peer discovery cannot hide source revocation or consume its rejected cursor', async t => {
  const f = await fixture(t);
  let active = true;
  const guarded = () => f.router.guardSource(f.source, () => active);
  const first = await f.router.targets(guarded());
  f.b.hooks.before = request => {
    if (request.method === ROUTER_METHODS.targets) { active = false; throw new Error('isolated interrupted directory'); }
  };
  await assert.rejects(f.router.targets(guarded(), { cursor: first.nextCursor }), /AUTHORIZATION_CHANGED/);
  active = true;
  f.b.hooks.before = undefined;
  const recovered = await f.router.targets(guarded(), { cursor: first.nextCursor });
  assert.deepEqual(recovered.targets.map(row => row.address), [f.address(f.b)]);
  assert.notEqual(recovered.completeness, 'partial');
  assert.equal(recovered.issueCount, undefined);

  f.a.hooks.before = request => {
    if (request.method === ROUTER_METHODS.targets) throw new Error('isolated source directory unavailable');
  };
  await assert.rejects(f.router.targets(guarded()), /NATIVE_RESULT_UNCONFIRMED/);
});

test('public discovery keeps an opted-out destination partial without hiding invalid directory responses', async t => {
  const f = await fixture(t, { gateway: true });
  f.b.hooks.before = request => {
    if (request.method === ROUTER_METHODS.targets) throw new Error('isolated disabled destination');
  };
  f.b.hooks.failureData = { reason: 'peer_message_policy_denied' };
  f.client.routeAgentMessage = createAgentMessageClientDispatcher({ router: f.router, broker: f.a.broker, client: f.client,
    session: f.session, verifySession: () => true, workspacePath: '/workspace/alias-a' });
  const read = async (id, cursor) => {
    f.a.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id, method: 'thread/agentMessage/targets',
      params: { sourceThreadId: 'same-thread', ...(cursor ? { cursor } : {}) } }));
    for (let i = 0; i < 100 && !f.client.messages.some(frame => frame.id === id); i++) await tick();
    const response = f.client.messages.find(frame => frame.id === id);
    assert.ok(response, 'public discovery must settle');
    return response;
  };
  const first = await read('partial-source');
  const unavailable = await read('partial-disabled', first.result.nextCursor);
  assert.equal(unavailable.error, undefined);
  assert.equal(unavailable.result.completeness, 'partial');
  assert.equal(unavailable.result.issueCount, 1);
  f.c.hooks.result = (request, result) => request.method === ROUTER_METHODS.targets
    ? { ...result, targets: [{ ...result.targets[0], threadId: '../invalid-selector' }] } : result;
  const invalid = await read('partial-invalid', unavailable.result.nextCursor);
  assert.equal(invalid.error?.message, 'AGENT_MESSAGES_INVALID_DISCOVERY_RESPONSE');
  assert.equal(invalid.result, undefined);
  assert.ok(f.all.every(endpoint => endpoint.operations.size === 0 && endpoint.receipts.size === 0));
});

test('concurrent peer discovery reads consume one original cursor without forking its authority', async t => {
  const f = await fixture(t);
  const first = await f.router.targets(f.source);
  let release, entered = 0;
  const held = new Promise(resolve => { release = resolve; });
  f.b.hooks.before = request => {
    if (request.method === ROUTER_METHODS.targets) { entered++; return held; }
  };
  const observe = () => f.router.targets(f.source, { cursor: first.nextCursor })
    .then(page => ({ page }), error => ({ error }));
  const pending = [observe(), observe()];
  for (let i = 0; i < 100 && entered !== 2; i++) await tick();
  assert.equal(entered, 2);
  release();
  const results = await Promise.all(pending);
  const accepted = results.filter(result => result.page), rejected = results.filter(result => result.error);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].error.message, /CURSOR_INVALID/);
  assert.deepEqual(accepted[0].page.targets.map(row => row.address), [f.address(f.b)]);
  const last = await f.router.targets(f.source, { cursor: accepted[0].page.nextCursor });
  assert.deepEqual(last.targets.map(row => row.address), [f.address(f.c)]);
});

test('production Gateway adapter intercepts public sends and resolution without current-target passthrough', async t => {
  const f = await fixture(t, { gateway: true });
  f.client.routeAgentMessage = createAgentMessageClientDispatcher({ router: f.router, broker: f.a.broker, client: f.client,
    session: f.session, verifySession: () => true, workspacePath: '/workspace/alias-a' });
  f.a.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id: 'send-public', method: 'thread/agentMessage/send',
    params: { sourceThreadId: 'same-thread', message: f.message() } }));
  for (let i = 0; i < 30 && !f.client.messages.some(message => message.id === 'send-public'); i++) await tick();
  const result = f.client.messages.find(message => message.id === 'send-public');
  assert.ok(result?.result, JSON.stringify(result));
  assert.deepEqual(result.result.targetAddress, f.address(f.b));
  assert.ok(!f.a.requests.some(request => request.method === 'thread/agentMessage/send'));
  f.a.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id: 'resolve-public', method: 'thread/agentMessage/resolve',
    params: { sourceThreadId: 'same-thread', address: f.address(f.b) } }));
  for (let i = 0; i < 30 && !f.client.messages.some(message => message.id === 'resolve-public'); i++) await tick();
  assert.equal(f.client.messages.find(message => message.id === 'resolve-public')?.result?.serverId, 'alias-b');
});

test('invalid signed source rows and mismatched destination receipts cannot be published as success', async t => {
  const f = await fixture(t);
  f.a.hooks.result = (request, result) => {
    if (request.method === ROUTER_METHODS.sourcePrepare) result.attestation.claims.bodySha256 = 'a'.repeat(64);
    return result;
  };
  await assert.rejects(f.router.send(f.source, f.message()), /INVALID_NATIVE_RESPONSE|ATTESTATION_INVALID/);
  assert.equal(f.b.receipts.size, 0);
  f.a.hooks.result = undefined;
  f.b.hooks.result = (request, result) => {
    if (request.method === ROUTER_METHODS.acceptForwarded) result.targetAddress = f.address(f.c);
    return result;
  };
  await assert.rejects(f.router.send(f.source, f.message()), /RECEIPT_MISMATCH/);
  assert.equal([...f.a.operations.values()][0].stage, 'dispatching');
  f.b.hooks.result = undefined;
  assert.equal((await f.router.get(f.source, { clientMessageId: 'client-message-1' })).receipt.status, 'queued');
  assert.equal(f.b.requests.filter(request => request.method === ROUTER_METHODS.acceptForwarded).length, 1);
});

test('warm receipt queries preserve current authority and avoid source ledger mutations', async t => {
  const f = await fixture(t);
  await f.router.send(f.source, f.message());
  const writes = f.a.requests.filter(request => request.method === ROUTER_METHODS.sourceRecordReceipt).length;
  for (let i = 0; i < 3; i++) assert.equal((await f.router.get(f.source, { clientMessageId: 'client-message-1' })).receipt.status, 'queued');
  assert.equal(f.a.requests.filter(request => request.method === ROUTER_METHODS.sourceRecordReceipt).length, writes);
  f.session.allowedServerIds.delete('alias-b');
  await assert.rejects(f.router.get(f.source, { clientMessageId: 'client-message-1' }));
});

test('directory indexing completes after the final authorized page and cumulative issues are counted once', async t => {
  for (const issues of [0, 2]) {
    const f = await fixture(t);
    f.b.hooks.result = (request, result) => {
      if (request.method !== ROUTER_METHODS.targets) return result;
      const first = request.params.cursor == null;
      return { ...result, targets: [{ ...result.targets[0], threadId: first ? 'b-first' : 'b-second' }],
        completeness: issues ? 'partial' : first ? 'indexing' : 'complete', issueCount: issues,
        ...(first ? { nextCursor: 'native-continuation' } : {}) };
    };
    let cursor;
    const pages = [];
    do { const page = await f.router.targets(f.source, { cursor }); pages.push(page); cursor = page.nextCursor; } while (cursor);
    assert.equal(pages.length, 4);
    assert.equal(pages.at(-1).completeness, issues ? 'partial' : 'complete');
    assert.equal(pages.at(-1).issueCount ?? 0, issues);
    assert.ok(pages.slice(0, -1).every(page => page.completeness !== 'complete'));
  }
});

test('schema-shaped discovery rows still require usable global selectors and bounded private cursors', async t => {
  for (const invalid of [result => ({ ...result, targets: [{ ...result.targets[0], threadId: '../escape' }] }),
    result => ({ ...result, nextCursor: 'x'.repeat(2049) })]) {
    const f = await fixture(t);
    f.b.hooks.result = (request, result) => request.method === ROUTER_METHODS.targets ? invalid(result) : result;
    const first = await f.router.targets(f.source);
    await assert.rejects(f.router.targets(f.source, { cursor: first.nextCursor }), /INVALID_DISCOVERY_RESPONSE/);
  }
});

async function coldGatewayDestination(t, beforeOpen = () => {}, closing = false) {
  const f = await fixture(t);
  const current = new Map(f.all.map(endpoint => [endpoint.target.id, endpoint]));
  let reopened = 0;
  const router = createGatewayAgentMessageRouter({
    getTarget: id => f.targets.get(id), getTargets: () => [...f.targets.values()],
    targetSignature: JSON.stringify, loginContexts: f.loginContexts,
    getBrokers: () => [...current.values()].map(endpoint => endpoint.broker),
    reusableWorkspaceBroker: async (target, workspacePath) => {
      let endpoint = current.get(target.id);
      if (endpoint.broker.closed || endpoint.broker.idleShutdown.closing) {
        assert.equal(target.id, f.b.target.id);
        assert.equal(workspacePath, f.b.descriptor.workspacePath);
        await beforeOpen(f);
        if (!endpoint.broker.closed) endpoint.child.emit('close', 0, null);
        endpoint = nativeEndpoint(t, target.id, { workspacePath,
          persisted: { key: endpoint.key, operations: endpoint.operations, receipts: endpoint.receipts } });
        endpoint.hooks.idleShutdown = true;
        current.set(target.id, endpoint); reopened++;
      }
      return { broker: endpoint.broker, key: target.id };
    },
  });
  const source = await f.capture(router);
  const listed = [];
  let cursor;
  for (let pages = 0; pages < 4; pages++) {
    const page = await router.targets(source, cursor ? { cursor } : {});
    listed.push(...page.targets);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.ok(listed.some(row => row.address.workspaceId === f.b.identity.workspaceId));
  assert.equal(f.b.broker.clientCount, 0);
  if (closing) f.b.broker.idleShutdown.closing = true;
  else f.b.child.emit('close', 0, null);
  return { ...f, router, source, current, reopened: () => reopened };
}

test('a broker committed to idle shutdown cannot shadow its live replacement', async t => {
  const f = await coldGatewayDestination(t, undefined, true);
  const sent = await f.router.send(f.source, f.message());
  assert.equal(sent.status, 'queued');
  assert.equal(f.reopened(), 1);
  assert.equal(f.b.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 0);
});

test('an exited viewer-free destination reopens for the original canonical wake without replaying acceptance', async t => {
  const f = await coldGatewayDestination(t);
  const original = f.message(f.b, { mode: 'wake_if_idle' });
  const receipt = await f.router.send(f.source, original);
  assert.equal(receipt.clientMessageId, original.clientMessageId);
  assert.equal(receipt.status, 'queued', 'routing cannot invent Applied or model execution');
  assert.deepEqual(receipt.targetAddress, original.targetAddress);
  const replacement = f.current.get(f.b.target.id);
  assert.notEqual(replacement.broker, f.b.broker);
  assert.equal(f.reopened(), 1);
  assert.equal(replacement.broker.clientCount, 0, 'no synthetic viewer or execution owner');
  assert.equal(replacement.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);
  const operation = [...f.a.operations.values()][0];
  const verified = await destinationVerifier(f, replacement)(operation.attestation, 'wake');
  assert.equal(verified.result?.operationId, operation.operationId, JSON.stringify(verified.error));
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.sourceCheckOriginal).length, 1);
  const observed = await f.router.get(f.source, { clientMessageId: original.clientMessageId });
  assert.equal(observed.receipt.messageId, receipt.messageId);
  assert.equal(replacement.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);
});

test('a queued viewer-free wake reconciles its original receipt after the destination exits without sending again', async t => {
  const f = await coldGatewayDestination(t);
  const original = f.message(f.b, { mode: 'wake_if_idle' });
  const queued = await f.router.send(f.source, original);
  const previous = f.current.get(f.b.target.id);
  assert.equal(queued.status, 'queued');
  previous.child.emit('close', 0, null);
  const observed = await f.router.get(f.source, { clientMessageId: original.clientMessageId });
  const replacement = f.current.get(f.b.target.id);
  assert.equal(f.reopened(), 2);
  assert.notEqual(replacement.broker, previous.broker);
  assert.deepEqual(observed.receipt, queued);
  assert.equal(previous.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);
  assert.equal(replacement.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 0);
  assert.equal(replacement.requests.filter(row => row.method === ROUTER_METHODS.queryOriginal).length, 1);
  assert.equal(replacement.broker.clientCount, 0);
  assert.equal(replacement.broker.hasProtectedIdleResources, false);
});

test('a viewer-free wake route keeps its destination through the original Source checkpoint and then releases it', { timeout: 5_000 }, async t => {
  const f = await coldGatewayDestination(t);
  let checkpointReached, releaseCheckpoint;
  const reached = new Promise(resolve => { checkpointReached = resolve; });
  const released = new Promise(resolve => { releaseCheckpoint = resolve; });
  f.a.hooks.before = async request => {
    if (request.method === ROUTER_METHODS.sourcePrepare) {
      checkpointReached();
      await released;
    }
  };
  const original = f.message(f.b, { mode: 'wake_if_idle' });
  const send = f.router.send(f.source, original);
  try {
    await reached;
    const destination = f.current.get(f.b.target.id);
    assert.equal(destination.broker.clientCount, 0);
    const stopped = await destination.broker.stopWhenIdle();
    assert.equal(stopped.status, 'busy', 'a live fixed send must outlast idle cleanup of its destination');
    assert.equal(destination.broker.closed, false);
    releaseCheckpoint();
    const receipt = await send;
    assert.equal(receipt.clientMessageId, original.clientMessageId);
    assert.equal(destination.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);
    assert.equal(destination.broker.hasProtectedIdleResources, false, 'no permanent viewer or read lease remains');
    assert.equal((await destination.broker.stopWhenIdle()).status, 'stopped');
  } finally {
    releaseCheckpoint();
    await send.catch(() => {});
  }
});

test('source revocation while reopening a viewer-free destination cannot prepare or forward a wake', async t => {
  const f = await coldGatewayDestination(t, current => current.revoke());
  await assert.rejects(f.router.send(f.source, f.message(f.b, { mode: 'wake_if_idle' })));
  assert.equal(f.a.operations.size, 0);
  for (const endpoint of f.current.values())
    assert.equal(endpoint.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 0);
});

test('authorization lost after selecting a real broker still schedules that exact broker for ordinary idle cleanup', async t => {
  const f = await fixture(t);
  let scheduled = 0;
  const router = createGatewayAgentMessageRouter({ getTarget: id => f.targets.get(id), getTargets: () => [f.a.target],
    targetSignature: JSON.stringify, loginContexts: f.loginContexts, getBrokers: () => [],
    reusableWorkspaceBroker: async () => { f.revoke(); return { broker: f.a.broker, key: 'owned-broker-key' }; },
    scheduleIdle: (key, broker) => { assert.equal(key, 'owned-broker-key'); assert.equal(broker, f.a.broker); scheduled++; } });
  const source = await f.capture(router);
  await assert.rejects(router.targets(source));
  assert.equal(scheduled, 1);
  assert.equal(f.a.broker.closed, false, 'idle scheduling never kills an attached peer runtime');
});

test('public RPC expiration cancels later dispatch and invalid no-ID mutation frames do not execute', async t => {
  const f = await fixture(t);
  let expire;
  f.client.routeAgentMessage = createAgentMessageClientDispatcher({ router: f.router, broker: f.a.broker, client: f.client,
    session: f.session, verifySession: () => true, workspacePath: '/workspace/alias-a',
    deadline: (_method, callback) => { expire = callback; return () => {}; } });
  f.a.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id: null, method: 'thread/agentMessage/send',
    params: { sourceThreadId: 'same-thread', message: f.message() } }));
  await tick();
  assert.equal(f.a.operations.size, 0);
  let release;
  f.a.hooks.before = request => request.method === ROUTER_METHODS.sourcePrepare ? new Promise(resolve => { release = resolve; }) : undefined;
  f.a.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id: 'public-expiry', method: 'thread/agentMessage/send',
    params: { sourceThreadId: 'same-thread', message: f.message() } }));
  for (let i = 0; i < 100 && !release; i++) await tick();
  assert.equal(typeof release, 'function'); expire();
  assert.equal(f.client.messages.find(response => response.id === 'public-expiry').error.data.kind, 'gatewayRequestExpired');
  release(); await tick(); await tick();
  assert.equal(f.b.receipts.size, 0);
  assert.equal(f.a.requests.filter(request => request.method === ROUTER_METHODS.sourceMarkDispatch).length, 0);
  assert.equal(f.client.messages.filter(response => response.id === 'public-expiry').length, 1);
});

test('discovery-only clients keep empty delivery modes and unready private transports do not advertise routed capabilities', async t => {
  const f = await fixture(t);
  f.client.peerAgentMessagesV1 = false;
  f.client.routeAgentMessage = createAgentMessageClientDispatcher({ router: f.router, broker: f.a.broker, client: f.client,
    session: f.session, verifySession: () => true, workspacePath: '/workspace/alias-a' });
  f.b.hooks.result = (request, result) => request.method === ROUTER_METHODS.targets ? { ...result,
    targets: result.targets.map(row => ({ ...row, title: '\u0000' + '标'.repeat(250), allowedModes: ['enqueue_only'] })) } : result;
  let cursor;
  const rows = [];
  for (let index = 0; index < 4; index++) {
    const id = 'discovery-' + index;
    f.a.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id, method: 'thread/agentMessage/targets',
      params: { sourceThreadId: 'same-thread', ...(cursor ? { cursor } : {}) } }));
    for (let i = 0; i < 30 && !f.client.messages.some(message => message.id === id); i++) await tick();
    const response = f.client.messages.find(message => message.id === id);
    assert.ok(response?.result, JSON.stringify(response));
    rows.push(...response.result.targets); cursor = response.result.nextCursor;
    if (!cursor) break;
  }
  const b = rows.find(row => row.address.targetId === f.b.identity.targetId);
  assert.deepEqual(b.allowedModes, []);
  assert.equal(b.title.length, 200);
  assert.equal(b.title.includes('\u0000'), false);
  const projected = f.a.broker.projectWorkspaceReceiptCapability({ result: { capabilities: { experimental: {
    crossSessionDiscoveryV1: true, crossSessionMessagesV1: true, peerAgentMessagesV1: true,
  } } } }, f.client);
  assert.equal(projected.result.capabilities.experimental.crossSessionDiscoveryV1, false);
  assert.equal(projected.result.capabilities.experimental[ROUTER_CAPABILITY], undefined);
});


test('read diagnostics carry a closed Native targets reason through the actual public dispatcher only', async t => {
  const f = await fixture(t, { gateway: true });
  f.client.routeAgentMessage = createAgentMessageClientDispatcher({ router: f.router, broker: f.a.broker, client: f.client,
    session: f.session, verifySession: () => true, workspacePath: '/workspace/alias-a' });
  const secret = 'PRIVATE_NATIVE_PATH_TOKEN';
  for (const endpoint of f.all) {
    endpoint.hooks.before = request => { if ([ROUTER_METHODS.targets, ROUTER_METHODS.sourceFind].includes(request.method)) throw new Error(secret); };
    endpoint.hooks.failureData = { reason: 'peer_source_tool_disabled', path: secret, token: secret };
  }
  const call = async (id, method, params) => {
    f.a.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id, method, params: { sourceThreadId: 'same-thread', ...params } }));
    for (let i = 0; i < 100 && !f.client.messages.some(frame => frame.id === id); i++) await tick();
    const frame = f.client.messages.find(frame => frame.id === id); assert.ok(frame?.error); return frame;
  };
  const known = await call('diagnostic-known', 'thread/agentMessage/targets', {});
  assert.deepEqual(known.error.data, { reason: 'peer_source_tool_disabled' });
  assert.ok(!JSON.stringify(known).includes(secret));
  for (const endpoint of f.all) endpoint.hooks.failureData.reason = 'unreviewed:'+secret;
  const unknown = await call('diagnostic-unknown', 'thread/agentMessage/targets', {});
  assert.deepEqual(unknown.error.data, { reason: 'unknown' });
  assert.ok(!JSON.stringify(unknown).includes(secret));
  const rejected = () => { throw Object.assign(new AgentMessageRouterError('AGENT_MESSAGES_NATIVE_RESULT_UNCONFIRMED'),
    { data: { reason: 'peer_source_tool_disabled', private: secret } }); };
  f.client.routeAgentMessage = createAgentMessageClientDispatcher({ router: { ...f.router, get: rejected, send: rejected },
    broker: f.a.broker, client: f.client, session: f.session, verifySession: () => true, workspacePath: '/workspace/alias-a' });
  const get = await call('diagnostic-get', 'thread/agentMessage/get', { query: { clientMessageId: 'original' } });
  assert.equal(Object.hasOwn(get.error, 'data'), false);
  const send = await call('diagnostic-send', 'thread/agentMessage/send', { message: f.message() });
  assert.equal(Object.hasOwn(send.error, 'data'), false);
});

test('outgoing receipt listing uses original signed Source scope and fresh reverse proof without dispatch or cache writes', async t => {
  const f = await fixture(t, { gateway: true, messageFeatures: true });
  const original = await f.router.send(f.source, f.message());
  const operation = [...f.a.operations.values()][0];
  assert.equal(operation.receipt.status, 'queued');
  f.b.receipts.set(operation.operationId, { ...original, status: 'applied', revision: 2 });
  const checkOriginal = destinationVerifier(f);
  f.b.hooks.before = async request => {
    if (request.method === ROUTER_METHODS.queryOriginalDetails) {
      const checked = await checkOriginal(request.params.attestation, 'observe');
      assert.equal(checked.result?.operationId, operation.operationId, JSON.stringify(checked.error));
    }
  };
  const dispatcher = createAgentMessageClientDispatcher({ router: f.router, broker: f.a.broker, client: f.client,
    session: f.session, verifySession: () => true, workspacePath: f.a.descriptor.workspacePath });
  const beforePrepare = f.a.requests.filter(row => row.method === ROUTER_METHODS.sourcePrepare).length;
  const beforeRecord = f.a.requests.filter(row => row.method === ROUTER_METHODS.sourceRecordReceipt).length;
  await dispatcher({ jsonrpc: '2.0', id: 'list-original-receipts', method: 'thread/agentMessage/receipts/list',
    params: { sourceThreadId: 'same-thread', status: 'applied', createdAfterMs: 100, createdBeforeMs: 101, limit: 256 } });
  const response = f.client.messages.find(row => row.id === 'list-original-receipts');
  assert.equal(response.result?.items.length, 1, JSON.stringify(response.error));
  assert.equal(response.result.items[0].confirmation, 'confirmed');
  assert.equal(response.result.items[0].receipt.status, 'applied');
  assert.equal(response.result.items[0].receipt.messageId, original.messageId);
  assert.equal(operation.receipt.status, 'queued', 'a read must not promote the Source cache to authority');
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.sourcePrepare).length, beforePrepare);
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.sourceRecordReceipt).length, beforeRecord);
  assert.equal(f.b.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.sourceCheckOriginal).length, 1);
});

test('outgoing list rejects a foreign source page and revoked native attempt before exposing another thread', async t => {
  const f = await fixture(t, { messageFeatures: true });
  await f.router.send(f.source, f.message());
  const operation = copy([...f.a.operations.values()][0]);
  operation.sourceAddress.threadId = 'foreign';
  f.a.hooks.sourceList = () => ({ items: [{ operation, cursor: 'p1' }], unconfirmedCount: 0 });
  await assert.rejects(f.router.listReceipts(f.source, {}));
  assert.equal(f.b.requests.filter(row => row.method === ROUTER_METHODS.queryOriginalDetails).length, 0);
  const origin = reverseFixture(f); f.a.broker.activeTurns.delete('same-thread');
  const request = origin.frame('listReceipts', {}); origin.emit(request);
  assert.equal((await origin.waitReply(request.id)).error.message, 'AGENT_MESSAGES_NATIVE_ATTEMPT_CHANGED');
});

test('reply association survives signed routing and a changed original reply under the same CID never dispatches again', async t => {
  const f = await fixture(t, { messageFeatures: true });
  const intent = f.message(f.b, { replyToMessageId: 'received-original' });
  const receipt = await f.router.send(f.source, intent);
  assert.equal(receipt.replyToMessageId, intent.replyToMessageId);
  const operation = copy([...f.a.operations.values()][0]);
  assert.equal(operation.attestation.claims.replyToMessageId, intent.replyToMessageId);
  await assert.rejects(f.router.send(f.source, { ...intent, replyToMessageId: 'another-original' }), /OPERATION_CONFLICT/);
  const checked = await destinationVerifier(f)(operation.attestation, 'append', { clientMessageId: intent.clientMessageId,
    mode: intent.mode, text: intent.text, replyToMessageId: 'another-original' });
  assert.equal(checked.error?.message, 'AGENT_MESSAGES_OPERATION_CONFLICT');
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.sourcePrepare).length, 1);
  assert.equal(f.b.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);
});

test('old Native capabilities reject receipt listing and reply before creating a source operation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.router.listReceipts(f.source, {}), error => error.code === -32601 && error.message === 'AGENT_MESSAGES_RECEIPTS_UNSUPPORTED');
  await assert.rejects(f.router.send(f.source, f.message(f.b, { replyToMessageId: 'received-original' })), error => error.code === -32601 && error.message === 'AGENT_MESSAGES_REPLIES_UNSUPPORTED');
  assert.equal(f.a.operations.size, 0);
  assert.equal(f.b.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 0);
});

test('public expired-receipt query preserves a closed capability admission error and succeeds only after real client negotiation', async t => {
  const old = await fixture(t, { messageFeatures: true });
  delete old.client.crossSessionMessageReceiptsV1;
  const legacyDispatch = createAgentMessageClientDispatcher({ router: old.router, broker: old.a.broker, client: old.client,
    session: old.session, verifySession: () => true, workspacePath: old.a.descriptor.workspacePath });
  await legacyDispatch({ jsonrpc: '2.0', id: 'unnegotiated-list', method: 'thread/agentMessage/receipts/list',
    params: { sourceThreadId: 'same-thread', status: 'expired' } });
  const denied = old.client.messages.find(row => row.id === 'unnegotiated-list');
  assert.deepEqual(denied.error, { code: -32601, message: 'AGENT_MESSAGES_RECEIPTS_UNSUPPORTED', data: { reason: 'receipts_unsupported' } });
  assert.equal(old.a.requests.filter(row => row.method === ROUTER_METHODS.sourceList).length, 0);
  const f = await fixture(t, { messageFeatures: true });
  const original = await f.router.send(f.source, f.message());
  const operation = [...f.a.operations.values()][0];
  f.b.receipts.set(operation.operationId, { ...original, status: 'expired', revision: 2, reasonCode: 'ttl_expired' });
  const dispatcher = createAgentMessageClientDispatcher({ router: f.router, broker: f.a.broker, client: f.client,
    session: f.session, verifySession: () => true, workspacePath: f.a.descriptor.workspacePath });
  await dispatcher({ jsonrpc: '2.0', id: 'expired-list', method: 'thread/agentMessage/receipts/list',
    params: { sourceThreadId: 'same-thread', status: 'expired' } });
  const response = f.client.messages.find(row => row.id === 'expired-list');
  assert.equal(response.result?.items[0]?.receipt.status, 'expired', JSON.stringify(response.error));
  assert.equal(response.result.items[0].reasonCode, 'ttl_expired');
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.sourceList).length, 1);
  assert.equal(f.b.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);
});

test('actual broker public list entry routes to its authenticated Source handler instead of raw Native passthrough', async t => {
  const f = await fixture(t, { messageFeatures: true });
  await f.router.send(f.source, f.message());
  const operation = [...f.a.operations.values()][0];
  f.b.receipts.set(operation.operationId, { ...operation.receipt, status: 'expired', revision: 2 });
  const dispatcher = createAgentMessageClientDispatcher({ router: f.router, broker: f.a.broker, client: f.client,
    session: f.session, verifySession: () => true, workspacePath: f.a.descriptor.workspacePath });
  f.client.routeAgentMessage = dispatcher;
  f.a.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id: 'outer-public-list', method: 'thread/agentMessage/receipts/list',
    params: { sourceThreadId: 'same-thread', status: 'expired', limit: 1 } }));
  const deadline = Date.now() + 3000;
  while (!f.client.messages.some(row => row.id === 'outer-public-list')) {
    assert.ok(Date.now() < deadline, 'outer public route deadline'); await tick();
  }
  const response = f.client.messages.find(row => row.id === 'outer-public-list');
  assert.equal(response.result?.items[0]?.receipt.status, 'expired', JSON.stringify(response.error));
  assert.equal(f.a.requests.filter(row => row.method === 'thread/agentMessage/receipts/list').length, 0);
  assert.equal(f.a.requests.filter(row => row.method === ROUTER_METHODS.sourceList).length, 1);
});

test('read-only listing after router recreation cannot mint an original-operation background wake owner', async t => {
  const f = await fixture(t, { messageFeatures: true });
  const receipt = await f.router.send(f.source, f.message());
  const operation = copy([...f.a.operations.values()][0]);
  const current = f.makeRouter();
  const source = await f.capture(current);
  const before = f.a.requests.length;
  const listed = await current.listReceipts(source, {});
  assert.equal(listed.items[0].receipt.messageId, receipt.messageId);
  assert.equal(listed.items[0].confirmation, 'confirmed');
  const blocked = await destinationVerifier({ ...f, router: current })(operation.attestation, 'wake');
  assert.equal(blocked.error?.message, 'AGENT_MESSAGES_ORIGINAL_OWNER_UNAVAILABLE');
  assert.equal(f.a.requests.slice(before).filter(row => [ROUTER_METHODS.sourcePrepare, ROUTER_METHODS.sourceMarkDispatch,
    ROUTER_METHODS.sourceRecordReceipt, ROUTER_METHODS.sourceCheckOriginal].includes(row.method)).length, 0);
  assert.equal(f.b.requests.filter(row => row.method === ROUTER_METHODS.acceptForwarded).length, 1);
});
