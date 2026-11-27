// Isolated frozen-candidate Gateway/Relay WebSocket authorization boundary review.
// Uses only synthetic credentials and mock Gateway RPC; never starts a Provider.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const candidateRoot = process.env.PHONE_AUTH_CANDIDATE_ROOT || join(repoRoot, "target/private-phone-latency-implementation/after-final-mobile-gateway-20261007-2050");
const expectedCandidateDigest = process.env.PHONE_AUTH_CANDIDATE_DIGEST || null;
const expectedCandidateFiles = process.env.PHONE_AUTH_CANDIDATE_COUNT ? Number(process.env.PHONE_AUTH_CANDIDATE_COUNT) : null;
let candidateDigest = null;
let candidateFiles = null;
const candidateLabel = (process.env.PHONE_AUTH_CANDIDATE_LABEL || "2050").replace(/[^A-Za-z0-9._-]/g, "_");
const mobileOrigin = "https://mobile.review";
const relayAuthority = "relay.review";

function credential() { return randomBytes(32).toString("hex"); }

async function verifyCandidate() {
  assert.ok(candidateRoot, "candidate freeze root is required");
  const metadata = JSON.parse(await readFile(join(candidateRoot, "metadata.json"), "utf8"));
  assert.match(metadata.sourceDigest, /^[0-9a-f]{64}$/);
  if (expectedCandidateDigest) assert.equal(metadata.sourceDigest, expectedCandidateDigest);
  if (expectedCandidateFiles !== null) assert.equal(metadata.files, expectedCandidateFiles);
  const manifest = JSON.parse(await readFile(join(candidateRoot, "sha256.json"), "utf8"));
  assert.equal(Object.keys(manifest).length, metadata.files);
  candidateDigest = metadata.sourceDigest;
  candidateFiles = metadata.files;
  for (const [path, digest] of Object.entries(manifest)) {
    const actual = createHash("sha256").update(await readFile(join(candidateRoot, path))).digest("hex");
    assert.equal(actual, digest, `frozen source hash mismatch: ${path}`);
  }
}

async function prepareRuntime(root) {
  const source = join(candidateRoot, "apps/kcoder-studio");
  const target = join(root, "apps/kcoder-studio");
  const relaySource = join(candidateRoot, "apps/kcoder-relay");
  const relayTarget = join(root, "apps/kcoder-relay");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await mkdir(relayTarget, { recursive: true, mode: 0o700 });
  await Promise.all([
    cp(join(source, "dev-server.mjs"), join(target, "dev-server.mjs")),
    cp(join(source, "package.json"), join(target, "package.json")),
    cp(join(source, "src"), join(target, "src"), { recursive: true }),
    cp(join(source, "shared"), join(target, "shared"), { recursive: true }),
    cp(join(relaySource, "package.json"), join(relayTarget, "package.json")),
    cp(join(relaySource, "src"), join(relayTarget, "src"), { recursive: true }),
    symlink(join(repoRoot, "apps/kcoder-studio/node_modules"), join(target, "node_modules"), "dir"),
    symlink(join(repoRoot, "apps/kcoder-relay/node_modules"), join(relayTarget, "node_modules"), "dir"),
  ]);
  return { studioRoot: target, relayRoot: relayTarget };
}

async function createGatewayState(root, authToken) {
  const home = join(root, "home");
  const config = join(home, "config");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(config, { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
  ]);
  const serversStore = join(config, "servers.json");
  await writeFile(serversStore, JSON.stringify([
    { id: "local", label: "WS auth fixture", runtime: "kcoder", transport: "local", workspace },
  ]), { mode: 0o600 });
  return { home, config, workspace, serversStore, authToken, port: 0, child: null };
}

async function startGateway(state, studioRoot) {
  const child = (await import("node:child_process")).spawn(process.execPath, ["dev-server.mjs"], {
    cwd: studioRoot,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: state.home,
      TMPDIR: tmpdir(),
      LANG: "C.UTF-8",
      KCODER_CONFIG_DIR: state.config,
      KCODER_STUDIO_HOST: "127.0.0.1",
      KCODER_STUDIO_PORT: "0",
      KCODER_STUDIO_AUTH_TOKEN: state.authToken,
      KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: "600000",
      KCODER_STUDIO_MOBILE_SOCKET_GRACE_MS: "1000",
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: mobileOrigin,
      KCODER_STUDIO_PUBLIC_ORIGINS: `https://${relayAuthority}`,
      KCODER_STUDIO_ALLOWED_HOSTS: `127.0.0.1,localhost,${relayAuthority}`,
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_WORKSPACE: state.workspace,
      KCODER_STUDIO_SERVERS_STORE: state.serversStore,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;
  let output = "";
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const timer = setTimeout(() => {
    if (!settled) rejectReady(new Error("isolated Gateway startup timed out"));
  }, 10_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    output = (output + chunk).slice(-4096);
    const match = output.match(/KCoder Studio: http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && !settled) {
      settled = true;
      clearTimeout(timer);
      resolveReady(Number(match[1]));
    }
  });
  child.stderr.on("data", () => {});
  child.once("error", () => {
    if (!settled) { settled = true; clearTimeout(timer); rejectReady(new Error("isolated Gateway failed to start")); }
  });
  child.once("exit", () => {
    if (!settled) { settled = true; clearTimeout(timer); rejectReady(new Error("isolated Gateway exited early")); }
  });
  state.port = await ready;
  return state;
}

async function stopGateway(state) {
  const child = state?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => {});
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, "exit").catch(() => {});
    child.kill("SIGKILL");
    await Promise.race([killed, new Promise(resolve => setTimeout(resolve, 1_000))]);
  }
}

