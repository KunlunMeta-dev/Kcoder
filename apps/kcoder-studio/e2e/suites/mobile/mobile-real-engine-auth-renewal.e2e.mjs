import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startClient } from "../../../../kcoder-relay/src/client.mjs";
import { startRelay } from "../../../../kcoder-relay/src/server.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { closeRpcAndWait, openRpc } from "../../harness/rpc.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const accessTtlMs = 20_000;
const socketGraceMs = 5_000;
const refreshLeadMs = 2_000;
const renewalCount = 4;
const relayGatewayId = "engine-renewal";
const maxHttpDiagnostics = 32;
const maxRelayClientDiagnostics = 128;
const httpDiagnosticOperations = new Set([
  "pair-device-a", "list-fixture-servers", "refresh-device-a", "pair-device-b", "refresh-device-b",
  "revoke-device-a", "refresh-revoked-device-a",
]);
const relayClientDiagnosticEvents = new Set([
  "control_connecting", "control_error", "control_close", "control_open",
  "open_rejected", "open_received",
  "data_connecting", "data_error", "data_close", "data_open",
  "local_connecting", "local_error", "local_close", "local_timeout", "local_connect",
  "bridge_closed", "reconnect_scheduled", "client_stopped",
]);
const kcoderBinary = resolve(
  process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"),
);

