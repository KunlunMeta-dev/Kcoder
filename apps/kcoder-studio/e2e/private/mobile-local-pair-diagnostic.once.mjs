import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";
import { createBoundedRelayDiagnosticCollector } from "../harness/public-relay-diagnostics.mjs";
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from "./rpc-ws-diagnostic.mjs";

const MAIN_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX";
const RELAY_ROOT = resolve(MAIN_ROOT, "apps/kcoder-relay");
const FIXTURE_ROOT = resolve(MAIN_ROOT, "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-infra.e2e.mjs/20261007-183008.205Z/state");
const CLI_PROOF_ROOT = resolve(repoRoot, "target/private-phone-ux-validation/b2-static03-build-20261008");
const CLI = resolve(CLI_PROOF_ROOT, "frozen-candidate/kcoder");
const CLI_SHA256 = "289618f7e0670be9840b48adcd93d73261ea1c20034596ae6a95d5ed41f3b67d";
const CLI_SOURCE_DIGEST = "0a51d82e17ef78d9db034d34143258b49f094d605a2e89e2c2e8498e70ffc15b";
const SOURCE_PINS = Object.freeze({
  "gateway/dev-server.mjs": [resolve(appRoot, "dev-server.mjs"), "b791281b303dfebad4b5686fc2d262503dfe6fa1957bef8b2a2fb10942024003"],
  "gateway/server-config.js": [resolve(appRoot, "src/server-config.js"), "39a5058b453a4abb76752862f275121fa370c48d224ad30dbd84b90a2f402b01"],
  "gateway/workspace-app-server-broker.js": [resolve(appRoot, "src/workspace-app-server-broker.js"), "de270981df51156abcc4320113f0717fa238b7cdbfbea6027098b711c19ceb59"],
  "gateway/mobile-device-auth.js": [resolve(appRoot, "src/mobile-device-auth.js"), "2bbaa56e754ddb757ed129d88042e738917bdcb38adb9de525593435cfb9d125"],
  "gateway/gateway-admission.js": [resolve(appRoot, "src/gateway-admission.js"), "d754a93cd544ed9b9facfa8223a7740f8b9098a942b13a55ec4dcb7623d2ee4c"],
  "gateway/mobile-device-private-storage.js": [resolve(appRoot, "src/mobile-device-private-storage.js"), "19aaa69ea9b8a7b548fbf698358834ce6e3196f3629c78761e15263f0307d1d6"],
  "relay/server.mjs": [resolve(RELAY_ROOT, "src/server.mjs"), "941172ab1e4415d5fdc9d02f2efb787fe144c7032f3853013bbdb13ac2826a5e"],
  "relay/client.mjs": [resolve(RELAY_ROOT, "src/client.mjs"), "339d7d85a203d2a6293138c000d0a17aa6bb0de1ae40bb9e524aae0073d988f8"],
  "relay/client-identity.mjs": [resolve(RELAY_ROOT, "src/client-identity.mjs"), "c9e22731e4b553b1060f5dc4060de5ff4f37483527ade1a28104741c2500aa7d"],
  "relay/transport.mjs": [resolve(RELAY_ROOT, "src/transport.mjs"), "8b94ae9f08cf088e4afdc59bba6594554cc3cd488f151a2229b9340eac8bf012"],
  "relay/package.json": [resolve(RELAY_ROOT, "package.json"), "9c9899c86c106b0ccbce4c635f6a8df0128559ab5bcedff5ed72cca84db095cb"],
  "relay/package-lock.json": [resolve(RELAY_ROOT, "package-lock.json"), "f4491ba93c4c858c4d17edacdffa49f2da84f48b4284441cb38d101f1ee591b0"],
  "relay/ws/package.json": [resolve(RELAY_ROOT, "node_modules/ws/package.json"), "c1ef91ca04eb4754c011c5f0e7638b5078ff71104fada400c44ac761cf93e0b1"],
  "e2e/gateway-harness.mjs": [resolve(appRoot, "e2e/harness/gateway.mjs"), "7cef55697a767cb78c88dd9c4c72203e9db129e16d8502341e5496d3a325a2c9"],
  "e2e/private/rpc-ws-diagnostic.mjs": [resolve(appRoot, "e2e/private/rpc-ws-diagnostic.mjs"), "31578823aaf3fea2d874ed2004b1d4f54da6476837246f348f10da8802e18c0d"],
  "e2e/private/header-websocket-ws-diagnostic.mjs": [resolve(appRoot, "e2e/private/header-websocket-ws-diagnostic.mjs"), "8ad8c60e952a3e00e5c8893e10a27d9d02b50c650675387624abe77c46bbb898"],
  "e2e/run-context.mjs": [resolve(appRoot, "e2e/harness/run-context.mjs"), "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11"],
  "e2e/workspace-fixture.mjs": [resolve(appRoot, "e2e/harness/workspace-fixture.mjs"), "00ffb4d817430b0fb7d3b08a23e918c9ab97b58a461425dfd16b364d1cbec8cd"],
  "e2e/public-relay-diagnostics.mjs": [resolve(appRoot, "e2e/harness/public-relay-diagnostics.mjs"), "05ac6a39900bc62738d51669c97f762655d325528c8079761c60135f55d4c605"],
});
const FIXTURE_PINS = Object.freeze({
  "pairing-fixtures": ["private-mobile-pairing-fixtures.json", "69db372a3a09a1654926beb724bc298ac1a34f3b82a81f40d19480e9559792f2"],
  "registration-store": ["relay-registration-store.json", "9725ea6c6280031a0da0bd14afe33247caca5234796b6553af3660dc84fbbeb8"],
  "alpha-client-identity": ["relay-client-alpha.json", "47d4edf86ce4b26277109cbe1bcb48a9ce5f10b9eeab3df6e45a547d4cbafa38"],
});
const KNOWN_ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "AssertionError", "TimeoutError", "AbortError", "AggregateError"]);