function postJson(host, port, path, { headers = {}, body } = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host, port, method: "POST", path, headers: {
      origin: mobileOrigin,
      "content-type": "application/json",
      "content-length": String(bytes.length),
      connection: "close",
      ...headers,
    } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once("error", reject);
    });
    request.setTimeout(5_000, () => request.destroy(new Error("fixture HTTP request timed out")));
    request.once("error", reject);
    request.end(bytes);
  });
}

function probeUpgrade({ host, port, path, origin = mobileOrigin, authorization, protocols }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const headers = {
      host,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": randomBytes(16).toString("base64"),
      "sec-websocket-version": "13",
    };
    if (origin !== null) headers.origin = origin;
    if (authorization !== undefined) headers.authorization = authorization;
    if (protocols !== undefined) headers["sec-websocket-protocol"] = protocols;
    const request = httpRequest({ host: "127.0.0.1", port, method: "GET", path, headers }, response => {
      response.resume();
      finish({ accepted: false, status: response.statusCode ?? 0, event: "http-response" });
    });
    request.setTimeout(5_000, () => request.destroy(new Error("fixture WebSocket probe timed out")));
    request.once("upgrade", (response, socket) => {
      finish({ accepted: response.statusCode === 101, status: response.statusCode ?? 0, event: "upgrade" });
      socket.destroy();
    });
    request.once("response", response => {
      response.resume();
      finish({ accepted: false, status: response.statusCode ?? 0, event: "http-response" });
    });
    request.once("error", error => finish({ accepted: false, status: null, event: "connection-error", code: error.code ?? "unknown" }));
    request.end();
  });
}