await runE2E(
  import.meta.url,
  {
    testId: "mobile-real-engine-device-auth-renewal-approval-continuity",
    tier: "full-integration",
    modelPolicy: "real Gateway and KCoder app-server with a loopback-only deterministic approval fixture; excludes Goal, Cron, and long Provider-stream continuity",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 15_000,
  },
  async context => {
    assert.equal(process.platform, "linux", "actual /proc executable provenance is required for this suite");
    const expectedKcoderSha256 = process.env.KCODER_E2E_EXPECTED_KCODER_SHA256 || "";
    assert.match(expectedKcoderSha256, /^[a-f0-9]{64}$/, "set KCODER_E2E_EXPECTED_KCODER_SHA256 to the approved KCoder binary SHA-256");
    assert.ok(process.env.KCODER_E2E_KCODER_BIN, "set KCODER_E2E_KCODER_BIN to the approved KCoder binary");

    const binaryBefore = await hashExecutableFile(kcoderBinary);
    assert.equal(binaryBefore.sha256, expectedKcoderSha256, "configured KCoder binary must match the explicit SHA-256 pin");
    const evidence = {
      scope: "actual KCoder app-server approval hold across four durable-device rotations; not Goal/Cron/provider-stream continuity",
      expectedKcoderSha256,
      configuredKcoderSha256: binaryBefore.sha256,
      configuredKcoderPath: binaryBefore.path,
      gatewayTargetServerId: null,
      backendAppServerId: null,
      accessTtlMs,
      socketGraceMs,
      renewalCount,
      renewals: [],
      httpDiagnostics: [],
      httpDiagnosticsDropped: 0,
      relayClientDiagnostics: [],
      relayClientDiagnosticsDropped: 0,
      result: "running",
    };
    let primaryFailure;
    try {
      const workspace = context.pathInState("workspace");
      const configDir = context.pathInState("config");
      const webRoot = context.pathInState("web-root");
      await Promise.all([
        mkdir(workspace, { recursive: true, mode: 0o700 }),
        mkdir(configDir, { recursive: true, mode: 0o700 }),
        mkdir(webRoot, { recursive: true, mode: 0o700 }),
      ]);

      const relayProxyPort = await reserveLoopbackPort();
      const relayAuthority = `127.0.0.1:${relayProxyPort}`;
      const relaySecret = randomBytes(32).toString("base64url");
      context.registerSecret(relaySecret);

      const model = await startApprovalModelFixture(context, {
        approvalPerTurn: true,
        approvalCommand: `printf 'APPROVAL_ACCEPTED' > '${resolve(workspace, "approval-accepted.txt")}'`,
        approvalFinalText: "Approval command completed.",
      });
      assert.equal(new URL(model.baseUrl).hostname, "127.0.0.1",
        "the deterministic approval provider fixture must remain loopback-only");
      const providerCredential = randomBytes(24).toString("hex");
      context.registerSecret(providerCredential);
      const settingsFile = await context.writeStateJson("approval-settings.json", {
        active_provider: "auth-renewal-fixture",
        permission_mode: "ask",
        providers: {
          "auth-renewal-fixture": {
            api_format: "openai_chat_completions",
            endpoint: model.baseUrl,
            default_model: "auth-renewal-fixture-model",
            context_window_tokens: 128_000,
            output_headroom_tokens: 8_192,
            max_output_tokens: 8_192,
            request_timeout_secs: 30,
            no_proxy: true,
            extra_body: {},
          },
        },
      });
      await context.writeStateJson("config/settings.json", {});
      await context.writeStateJson("config/credentials.json", {
        "auth-renewal-fixture": { type: "api", key: providerCredential },
      });
      const serversFile = await context.writeStateJson("servers.json", [{
        id: "local",
        label: "Isolated authorization renewal fixture",
        transport: "local",
        command: kcoderBinary,
        workspace,
        settingsFile,
      }]);
      const serversStore = context.pathInState("servers-store.json");

      const gateway = await startGateway(context, {
        auth: true,
        label: "mobile-engine-auth-renewal-gateway",
        workspace,
        serversFile,
        serversStore,
        kcoderBin: kcoderBinary,
        env: {
          KCODER_CONFIG_DIR: configDir,
          KCODER_STUDIO_MOCK: "0",
          KCODER_STUDIO_WEB_ROOT: webRoot,
          KCODER_STUDIO_PUBLIC_ORIGINS: `http://127.0.0.1:${relayProxyPort}`,
          KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: String(accessTtlMs),
          KCODER_STUDIO_MOBILE_SOCKET_GRACE_MS: String(socketGraceMs),
        },
      });

      const relay = await startRelay({
        gateways: [{
          id: relayGatewayId,
          secret: relaySecret,
          pairingToken: gateway.authToken,
        }],
        sharedHosts: [relayAuthority],
        controlPort: 0,
        proxyPort: relayProxyPort,
        connectTimeout: 5_000,
        pairingBodyTimeoutMs: 5_000,
      });
      context.registerPort("isolated-engine-renewal-relay-control", relay.controlPort);
      context.registerPort("isolated-engine-renewal-relay-proxy", relay.proxyPort);
      context.addCleanup("close isolated Engine-renewal Relay", () => relay.close());

      let relayOnline = false;
      const relayClient = startClient({
        url: `http://127.0.0.1:${relay.controlPort}`,
        secret: relaySecret,
        gatewayId: relayGatewayId,
        gateway: gateway.baseUrl,
        allowInsecure: true,
        retryMs: 100,
        onOnline: () => { relayOnline = true; },
        onDiagnostic: record => captureRelayClientDiagnostic(context, evidence, record),
      });
      context.addCleanup("stop isolated Engine-renewal Relay Gateway client", () => relayClient.close());
      await waitFor(
        () => relayOnline ? true : null,
        15_000,
        "isolated Relay control channel",
        50,
        context.abortSignal,
      );

      let grantA = await pairDevice(context, evidence, relay, relayGatewayId, gateway.authToken, "device A", "pair-device-a");
      const initialALeaseExpiresAt = grantA.wsLeaseExpiresAt;
      const serverListResponse = await requestRelayJson(context, evidence, relay, relayGatewayId, "/api/servers", {
        operation: "list-fixture-servers",
        accessToken: grantA.accessToken,
      });
      assert.equal(serverListResponse.status, 200, "paired device A must read the authenticated Gateway server list");
      assert.ok(Array.isArray(serverListResponse.payload?.servers), "authenticated server-list response must contain servers");
      assert.equal(serverListResponse.payload.servers.length, 1,
        "the private Gateway server store must expose exactly the one isolated fixture server");
      const fixtureServer = serverListResponse.payload.servers[0];
      assert.equal(fixtureServer.label, "Isolated authorization renewal fixture");
      assert.equal(fixtureServer.transport, "local");
      assert.equal(fixtureServer.workspacePath, workspace,
        "the authoritative Gateway server must use the isolated fixture workspace");
      assert.equal(fixtureServer.command, kcoderBinary,
        "the authoritative Gateway server must use the explicitly pinned KCoder executable");
      assert.equal(fixtureServer.settingsFile, settingsFile,
        "the authoritative Gateway server must use the loopback approval fixture settings");
      const fixtureServerId = fixtureServer.id;
      assert.equal(typeof fixtureServerId, "string", "the authenticated Gateway server list must provide its authoritative id");
      assert.equal(fixtureServerId, "local",
        "the authenticated Gateway target id must exactly match this private fixture's configured route id");
      evidence.gatewayTargetServerId = fixtureServerId;
      evidence.fixtureServer = {
        gatewayTargetId: fixtureServerId,
        count: serverListResponse.payload.servers.length,
        transport: fixtureServer.transport,
        workspaceMatchesFixture: fixtureServer.workspacePath === workspace,
        commandMatchesPinnedBinary: fixtureServer.command === kcoderBinary,
        settingsMatchApprovalFixture: fixtureServer.settingsFile === settingsFile,
      };

      const rpcA = await openDeviceRpc(context, relay, relayGatewayId, grantA, fixtureServerId, "device A");
      const initializedA = await rpcA.request("initialize", initializeParams("auth-renewal-device-a"));
      assert.equal(initializedA.serverInfo?.name, "kcoder-app-server");
      assert.ok(typeof initializedA.sessionId === "string" && initializedA.sessionId.length > 0,
        "the real app-server initialize response must expose its backend Engine session identity");
      const expectedBackendServerId = `server-${initializedA.sessionId}`;
      evidence.backendAppServerId = expectedBackendServerId;
      assert.equal(initializedA.capabilities?.approvals, true);
      assert.equal(initializedA.capabilities?.experimental?.residentThreads, true,
        "the actual app-server must advertise its resident-thread capability");
      assert.equal(initializedA.capabilities?.experimental?.interactionBindingV1, true,
        "actual app-server interaction binding capability must be present");

      const threadStart = await rpcA.request("thread/start", {});
      const threadId = threadStart.thread?.id;
      assert.equal(typeof threadId, "string", "real app-server must create the approval-holding thread");
      const terminalA = await startTerminal(rpcA, workspace);
      await writeTerminalMarker(context, rpcA, terminalA, workspace, "device-a-before-approval.txt", "DEVICE_A_BEFORE_APPROVAL");

      const turnStart = await rpcA.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "MOBILE_ENGINE_AUTH_RENEWAL_APPROVAL_HOLD" }],
      });
      const turnId = turnStart.turn?.id;
      assert.equal(typeof turnId, "string", "real Engine must accept the held turn");

      const backendProcesses = await waitFor(async () => {
        const matches = await findOwnedExecutableProcesses({
          pgid: gateway.child.pid,
          executablePath: binaryBefore.path,
        });
        return matches.length > 0 ? matches : null;
      }, 20_000, "real KCoder app-server process in the owned Gateway process group", 100, context.abortSignal);
      assert.ok(backendProcesses.some(item => item.sha256 === expectedKcoderSha256),
        "the running app-server executable bytes must match the explicit binary SHA-256 pin");
      evidence.appServerProcesses = backendProcesses.map(({ pid, sha256 }) => ({ pid, sha256 }));

      const approval = await rpcA.waitFor(
        message => message.method === "approval/request" && message.params?.threadId === threadId && message.params?.turnId === turnId,
        30_000,
        "real Engine approval request",
      );
      const approvalAt = Date.now();
      const approvalId = approval.params?.approvalId;
      assert.equal(typeof approval.id, "number", "approval must be an unresolved JSON-RPC request from the Engine");
      assert.equal(typeof approvalId, "string");
      assert.equal(approval.params?.serverId, expectedBackendServerId,
        "the Engine approval serverId must match the backend identity derived from initialize.sessionId, separately from the Gateway target id");
      assert.equal(approval.params?.threadId, threadId,
        "the approval must remain bound to the real app-server thread selected for this held turn");
      assert.equal(approval.params?.turnId, turnId,
        "the approval must remain bound to the exact active real Engine turn");
      assert.ok(approvalAt < initialALeaseExpiresAt,
        "the held Engine approval must begin before device A's initial server-issued WebSocket lease expires");
      evidence.initialAWebSocketLeaseExpiresAt = initialALeaseExpiresAt;
      evidence.approvalObservedAt = approvalAt;
      evidence.approvalWasPendingBeforeRenewal = true;
      const approvedCommandMarker = resolve(workspace, "approval-accepted.txt");
      assert.equal(await fileHasContent(approvedCommandMarker, "APPROVAL_ACCEPTED"), false,
        "the Engine approval command must remain unexecuted while the approval request is pending");

      for (let index = 0; index < renewalCount; index += 1) {
        const currentExpiresAt = grantA.expiresAt;
        assert.ok(Number.isSafeInteger(currentExpiresAt),
          "refresh timing must come from the actual server-issued access expiresAt");
        await waitFor(
          () => Date.now() >= currentExpiresAt - refreshLeadMs ? true : null,
          accessTtlMs + 5_000,
          `device A server-issued expiry window ${index + 1}`,
          50,
          context.abortSignal,
        );
        const requestedAt = Date.now();
        const nextGrant = await refreshDevice(context, evidence, relay, relayGatewayId, grantA, "refresh-device-a");
        assert.ok(nextGrant.expiresAt > currentExpiresAt, "routine refresh must advance the server access expiry");
        assert.ok(nextGrant.wsLeaseExpiresAt > initialALeaseExpiresAt,
          "routine refresh must extend device A's bounded WebSocket lease beyond its initial server-issued lease");
        assert.equal(nextGrant.deviceId, grantA.deviceId, "routine refresh must retain the same device family");
        assert.equal(nextGrant.authorizationGeneration, grantA.authorizationGeneration,
          "routine rotation must retain stable device authorization generation");
        assert.notEqual(nextGrant.accessToken, grantA.accessToken, "routine refresh must rotate the access credential");
        assert.notEqual(nextGrant.refreshToken, grantA.refreshToken, "routine refresh must rotate the refresh credential");
        grantA = nextGrant;

        assert.equal(rpcA.socket.readyState, rpcA.socket.constructor.OPEN,
          "routine access rotation must preserve the already-open device A WebSocket owner");
        const read = await rpcA.request("thread/read", { threadId, limit: 10 });
        assert.equal(read.thread?.id, threadId, "the original thread must remain readable on the same WebSocket");
        const terminalList = await rpcA.request("terminal/list", {});
        assert.ok(terminalList.sessions?.some(session => session.session_id === terminalA.sessionId),
          "device A's pre-existing PTY must remain attached through ordinary refresh");
        const markerName = `device-a-after-refresh-${index + 1}.txt`;
        await writeTerminalMarker(context, rpcA, terminalA, workspace, markerName, `DEVICE_A_REFRESH_${index + 1}`);
        assert.equal(hasRpcMessage(rpcA, message => message.method === "approval/resolved" && message.params?.approvalId === approvalId), false,
          "routine refresh must not resolve or cancel the pending approval");
        assert.equal(hasRpcMessage(rpcA, message => message.method === "turn/completed" && message.params?.turnId === turnId), false,
          "routine refresh must not complete or interrupt the held Engine turn");

        evidence.renewals.push({
          sequence: index + 1,
          priorExpiresAt: currentExpiresAt,
          requestAt: requestedAt,
          nextExpiresAt: grantA.expiresAt,
          accessCredentialRotated: true,
          deviceAuthorizationGenerationStable: true,
          sameWebSocketOpen: true,
          sameThreadReadable: true,
          approvalStillPending: true,
          existingPtyAcceptedInput: true,
          initialWebSocketLeaseAlreadyPassed: Date.now() > initialALeaseExpiresAt,
        });
      }

      await waitFor(
        () => Date.now() > Math.max(approvalAt + 3 * accessTtlMs, initialALeaseExpiresAt) ? true : null,
        accessTtlMs + socketGraceMs,
        "approval-held real Engine turn to span more than three access-token TTLs and the initial WebSocket lease",
        50,
        context.abortSignal,
      );
      const initialLeaseCrossedAt = Date.now();
      assert.ok(initialLeaseCrossedAt > initialALeaseExpiresAt,
        "the same held WebSocket must remain active after its original server-issued lease has expired");
      assert.ok(Date.now() < grantA.wsLeaseExpiresAt,
        "the authorized test must revoke before the server-issued bounded socket lease naturally expires");
      assert.equal(rpcA.socket.readyState, rpcA.socket.constructor.OPEN);
      assert.equal(hasRpcMessage(rpcA, message => message.method === "turn/completed" && message.params?.turnId === turnId), false,
        "approval remains pending after more than three short access TTLs");

      rpcA.respond(approval.id, {
        decision: "accept",
        approvalId,
        threadId,
        turnId,
      });
      const approvalResolved = await rpcA.waitFor(
        message => message.method === "approval/resolved" && message.params?.approvalId === approvalId && message.params?.decision === "accept",
        15_000,
        "approval resolution after explicit acceptance",
      );
      assert.equal(approvalResolved.params?.turnId, turnId);
      const completion = await rpcA.waitFor(
        message => message.method === "turn/completed" && message.params?.threadId === threadId && message.params?.turnId === turnId,
        30_000,
        "completion of the explicitly approved real Engine turn",
      );
      assert.ok(completion.params?.turn, "the real Engine turn must finish after the pending approval is accepted");
      assert.equal(await fileHasContent(approvedCommandMarker, "APPROVAL_ACCEPTED"), true,
        "accepting the pending real Engine approval must execute its isolated fixture command");
      evidence.approvalResolved = true;
      evidence.turnCompletedAfterExplicitApproval = true;
      evidence.approvalHeldDurationMs = Date.now() - approvalAt;
      evidence.initialLeaseCrossedAt = initialLeaseCrossedAt;
      evidence.sameWebSocketOpenAfterInitialLease = rpcA.socket.readyState === rpcA.socket.constructor.OPEN;

      const grantB = await pairDevice(context, evidence, relay, relayGatewayId, gateway.authToken, "device B", "pair-device-b");
      assert.notEqual(grantA.deviceId, grantB.deviceId, "the two clients must have separate durable device families");
      const rpcB = await openDeviceRpc(context, relay, relayGatewayId, grantB, fixtureServerId, "device B");
      const initializedB = await rpcB.request("initialize", initializeParams("auth-renewal-device-b"));
      assert.equal(initializedB.serverInfo?.name, "kcoder-app-server");
      const terminalB = await startTerminal(rpcB, workspace);
      await writeTerminalMarker(context, rpcB, terminalB, workspace, "device-b-before-revoke.txt", "DEVICE_B_BEFORE_REVOKE");
      const freshGrantB = await refreshDevice(context, evidence, relay, relayGatewayId, grantB, "refresh-device-b");
      assert.equal(freshGrantB.deviceId, grantB.deviceId);
      assert.ok(Number.isSafeInteger(freshGrantB.expiresAt) && Number.isSafeInteger(freshGrantB.wsLeaseExpiresAt));
      assert.ok(Date.now() < grantA.wsLeaseExpiresAt,
        "device A must be revoked before its bounded active WebSocket lease expires naturally");
      const revoke = await requestRelayJson(context, evidence, relay, relayGatewayId, `/api/mobile/devices/${grantA.deviceId}`, {
        operation: "revoke-device-a",
        method: "DELETE",
        accessToken: freshGrantB.accessToken,
      });
      assert.equal(revoke.status, 204, "device B must be able to revoke device A through the isolated Relay route");
      await waitForRpcClose(rpcA, 10_000, "revoked device A");
      evidence.deviceARevoked = true;
      evidence.deviceAWebSocketClosed = true;

      const rejectedRefresh = await requestRelayJson(context, evidence, relay, relayGatewayId, "/api/mobile/session/refresh", {
        operation: "refresh-revoked-device-a",
        method: "POST",
        body: {
          refreshToken: grantA.refreshToken,
          rotationId: randomUUID(),
          deviceId: grantA.deviceId,
        },
      });
      assert.equal(rejectedRefresh.status, 401, "a revoked device A refresh credential must be rejected");
      evidence.deviceARefreshRejected = true;

      assert.equal(rpcB.socket.readyState, rpcB.socket.constructor.OPEN,
        "revoking device A must leave the independently authorized device B WebSocket open");
      const terminalListB = await rpcB.request("terminal/list", {});
      assert.ok(terminalListB.sessions?.some(session => session.session_id === terminalB.sessionId),
        "device B's own PTY must remain attached after device A revocation");
      await writeTerminalMarker(context, rpcB, terminalB, workspace, "device-b-after-revoke.txt", "DEVICE_B_AFTER_REVOKE");
      evidence.deviceBPtyUsableAfterDeviceARevoke = true;

      const binaryAfter = await hashExecutableFile(kcoderBinary);
      assert.equal(binaryAfter.sha256, expectedKcoderSha256, "configured binary bytes must remain equal to the explicit pin");
      const backendProcessesAfter = await findOwnedExecutableProcesses({
        pgid: gateway.child.pid,
        executablePath: binaryBefore.path,
      });
      assert.ok(backendProcessesAfter.some(item => item.sha256 === expectedKcoderSha256),
        "actual app-server process remains verifiable after device A revoke while B still owns a PTY");
      evidence.configuredKcoderSha256After = binaryAfter.sha256;
      evidence.appServerProcessesAfter = backendProcessesAfter.map(({ pid, sha256 }) => ({ pid, sha256 }));
      evidence.result = "passed";
      return {
        actualGateway: true,
        actualRelayRoute: true,
        actualKcoderAppServerBinarySha256: expectedKcoderSha256,
        gatewayTargetServerId: fixtureServerId,
        backendAppServerId: expectedBackendServerId,
        durableDeviceRotations: renewalCount,
        pendingEngineApprovalHeldForMoreThanThreeAccessTtls: true,
        revokedDeviceWebSocketClosed: true,
        revokedDeviceRefreshRejected: true,
        otherDevicePtyRemainedUsable: true,
        goalsCronAndProviderLongStreamExcluded: true,
      };
    } catch (error) {
      primaryFailure = error instanceof Error ? error : new Error(String(error));
      evidence.result = "failed";
      evidence.failure = { name: primaryFailure.name || "Error", message: context.redactText(primaryFailure.message) };
      throw primaryFailure;
    } finally {
      try {
        await context.writeArtifactJson("mobile-real-engine-auth-renewal.json", evidence);
      } catch (artifactError) {
        if (!primaryFailure) throw artifactError;
        primaryFailure.message = `${primaryFailure.message}; sanitized evidence artifact could not be saved: ${context.redactText(artifactError?.message || String(artifactError))}`;
      }
    }
  },
);

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  return port;
}