assert.equal(process.env.KCODER_E2E_LOCAL_PAIR_DIAGNOSTIC, "1", "local pair diagnostic requires explicit enable");
assert.equal(process.version, "v22.17.0", "use the reviewed Node runtime");

await runE2E(import.meta.url, {
  testId: "mobile-local-gateway-relay-pair-diagnostic",
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "Local real Gateway + loopback Relay pair exchange and direct Rust app-server initialize only; no turn, Provider, Browser, public route, or phone claim",
  cleanupTimeoutMs: 30_000,
}, async context => {
  const sourceBefore = await collectSourcePins();
  assert.equal((await filePin(CLI)).sha256, CLI_SHA256, "fixed CLI input must match the approved binary");
  const archivePath = resolve(CLI_PROOF_ROOT, "source-archive.json");
  assert.equal(await shaFile(archivePath), "1c3388b58f89e9d4a2dc45ed3fc41a307126f108500e93d2689330f447003789");
  const cliArchive = JSON.parse(await readFile(archivePath, "utf8"));
  assert.equal(cliArchive.sourceDigest, CLI_SOURCE_DIGEST);
  assert.equal(cliArchive.fileCount, 17);
  for (const row of cliArchive.files) {
    assert.deepEqual(await filePin(resolve(CLI_PROOF_ROOT, "sources", row.path)), { bytes: row.bytes, sha256: row.sha256 });
  }
  await assertPrivateDirectory(FIXTURE_ROOT);
  const fixtureFiles = {};
  for (const [label, [name, expectedSha]] of Object.entries(FIXTURE_PINS)) {
    const path = resolve(FIXTURE_ROOT, name);
    await assertPrivateFile(path);
    const info = await filePin(path);
    assert.equal(info.sha256, expectedSha, `${label} source pin changed`);
    fixtureFiles[label] = info;
  }

  const results = {
    classification: "local direct and loopback Relay-proxied WebSocket to the same real Gateway/fixed Rust initialize; loopback transport is ws, not TLS, and this is not public/full path/turn/mobile UI",
    nodeVersion: process.version,
    cli: { sha256: CLI_SHA256, sourceDigest: CLI_SOURCE_DIGEST, configuredForGateway: true, childStartProof: "not-yet-verified" },
    gatewayMock: false,
    providerCalls: 0,
    rpcCalls: { initialize: 0, initializedNotification: 0, turn: 0 },
    rustInitialize: { state: "not-attempted", websocketOpened: false, initializedNotificationSent: false, socketCleanup: "not-opened", initializeRequestCount: 0, elapsedMs: null, response: null, childProof: null, errorMetadata: null },
    relayRustInitialize: { state: "not-attempted", websocketOpened: false, initializedNotificationSent: false, socketCleanup: "not-opened", initializeRequestCount: 0, elapsedMs: null, response: null, childProof: null, errorMetadata: null },
    fixtureFiles,
    sourceBefore,
    pairs: [],
    relayDataChannels: null,
    websocketTransportDiagnostics: [],
    websocketTransportDiagnosticsDropped: 0,
    cleanup: { direct: { state: "not-created" }, relay: { state: "not-created" } },
  };
  let collector = null;
  await context.writeArtifactJson("local-pair-diagnostic-inputs-before.json", {
    sourcePins: sourceBefore,
    cli: { sha256: CLI_SHA256, sourceDigest: CLI_SOURCE_DIGEST, childStartProof: "not-yet-verified" },
    fixtureFiles,
    runtimeTopology: "run-owned Gateway + run-owned loopback Relay; direct and Relay Host/Origin pairs both include their exact ephemeral listener ports; Gateway admission explicitly allows those two origins and Relay sharedHosts contains only the Relay authority",
  });
  // LIFO order: these final evidence checks execute after sessions, client, Relay, and Gateway cleanup.
  context.addCleanup("write final local pairing evidence", () => {
    results.relayDiagnostics = collector?.snapshot?.() ?? null;
    return context.writeArtifactJsonInternal("local-pair-diagnostic.json", results);
  });
  context.addCleanup("verify pinned sources after cleanup", async () => {
    const sourceAfter = await collectSourcePins();
    assert.deepEqual(sourceAfter, sourceBefore, "pinned Gateway/Relay/CLI inputs changed during local pair diagnostic");
    results.sourceAfter = sourceAfter;
    await context.writeArtifactJsonInternal("local-pair-diagnostic-source-after.json", sourceAfter);
  });

  const fixtureDocument = await readPrivateJson(resolve(FIXTURE_ROOT, "private-mobile-pairing-fixtures.json"));
  const storeDocument = await readPrivateJson(resolve(FIXTURE_ROOT, "relay-registration-store.json"));
  const clientIdentity = await readPrivateJson(resolve(FIXTURE_ROOT, "relay-client-alpha.json"));
  const pair = fixtureDocument.alpha;
  const registration = storeDocument.gateways?.find(row => row.id === pair?.id);
  assert.match(pair?.id || "", /^[a-f0-9]{32}$/);
  assert.match(pair?.pairingToken || "", /^[A-Za-z0-9._~-]{32,512}$/);
  assert.ok(registration && registration.id === pair.id && registration.pairingToken === pair.pairingToken
    && registration.secret === clientIdentity.secret && clientIdentity.id === pair.id,
  "alpha private Gateway/Relay pairing fixtures must be bound");
  assert.equal(clientIdentity.pairingTokenHash, createHash("sha256").update(pair.pairingToken).digest("hex"));
  for (const value of [pair.id, pair.pairingToken, registration.secret, registration.enrollmentTokenHash]) context.registerSecret(value);

  const workspace = await materializeWorkspace(context, "minimal", { instanceId: "local-pair-diagnostic" });
  const configDir = context.pathInState("gateway-config");
  await mkdir(configDir, { mode: 0o700 });
  const settingsFile = await context.writeStateJson("gateway-config/settings.json", {
    hooks: {}, active_provider: "pair-diagnostic-no-provider",
    providers: { "pair-diagnostic-no-provider": { api_format: "openai_chat_completions", endpoint: "http://127.0.0.1:9/v1", default_model: "unused",
      context_window_tokens: 8192, output_headroom_tokens: 1024, max_output_tokens: 1024, discover_models: false, no_proxy: true } },
  });
  const dummyKey = "local-pair-diagnostic-no-provider-call";
  context.registerSecret(dummyKey);
  await context.writeStateJson("gateway-config/credentials.json", { "pair-diagnostic-no-provider": { type: "api", key: dummyKey } });
  const serversFile = await context.writeStateJson("gateway-servers.json", [{ id: "pair-fixture", label: "Owned pair diagnostic fixture",
    runtime: "kcoder", transport: "local", command: CLI, workspacePath: workspace.path, settingsFile }]);

  collector = createBoundedRelayDiagnosticCollector({ redactText: value => context.redactText(value), maxEvents: 128, maxBytes: 32 * 1024 });
  const relayProxyPort = await reserveLoopbackPort();
  const gatewayPort = await reserveLoopbackPort();
  assert.notEqual(relayProxyPort, gatewayPort, "owned Relay and Gateway fixture ports must be distinct");
  const gatewayAuthority = `127.0.0.1:${gatewayPort}`;
  const gatewayOrigin = `http://${gatewayAuthority}`;
  const relayAuthority = `127.0.0.1:${relayProxyPort}`;
  const relayOrigin = `http://${relayAuthority}`;
  results.routeAuthorities = { directGateway: gatewayAuthority, directOrigin: gatewayOrigin,
    relayProxy: relayAuthority, relayOrigin };
  const relayStore = await context.writeStateJson("relay-registration-store-alpha-only.json", {
    version: storeDocument.version,
    gateways: [{ id: registration.id, secret: registration.secret, pairingToken: registration.pairingToken,
      enrollmentTokenHash: registration.enrollmentTokenHash }],
  });
  const { startRelay } = await import(pathToFileURL(resolve(RELAY_ROOT, "src/server.mjs")));
  const relay = await startRelay({ gateways: [], sharedHosts: [relayAuthority], registrationStoreFile: relayStore,
    controlPort: 0, proxyPort: relayProxyPort });
  assert.equal(relay.proxyPort, relayProxyPort, "Relay must bind the exact authority prepared for Gateway admission");
  context.registerPort("local-pair-relay-control", relay.controlPort);
  context.registerPort("local-pair-relay-proxy", relay.proxyPort);
  context.addCleanup("close owned loopback Relay servers", () => relay.close());
  const gateway = await startGateway(context, {
    label: "local-pair-diagnostic-gateway", auth: true, authToken: pair.pairingToken,
    port: gatewayPort,
    workspace: workspace.path, serversFile, serversStore: context.pathInState("gateway-server-store.json"),
    kcoderBin: CLI, gatewayRoot: appRoot, allowedHosts: `${gatewayAuthority},${relayAuthority}`,
    env: {
      KCODER_STUDIO_MOCK: "0",
      KCODER_HOME: context.pathInState("gateway-home"),
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_PUBLIC_ORIGINS: `${gatewayOrigin},${relayOrigin}`,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: `${gatewayOrigin},${relayOrigin}`,
    },
  });
  const { startClient } = await import(pathToFileURL(resolve(RELAY_ROOT, "src/client.mjs")));
  let relayOnline = false;
  const client = startClient({ url: `http://127.0.0.1:${relay.controlPort}`, secret: registration.secret,
    gatewayId: registration.id, gateway: gateway.baseUrl, allowInsecure: true, retryMs: 750,
    onOnline: () => { relayOnline = true; }, onDiagnostic: record => collector.push(record) });
  context.addCleanup("stop owned loopback Relay client", () => client.close());
  await waitFor(() => relayOnline, 10_000, "local Relay control channel online", 25, context.abortSignal);

  const directSession = makeSessionRecord("direct-gateway");
  const relaySession = makeSessionRecord("loopback-relay");
  results.cleanup.direct = directSession.cleanup;
  results.cleanup.relay = relaySession.cleanup;
  // Register cleanup before either POST. Missing/invalid response tokens remain explicitly unconfirmed.
  context.addCleanup("revoke loopback Relay pair session once", () => revokeSession(context, relaySession, {
    port: relay.proxyPort, path: `/g/${pair.id}/api/mobile/session`, route: "relay:/g/<fixture-id>/api/mobile/session",
    authority: relayAuthority, origin: relayOrigin,
  }));
  context.addCleanup("revoke direct Gateway pair session once", () => revokeSession(context, directSession, {
    port: gateway.port, path: "/api/mobile/session", route: "gateway:/api/mobile/session",
    authority: gatewayAuthority, origin: gatewayOrigin,
  }));

  const beforeDirectOpens = dataOpenCount(collector);
  await pairSession(context, directSession, { port: gateway.port, path: "/api/mobile/session", route: "gateway:/api/mobile/session",
    token: pair.pairingToken, authority: gatewayAuthority, origin: gatewayOrigin });
  const afterDirectOpens = dataOpenCount(collector);
  assert.equal(afterDirectOpens - beforeDirectOpens, 0, "direct Gateway pairing must not open a Relay data channel");
  assert.ok(directSession.statusCode === 200 && directSession.schema?.valid, "direct Gateway pair endpoint must issue a valid session grant");

  // This direct local initialize preflight is independent of the later Relay POST/data-channel assertions.
  await initializeLocalRustAppServer(context, gateway, directSession, workspace.path, settingsFile, results);

  const beforeRelayOpens = dataOpenCount(collector);
  await pairSession(context, relaySession, { port: relay.proxyPort, path: `/g/${pair.id}/api/mobile/session`,
    route: "relay:/g/<fixture-id>/api/mobile/session", token: pair.pairingToken, authority: relayAuthority, origin: relayOrigin });
  const afterRelayOpens = dataOpenCount(collector);
  assert.equal(afterRelayOpens - beforeRelayOpens, 1, "one Relay-proxied pair POST must create exactly one data channel");
  assert.notEqual(directSession.accessToken, relaySession.accessToken, "each pairing must create an independent session");
  results.sessionCredentialsDistinct = true;
  results.relayDataChannels = {
    directPairDelta: afterDirectOpens - beforeDirectOpens,
    relayPairDelta: afterRelayOpens - beforeRelayOpens,
    events: collector.snapshot(),
  };
  assert.ok(relaySession.statusCode === 200 && relaySession.schema?.valid, "loopback Relay pair endpoint must issue a valid session grant");

  const relayRpcUrl = new URL(`/g/${pair.id}/rpc`, `ws://${relayAuthority}`);
  relayRpcUrl.searchParams.set("token", relaySession.rpcToken);
  relayRpcUrl.searchParams.set("server", "pair-fixture");
  relayRpcUrl.searchParams.set("workspace", workspace.path);
  const relayWssOpenBefore = dataOpenCount(collector);
  const relayWssEventStart = collector.snapshot().eventCount;
  await initializeLocalRustAppServer(context, gateway, relaySession, workspace.path, settingsFile, results, {
    route: "loopback-relay-ws", rpcUrl: relayRpcUrl.href, requestOrigin: relayOrigin, observation: results.relayRustInitialize,
  });
  const relayWssOpenAfter = dataOpenCount(collector);
  results.relayRustInitialize.dataChannelOpenDelta = relayWssOpenAfter - relayWssOpenBefore;
  assert.equal(results.relayRustInitialize.dataChannelOpenDelta, 1,
    "one Relay-routed Gateway RPC initialize must use exactly one additional accepted data channel");
  const relayWssEvents = collector.snapshot().events.slice(relayWssEventStart)
    .filter(event => event.event === "data_open" || event.event === "local_connect");
  const relayWssDataOpens = relayWssEvents.filter(event => event.event === "data_open");
  const relayWssLocalConnects = relayWssEvents.filter(event => event.event === "local_connect");
  assert.equal(relayWssDataOpens.length, 1, "the RPC route must have one correlated accepted Relay data socket");
  assert.equal(relayWssLocalConnects.length, 1, "the accepted Relay data socket must connect to the owned Gateway");
  assert.equal(relayWssDataOpens[0].correlation, relayWssLocalConnects[0].correlation,
    "Relay data acceptance and local Gateway connection must share the same hashed channel correlation");
  results.relayDataChannels.rpcInitialize = {
    acceptedDataOpenCount: relayWssDataOpens.length,
    localGatewayConnectCount: relayWssLocalConnects.length,
    sameChannelCorrelation: true,
    events: relayWssEvents,
  };
  results.relayDataChannels.finalSnapshot = collector.snapshot();

  assert.equal(results.rpcCalls.initialize, 2, "direct and Relay routes must each initialize once");
  assert.equal(results.rpcCalls.initializedNotification, 2, "both initialized notifications must be sent");

  assert.equal(collector.snapshot().droppedCount, 0);
  assert.equal(collector.snapshot().rejectedCount, 0);

  async function pairSession(ctx, session, { port, path, route, token, authority, origin }) {
    const body = Buffer.from(JSON.stringify({ token }), "utf8");
    const response = await requestHttp(ctx, { port, path, method: "POST", body, parseJson: true, timeoutMs: 12_000, authority, origin });
    const schema = schemaProjection(response.payload);
    const errorMetadata = response.errorMetadata ?? (response.statusCode !== 200
      ? { errorName: "HttpStatusFailure" } : !schema.valid ? { errorName: "InvalidResponseSchema" } : null);
    Object.assign(session, { route, elapsedMs: response.elapsedMs, statusCode: response.statusCode,
      responseBytes: response.responseBytes, schema, error: Boolean(errorMetadata), errorMetadata });
    if (typeof response.payload?.accessToken === "string") {
      ctx.registerSecret(response.payload.accessToken); session.accessToken = response.payload.accessToken;
    }
    if (typeof response.payload?.rpcToken === "string") {
      ctx.registerSecret(response.payload.rpcToken);
      session.rpcToken = response.payload.rpcToken;
    }
    if (typeof response.payload?.refreshToken === "string") ctx.registerSecret(response.payload.refreshToken);
    results.pairs.push({ stage: session.stage, route, elapsedMs: session.elapsedMs, statusCode: session.statusCode,
      responseBytes: session.responseBytes, schema: session.schema, error: session.error, errorMetadata: session.errorMetadata });
    body.fill(0);
  }
});