test(`${candidateLabel} Gateway/Relay WS credential-carrier boundary (isolated mock RPC)`, { timeout: 60_000 }, async t => {
  await verifyCandidate();
  const tempRoot = await mkdtemp(join(tmpdir(), "kcoder-ws-boundary-review-"));
  let gateway;
  let relay;
  let relayClient;
  try {
    const runtime = await prepareRuntime(tempRoot);
    const authToken = credential();
    const controlSecret = credential();
    gateway = await startGateway(await createGatewayState(tempRoot, authToken), runtime.studioRoot);

    const relayServerModule = await import(pathToFileURL(join(runtime.relayRoot, "src/server.mjs")));
    const relayClientModule = await import(pathToFileURL(join(runtime.relayRoot, "src/client.mjs")));
    relay = await relayServerModule.startRelay({
      gateways: [{ id: "ws-review", secret: controlSecret, pairingToken: authToken }],
      sharedHosts: [relayAuthority],
      controlPort: 0,
      proxyPort: 0,
      connectTimeout: 1_500,
      pairingBodyTimeoutMs: 1_500,
    });
    let onlineResolve;
    const online = new Promise(resolve => { onlineResolve = resolve; });
    relayClient = relayClientModule.startClient({
      url: `http://127.0.0.1:${relay.controlPort}`,
      secret: controlSecret,
      gatewayId: "ws-review",
      gateway: `http://127.0.0.1:${gateway.port}`,
      allowInsecure: true,
      retryMs: 50,
      onOnline: onlineResolve,
    });
    await Promise.race([
      online,
      new Promise((_, reject) => setTimeout(() => reject(new Error("isolated Relay client did not connect")), 8_000)),
    ]);
    const paired = await postJson("127.0.0.1", relay.proxyPort, "/g/ws-review/api/mobile/session", {
      headers: { host: relayAuthority },
      body: { token: authToken, durableDeviceAuthorization: true, deviceLabel: "synthetic protocol review" },
    });
    assert.equal(paired.status, 200, "synthetic durable device pairing succeeds through the isolated Relay");
    const session = JSON.parse(paired.body.toString("utf8"));
    assert.equal(session.capabilities?.mobileRefreshV1, true);
    assert.equal(typeof session.accessToken, "string");
    assert.equal(typeof session.rpcToken, "string");
    const tag = `kcoder-session.${session.accessToken}`;
    // Empty ID is a syntactically valid HTTP subprotocol token but invalid to
    // both the Relay/Gateway session-ID parsers. It exercises parser ambiguity
    // without relying on a malformed HTTP header that Node/ws may reject first.
    const malformed = "kcoder-session.";
    const duplicate = `${tag}, ${tag}`;
    const conflictingDuplicate = `${tag}, kcoder-session.${"a".repeat(64)}`;
    const directPath = `/rpc?token=${encodeURIComponent(session.rpcToken)}&server=local&channel=runtime`;
    const relayPath = `/g/ws-review/rpc?token=${encodeURIComponent(session.rpcToken)}&server=local&channel=runtime`;
    const bearer = `Bearer ${session.accessToken}`;

    const observations = {
      gatewayBearerControl: await probeUpgrade({ host: relayAuthority, port: gateway.port, path: directPath, origin: null, authorization: bearer }),
      gatewaySingleMobileTag: await probeUpgrade({ host: relayAuthority, port: gateway.port, path: directPath, protocols: tag }),
      gatewayDuplicateValidTagsNoBearer: await probeUpgrade({ host: relayAuthority, port: gateway.port, path: directPath, protocols: duplicate }),
      gatewayBearerPlusMalformedTag: await probeUpgrade({ host: relayAuthority, port: gateway.port, path: directPath, origin: null, authorization: bearer, protocols: malformed }),
      gatewayValidThenUnknownTagNoBearer: await probeUpgrade({ host: relayAuthority, port: gateway.port, path: directPath, protocols: conflictingDuplicate }),
      relayBearerControl: await probeUpgrade({ host: relayAuthority, port: relay.proxyPort, path: relayPath, origin: null, authorization: bearer }),
      relaySingleMobileTag: await probeUpgrade({ host: relayAuthority, port: relay.proxyPort, path: relayPath, protocols: tag }),
      relayDuplicateValidTagsNoBearer: await probeUpgrade({ host: relayAuthority, port: relay.proxyPort, path: relayPath, protocols: duplicate }),
      relayBearerPlusMalformedTag: await probeUpgrade({ host: relayAuthority, port: relay.proxyPort, path: relayPath, origin: null, authorization: bearer, protocols: malformed }),
      relayBearerPlusDuplicateTags: await probeUpgrade({ host: relayAuthority, port: relay.proxyPort, path: relayPath, authorization: bearer, protocols: duplicate }),
      relayBearerPlusConflictingDuplicate: await probeUpgrade({ host: relayAuthority, port: relay.proxyPort, path: relayPath, authorization: bearer, protocols: conflictingDuplicate }),
    };

    t.diagnostic(JSON.stringify(observations));
    assert.equal(observations.gatewayBearerControl.accepted, true);
    assert.equal(observations.gatewaySingleMobileTag.accepted, true);
    assert.equal(observations.relayBearerControl.accepted, true);
    assert.equal(observations.relaySingleMobileTag.accepted, true);
    for (const name of [
      "gatewayDuplicateValidTagsNoBearer",
      "gatewayBearerPlusMalformedTag",
      "gatewayValidThenUnknownTagNoBearer",
      "relayDuplicateValidTagsNoBearer",
      "relayBearerPlusMalformedTag",
      "relayBearerPlusDuplicateTags",
      "relayBearerPlusConflictingDuplicate",
    ]) assert.notEqual(observations[name].status, 101, `${name} must reject an ambiguous Mobile credential carrier`);

    const evidence = {
      status: "pass",
      candidateRoot,
      candidateDigest,
      candidateFiles,
      gatewayMode: "isolated KCODER_STUDIO_MOCK=1, synthetic durable device grant, no Engine/Provider",
      relayMode: "candidate Relay connected to isolated Gateway through script control client",
      credentialsRecorded: false,
      observations,
      invariant: "A single valid Bearer or single valid kcoder-session carrier upgrades. Multiple or malformed kcoder-session carriers are rejected by both Gateway and Relay, including when a valid Bearer is also present.",
    };
    await t.test("record strict carrier handling only after all negative handshakes are rejected", () => {
      assert.equal(evidence.status, "pass");
      for (const name of ["gatewaySingleMobileTag", "relaySingleMobileTag", "gatewayBearerControl", "relayBearerControl"])
        assert.equal(observations[name].accepted, true);
      for (const name of ["gatewayDuplicateValidTagsNoBearer", "gatewayBearerPlusMalformedTag", "gatewayValidThenUnknownTagNoBearer", "relayDuplicateValidTagsNoBearer", "relayBearerPlusMalformedTag", "relayBearerPlusDuplicateTags", "relayBearerPlusConflictingDuplicate"])
        assert.notEqual(observations[name].status, 101);
    });
    const evidencePath = join(repoRoot, `target/private-phone-ux-implementation/websocket-protocol-boundary-${candidateLabel}-review.json`);
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    t.diagnostic(`sanitized WebSocket boundary evidence written to ${evidencePath}`);
  } finally {
    relayClient?.close();
    if (relay) await relay.close();
    await stopGateway(gateway);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