async function pairDevice(context, evidence, relay, gatewayId, pairingToken, label, operation) {
  const response = await requestRelayJson(context, evidence, relay, gatewayId, "/api/mobile/session", {
    operation,
    method: "POST",
    body: { token: pairingToken, durableDeviceAuthorization: true, deviceLabel: label },
  });
  assert.equal(response.status, 200, "isolated durable mobile pairing must succeed through Relay");
  const grant = response.payload;
  assert.equal(grant.capabilities?.mobileRefreshV1, true);
  assert.equal(grant.capabilities?.mobileDeviceManagementV1, true);
  assert.equal(response.setCookie, null, "durable device pairing must not create a cookie session");
  for (const value of [grant.accessToken, grant.refreshToken, grant.rpcToken]) {
    if (typeof value === "string") context.registerSecret(value);
  }
  assert.ok(typeof grant.deviceId === "string" && typeof grant.authorizationGeneration === "string");
  assert.ok(Number.isSafeInteger(grant.expiresAt) && Number.isSafeInteger(grant.wsLeaseExpiresAt));
  return grant;
}

async function refreshDevice(context, evidence, relay, gatewayId, grant, operation) {
  const response = await requestRelayJson(context, evidence, relay, gatewayId, "/api/mobile/session/refresh", {
    operation,
    method: "POST",
    body: {
      refreshToken: grant.refreshToken,
      rotationId: randomUUID(),
      deviceId: grant.deviceId,
    },
  });
  assert.equal(response.status, 200, "durable device refresh must succeed through the exact Relay Gateway route");
  const nextGrant = response.payload;
  for (const value of [nextGrant.accessToken, nextGrant.refreshToken, nextGrant.rpcToken]) {
    if (typeof value === "string") context.registerSecret(value);
  }
  return nextGrant;
}