function makeSessionRecord(stage) {
  return { stage, route: null, accessToken: null, rpcToken: null, elapsedMs: null, statusCode: null, responseBytes: 0,
    schema: null, error: false, errorMetadata: null,
    cleanup: { state: "unknown-no-response", statusCode: null, responseBytes: null, elapsedMs: null, error: false, errorMetadata: null } };
}

async function initializeLocalRustAppServer(context, gateway, session, workspacePath, settingsFile, results,
  { route = "direct-gateway", rpcUrl: suppliedRpcUrl, requestOrigin = gateway.baseUrl, observation = results.rustInitialize } = {}) {
  assert.ok(session.accessToken && session.rpcToken, "local Gateway session must provide in-memory HTTP and RPC credentials");
  const startedAt = performance.now();
  let rpc;
  try {
    const url = suppliedRpcUrl ? new URL(suppliedRpcUrl) : new URL(gatewayRpcUrl(gateway, "pair-fixture", session.rpcToken));
    if (!suppliedRpcUrl) url.searchParams.set("workspace", workspacePath);
    const parsedOrigin = new URL(requestOrigin);
    assert.equal(parsedOrigin.origin, requestOrigin, "RPC Origin must be a canonical origin");
    assert.equal(parsedOrigin.host, url.host, "RPC Host authority and Origin authority must match exactly");
    rpc = await openRpc(url.href, {
      headers: { Origin: requestOrigin, Authorization: `Bearer ${session.accessToken}` },
      timeoutMs: 10_000,
      onDiagnostic: record => recordWsTransportDiagnostic(results, route, record),
    });
    observation.websocketOpened = true;
    observation.socketCleanup = "registered";
    context.addCleanup(`close ${route} local Rust initialize socket`, async () => {
      try {
        await closeRpcAndWait(rpc, `${route} local Rust initialize socket`, 5_000);
        observation.socketCleanup = "confirmed-closed";
      } catch {
        observation.socketCleanup = "failed";
        throw new Error("direct local Rust initialize socket cleanup failed");
      }
    });

    observation.initializeRequestCount = 1;
    results.rpcCalls.initialize += 1;
    const initialized = await rpc.request("initialize", {
      protocolVersion: "2026-07-27",
      clientInfo: { name: `mobile-local-rust-initialize-${route}`, version: "1" },
    }, 15_000);
    const isObject = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
    const response = {
      protocolVersionMatches: initialized?.protocolVersion === "2026-07-27",
      serverInfoObject: isObject(initialized?.serverInfo),
      serverInfoNameMatches: initialized?.serverInfo?.name === "kcoder-app-server",
      serverInfoVersionString: typeof initialized?.serverInfo?.version === "string" && initialized.serverInfo.version.length > 0,
      capabilitiesObject: isObject(initialized?.capabilities),
      approvalsBoolean: typeof initialized?.capabilities?.approvals === "boolean",
      questionsBoolean: typeof initialized?.capabilities?.questions === "boolean",
      threadResumeBoolean: typeof initialized?.capabilities?.threadResume === "boolean",
      experimentalCapabilitiesObject: isObject(initialized?.capabilities?.experimental),
    };
    observation.response = response;
    assert.equal(response.protocolVersionMatches, true, "local Rust initialize must return the pinned app-server protocol version");
    for (const [key, value] of Object.entries(response)) {
      assert.equal(value, true, `local Rust initialize result contract failed: ${key}`);
    }
    rpc.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    observation.initializedNotificationSent = true;
    results.rpcCalls.initializedNotification += 1;
    assert.equal(results.rpcCalls.turn, 0, "initialize-only preflight must not issue a turn");
    assert.equal(results.providerCalls, 0, "initialize-only preflight must not call a Provider");

    observation.childProof = await proveOwnedRustChild(gateway.child.pid, settingsFile, workspacePath);
    observation.state = "passed";
    observation.elapsedMs = roundedMs(performance.now() - startedAt);
    results.cli.childStartProof = "proven-by-/proc-descendant-exe-and-argv";
  } catch (error) {
    observation.state = "failed";
    observation.errorMetadata = safeErrorMetadata(error);
    throw new Error("local real Rust app-server initialize-only preflight failed");
  } finally {
    observation.elapsedMs = roundedMs(performance.now() - startedAt);
  }
}

