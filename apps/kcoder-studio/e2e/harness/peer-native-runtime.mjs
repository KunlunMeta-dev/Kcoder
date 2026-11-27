import assert from 'node:assert/strict';
import { openSync, closeSync, fstatSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { WorkspaceAppServerBroker } from '../../src/workspace-app-server-broker.js';
import { createRuntimeTargetAdapter } from '../../src/runtime-target-adapter.js';
import { ChannelTaskClient } from '../../src/channel-task-client.mjs';
import { createAccountLoginContexts } from '../../src/account-login-context.js';
import { captureNativeRemoteSourceClient } from '../../src/remotes/source-client-owner.mjs';
import { createWorkspaceNativeBackchannel } from '../../src/remotes/workspace-backchannel.mjs';
import { createGatewayAgentMessageRouter, createAgentMessageClientDispatcher,
  initializeAgentMessageEndpoint } from '../../src/agent-message-router-gateway.js';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { waitFor } from './run-context.mjs';
import { createPeerRouteDiagnostics, closedPeerRouteReason } from './peer-route-diagnostics.mjs';
import { captureAcceptedPeerReceiptReader } from './accepted-peer-receipt.mjs';
import { AppServerStdioClient } from './app-server-stdio.mjs';
import { ROUTER_METHODS, routerIdentity, routerOperationId } from '../../src/agent-message-router-private.js';
import { isDeepStrictEqual } from 'node:util';

/** Two actual Native profiles behind the actual Gateway broker/router. The
 * authenticated socket subjects are controlled fixture objects, not a test of
 * HTTP login, a remote OS account, a GUI or autonomous model selection.
 */
export async function peerNativeFixture(context, binary) {
  const image = openSync(binary, 'r');
  context.addCleanup('close peer candidate image', () => closeSync(image));
  const expectedImage = fstatSync(image, { bigint: true });
  const endpoints = new Map(), targets = new Map(), clients = new Set(), endpointOwners = new Set();
  const loginContexts = createAccountLoginContexts();
  const acceptedReceipts = new Map();
  let router, checksHeld = false, releaseChecks;
  let checkBarrier = Promise.resolve();
  let checksSeen = 0;
  const diagnostics = createPeerRouteDiagnostics(context);
  const observe = diagnostics.observe, closedReason = closedPeerRouteReason;
  const routerForNative = new Proxy({}, { get(_target, property) {
    if (property !== 'verifyOriginalOperation') return router?.[property];
    return async parameters => { const check = ++checksSeen; if (checksHeld) await checkBarrier;
      observe({ lane: 'verifyOriginal', phase: 'begin', check, access: parameters.access });
      try {
        const result = await router.verifyOriginalOperation(parameters);
        observe({ lane: 'verifyOriginal', phase: 'result', check, stage: result.stage });
        return result;
      } catch (error) {
        observe({ lane: 'verifyOriginal', phase: 'rejected', check, reason: closedReason(error),
          code: Number.isInteger(error?.code) ? error.code : null });
        throw error;
      } };
  } });
  const createEndpoint = async alias => {
    let endpoint = endpoints.get(alias);
    if (!endpoint) {
      const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: `peer-${alias}` });
      const profile = context.pathInState(`peer-${alias}-profile`);
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await context.writeStateJson(`peer-${alias}-profile/settings.json`, {
        permission_mode: 'bypass', history_enabled: true,
        active_provider:'fixture',model:'fixture-model',max_retries:0,
        providers:{fixture:{api_format:'openai_chat_completions',endpoint:'http://127.0.0.1:1/v1',
          default_model:'fixture-model',context_window_tokens:200000,max_output_tokens:1024,
          output_headroom_tokens:1024,no_proxy:true,authentication:{mode:'none'}}},
        cross_session_messages: { enabled: true, wake_idle: alias === 'b' },
      });
      const target = { id: alias, runtime: 'kcoder', transport: 'local', cwd: workspace };
      endpoint = { alias, workspace, profile, target, generation: 0, broker: null };
      endpoints.set(alias, endpoint); targets.set(alias, target);
    }
    if (endpoint.broker && !endpoint.broker.closed) return endpoint;
    const label = `peer-native-${alias}-${++endpoint.generation}`;
    const child = context.spawnOwned(label, binary, ['app-server', '--scenario', 'markdown-showcase',
      '--migration-source-parent-local-v1'], { cwd: endpoint.workspace,
      env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: endpoint.profile, KCODER_HOME: endpoint.profile }),
      stdin: 'pipe' });
    let broker;
    const expectedSignature = JSON.stringify(endpoint.target);
    const backchannel = createWorkspaceNativeBackchannel({ child, spawnedProcess: child, targetId: alias,
      expectedSignature, getCurrentTarget: () => targets.get(alias), targetSignature: JSON.stringify,
      isTrackedChild: value => context.processes.get(label)?.child === value,
      trustedImageMatches: () => { try { const actual = statSync(`/proc/${child.pid}/exe`, { bigint: true });
        return actual.dev === expectedImage.dev && actual.ino === expectedImage.ino;
      } catch { return false; } }, getBroker: () => broker, endpointOwners,
      getAgentMessageRouter: () => routerForNative });
    broker = new WorkspaceAppServerBroker({ child, adapter: createRuntimeTargetAdapter('kcoder'),
      serverId: alias, targetTransport: 'local', residentThreads: true, migrationSourceParentV1: true,
      nativeRemoteHostBackchannel: backchannel, maxMessageBytes: 2 * 1024 * 1024 });
    broker.agentMessageTargetSignature = expectedSignature;
    const privateRequest = broker.sendAgentMessageRouterRequest.bind(broker);
    broker.sendAgentMessageRouterRequest = async (method, params, proof) => {
      // This fixture-only observer never changes the production request/result
      // and deliberately retains no params, proof, body or raw Native error.
      observe({ lane: 'private', alias, phase: 'begin', method });
      try {
        const response = await privateRequest(method, params, proof);
        if (!response.error && method === ROUTER_METHODS.identity) endpoint.identity = routerIdentity(response.result);
        if (!response.error && method === ROUTER_METHODS.sourceRecordReceipt) captureAccepted(alias, response.result, proof);
        observe({ lane: 'private', alias, phase: response.error ? 'rejected' : 'result', method,
          ...(response.error ? { code: response.error.code, reason: closedReason(response.error),
            nativeReason: closedReason({ message: response.error.data?.reason }) } :
            { stage: response.result?.stage ?? null, receiptStatus: response.result?.receipt?.status ?? null }) });
        return response;
      } catch (error) {
        observe({ lane: 'private', alias, phase: 'threw', method, reason: closedReason(error) });
        throw error;
      }
    };
    endpoint.broker = broker; endpoint.child = child; endpoint.label = label;
    if (process.env.KCODER_E2E_TRACE_PEER_LOCKS === '1') {
      // Owned Native processes only. flock metadata contains no packet bodies,
      // credentials, environment values or bytes read from private files.
      context.spawnOwned(`${label}-locks`, '/usr/bin/strace',
        ['-f', '-yy', '-e', 'trace=flock', '-p', String(child.pid)],
        { cwd: endpoint.workspace, env: context.isolatedEnvironment(), stdin: 'ignore' });
    }
    context.addCleanup(`close peer broker ${label}`, () => broker.clearTransientState());
    await initializeAgentMessageEndpoint(broker);
    return endpoint;
  };
  await createEndpoint('a'); await createEndpoint('b');
  router = createGatewayAgentMessageRouter({ getTarget: id => targets.get(id),
    getTargets: () => [...targets.values()], targetSignature: JSON.stringify, loginContexts,
    getBrokers: () => [...endpoints.values()].map(endpoint => endpoint.broker),
    reusableWorkspaceBroker: async target => ({ broker: (await createEndpoint(target.id)).broker, key: target.id }) });
  const session = { allowedServerIds: new Set(targets.keys()) };
  let sessionActive = true;
  function captureAccepted(alias, operation, proof) {
    if (acceptedReceipts.has(operation.operationId)) return;
    const source = endpoints.get(alias);
    const destination = [...endpoints.values()].find(endpoint => isDeepStrictEqual(endpoint.identity, proof.destination));
    assert.ok(source && destination && isDeepStrictEqual(source.identity, proof.source));
    const subject = 'peer-fixture-account';
    const snapshots = [source, destination].map(endpoint => ({ alias: endpoint.alias,
      signature: JSON.stringify(targets.get(endpoint.alias)), generation: loginContexts.generation(subject, endpoint.alias),
      principal: loginContexts.identity(subject, endpoint.alias)?.principalId ?? null }));
    const verifyCurrent = () => {
      assert.equal(sessionActive, true, 'Original fixture authentication expired');
      for (const snapshot of snapshots) {
        assert.ok(session.allowedServerIds.has(snapshot.alias), 'Original target access revoked');
        assert.equal(JSON.stringify(targets.get(snapshot.alias)), snapshot.signature, 'Original target catalog changed');
        assert.equal(loginContexts.generation(subject, snapshot.alias), snapshot.generation, 'Original account generation changed');
        assert.equal(loginContexts.identity(subject, snapshot.alias)?.principalId ?? null, snapshot.principal, 'Original account principal changed');
      }
    };
    const identity = async endpoint => {
      verifyCurrent();
      assert.ok(endpoint.broker && !endpoint.broker.closed, 'Original Native endpoint is unavailable');
      const response = await endpoint.broker.sendAgentMessageRouterRequest(ROUTER_METHODS.identity, {});
      verifyCurrent(); assert.ok(response && !response.error && response.result);
      return routerIdentity(response.result);
    };
    acceptedReceipts.set(operation.operationId, captureAcceptedPeerReceiptReader({ operation, proof, verifyCurrent,
      sourceIdentity: () => identity(source), destinationIdentity: () => identity(destination),
      queryDestination: (params, purpose) => { verifyCurrent(); return destination.broker.sendAgentMessageRouterRequest(ROUTER_METHODS.queryOriginal, params, purpose); } }));
  }
  context.addCleanup('release peer verification barrier', () => { checksHeld = false; releaseChecks?.(); });
  context.addCleanup('close owned peer clients', () => { for (const client of clients) client.close(); });
  const clientFor = async alias => {
    const endpoint = await createEndpoint(alias), broker = endpoint.broker;
    const client = new ChannelTaskClient(broker); clients.add(client);
    client.client.authorizationOwner = 'peer-fixture-account';
    client.client.nativeRemoteSourceOwner = captureNativeRemoteSourceClient({ client: client.client, broker,
      sourceTarget: endpoint.target, authorizationOwner: client.client.authorizationOwner, session,
      verifySession: () => sessionActive, getTarget: id => targets.get(id), targetSignature: JSON.stringify,
      accountIdentity: loginContexts.identity, accountGeneration: loginContexts.generation });
    await client.request('initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'owned-native-peer-contract', version: '1' }, capabilities: { experimental: {
        residentThreads: true, gatewaySharedThreadsV1: true, sessionLifetimeV1: true, turnReceiptsV1: true,
        crossSessionDiscoveryV1: true, crossSessionDiscoverySearchV1: true, crossSessionMessagesV1: true, peerAgentMessagesV1: true,
      } } });
    client.client.routeAgentMessage = createAgentMessageClientDispatcher({ router, broker, client: client.client,
      session, verifySession: () => sessionActive, workspacePath: endpoint.workspace });
    return client;
  };
  const seed = async (client, alias) => {
    const { thread } = await client.request('thread/start', {});
    await client.request('gateway/thread/attach', { threadId: thread.id, viewId: `peer-${alias}` });
    const id = `peer-seed-${alias}`;
    await client.request('turn/start', { threadId: thread.id, clientMessageId: id,
      input: [{ type: 'text', text: `OWNED_PEER_SEED_${alias}` }] });
    await waitFor(async () => {const {receipt}=await client.request('turn/receipt/read', {
      threadId: thread.id, clientMessageId: id });
      if (['failed','interrupted'].includes(receipt?.status)) throw new Error(`Owned seed terminal status: ${receipt.status}`);
      return receipt?.status==='completed';},
    30_000, 'owned original peer seed');
    return thread;
  };
  const rawReaderFor = async (alias, peerSupport) => {
    const endpoint = endpoints.get(alias);
    assert.ok(endpoint?.broker.closed, 'stop the original Native owner before opening its real reader');
    const label = `peer-raw-reader-${alias}-${peerSupport ? 'modern' : 'legacy'}`;
    const child = context.spawnOwned(label, binary, ['app-server', '--scenario', 'markdown-showcase'], {
      cwd: endpoint.workspace,
      env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: endpoint.profile, KCODER_HOME: endpoint.profile }),
      stdin: 'pipe',
    });
    const reader = new AppServerStdioClient(label, child, { notificationHistoryLimit: 128 });
    context.addCleanup(`close raw Native reader ${label}`, () => reader.closeReader());
    const initialized = await reader.request('initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'owned-native-receive-compat', version: '1' }, capabilities: { experimental: {
        residentThreads: true,
        peerAgentMessagesV1: peerSupport, threadTranscriptSnapshotV1: true,
        threadTranscriptObservationV1: true, threadResumeHistoryPageV1: true,
      } } });
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.result.capabilities.experimental.peerAgentMessagesV1, peerSupport);
    return { reader, stop: async () => { await context.stopOwned(label); reader.closeReader(); } };
  };
  return { router, endpoints, session, clientFor, seed,
    rawReaderFor,
    async readAcceptedDestinationReceipt(receipt) {
      const read = acceptedReceipts.get(routerOperationId(receipt.sourceAddress, receipt.clientMessageId));
      assert.ok(read, 'Only an actual successful Source receipt record can create this fixture reader');
      return read(receipt);
    },
    withRouteDiagnostics: diagnostics.withDiagnostics,
    checksSeen: () => checksSeen,
    holdSourceChecks() { assert.equal(checksHeld, false); checksHeld = true;
      checkBarrier = new Promise(resolve => { releaseChecks = resolve; }); },
    releaseSourceChecks() { checksHeld = false; releaseChecks?.(); },
    revokeSession() { sessionActive = false; },
    async stopEndpoint(alias) { const endpoint = endpoints.get(alias);
      endpoint.broker.clearTransientState(); await context.stopOwned(endpoint.label); },
  };
}