async function requestRelayJson(context, evidence, relay, gatewayId, path, { operation, method = "GET", body, accessToken } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let response;
  try {
    response = await fetch(
      `http://127.0.0.1:${relay.proxyPort}/g/${gatewayId}${path}`,
      {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    recordHttpDiagnostic(context, evidence, {
      operation,
      method,
      outcome: "fetch-error",
      error: safeErrorSummary(error),
      cause: safeErrorSummary(error?.cause),
    });
    throw error;
  }
  const isJson = isJsonContentType(response.headers.get("content-type"));
  const setCookie = response.headers.get("set-cookie");
  if (response.status === 204) {
    recordHttpDiagnostic(context, evidence, {
      operation, method, outcome: "response", status: response.status, isJson, jsonParsed: false,
    });
    return { status: response.status, payload: null, setCookie };
  }
  let payload;
  try { payload = await response.json(); }
  catch {
    recordHttpDiagnostic(context, evidence, {
      operation, method, outcome: "response", status: response.status, isJson, jsonParsed: false,
    });
    throw new Error(`isolated Gateway returned non-JSON HTTP ${response.status}`);
  }
  recordHttpDiagnostic(context, evidence, {
    operation, method, outcome: "response", status: response.status, isJson, jsonParsed: true,
  });
  return { status: response.status, payload, setCookie };
}

function recordHttpDiagnostic(context, evidence, record) {
  if (evidence.httpDiagnostics.length >= maxHttpDiagnostics) {
    evidence.httpDiagnosticsDropped += 1;
    return;
  }
  const safe = {
    observedAtUnixMs: Date.now(),
    operation: httpDiagnosticOperations.has(record.operation) ? record.operation : "unknown",
    method: ["GET", "POST", "DELETE"].includes(record.method) ? record.method : "unknown",
    outcome: ["fetch-error", "response"].includes(record.outcome) ? record.outcome : "unknown",
  };
  if (Number.isInteger(record.status) && record.status >= 100 && record.status <= 599) safe.status = record.status;
  if (typeof record.isJson === "boolean") safe.isJson = record.isJson;
  if (typeof record.jsonParsed === "boolean") safe.jsonParsed = record.jsonParsed;
  const error = safeErrorSummary(record.error);
  const cause = safeErrorSummary(record.cause);
  if (error) safe.error = error;
  if (cause) safe.cause = cause;
  evidence.httpDiagnostics.push(context.redactValue(safe));
}

function safeErrorSummary(error) {
  if (!error || typeof error !== "object") return null;
  const safe = {};
  if (typeof error.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)) safe.name = error.name;
  if (typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)) safe.code = error.code;
  if (Number.isSafeInteger(error.errno)) safe.errno = error.errno;
  if (typeof error.syscall === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(error.syscall)) safe.syscall = error.syscall;
  return Object.keys(safe).length ? safe : null;
}