async function proveOwnedRustChild(gatewayPid, settingsFile, workspacePath) {
  const nodes = [];
  for (const name of await readdir("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const statLine = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = statLine.slice(statLine.lastIndexOf(")") + 2).trim().split(/\s+/);
      nodes.push({ pid: Number(name), parent: Number(fields[1]) });
    } catch {}
  }
  const descendants = new Set([gatewayPid]);
  for (let pass = 0; pass < nodes.length; pass++) {
    for (const row of nodes) if (descendants.has(row.parent)) descendants.add(row.pid);
  }
  const binaryRealpath = await realpath(CLI);
  const matches = [];
  for (const pid of descendants) {
    if (pid === gatewayPid) continue;
    try {
      if (await realpath(`/proc/${pid}/exe`) !== binaryRealpath) continue;
      const argv = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").split("\0").filter(Boolean);
      const expectedArgv = [CLI, "--settings-file", settingsFile, "--cwd", workspacePath, "app-server"];
      const argvProjection = {
        executableMatchesFixedCli: argv[0] === CLI,
        settingsFileArgumentMatches: argv[1] === "--settings-file" && argv[2] === settingsFile,
        workspaceArgumentMatches: argv[3] === "--cwd" && argv[4] === workspacePath,
        appServerSubcommandAtExpectedPosition: argv[5] === "app-server",
        noUnexpectedArguments: argv.length === expectedArgv.length,
      };
      if (Object.values(argvProjection).every(Boolean)) matches.push({ pid, argvProjection });
    } catch {}
  }
  assert.equal(matches.length, 1, "initialize must be served by exactly one Gateway-owned fixed Rust CLI child with expected argv");
  const child = matches[0];
  const childExe = await stat(`/proc/${child.pid}/exe`);
  const fixedExe = await stat(CLI);
  assert.ok(childExe.dev === fixedExe.dev && childExe.ino === fixedExe.ino && childExe.size === fixedExe.size,
    "actual app-server executable must match the fixed CLI file identity");
  return {
    appServerPid: child.pid,
    executableSha256: CLI_SHA256,
    executablePathMatchesFixedCli: true,
    executableIdentityMatches: true,
    argv: child.argvProjection,
  };
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  return port;
}

