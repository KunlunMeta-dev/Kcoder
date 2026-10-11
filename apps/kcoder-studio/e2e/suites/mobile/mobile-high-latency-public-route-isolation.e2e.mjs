import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HeaderWebSocket } from "../../harness/header-websocket.mjs";
import { closeRpcAndWait, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { runE2E } from "../../harness/run-context.mjs";

const enabled = process.env.KCODER_E2E_PUBLIC_ROUTE_ISOLATION === "1";
if (!enabled) {
  throw new Error("Set KCODER_E2E_PUBLIC_ROUTE_ISOLATION=1 only for the authorized public-route isolation probe");
}

const origin = new URL(requiredEnv("KCODER_E2E_PUBLIC_ROUTE_ORIGIN")).origin;
const fixturePath = resolve(requiredEnv("KCODER_E2E_PUBLIC_PAIRING_FIXTURES"));
assert.equal(origin, "https://hyf2333.top", "the temporary isolated TLS front uses the standard HTTPS origin on port 443");

await runE2E(import.meta.url, {
  testId: "mobile-high-latency-public-route-isolation",
  tier: "manual-live",
  modelPolicy: "public HTTPS/WSS route, cookie/Bearer/session isolation between two temporary mock Gateways; read-only thread/list only, no model call or task mutation",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 15_000,
}, async context => {
  const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
  const alpha = validateFixture("alpha", fixtures.alpha);
  const beta = validateFixture("beta", fixtures.beta);
  assert.notEqual(alpha.id, beta.id, "the two temporary Gateways must use different route identities");
  assert.notEqual(alpha.pairingToken, beta.pairingToken, "the two temporary Gateways must use independent pairing tokens");
  for (const fixture of [alpha, beta]) context.registerSecret(fixture.pairingToken);

  const route = fixture => `${origin}/g/${fixture.id}`;
  const publicRootResponse = await fetchWithTimeout(`${origin}/`);
  assert.equal(publicRootResponse.status, 200, "the frozen mobile web root should load over public HTTPS");

  const activeRpcs = new Set();
  context.addCleanup("close public test WebSockets", async () => {
    await Promise.all([...activeRpcs].map(rpc => closeTestRpc(rpc, "public test WebSocket")));
  });

  async function exchange(fixture, label) {
    const response = await fetchWithTimeout(`${route(fixture)}/api/mobile/session`, {
      method: "POST",
      headers: { Origin: origin, "content-type": "application/json" },
      body: JSON.stringify({ token: fixture.pairingToken }),
    });
    assert.equal(response.status, 200, `${label} pairing token should exchange on its own route`);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const body = await response.json();
    assert.equal(typeof body.accessToken, "string");
    assert.equal(typeof body.rpcToken, "string");
    assert.equal(typeof body.expiresAt, "number");
    context.registerSecret(body.accessToken);
    context.registerSecret(body.rpcToken);

    const rawCookie = response.headers.get("set-cookie") || "";
    const cookie = rawCookie.split(";", 1)[0];
    const cookieValue = cookie.slice(cookie.indexOf("=") + 1);
    assert.ok(cookie.startsWith("kcoder_studio_session="), `${label} pairing response should set the mobile web cookie`);
    const routePathScoped = rawCookie.includes(`Path=/g/${fixture.id}/`);
    assert.ok(routePathScoped, `${label} cookie should be scoped to its own Gateway route`);
    context.registerSecret(cookieValue);

    const state = { ...body, cookie, routePathScoped, sessionExchangeStatus: response.status };
    let revoked = false;
    context.addCleanup(`revoke temporary ${label} mobile session`, async () => {
      if (revoked) return;
      const deleted = await fetchWithTimeout(`${route(fixture)}/api/mobile/session`, {
        method: "DELETE",
        headers: { Origin: origin, Authorization: `Bearer ${body.accessToken}` },
      });
      revoked = deleted.status === 204;
      assert.equal(deleted.status, 204, `temporary ${label} session cleanup should revoke the test token`);
    });
    state.revoke = async () => {
      if (revoked) return;
      const deleted = await fetchWithTimeout(`${route(fixture)}/api/mobile/session`, {
        method: "DELETE",
        headers: { Origin: origin, Authorization: `Bearer ${body.accessToken}` },
      });
      assert.equal(deleted.status, 204, `${label} session should revoke successfully`);
      revoked = true;
    };
    return state;
  }

  async function servers(fixture, session, label, credential = "bearer") {
    const headers = { Origin: origin };
    if (credential === "bearer") headers.Authorization = `Bearer ${session.accessToken}`;
    if (credential === "cookie") headers.Cookie = session.cookie;
    if (credential === "cookie+bearer") {
      headers.Cookie = session.cookie;
      headers.Authorization = `Bearer ${session.accessToken}`;
    }
    const response = await fetchWithTimeout(`${route(fixture)}/api/servers`, { headers });
    return { response, body: response.ok ? await response.json() : null, label };
  }

  async function openAuthenticatedRpc(fixture, session, serverId, name) {
    const url = new URL(`${route(fixture)}/rpc`);
    url.protocol = "wss:";
    url.searchParams.set("token", session.rpcToken);
    url.searchParams.set("server", serverId);
    url.searchParams.set("channel", "runtime");
    const rpc = await openRpc(url.toString(), {
      timeoutMs: 15_000,
      headers: { Origin: origin, Authorization: `Bearer ${session.accessToken}` },
    });
    activeRpcs.add(rpc);
    const initialized = await initializeRpc(rpc, name);
    assert.equal(initialized.protocolVersion, "2026-07-27", `${name} should initialize over public WSS`);
    rpc.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    const listed = await rpc.request("thread/list", {}, 20_000);
    assert.ok(listed && typeof listed === "object", `${name} thread/list should return over WSS`);
    return { rpc, threadList: listed };
  }

  const alphaSession = await exchange(alpha, "alpha");
  const betaSession = await exchange(beta, "beta");

  const alphaBearer = await servers(alpha, alphaSession, "alpha bearer");
  const betaBearer = await servers(beta, betaSession, "beta bearer");
  assert.equal(alphaBearer.response.status, 200);
  assert.equal(betaBearer.response.status, 200);
  assert.notEqual(alphaBearer.body.servers?.[0]?.id, betaBearer.body.servers?.[0]?.id,
    "each route should expose its own restricted test target fixture");

  const alphaCookie = await servers(alpha, alphaSession, "alpha cookie", "cookie");
  const betaCookie = await servers(beta, betaSession, "beta cookie", "cookie");
  assert.equal(alphaCookie.response.status, 401, "Relay API auth should require an explicit Bearer, even on alpha's route");
  assert.equal(betaCookie.response.status, 401, "Relay API auth should require an explicit Bearer, even on beta's route");
  const alphaCookieWithBearer = await servers(alpha, alphaSession, "alpha cookie and Bearer", "cookie+bearer");
  assert.equal(alphaCookieWithBearer.response.status, 200, "alpha's Bearer should authenticate its route when its path-scoped cookie is present");

  const alphaBearerOnBeta = await servers(beta, alphaSession, "alpha bearer on beta");
  const alphaCookieOnBeta = await servers(beta, alphaSession, "alpha cookie on beta", "cookie");
  const alphaCookieBearerOnBeta = await servers(beta, alphaSession, "alpha cookie and Bearer on beta", "cookie+bearer");
  assert.equal(alphaBearerOnBeta.response.status, 401, "alpha's Bearer must not authenticate beta's route");
  assert.equal(alphaCookieOnBeta.response.status, 401, "alpha's cookie must not authenticate beta's route");
  assert.equal(alphaCookieBearerOnBeta.response.status, 401, "alpha's cookie and Bearer must not authenticate beta's route");

  const wrongPairing = await fetchWithTimeout(`${route(beta)}/api/mobile/session`, {
    method: "POST",
    headers: { Origin: origin, "content-type": "application/json" },
    body: JSON.stringify({ token: alpha.pairingToken }),
  });
  assert.equal(wrongPairing.status, 401, "alpha's pairing token must not exchange on beta's route");

  const suffixResponse = await fetchWithTimeout(`${origin}/g/${alpha.id}-suffix/api/servers`, {
    headers: { Origin: origin, Authorization: `Bearer ${alphaSession.accessToken}` },
  });
  assert.equal(suffixResponse.status, 404, "a Gateway ID suffix must not match either exact route");

  const betaServerId = betaBearer.body.servers[0].id;
  const wrongWssStatus = await rejectedWebSocketStatus(
    rpcUrl(beta, alphaSession.rpcToken, betaServerId),
    { Origin: origin, Authorization: `Bearer ${alphaSession.accessToken}` },
  );
  assert.equal(wrongWssStatus, 401, "alpha's Bearer/RPC token pair must not open beta's WSS route");

  const alphaRpc = await openAuthenticatedRpc(alpha, alphaSession, alphaBearer.body.servers[0].id, "public-route-alpha");
  const betaRpc = await openAuthenticatedRpc(beta, betaSession, betaServerId, "public-route-beta");
  const alphaSocketCloseMode = await closeTestRpc(alphaRpc.rpc, "alpha public WSS");
  activeRpcs.delete(alphaRpc.rpc);

  const betaAfterAlphaClose = await betaRpc.rpc.request("thread/list", {}, 20_000);
  assert.ok(betaAfterAlphaClose && typeof betaAfterAlphaClose === "object",
    "beta WSS should remain usable after alpha disconnects");
  await alphaSession.revoke();

  const alphaAfterRevoke = await servers(alpha, alphaSession, "alpha after revoke");
  const betaAfterAlphaRevoke = await servers(beta, betaSession, "beta after alpha revoke");
  assert.equal(alphaAfterRevoke.response.status, 401, "revoking alpha should invalidate alpha's Bearer");
  assert.equal(betaAfterAlphaRevoke.response.status, 200, "revoking alpha should not affect beta's Bearer");
  const betaAfterAlphaRevokedWss = await betaRpc.rpc.request("thread/list", {}, 20_000);
  assert.ok(betaAfterAlphaRevokedWss && typeof betaAfterAlphaRevokedWss === "object",
    "beta WSS should remain usable after alpha session revocation");

  await closeTestRpc(betaRpc.rpc, "beta public WSS");
  activeRpcs.delete(betaRpc.rpc);
  await betaSession.revoke();
  const betaAfterRevoke = await servers(beta, betaSession, "beta after revoke");
  assert.equal(betaAfterRevoke.response.status, 401, "revoking beta should invalidate beta's Bearer");

  const result = {
    transport: "public HTTPS and WSS on standard port 443 via temporary isolated TLS front; production Relay/Caddy untouched",
    gatewayRouteCount: 2,
    gatewayFixturesDistinct: true,
    serverFixturesDistinct: true,
    checks: [
      { name: "public-root-https", status: publicRootResponse.status },
      { name: "route-a-exact-session-route", status: alphaSession.sessionExchangeStatus },
      { name: "route-b-exact-session-route", status: betaSession.sessionExchangeStatus },
      { name: "route-a-own-explicit-auth", status: alphaBearer.response.status },
      { name: "route-b-own-explicit-auth", status: betaBearer.response.status },
      { name: "route-a-explicit-auth-on-b", status: alphaBearerOnBeta.response.status },
      { name: "route-a-session-only", status: alphaCookie.response.status },
      { name: "route-b-session-only", status: betaCookie.response.status },
      { name: "route-a-explicit-auth-with-session", status: alphaCookieWithBearer.response.status },
      { name: "route-a-session-on-b", status: alphaCookieOnBeta.response.status },
      { name: "route-a-explicit-auth-and-session-on-b", status: alphaCookieBearerOnBeta.response.status },
      { name: "route-a-pairing-on-b", status: wrongPairing.status },
      { name: "route-a-suffix-boundary", status: suffixResponse.status },
      { name: "route-a-wss-auth-on-b", status: wrongWssStatus },
      { name: "route-a-session-path-scope", status: alphaSession.routePathScoped ? "PASS" : "FAIL" },
      { name: "route-b-session-path-scope", status: betaSession.routePathScoped ? "PASS" : "FAIL" },
      { name: "route-a-wss-init-and-list", status: "PASS" },
      { name: "route-b-wss-init-and-list", status: "PASS" },
      { name: "route-b-rpc-after-a-socket-close", status: "PASS" },
      { name: "route-a-after-revoke", status: alphaAfterRevoke.response.status },
      { name: "route-b-after-a-revoke", status: betaAfterAlphaRevoke.response.status },
      { name: "route-b-rpc-after-a-revoke", status: "PASS" },
      { name: "route-b-after-revoke", status: betaAfterRevoke.response.status },
    ],
    alphaSocketCloseMode,
    modelCallPerformed: false,
    taskMutationPerformed: false,
    physicalPhoneScan: "UNVERIFIED",
  };
  await context.writeArtifactJson("public-route-isolation-result.json", result);
  console.log(JSON.stringify(result));
  return result;
});

function validateFixture(name, value) {
  assert.ok(value && typeof value === "object", `${name} pairing fixture should exist`);
  assert.match(value.id, /^[a-f0-9]{32}$/, `${name} Gateway ID should be valid`);
  assert.equal(typeof value.pairingToken, "string");
  assert.ok(value.pairingToken.length >= 32);
  return { id: value.id, pairingToken: value.pairingToken };
}

function rpcUrl(fixture, rpcToken, serverId) {
  const url = new URL(`${origin}/g/${fixture.id}/rpc`);
  url.protocol = "wss:";
  url.searchParams.set("token", rpcToken);
  url.searchParams.set("server", serverId);
  url.searchParams.set("channel", "runtime");
  return url.toString();
}

async function rejectedWebSocketStatus(url, headers) {
  const socket = new HeaderWebSocket(url, headers);
  return new Promise((resolveStatus, rejectStatus) => {
    let settled = false;
    const timer = setTimeout(() => finish(null), 15_000);
    const finish = status => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolveStatus(status);
    };
    socket.addEventListener("error", event => {
      const match = String(event.error?.message || "").match(/HTTP\/1\.1 (\d{3})/);
      if (match) finish(Number(match[1]));
      else {
        settled = true;
        clearTimeout(timer);
        rejectStatus(new Error("WSS cross-route request failed before an HTTP response"));
      }
    }, { once: true });
    socket.addEventListener("open", () => finish(101), { once: true });
  });
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

async function closeTestRpc(rpc, label) {
  if (!rpc?.socket || rpc.socket.readyState === 3) return "already-closed";
  try {
    await closeRpcAndWait(rpc, label, 5_000);
    return "graceful";
  } catch {
    rpc.socket.socket.destroy();
    await waitForSocketClose(rpc.socket, label);
    return "forced-local-transport";
  }
}

async function waitForSocketClose(socket, label) {
  if (socket.readyState === 3) return;
  await new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("close", onClose);
      rejectClose(new Error(`${label} transport did not close after local destroy`));
    }, 5_000);
    const onClose = () => {
      clearTimeout(timer);
      resolveClose();
    };
    socket.addEventListener("close", onClose, { once: true });
    if (socket.readyState === 3) onClose();
  });
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is missing`);
  return value;
}
