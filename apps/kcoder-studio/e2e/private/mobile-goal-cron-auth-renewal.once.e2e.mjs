import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startApprovalModelFixture } from '../harness/approval-model.mjs';
import { startGateway } from '../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from '../harness/rpc.mjs';
import { findOwnedExecutableProcesses, hashExecutableFile } from '../harness/owned-executable-provenance.mjs';
import { validateCurrentArchivedGateway } from '../harness/current-mobile-web-archive.mjs';
import { runE2E, waitFor } from '../harness/run-context.mjs';

const ACCESS_TTL_MS = 8_000;
const SOCKET_GRACE_MS = 1_500;
const REFRESH_LEAD_MS = 1_500;
const BINARY = resolve(process.env.KCODER_E2E_KCODER_BIN || '');
const EXPECTED_BINARY_SHA256 = process.env.KCODER_E2E_EXPECTED_KCODER_SHA256;
const RUN_MODE = process.env.KCODER_E2E_GOAL_CRON_AUTH_RENEWAL_CASE || 'all';
const OPEN = 1;

await runE2E(import.meta.url, {
  testId: 'goal-and-cron-automation-natural-auth-renewal',
  tier: 'full-integration',
  modelPolicy: `actual Gateway and Rust app-server; ${RUN_MODE === 'all' ? 'two' : 'one'} isolated target-owned workspace(s); deterministic loopback Provider only; no external model, personal task, or production automation`,
  retainSuccessLogs: true,
  cleanupTimeoutMs: 20_000,
}, async context => {
  assert.ok(process.env.KCODER_E2E_KCODER_BIN, 'pin KCODER_E2E_KCODER_BIN explicitly');
  assert.match(EXPECTED_BINARY_SHA256 || '', /^[a-f0-9]{64}$/, 'pin KCODER_E2E_EXPECTED_KCODER_SHA256 explicitly');
  assert.ok(['all', 'setup-smoke', 'cron'].includes(RUN_MODE), 'KCODER_E2E_GOAL_CRON_AUTH_RENEWAL_CASE must be all, setup-smoke, or cron');
  const binaryIdentity = await hashExecutableFile(BINARY);
  assert.equal(binaryIdentity.sha256, EXPECTED_BINARY_SHA256);
  const gatewayRuntime = await validateCurrentArchivedGateway();
  assert.equal(resolve(gatewayRuntime.binaryPath), BINARY, 'the frozen Gateway runtime must name the requested immutable CLI copy');
  assert.equal(gatewayRuntime.binarySha256, EXPECTED_BINARY_SHA256);

  const evidence = {
    result: 'RUNNING',
    binarySha256: EXPECTED_BINARY_SHA256,
    gatewayRuntimeBefore: {
      root: gatewayRuntime.root,
      manifestSha256: gatewayRuntime.manifestSha256,
      sourceTreeSha256: gatewayRuntime.sourceTreeSha256,
      dependencyTreeSha256: gatewayRuntime.dependencyTreeSha256,
      scriptSha256: gatewayRuntime.scriptSha256,
      nodeVersion: gatewayRuntime.nodeVersion,
      nodeExecutable: gatewayRuntime.nodeExecutable,
    },
    accessTtlMs: ACCESS_TTL_MS,
    socketGraceMs: SOCKET_GRACE_MS,
    refreshLeadMs: REFRESH_LEAD_MS,
    runMode: RUN_MODE,
    refreshTiming: 'Each refresh waits against the prior server-issued numeric expiresAt; no clock override.',
    providerBoundary: 'Loopback deterministic SSE fixture; no external model request or model-quality claim.',
    automationBoundary: 'Goal continuation and one confirmed one-shot At Cron run only; no Goal/Cron UI or production/user state.',
    selectedCases: RUN_MODE === 'cron' ? ['cron'] : (RUN_MODE === 'setup-smoke' ? ['setup-smoke'] : ['goal', 'cron']),
    cases: [],
    processes: [],
    timeline: [],
    timelineDropped: 0,
  };
  let failure;
  const recordTimeline = (fixture, event) => {
    if (evidence.timeline.length >= 256) {
      evidence.timelineDropped += 1;
      return;
    }
    evidence.timeline.push({ fixture, ...event });
  };
  const persistCronMilestone = (name, payload) => context.writeArtifactJson(`cron-events/${name}.json`, {
    fixture: 'cron',
    event: name,
    observedAt: Date.now(),
    payload,
  });

  const startRenewalOwner = (fixture, initialGrant) => {
    const controller = new AbortController();
    let currentGrant = initialGrant;
    let rpc = null;
    let socket = null;
    let heldVerifier = null;
    let stopped = false;
    let renewalFailure = null;
    const setupRotations = [];
    const heldRotations = [];
    const initialWsLeaseExpiresAt = initialGrant.wsLeaseExpiresAt;
    recordTimeline(fixture.name, {
      event: 'renewal-owner-start', at: Date.now(),
      expiresAt: initialGrant.expiresAt,
      firstRefreshAtOrAfter: initialGrant.expiresAt - REFRESH_LEAD_MS,
      wsLeaseExpiresAt: initialWsLeaseExpiresAt,
    });

    const task = (async () => {
      while (!stopped) {
        const prior = currentGrant;
        assert.ok(Number.isFinite(prior.expiresAt), 'mobile grant must expose server-issued numeric expiresAt');
        await waitFor(
          () => stopped || Date.now() >= prior.expiresAt - REFRESH_LEAD_MS,
          ACCESS_TTL_MS + 3_000,
          `${fixture.name} background refresh window from server expiresAt`,
          25,
          controller.signal,
        );
        if (stopped) return;
        const phase = heldVerifier ? 'held-task' : 'setup';
        const verifier = heldVerifier;
        const refreshedAt = Date.now();
        assert.ok(refreshedAt < prior.expiresAt, 'refresh must be issued before the prior access grant expires');
        const next = await fixture.refresh(prior, phase);
        currentGrant = next;
        if (rpc) {
          assert.equal(rpc.socket, socket, 'authorization refresh must retain the same RPC WebSocket');
          assert.equal(socket.readyState, OPEN, 'authorization refresh must keep the owned RPC WebSocket open');
        }
        const rotation = {
          index: setupRotations.length + heldRotations.length + 1,
          phase,
          refreshedAt,
          priorExpiresAt: prior.expiresAt,
          newExpiresAt: next.expiresAt,
          wsLeaseExpiresAt: next.wsLeaseExpiresAt,
        };
        if (verifier) {
          rotation.ownerState = await verifier(next);
          heldRotations.push(rotation);
        } else {
          setupRotations.push(rotation);
        }
      }
    })().catch(error => {
      if (!stopped) renewalFailure = error;
    });

    const owner = {
      get currentGrant() { return currentGrant; },
      get setupRotations() { return setupRotations; },
      get heldRotations() { return heldRotations; },
      initialWsLeaseExpiresAt,
      get socket() { return socket; },
      attachRpc(value) {
        assert.equal(rpc, null, 'the renewal owner may attach one RPC socket');
        rpc = value;
        socket = value.socket;
        socket.addEventListener('close', () => recordTimeline(fixture.name, {
          event: 'rpc-websocket-close', at: Date.now(), closeEventObserved: true,
          readyState: socket.readyState,
        }));
        recordTimeline(fixture.name, { event: 'rpc-websocket-open', at: Date.now(), readyState: socket.readyState });
      },
      markHeld(verifier) {
        assert.equal(typeof verifier, 'function');
        assert.equal(heldVerifier, null, 'held-task refresh verifier may be installed only once');
        heldVerifier = verifier;
        recordTimeline(fixture.name, { event: 'held-task-observed', at: Date.now(), expiresAt: currentGrant.expiresAt });
      },
      assertHealthy() {
        if (renewalFailure) throw renewalFailure;
      },
      async waitForHeldRotations(count, label) {
        await waitFor(
          () => heldRotations.length >= count || renewalFailure,
          count * (ACCESS_TTL_MS + 3_000),
          `${label}: ${count} natural refresh ACKs while the task is held`,
          25,
          context.abortSignal,
        );
        owner.assertHealthy();
        assert.ok(Date.now() > initialWsLeaseExpiresAt,
          'the held task must remain live after its original WebSocket lease expires');
        assert.equal(socket.readyState, OPEN, 'the original WebSocket must stay open beyond its original lease');
        return {
          grant: currentGrant,
          socket,
          initialWsLeaseExpiresAt,
          setupRotations: [...setupRotations],
          rotations: heldRotations.slice(0, count),
        };
      },
      async waitForSetupRotations(count, label) {
        await waitFor(
          () => setupRotations.length >= count || renewalFailure,
          count * (ACCESS_TTL_MS + 3_000),
          `${label}: ${count} natural refresh ACKs during setup`,
          25,
          context.abortSignal,
        );
        owner.assertHealthy();
        assert.ok(socket, 'the setup renewal proof requires an attached RPC WebSocket');
        assert.equal(socket.readyState, OPEN, 'setup renewal must retain the same RPC WebSocket');
        return { grant: currentGrant, socket, rotations: setupRotations.slice(0, count) };
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        recordTimeline(fixture.name, { event: 'renewal-owner-stop', at: Date.now(), heldRefreshes: heldRotations.length });
        controller.abort(new Error(`${fixture.name} renewal owner stopped`));
        await task;
      },
    };
    return owner;
  };

  const createFixture = async ({ name, holdRequestNumber, projectAutomations }) => {
    const workspace = context.pathInState(`${name}/workspace`);
    const configDir = context.pathInState(`${name}/config`);
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(configDir, { recursive: true, mode: 0o700 }),
    ]);

    const released = new Set();
    const heldMarker = `${name.toUpperCase()}_HELD_${randomUUID()}`;
    const completedMarker = `${name.toUpperCase()}_COMPLETED_${randomUUID()}`;
    const model = await startApprovalModelFixture(context, {
      responseSteps: ({ requestNumber }) => requestNumber === holdRequestNumber
        ? [
          { delta: { role: 'assistant', content: heldMarker } },
          { ready: () => released.has(requestNumber), delta: { content: ` ${completedMarker}` } },
          { finishReason: 'stop' },
        ]
        : [
          { delta: { role: 'assistant', content: `${name.toUpperCase()}_INITIAL_${requestNumber}` } },
          { finishReason: 'stop' },
        ],
    });
    assert.equal(new URL(model.baseUrl).hostname, '127.0.0.1');
    context.addCleanup(`release ${name} held provider response`, () => {
      released.add(holdRequestNumber);
    });

    const credential = randomUUID();
    context.registerSecret(credential);
    await context.writeStateJson(`${name}/config/settings.json`, {});
    await context.writeStateJson(`${name}/config/credentials.json`, {
      fixture: { type: 'api', key: credential },
    });
    const settingsFile = await context.writeStateJson(`${name}/settings.json`, {
      active_provider: 'fixture',
      providers: {
        fixture: {
          api_format: 'openai_chat_completions',
          endpoint: model.baseUrl,
          default_model: `${name}-deterministic-loopback`,
          context_window_tokens: 128000,
          output_headroom_tokens: 8192,
          max_output_tokens: 256,
          request_timeout_secs: 90,
          no_proxy: true,
          extra_body: {},
        },
      },
      goal_enabled: true,
      goal_max_auto_continuations: 1,
    });
    const serversFile = await context.writeStateJson(`${name}/servers.json`, [{
      id: 'local',
      runtime: 'kcoder',
      label: `${name} owned fixture`,
      transport: 'local',
      command: BINARY,
      workspace,
      settingsFile,
    }]);
    const serversStore = context.pathInState(`${name}/gateway/servers-store.json`);
    const gateway = await startGateway(context, {
      label: `${name}-gateway`,
      gatewayRoot: gatewayRuntime.root,
      cwd: gatewayRuntime.root,
      auth: true,
      workspace,
      serversFile,
      serversStore,
      kcoderBin: BINARY,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_MOCK: '0',
        KCODER_STUDIO_WEB_ROOT: '',
        KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: String(ACCESS_TTL_MS),
        KCODER_STUDIO_MOBILE_SOCKET_GRACE_MS: String(SOCKET_GRACE_MS),
      },
    });
    const deviceStore = resolve(dirname(serversStore), 'mobile-device-auth/devices.json');

    const http = async (path, options = {}) => {
      const hasBody = options.body !== undefined;
      const response = await fetch(`${gateway.baseUrl}${path}`, {
        method: options.method || (hasBody ? 'POST' : 'GET'),
        signal: AbortSignal.timeout(5_000),
        headers: {
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          ...(options.grant ? { authorization: `Bearer ${options.grant.accessToken}` } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      });
      const payload = response.status === 204 ? null : await response.json();
      for (const field of ['accessToken', 'refreshToken', 'rpcToken']) {
        if (payload?.[field]) context.registerSecret(payload[field]);
      }
      return { status: response.status, payload };
    };

    const pair = async label => {
      const pairStartedAt = Date.now();
      recordTimeline(name, { event: 'pair-request', at: pairStartedAt });
      const reply = await http('/api/mobile/session', {
        body: {
          token: gateway.authToken,
          durableDeviceAuthorization: true,
          deviceLabel: label,
        },
      });
      assert.equal(reply.status, 200);
      assert.equal(reply.payload.capabilities.mobileRefreshV1, true);
      recordTimeline(name, {
        event: 'pair-ack', at: Date.now(), expiresAt: reply.payload.expiresAt,
        wsLeaseExpiresAt: reply.payload.wsLeaseExpiresAt,
      });
      return reply.payload;
    };
    const refresh = async (grant, phase) => {
      const rotationId = randomUUID();
      const refreshIssuedAt = Date.now();
      recordTimeline(name, {
        event: 'refresh-request', at: refreshIssuedAt, phase,
        priorExpiresAt: grant.expiresAt, priorWsLeaseExpiresAt: grant.wsLeaseExpiresAt,
      });
      const reply = await http('/api/mobile/session/refresh', {
        body: { refreshToken: grant.refreshToken, deviceId: grant.deviceId, rotationId },
      });
      assert.equal(reply.status, 200);
      const next = reply.payload;
      recordTimeline(name, {
        event: 'refresh-ack', at: Date.now(), phase,
        priorExpiresAt: grant.expiresAt, expiresAt: next.expiresAt,
        wsLeaseExpiresAt: next.wsLeaseExpiresAt,
      });
      assert.equal(next.deviceId, grant.deviceId);
      assert.equal(next.authorizationGeneration, grant.authorizationGeneration);
      assert.ok(next.expiresAt > grant.expiresAt);
      assert.notEqual(next.accessToken, grant.accessToken);
      assert.notEqual(next.refreshToken, grant.refreshToken);
      const raw = await readFile(deviceStore, 'utf8');
      const stored = JSON.parse(raw).devices.find(row => row.id === grant.deviceId);
      assert.equal(stored.lastRotationId, rotationId);
      assert.equal(stored.accessExpiresAt, next.expiresAt);
      for (const token of [grant.accessToken, next.accessToken, grant.refreshToken, next.refreshToken]) {
        assert.equal(raw.includes(token), false, 'device store must not persist bearer or refresh tokens');
      }
      assert.equal((await http('/api/servers', { grant })).status, 401,
        'the prior access token must not authorize a new HTTP request after rotation');
      assert.equal((await http('/api/servers', { grant: next })).status, 200,
        'the rotated access token must authorize a new HTTP request');
      return next;
    };
    const connect = async (label, { waitForSetupRefreshBeforeInitialize = false } = {}) => {
      const grant = await pair(label);
      const renewalOwner = startRenewalOwner({ name, refresh }, grant);
      let rpc = null;
      let rpcClosed = false;
      const closeOwnedRpc = async () => {
        if (!rpc || rpcClosed) return;
        rpcClosed = true;
        await closeRpcAndWait(rpc, `${name} RPC`);
      };
      context.addCleanup(`stop ${name} renewal owner and close RPC`, async () => {
        await renewalOwner.stop();
        await closeOwnedRpc();
      });
      const openingGrant = renewalOwner.currentGrant;
      rpc = await openRpc(gatewayRpcUrl(gateway, 'local', openingGrant.rpcToken), {
        headers: { authorization: `Bearer ${openingGrant.accessToken}` },
      });
      renewalOwner.attachRpc(rpc);
      if (waitForSetupRefreshBeforeInitialize) {
        await renewalOwner.waitForSetupRotations(1, `${name} pre-initialize setup`);
      }
      const initializeStartedAt = Date.now();
      const initialized = await rpc.request('initialize', {
        protocolVersion: '2026-07-27',
        clientInfo: { name: `mobile-${name}-renewal-fixture`, version: '1' },
        capabilities: { experimental: { projectAutomations } },
      });
      assert.equal(initialized.serverInfo.name, 'kcoder-app-server');
      assert.ok(typeof initialized.sessionId === 'string' && initialized.sessionId.length > 0);
      recordTimeline(name, { event: 'initialize-ack', at: Date.now(), startedAt: initializeStartedAt });
      renewalOwner.assertHealthy();
      return { grant, rpc, initialized, renewalOwner, closeRpc: closeOwnedRpc };
    };

    return {
      name, workspace, model, released, heldMarker, completedMarker, gateway, deviceStore,
      http, refresh, connect,
    };
  };

  const observeProviderOutcome = (fixture, requestNumber, label) => {
    const outcome = fixture.model.requestOutcomes[requestNumber - 1];
    assert.ok(outcome, `${label}: Provider request outcome must exist`);
    recordTimeline(fixture.name, {
      event: 'provider-outcome-observed', at: Date.now(), label,
      requestNumber, closed: outcome.closed, aborted: outcome.aborted,
    });
    return outcome;
  };
  const assertProviderRequestHeld = (fixture, requestNumber, label) => {
    assert.equal(fixture.model.requests.length, requestNumber,
      `${label}: exactly the expected Provider requests must have been dispatched`);
    const outcome = observeProviderOutcome(fixture, requestNumber, label);
    assert.equal(outcome.closed, false, `${label}: Provider response must still be open`);
    assert.equal(outcome.aborted, false, `${label}: Provider response must not be aborted`);
    assert.equal(fixture.model.activeResponseCount, 1,
      `${label}: the loopback Provider must still hold exactly this response`);
    return outcome;
  };
  const observedAppServerPids = async gateway => {
    const rows = await findOwnedExecutableProcesses({
      pgid: gateway.child.pid,
      executablePath: binaryIdentity.path,
    });
    const pids = rows.filter(item => item.sha256 === EXPECTED_BINARY_SHA256).map(item => item.pid).sort((a, b) => a - b);
    assert.ok(pids.length > 0, 'the owned Gateway process group must contain the pinned Rust app-server binary');
    return pids;
  };

  try {
    if (RUN_MODE === 'setup-smoke') {
      const setup = await createFixture({ name: 'setup-smoke', holdRequestNumber: 1, projectAutomations: false });
      const setupOwner = await setup.connect('setup-renewal-smoke', { waitForSetupRefreshBeforeInitialize: true });
      assert.equal(setupOwner.renewalOwner.setupRotations.length, 1,
        'the short case must observe exactly one setup refresh ACK before initialize');
      assert.equal(setup.model.requests.length, 0, 'the setup-only smoke must not dispatch a Provider request');
      const setupProcesses = await observedAppServerPids(setup.gateway);
      await setupOwner.renewalOwner.stop();
      await setupOwner.closeRpc();
      assert.equal(setupOwner.renewalOwner.socket.readyState, 3, 'setup smoke must close its owned RPC socket');
      evidence.processes.push(...setupProcesses.map(pid => ({
        fixture: 'setup-smoke', pid, sha256: EXPECTED_BINARY_SHA256,
      })));
      evidence.cases.push({
        name: 'pair-to-initialize-setup-refresh-smoke', result: 'PASS',
        workspaceOwnedByRun: setup.workspace.startsWith(context.stateDir),
        deviceId: setupOwner.renewalOwner.currentGrant.deviceId,
        authorizationGeneration: setupOwner.renewalOwner.currentGrant.authorizationGeneration,
        initializedSessionId: setupOwner.initialized.sessionId,
        originalWsLeaseExpiresAt: setupOwner.renewalOwner.initialWsLeaseExpiresAt,
        setupRotations: setupOwner.renewalOwner.setupRotations,
        heldRotations: 0,
        providerRequests: setup.model.requests.length,
        sameRpcSocketKeptOpenThroughSetupRefresh: true,
      });
      assert.equal((await hashExecutableFile(BINARY)).sha256, EXPECTED_BINARY_SHA256);
      const gatewayRuntimeAfter = await validateCurrentArchivedGateway();
      assert.deepEqual(gatewayRuntimeAfter, gatewayRuntime, 'frozen Gateway source, dependencies, Node, and CLI pins must remain stable');
      evidence.gatewayRuntimeAfter = {
        root: gatewayRuntimeAfter.root,
        manifestSha256: gatewayRuntimeAfter.manifestSha256,
        sourceTreeSha256: gatewayRuntimeAfter.sourceTreeSha256,
        dependencyTreeSha256: gatewayRuntimeAfter.dependencyTreeSha256,
        scriptSha256: gatewayRuntimeAfter.scriptSha256,
        nodeVersion: gatewayRuntimeAfter.nodeVersion,
        nodeExecutable: gatewayRuntimeAfter.nodeExecutable,
      };
      evidence.result = 'PASS';
      return {
        setupRefreshBeforeInitialize: true,
        setupRefreshes: 1,
        providerRequests: 0,
        actualGatewayAndRustAppServer: true,
      };
    }

    if (RUN_MODE !== 'cron') {
    const goal = await createFixture({ name: 'goal', holdRequestNumber: 2, projectAutomations: false });
    const goalOwner = await goal.connect('goal-continuation');
    const goalRpc = goalOwner.rpc;
    const goalBackendPidsBefore = await observedAppServerPids(goal.gateway);
    const goalThread = (await goalRpc.request('thread/start', {})).thread.id;
    const createdGoal = await goalRpc.request('thread/goal/set', {
      threadId: goalThread,
      objective: 'Complete the isolated automatic continuation fixture',
    });
    assert.equal(createdGoal.goal.status, 'active');
    const firstTurn = await goalRpc.request('turn/start', {
      threadId: goalThread,
      clientMessageId: randomUUID(),
      input: [{ type: 'text', text: 'Start the isolated Goal fixture.' }],
    });
    await goalRpc.waitFor(message => message.method === 'turn/completed'
      && message.params?.threadId === goalThread
      && message.params?.turnId === firstTurn.turn.id, 15_000, 'initial Goal turn completion');
    assert.equal(goal.model.requests.length, 1, 'the initial turn must issue exactly one Provider request');
    goalOwner.renewalOwner.assertHealthy();

    const continuationStarted = await goalRpc.waitFor(message => message.method === 'turn/started'
      && message.params?.threadId === goalThread
      && message.params?.turn?.internal === true
      && typeof message.params?.turnId === 'string'
      && message.params.turnId !== firstTurn.turn.id, 15_000, 'real automatic Goal continuation turn');
    const continuationTurnId = continuationStarted.params.turnId;
    await waitFor(() => goal.model.requests.length === 2, 10_000,
      'Goal continuation Provider request received while its auth renewal owner is active', 25, context.abortSignal);
    goalOwner.renewalOwner.assertHealthy();
    await goalRpc.waitFor(message => message.method === 'item/delta'
      && message.params?.threadId === goalThread
      && message.params?.turnId === continuationTurnId
      && message.params?.delta?.text?.includes(goal.heldMarker), 10_000, 'held Goal continuation Provider output');
    assertProviderRequestHeld(goal, 2, 'Goal continuation held Provider output');
    const heldGoal = await goalRpc.request('thread/goal/get', { threadId: goalThread });
    assert.equal(heldGoal.goal?.goalId, createdGoal.goal.goalId);
    assert.equal(heldGoal.goal?.status, 'active');
    assert.ok(Number.isSafeInteger(heldGoal.goal?.turnCount), 'held Goal turnCount baseline must be an integer');
    const heldGoalBaseline = {
      goalId: heldGoal.goal.goalId,
      status: heldGoal.goal.status,
      turnCount: heldGoal.goal.turnCount,
    };
    recordTimeline('goal', {
      event: 'held-goal-authoritative-baseline', at: Date.now(), ...heldGoalBaseline,
    });
    goalOwner.renewalOwner.markHeld(async () => {
      const current = await goalRpc.request('thread/goal/get', { threadId: goalThread });
      assert.equal(current.goal?.goalId, heldGoalBaseline.goalId);
      assert.equal(current.goal?.status, heldGoalBaseline.status);
      assert.equal(current.goal?.turnCount, heldGoalBaseline.turnCount,
        'natural authorization refresh must not start another outer Goal turn');
      assertProviderRequestHeld(goal, 2, 'Goal continuation renewal checkpoint');
      assert.equal(goalRpc.messages().filter(message => message.method === 'turn/completed'
        && message.params?.turnId === continuationTurnId).length, 0);
      return { goalId: current.goal.goalId, status: current.goal.status, turnCount: current.goal.turnCount };
    });
    const goalBackendPidsHeld = await observedAppServerPids(goal.gateway);
    assertProviderRequestHeld(goal, 2, 'Goal continuation held output');
    const initialGoalLease = goalOwner.grant.wsLeaseExpiresAt;
    const goalRenewal = await goalOwner.renewalOwner.waitForHeldRotations(4, 'Goal continuation');
    await goalOwner.renewalOwner.stop();
    goal.released.add(2);
    const goalCompletion = await goalRpc.waitFor(message => message.method === 'turn/completed'
      && message.params?.threadId === goalThread
      && message.params?.turnId === continuationTurnId, 15_000, 'same automatic Goal continuation completion');
    assert.equal(goalCompletion.params.turn.status, 'completed');
    await goalRpc.waitFor(message => message.method === 'item/delta'
      && message.params?.threadId === goalThread
      && message.params?.turnId === continuationTurnId
      && message.params?.delta?.text?.includes(goal.completedMarker), 5_000, 'final Goal continuation Provider output');
    await waitFor(() => goal.model.requestOutcomes[1]?.closed && !goal.model.requestOutcomes[1]?.aborted,
      5_000, 'Goal Provider stream closed normally', 25, context.abortSignal);
    observeProviderOutcome(goal, 2, 'Goal continuation completed response');
    const completedGoal = await goalRpc.request('thread/goal/get', { threadId: goalThread });
    assert.equal(completedGoal.goal?.goalId, heldGoalBaseline.goalId);
    assert.equal(completedGoal.goal?.status, 'active', 'a plain answer must not fabricate Goal completion');
    assert.equal(completedGoal.goal?.turnCount, heldGoalBaseline.turnCount,
      'completing the already-running continuation must preserve its outer turn count');
    assert.equal(goal.model.requests.length, 2);
    assert.equal(goal.model.requestOutcomes[1].aborted, false);
    const goalProcesses = await findOwnedExecutableProcesses({
      pgid: goal.gateway.child.pid,
      executablePath: binaryIdentity.path,
    });
    assert.ok(goalProcesses.some(item => item.sha256 === EXPECTED_BINARY_SHA256));
    evidence.processes.push(...goalProcesses.map(({ pid, sha256 }) => ({ fixture: 'goal', pid, sha256 })));
    evidence.cases.push({
      name: 'active-goal-continuation-four-natural-refreshes', result: 'PASS',
      workspaceOwnedByRun: goal.workspace.startsWith(context.stateDir),
      deviceId: goalOwner.grant.deviceId,
      authorizationGeneration: goalOwner.grant.authorizationGeneration,
      initialThreadId: goalThread,
      initialTurnId: firstTurn.turn.id,
      automaticTurnId: continuationTurnId,
      appServerPidsBefore: goalBackendPidsBefore,
      appServerPidsWhileHeld: goalBackendPidsHeld,
      originalWsLeaseExpiresAt: initialGoalLease,
      finalGrantExpiresAt: goalRenewal.grant.expiresAt,
      originalSocketStayedOpen: goalRenewal.socket.readyState === OPEN,
      providerRequests: goal.model.requests.length,
      automaticTurnNotReplayed: true,
      finalGoalStatus: completedGoal.goal.status,
      finalGoalTurnCount: completedGoal.goal.turnCount,
      heldGoalBaselineTurnCount: heldGoalBaseline.turnCount,
      rotations: goalRenewal.rotations,
      setupRotations: goalRenewal.setupRotations,
    });
    await goalOwner.closeRpc();
    }

    const cron = await createFixture({ name: 'cron', holdRequestNumber: 1, projectAutomations: true });
    const cronOwner = await cron.connect('cron-one-shot');
    const cronRpc = cronOwner.rpc;
    const cronBackendPidsBefore = await observedAppServerPids(cron.gateway);
    const jobIntent = `isolated natural-refresh scheduled turn ${randomUUID()}`;
    const dueAt = Date.now() + 6_000;
    const createdJob = await cronRpc.request('cron/create', {
      prompt: jobIntent,
      schedule: { kind: 'at', at: new Date(dueAt).toISOString() },
      confirmed: true,
      jitterSeconds: 0,
    });
    const job = createdJob.job;
    assert.equal(job.schedule.kind, 'at');
    assert.equal(job.jitter_seconds, 0);
    assert.ok(typeof job.id === 'string' && job.id.length > 0);
    const scheduledAt = Date.parse(job.next_run_at);
    assert.ok(Number.isFinite(scheduledAt) && scheduledAt > Date.now());

    const runStarted = await cronRpc.waitFor(message => message.method === 'automation/runStarted'
      && message.params?.jobId === job.id, 25_000, 'owned Cron automation runStarted event');
    assert.equal(runStarted.params.workspacePath, cron.workspace);
    assert.ok(typeof runStarted.params.threadId === 'string' && runStarted.params.threadId.length > 0);
    assert.ok(typeof runStarted.params.requestId === 'string' && runStarted.params.requestId.startsWith('kcoder-automation-turn:'));
    const cronThreadId = runStarted.params.threadId;
    const cronRunStartedEvidence = {
      method: runStarted.method,
      jobId: runStarted.params.jobId,
      threadId: runStarted.params.threadId,
      requestId: runStarted.params.requestId,
    };
    const runStartedObservedAt = Date.now();
    recordTimeline('cron', {
      event: 'automation-runStarted-observed', at: runStartedObservedAt, payload: cronRunStartedEvidence,
    });
    await persistCronMilestone('01-automation-runStarted', cronRunStartedEvidence);
    const startedTurn = await cronRpc.waitFor(message => message.method === 'turn/started'
      && message.params?.threadId === cronThreadId
      && message.params?.turn?.threadId === cronThreadId
      && message.params?.turn?.status === 'running'
      && typeof message.params?.turn?.id === 'string'
      && message.params.turnId === message.params.turn.id
      && typeof message.params?.attemptId === 'string'
      && message.params.attemptId.length > 0, 15_000, 'typed scheduled Cron turn/started event');
    const cronTurnId = startedTurn.params.turn.id;
    const cronStartedTurnEvidence = {
      method: startedTurn.method,
      threadId: startedTurn.params.threadId,
      turnId: startedTurn.params.turnId,
      attemptId: startedTurn.params.attemptId,
      status: startedTurn.params.turn.status,
    };
    const startedTurnObservedAt = Date.now();
    recordTimeline('cron', {
      event: 'turn-started-observed', at: startedTurnObservedAt, payload: cronStartedTurnEvidence,
    });
    await persistCronMilestone('02-turn-started', cronStartedTurnEvidence);
    assert.ok(typeof cronTurnId === 'string' && cronTurnId.length > 0);
    await waitFor(() => cron.model.requests.length === 1, 10_000,
      'Cron Provider request received while its auth renewal owner is active', 25, context.abortSignal);
    cronOwner.renewalOwner.assertHealthy();
    observeProviderOutcome(cron, 1, 'Cron Provider request observed');
    await cronRpc.waitFor(message => message.method === 'item/delta'
      && message.params?.threadId === cronThreadId
      && message.params?.turnId === cronTurnId
      && message.params?.delta?.text?.includes(cron.heldMarker), 10_000, 'held Cron Provider output');
    assertProviderRequestHeld(cron, 1, 'Cron held Provider output');
    const cronBackendPidsHeld = await observedAppServerPids(cron.gateway);

    const readCronRun = async () => {
      const result = await cronRpc.request('cron/list', {});
      const run = result.executionDiagnostics?.runs?.find(row => row.jobId === job.id);
      assert.ok(run, 'cron/list must expose the exact one-shot job execution receipt');
      return { result, run };
    };
    const runningReceipt = await waitFor(async () => {
      const value = await readCronRun();
      return value.run.status === 'running' ? value : null;
    }, 10_000, 'durable Cron running receipt', 100, context.abortSignal);
    assert.equal(runningReceipt.run.requestId, runStarted.params.requestId);
    assert.equal(runningReceipt.run.jobId, job.id);
    assert.equal(runningReceipt.run.threadId, cronThreadId);
    assert.equal(runningReceipt.run.turnId, cronTurnId);
    assert.equal(runningReceipt.run.attemptId, startedTurn.params.attemptId);
    assert.equal(runningReceipt.run.workspacePath, cron.workspace);
    assert.ok(typeof runningReceipt.run.attemptId === 'string' && runningReceipt.run.attemptId.length > 0);
    assert.deepEqual(runningReceipt.run.schedule, job.schedule,
      'the durable receipt must retain the exact one-shot schedule');
    assert.equal(Date.parse(runningReceipt.run.scheduledAt), scheduledAt,
      'the durable receipt must preserve the exact one-shot scheduled instant');
    const triggerPrefix = `cron:${job.id}:`;
    assert.ok(runningReceipt.run.triggerId.startsWith(triggerPrefix), 'the receipt trigger must identify this exact job');
    assert.equal(Date.parse(runningReceipt.run.triggerId.slice(triggerPrefix.length)), scheduledAt,
      'the trigger identity must preserve this exact one-shot schedule');
    assert.equal(runStarted.params.requestId, `kcoder-automation-turn:${runningReceipt.run.triggerId}`,
      'runStarted must carry the request ID derived from the durable execution trigger');
    const cronRunningReceiptEvidence = {
      jobId: runningReceipt.run.jobId,
      triggerId: runningReceipt.run.triggerId,
      scheduledAt: runningReceipt.run.scheduledAt,
      requestId: runningReceipt.run.requestId,
      threadId: runningReceipt.run.threadId,
      turnId: runningReceipt.run.turnId,
      attemptId: runningReceipt.run.attemptId,
      status: runningReceipt.run.status,
    };
    const runningReceiptObservedAt = Date.now();
    recordTimeline('cron', {
      event: 'running-execution-receipt-observed', at: runningReceiptObservedAt, payload: cronRunningReceiptEvidence,
    });
    await persistCronMilestone('03-running-execution-receipt', cronRunningReceiptEvidence);
    const cronIdentity = {
      jobId: runningReceipt.run.jobId,
      triggerId: runningReceipt.run.triggerId,
      requestId: runningReceipt.run.requestId,
      threadId: runningReceipt.run.threadId,
      turnId: runningReceipt.run.turnId,
      attemptId: runningReceipt.run.attemptId,
      scheduledAt: runningReceipt.run.scheduledAt,
    };
    const cronInitialLease = cronOwner.grant.wsLeaseExpiresAt;
    cronOwner.renewalOwner.markHeld(async () => {
      const current = await readCronRun();
      assert.equal(current.run.status, 'running');
      for (const [key, value] of Object.entries(cronIdentity)) assert.equal(current.run[key], value, `Cron ${key} must remain bound to the same execution`);
      assert.equal(current.run.automaticReplay, false);
      assertProviderRequestHeld(cron, 1, 'Cron renewal checkpoint');
      assert.equal(cronRpc.messages().filter(message => message.method === 'turn/completed'
        && message.params?.turnId === cronTurnId).length, 0);
      return { status: current.run.status, ...cronIdentity };
    });
    const cronRenewal = await cronOwner.renewalOwner.waitForHeldRotations(4, 'Cron scheduled turn');
    await cronOwner.renewalOwner.stop();
    cron.released.add(1);
    const cronCompletion = await cronRpc.waitFor(message => message.method === 'turn/completed'
      && message.params?.threadId === cronThreadId
      && message.params?.turnId === cronTurnId, 15_000, 'same Cron scheduled turn completion');
    assert.equal(cronCompletion.params.turn.status, 'completed');
    await cronRpc.waitFor(message => message.method === 'item/delta'
      && message.params?.threadId === cronThreadId
      && message.params?.turnId === cronTurnId
      && message.params?.delta?.text?.includes(cron.completedMarker), 5_000, 'final Cron Provider output');
    await waitFor(() => cron.model.requestOutcomes[0]?.closed && !cron.model.requestOutcomes[0]?.aborted,
      5_000, 'Cron Provider stream closed normally', 25, context.abortSignal);
    observeProviderOutcome(cron, 1, 'Cron completed response');
    const completedExecution = await waitFor(async () => {
      const current = await readCronRun();
      return current.run.status === 'succeeded' ? current : null;
    }, 10_000, 'persisted successful Cron execution receipt', 100, context.abortSignal);
    for (const [key, value] of Object.entries(cronIdentity)) assert.equal(completedExecution.run[key], value);
    assert.equal(completedExecution.run.automaticReplay, false);
    assert.ok(completedExecution.run.startedAt);
    assert.ok(completedExecution.run.finishedAt);
    const succeededReceiptEvidence = {
        jobId: completedExecution.run.jobId,
        triggerId: completedExecution.run.triggerId,
        scheduledAt: completedExecution.run.scheduledAt,
        requestId: completedExecution.run.requestId,
        threadId: completedExecution.run.threadId,
        turnId: completedExecution.run.turnId,
        attemptId: completedExecution.run.attemptId,
        status: completedExecution.run.status,
    };
    const succeededReceiptObservedAt = Date.now();
    recordTimeline('cron', {
      event: 'succeeded-execution-receipt-observed', at: succeededReceiptObservedAt,
      payload: succeededReceiptEvidence,
    });
    await persistCronMilestone('04-succeeded-execution-receipt', succeededReceiptEvidence);
    assert.equal(cron.model.requests.length, 1);
    assert.equal(cron.model.requestOutcomes[0].aborted, false);
    const cronProcesses = await findOwnedExecutableProcesses({
      pgid: cron.gateway.child.pid,
      executablePath: binaryIdentity.path,
    });
    assert.ok(cronProcesses.some(item => item.sha256 === EXPECTED_BINARY_SHA256));
    evidence.processes.push(...cronProcesses.map(({ pid, sha256 }) => ({ fixture: 'cron', pid, sha256 })));
    evidence.cases.push({
      name: 'confirmed-one-shot-cron-four-natural-refreshes', result: 'PASS',
      workspaceOwnedByRun: cron.workspace.startsWith(context.stateDir),
      deviceId: cronOwner.grant.deviceId,
      authorizationGeneration: cronOwner.grant.authorizationGeneration,
      projectAutomationsNegotiated: true,
      jobId: job.id,
      cronRunStartedObservedOnOwnedRpc: true,
      initializedSessionId: cronOwner.initialized.sessionId,
      actualAutomaticThreadId: cronThreadId,
      appServerPidsBefore: cronBackendPidsBefore,
      appServerPidsWhileHeld: cronBackendPidsHeld,
      originalWsLeaseExpiresAt: cronInitialLease,
      finalGrantExpiresAt: cronRenewal.grant.expiresAt,
      originalSocketStayedOpen: cronRenewal.socket.readyState === OPEN,
      providerRequests: cron.model.requests.length,
      executionReceiptStatus: completedExecution.run.status,
      executionIdentity: cronIdentity,
      rotations: cronRenewal.rotations,
      setupRotations: cronRenewal.setupRotations,
    });
    await cronOwner.closeRpc();

    const expectedCaseNames = RUN_MODE === 'cron'
      ? ['confirmed-one-shot-cron-four-natural-refreshes']
      : ['active-goal-continuation-four-natural-refreshes', 'confirmed-one-shot-cron-four-natural-refreshes'];
    assert.deepEqual(evidence.cases.map(testCase => testCase.name), expectedCaseNames,
      'only the explicitly selected lifecycle cases may be reported as executed');
    assert.equal((await hashExecutableFile(BINARY)).sha256, EXPECTED_BINARY_SHA256);
    const gatewayRuntimeAfter = await validateCurrentArchivedGateway();
    assert.deepEqual(gatewayRuntimeAfter, gatewayRuntime, 'frozen Gateway source, dependencies, Node, and CLI pins must remain stable');
    evidence.gatewayRuntimeAfter = {
      root: gatewayRuntimeAfter.root,
      manifestSha256: gatewayRuntimeAfter.manifestSha256,
      sourceTreeSha256: gatewayRuntimeAfter.sourceTreeSha256,
      dependencyTreeSha256: gatewayRuntimeAfter.dependencyTreeSha256,
      scriptSha256: gatewayRuntimeAfter.scriptSha256,
      nodeVersion: gatewayRuntimeAfter.nodeVersion,
      nodeExecutable: gatewayRuntimeAfter.nodeExecutable,
    };
    evidence.result = 'PASS';
    return {
      actualGatewayAndRustAppServer: true,
      ...(RUN_MODE === 'cron' ? {} : { goalAutomaticContinuation: { naturalRefreshes: 4, providerRequests: 2, noReplay: true } }),
      cronScheduledExecution: { naturalRefreshes: 4, providerRequests: 1, noReplay: true, receiptStatus: 'succeeded' },
      loopbackDeterministicProviderOnly: true,
      personalOrProductionAutomationTouched: false,
      noGoalOrCronProductUIClaim: true,
    };
  } catch (error) {
    failure = error;
    evidence.result = 'FAIL';
    evidence.error = context.redactText(error.message);
    throw error;
  } finally {
    try {
      await context.writeArtifactJson('goal-cron-auth-renewal.json', evidence);
    } catch (error) {
      if (!failure) throw error;
    }
  }
});