function recordWsTransportDiagnostic(results, stage, record) {
  const events = new Set([
    "connect_started", "dns_lookup", "tcp_connected", "tls_secure_connect", "socket_error", "socket_close",
    "handshake_write_started", "handshake_write_submitted", "handshake_write_callback", "upgrade_response_bytes",
    "upgrade_response", "upgrade_validation", "open_timeout",
  ]);
  if (!record || !events.has(record.event)) return;
  if (results.websocketTransportDiagnostics.length >= 64) { results.websocketTransportDiagnosticsDropped += 1; return; }
  const safe = { stage, event: record.event };
  if (Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0 && record.elapsedMs <= 30_000) safe.elapsedMs = record.elapsedMs;
  if (["connecting", "tls_handshake", "tls_connected", "tcp_connected", "handshake_write", "upgrade_rejected", "upgrade_invalid", "open"].includes(record.phase)) safe.phase = record.phase;
  if (record.event === "connect_started" && ["tcp", "tls"].includes(record.transport)) safe.transport = record.transport;
  if (record.event === "dns_lookup") {
    if (["complete", "error"].includes(record.outcome)) safe.outcome = record.outcome;
    if (record.family === 4 || record.family === 6) safe.family = record.family;
    if (["dns_failure", "dns_retry", "refused", "reset", "timeout", "unreachable", "tls_certificate", "tls_protocol", "tls_handshake", "protocol", "other"].includes(record.errorKind)) safe.errorKind = record.errorKind;
  }
  if (record.event === "tls_secure_connect") {
    if (typeof record.authorized === "boolean") safe.authorized = record.authorized;
    if (["h2", "http/1.1", "other", "none"].includes(record.alpn)) safe.alpn = record.alpn;
  }
  if (["socket_error", "handshake_write_callback", "upgrade_validation"].includes(record.event) &&
    ["dns_failure", "dns_retry", "refused", "reset", "timeout", "unreachable", "tls_certificate", "tls_protocol", "tls_handshake", "protocol", "other"].includes(record.errorKind)) safe.errorKind = record.errorKind;
  if (record.event === "socket_close") {
    if (typeof record.hadError === "boolean") safe.hadError = record.hadError;
    if (typeof record.handshakeComplete === "boolean") safe.handshakeComplete = record.handshakeComplete;
  }
  if (record.event === "handshake_write_submitted" && typeof record.backpressured === "boolean") safe.backpressured = record.backpressured;
  if (["handshake_write_callback", "upgrade_validation"].includes(record.event) && ["complete", "error", "accepted", "rejected"].includes(record.outcome)) safe.outcome = record.outcome;
  if (record.event === "upgrade_response_bytes" && Number.isSafeInteger(record.firstChunkBytes) && record.firstChunkBytes >= 0) safe.firstChunkBytes = Math.min(record.firstChunkBytes, 1_000_000);
    if (record.event === "upgrade_response" && (record.statusCode === null || (Number.isInteger(record.statusCode) && record.statusCode >= 100 && record.statusCode <= 599))) safe.statusCode = record.statusCode;
    if (record.event === "upgrade_response") safe.statusParsed = record.statusParsed === true;
  results.websocketTransportDiagnostics.push(safe);
}

