import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { initializeRpc, openRpc } from "../../harness/rpc.mjs";

const expectedRuntimeSha256 = requiredEnv("KCODER_E2E_EXPECTED_KCODER_SHA256");
const expectedRuntimePath = resolve(repoRoot, "target/kcoder-relay/bin/kcoder");
const gatewayUnit = process.env.KCODER_E2E_PUBLIC_GATEWAY_UNIT?.trim()
  || "kcoder-cyx-relay-gateway.service";
const enabled = process.env.KCODER_E2E_PUBLIC_RELAY_VERIFY === "1";
if (!enabled) throw new Error("Set KCODER_E2E_PUBLIC_RELAY_VERIFY=1 to run the manual public-relay probe");

const baseUrl = new URL(requiredEnv("KCODER_RELAY_PUBLIC_URL"));
const pairingToken = requiredEnv("KCODER_RELAY_GATEWAY_TOKEN");
assert.equal(baseUrl.protocol, "https:", "public pairing must use HTTPS");
baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
baseUrl.search = "";
baseUrl.hash = "";
const origin = baseUrl.origin;

await runE2E(import.meta.url, {
  testId: "mobile-public-relay-pairing-and-wss",
  tier: "manual-live",
  modelPolicy: "model-independent public HTTPS/WSS, temporary mobile session revocation and read-only app-server thread/list; no model call or thread mutation",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 10_000,
}, async context => {
  context.registerSecret(pairingToken);

  const unauthenticated = await fetchWithTimeout(`${origin}/`, { redirect: "manual" });
  assert.equal(unauthenticated.status, 401, "public HTTPS route should reach the authenticated Gateway");

  const healthResponse = await fetchWithTimeout(`${origin}/_relay/health`);
  assert.equal(healthResponse.status, 200, "public Relay control route should be reachable over HTTPS");
  const relayHealth = await healthResponse.json();
  assert.equal(relayHealth.online, true, "public Relay must report the paired client online");

  const sessionResponse = await fetchWithTimeout(`${origin}/api/mobile/session`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: JSON.stringify({ token: pairingToken }),
  });
  assert.equal(sessionResponse.status, 200, "current pairing token must exchange for a short-lived mobile session");
  const session = await sessionResponse.json();
  assert.equal(typeof session.accessToken, "string");
  assert.equal(typeof session.expiresAt, "number");
  assert.equal(session.rpcToken, "cookie-auth", "mobile RPC must use the cookie-auth protocol token");
  context.registerSecret(session.accessToken);
  context.registerSecret(session.rpcToken);
  let sessionCleanupAttempted = false;

  context.addCleanup("revoke temporary public mobile session", async () => {
    if (sessionCleanupAttempted) return;
    sessionCleanupAttempted = true;
    const response = await fetchWithTimeout(`${origin}/api/mobile/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(response.status, 204, "temporary mobile session cleanup should revoke the token");
  });

  const serversResponse = await fetchWithTimeout(`${origin}/api/servers`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(serversResponse.status, 200, "Bearer session must authorize the server list");
  const serversPayload = await serversResponse.json();
  assert.ok(Array.isArray(serversPayload.servers));
  const server = serversPayload.servers.find(item => item.id === "local") || serversPayload.servers[0];
  assert.ok(server?.id, "the public session must expose a usable local target");

  const websocketUrl = new URL("/rpc", origin);
  websocketUrl.protocol = "wss:";
  websocketUrl.searchParams.set("token", session.rpcToken);
  websocketUrl.searchParams.set("server", server.id);
  websocketUrl.searchParams.set("channel", "runtime");
  const rpc = await openRpc(websocketUrl.toString(), {
    headers: {
      Origin: origin,
      Authorization: `Bearer ${session.accessToken}`,
    },
    timeoutMs: 20_000,
  });
  let websocketCloseAttempted = false;
  context.addCleanup("close public app-server WebSocket", async () => {
    if (websocketCloseAttempted) return;
    websocketCloseAttempted = true;
    await closeRpc(rpc);
  });

  const initialized = await initializeRpc(rpc, "kcoder-studio-mobile-public-probe");
  assert.equal(initialized.protocolVersion, "2026-07-27", "public WSS must initialize the current app-server protocol");
  rpc.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
  const threadList = await rpc.request("thread/list", {}, 30_000);
  assert.ok(threadList && typeof threadList === "object", "public WSS thread/list must return successfully");

  const gatewayPid = await readGatewayMainPid(context);
  const appServer = await waitFor(
    () => findAppServerDescendant(gatewayPid),
    20_000,
    "Gateway-owned app-server process",
    100,
    context.abortSignal,
  );
  assert.equal(appServer.sha256, expectedRuntimeSha256, "live app-server must use the approved immutable CLI build");
  assert.equal(appServer.executable, expectedRuntimePath, "live app-server executable must be the configured, promoted target path");
  assert.equal(appServer.cwd, repoRoot, "live app-server working directory must remain the dedicated checkout");

  websocketCloseAttempted = true;
  await closeRpc(rpc);

  sessionCleanupAttempted = true;
  const cleanup = await revokeAndCheckSession(origin, session.accessToken);
  await context.writeArtifactJson("public-mobile-session-cleanup.json", {
    deleteStatus: cleanup.deleteStatus,
    deleteRequestCompleted: cleanup.deleteRequestCompleted,
    apiServersAfterDeleteStatus: cleanup.apiServersAfterDeleteStatus,
    postDeleteBearerRejected: cleanup.apiServersAfterDeleteStatus === 401,
  });
  assert.equal(cleanup.deleteStatus, 204, "temporary mobile session cleanup should revoke the token");
  assert.equal(cleanup.apiServersAfterDeleteStatus, 401, "the revoked session Bearer must be rejected after DELETE");

  await context.writeArtifactJson("public-relay-verification.json", {
    host: origin,
    httpsUnauthenticatedStatus: unauthenticated.status,
    relayHealthOnline: relayHealth.online === true,
    pairingSessionExchange: sessionResponse.status === 200,
    rpcTokenCookieAuth: session.rpcToken === "cookie-auth",
    authorizedServerListStatus: serversResponse.status,
    selectedServerId: server.id,
    websocket: {
      tls: true,
      originHeader: origin,
      bearerHeader: true,
      rpcTokenQueryIsCookieAuth: websocketUrl.searchParams.get("token") === "cookie-auth",
      initializeProtocol: initialized.protocolVersion,
      initializedNotificationSent: true,
      threadListReturned: true,
      threadCount: Array.isArray(threadList.threads) ? threadList.threads.length : null,
    },
    gatewayMainPid: gatewayPid,
    appServer,
    sessionDeleteStatus: cleanup.deleteStatus,
    apiServersAfterDeleteStatus: cleanup.apiServersAfterDeleteStatus,
    modelCall: "NOT_RUN",
    physicalPhoneScan: "UNVERIFIED",
  });

  return {
    publicHttps: true,
    relayClientOnline: relayHealth.online === true,
    pairingSessionExchange: true,
    publicWssInitialize: initialized.protocolVersion,
    initializedNotificationSent: true,
    rpcTokenCookieAuth: session.rpcToken === "cookie-auth",
    threadList: true,
    sessionDeleted: cleanup.deleteStatus === 204,
    revokedBearerRejected: cleanup.apiServersAfterDeleteStatus === 401,
    runtimeBinarySha256: appServer.sha256,
    modelCall: "NOT_RUN",
    physicalPhoneScan: "UNVERIFIED",
  };
});

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is missing`);
  return value;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function revokeAndCheckSession(origin, accessToken) {
  let deleteStatus = null;
  let deleteRequestCompleted = false;
  let apiServersAfterDeleteStatus = null;
  try {
    const response = await fetchWithTimeout(`${origin}/api/mobile/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    deleteStatus = response.status;
    deleteRequestCompleted = true;
  } catch {}

  try {
    const response = await fetchWithTimeout(`${origin}/api/servers`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    apiServersAfterDeleteStatus = response.status;
  } catch {}

  return { deleteStatus, deleteRequestCompleted, apiServersAfterDeleteStatus };
}

async function closeRpc(rpc) {
  const socket = rpc.socket;
  if (socket.readyState === 3) return;
  let timer;
  const closed = new Promise(resolveClosed => {
    timer = setTimeout(() => resolveClosed(false), 5_000);
    socket.addEventListener("close", () => resolveClosed(true), { once: true });
  });
  rpc.close();
  const didClose = await closed;
  clearTimeout(timer);
  assert.ok(didClose, "public app-server WebSocket should finish closing before session revocation");
}

async function readGatewayMainPid(context) {
  const child = context.spawnOwned(
    "read-public-gateway-mainpid",
    "systemctl",
    ["--user", "show", gatewayUnit, "-p", "MainPID", "--value"],
    { cwd: repoRoot },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", value => { stdout += value; });
  await waitFor(() => child.exitCode !== null, 5_000, "Gateway main PID query", 25, context.abortSignal);
  assert.equal(child.exitCode, 0, "Gateway main PID query must succeed");
  const pid = Number(stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1, "Gateway must be running in the dedicated user unit");
  return pid;
}

async function findAppServerDescendant(gatewayPid) {
  const processEntries = (await readdir("/proc", { withFileTypes: true }))
    .filter(entry => /^\d+$/.test(entry.name));
  const parentByPid = new Map();
  await Promise.all(processEntries.map(async entry => {
    try {
      const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parentByPid.set(Number(entry.name), Number(fields[1]));
    } catch {}
  }));
  const descendants = new Set([gatewayPid]);
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const [pid, parentPid] of parentByPid) {
      if (descendants.has(parentPid) && !descendants.has(pid)) {
        descendants.add(pid);
        advanced = true;
      }
    }
  }
  for (const pid of descendants) {
    if (pid === gatewayPid) continue;
    try {
      const command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
      if (!command.includes("app-server")) continue;
      const executable = await readlink(`/proc/${pid}/exe`);
      if (basename(executable) !== "kcoder") continue;
      const cwd = await readlink(`/proc/${pid}/cwd`);
      const sha256 = await hashFile(`/proc/${pid}/exe`);
      return { pid, parentPid: parentByPid.get(pid) ?? null, executable, cwd, sha256 };
    } catch {}
  }
  return null;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