function isJsonContentType(value) {
  if (typeof value !== "string") return false;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(mediaType);
}

function captureRelayClientDiagnostic(context, evidence, record) {
  if (!record || !relayClientDiagnosticEvents.has(record.event)) return;
  if (evidence.relayClientDiagnostics.length >= maxRelayClientDiagnostics) {
    evidence.relayClientDiagnosticsDropped += 1;
    return;
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 0) return;
  const safe = { event: record.event, generation: record.generation };
  if (Number.isSafeInteger(record.atUnixMs)) safe.atUnixMs = record.atUnixMs;
  if (typeof record.monotonicMs === "number" && Number.isFinite(record.monotonicMs)) safe.monotonicMs = record.monotonicMs;
  if (typeof record.correlation === "string" && /^[a-f0-9]{64}$/.test(record.correlation)) {
    safe.correlationIdHash = record.correlation;
  }
  if (["handshake_status", "timeout", "refused", "reset", "unreachable", "protocol", "transport"].includes(record.errorKind)) {
    safe.errorKind = record.errorKind;
  }
  if (Number.isInteger(record.handshakeStatus) && record.handshakeStatus >= 100 && record.handshakeStatus <= 599) {
    safe.handshakeStatus = record.handshakeStatus;
  }
  if (Number.isInteger(record.closeCode) && record.closeCode >= 1000 && record.closeCode <= 4999) safe.closeCode = record.closeCode;
  if (typeof record.hadError === "boolean") safe.hadError = record.hadError;
  if (["invalid_frame", "invalid_open", "socket_capacity", "gateway_mismatch"].includes(record.rejectReason)) {
    safe.rejectReason = record.rejectReason;
  }
  evidence.relayClientDiagnostics.push(context.redactValue(safe));
}