async function revokeSession(context, session, { port, path, route, authority, origin }) {
  if (!session.accessToken) {
    session.cleanup.state = "unconfirmed-no-access-token";
    return;
  }
  const response = await requestHttp(context, { port, path, method: "DELETE", accessToken: session.accessToken,
    timeoutMs: 8_000, cleanup: true, authority, origin });
  const confirmed = response.statusCode === 204 && response.responseBytes === 0 && !response.errorMetadata;
  Object.assign(session.cleanup, { route, state: confirmed ? "confirmed" : "unconfirmed",
    statusCode: response.statusCode, responseBytes: response.responseBytes, elapsedMs: response.elapsedMs,
    error: !confirmed, errorMetadata: response.errorMetadata ?? (confirmed ? null : { errorName: "HttpStatusFailure" }) });
  assert.equal(session.cleanup.state, "confirmed", `${session.stage} session revoke must return one bounded 204`);
}

function requestHttp(context, { port, path, method, body, parseJson = false, accessToken, timeoutMs, cleanup = false,
  authority, origin }) {
  assert.match(authority || "", /^127\.0\.0\.1:[0-9]{1,5}$/, "HTTP Host must use the exact loopback listener authority");
  const parsedOrigin = new URL(origin);
  assert.equal(parsedOrigin.origin, origin, "HTTP Origin must be a canonical origin");
  assert.equal(parsedOrigin.host, authority, "HTTP Host authority and Origin authority must match exactly");
  return new Promise(resolvePromise => {
    const startedAt = performance.now();
    const headers = { host: authority, origin, connection: "close", accept: "application/json" };
    if (body) { headers["content-type"] = "application/json"; headers["content-length"] = String(body.byteLength); }
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    let settled = false, responseBytes = 0, tooLarge = false;
    const chunks = [];
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      body?.fill(0);
      resolvePromise({ ...result, responseBytes, elapsedMs: roundedMs(performance.now() - startedAt) });
    };
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false,
      ...(cleanup ? {} : { signal: context.abortSignal }) }, res => {
      const statusCode = Number.isInteger(res.statusCode) ? res.statusCode : null;
      res.on("data", chunk => {
        responseBytes += chunk.length;
        if (responseBytes <= 65_536) chunks.push(Buffer.from(chunk));
        else tooLarge = true;
      });
      res.once("end", () => {
        let payload = null;
        if (parseJson && statusCode === 200 && !tooLarge) {
          const raw = Buffer.concat(chunks);
          try { payload = JSON.parse(raw.toString("utf8")); } catch { payload = null; }
          raw.fill(0);
        }
        for (const chunk of chunks) chunk.fill(0);
        finish({ statusCode, payload, errorMetadata: tooLarge ? { errorName: "ResponseTooLarge" } : null });
      });
      res.once("error", error => finish({ statusCode, payload: null, errorMetadata: safeErrorMetadata(error) }));
    });
    const timer = setTimeout(() => {
      const error = Object.assign(new Error("bounded local pair request timed out"), { name: "TimeoutError", code: "ETIMEDOUT" });
      req.destroy(error);
    }, timeoutMs);
    req.once("error", error => finish({ statusCode: null, payload: null, errorMetadata: safeErrorMetadata(error) }));
    req.end(body);
  });
}