function initializeParams(name) {
  return {
    protocolVersion: "2026-07-27",
    clientInfo: { name, version: "1" },
    capabilities: { experimental: { interactionBindingV1: true } },
  };
}

async function openDeviceRpc(context, relay, gatewayId, grant, serverId, label) {
  const url = new URL(`ws://127.0.0.1:${relay.proxyPort}/g/${gatewayId}/rpc`);
  url.searchParams.set("token", grant.rpcToken);
  url.searchParams.set("server", serverId);
  url.searchParams.set("channel", "runtime");
  const rpc = await openRpc(url, {
    headers: { authorization: `Bearer ${grant.accessToken}` },
    timeoutMs: 10_000,
  });
  context.addCleanup(`close ${label} real Relay WebSocket`, () => closeRpcAndWait(rpc, label, 5_000));
  return rpc;
}

function hasRpcMessage(rpc, predicate) {
  return rpc.messages().some(predicate);
}

async function waitForRpcClose(rpc, timeoutMs, label) {
  const closedState = rpc.socket.constructor.CLOSED;
  if (rpc.socket.readyState === closedState) return;
  let timer;
  await Promise.race([
    new Promise(resolveClose => rpc.socket.addEventListener("close", resolveClose, { once: true })),
    new Promise((_, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(new Error(`${label} WebSocket did not close`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function startTerminal(rpc, workspace) {
  const result = await rpc.request("terminal/start", { cwd: workspace });
  assert.ok(typeof result.session_id === "string", "the real app-server must start a PTY session");
  return { sessionId: result.session_id };
}

async function writeTerminalMarker(context, rpc, terminal, workspace, filename, marker) {
  const markerPath = resolve(workspace, filename);
  const command = `printf '%s' '${marker}' > '${markerPath}'\n`;
  assert.equal(command.charCodeAt(command.length - 1), 10,
    "PTY marker command must end with an LF so the shell executes it");
  await rpc.request("terminal/write", { session_id: terminal.sessionId, data: command });
  await waitFor(
    async () => await fileHasContent(markerPath, marker) ? true : null,
    5_000,
    `PTY marker ${filename}`,
    50,
    context.abortSignal,
  );
}

async function fileHasContent(path, expected) {
  try { return await readFile(path, "utf8") === expected; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