function schemaProjection(value) {
  const object = Boolean(value && typeof value === "object" && !Array.isArray(value));
  return {
    object,
    accessTokenString: object && typeof value.accessToken === "string" && value.accessToken.length > 0,
    rpcTokenString: object && typeof value.rpcToken === "string" && value.rpcToken.length > 0,
    expiresAtFinite: object && typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt),
    capabilitiesObject: object && Boolean(value.capabilities && typeof value.capabilities === "object" && !Array.isArray(value.capabilities)),
    refreshCapabilityBoolean: object && typeof value.capabilities?.mobileRefreshV1 === "boolean",
    deviceManagementCapabilityBoolean: object && typeof value.capabilities?.mobileDeviceManagementV1 === "boolean",
    valid: object && typeof value.accessToken === "string" && value.accessToken.length > 0
      && typeof value.rpcToken === "string" && value.rpcToken.length > 0
      && typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
      && Boolean(value.capabilities && typeof value.capabilities === "object" && !Array.isArray(value.capabilities))
      && typeof value.capabilities.mobileRefreshV1 === "boolean"
      && typeof value.capabilities.mobileDeviceManagementV1 === "boolean",
  };
}

function safeErrorMetadata(error) {
  const safeCode = value => typeof value === "string" && /^[A-Z0-9_]{1,64}$/.test(value) ? value : null;
  const socket = error?.cause?.socket;
  return {
    errorName: KNOWN_ERROR_NAMES.has(error?.name) ? error.name : "OtherError",
    errorCode: safeCode(error?.code), causeCode: safeCode(error?.cause?.code),
    socketBytesRead: Number.isSafeInteger(socket?.bytesRead) && socket.bytesRead >= 0 ? socket.bytesRead : null,
    socketBytesWritten: Number.isSafeInteger(socket?.bytesWritten) && socket.bytesWritten >= 0 ? socket.bytesWritten : null,
  };
}

function dataOpenCount(collector) { return collector.snapshot().events.filter(event => event.event === "data_open").length; }
function roundedMs(value) { return Math.round(value * 10) / 10; }

async function collectSourcePins() {
  const rows = {};
  for (const [label, [path, expectedSha256]] of Object.entries(SOURCE_PINS)) {
    await assertRegularNoSymlink(path);
    const pin = await filePin(path);
    assert.equal(pin.sha256, expectedSha256, `${label} source drifted from the reviewed local pairing candidate`);
    rows[label] = pin;
  }
  await assertRegularNoSymlink(CLI);
  const binary = await filePin(CLI);
  assert.equal(binary.sha256, CLI_SHA256);
  rows.cli = binary;
  return rows;
}

async function readPrivateJson(path) {
  await assertPrivateFile(path);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("private test fixture is not valid JSON"); }
}

async function assertPrivateDirectory(path) {
  await noSymlinkPath(path);
  const info = await lstat(path);
  assert.ok(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700,
    "test fixture directory must be owned private mode 0700");
}

async function assertPrivateFile(path) {
  await assertRegularNoSymlink(path);
  const info = await lstat(path);
  assert.ok(info.isFile() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && info.size < 65_536,
    "private fixture must be owned regular mode 0600 and bounded");
}

async function assertRegularNoSymlink(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "pinned runtime input must be a regular non-symlink file");
  assert.equal(await realpath(path), resolve(path), "pinned runtime input must use its canonical path");
}

async function noSymlinkPath(path) {
  let current = "/";
  for (const component of resolve(path).split("/").filter(Boolean)) {
    current = resolve(current, component);
    assert.equal((await lstat(current)).isSymbolicLink(), false, "private fixture boundary cannot traverse a symlink");
  }
}

async function shaFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function filePin(path) { return { bytes: (await stat(path)).size, sha256: await shaFile(path) }; }
