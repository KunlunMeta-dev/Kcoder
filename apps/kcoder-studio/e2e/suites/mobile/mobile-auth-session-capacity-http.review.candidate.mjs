import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startGateway } from "../../harness/gateway.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

const DEVICE_LIMIT = 32;
const RESPONSE_LIMIT = 16 * 1024;
const MAIN_BUDGET_MS = 45_000;
const CLEANUP_BUDGET_MS = 35_000;
const ONE_HOUR_MS = "3600000";

await runE2E(import.meta.url, {
  testId: "gateway-auth-session-capacity-http-review",
  tier: "model-independent",
  modelPolicy: "owned local Gateway HTTP auth lifecycle; no Browser, app-server, Provider, or external Gateway",
  retainSuccessLogs: true,
  bodyAbortTimeoutMs: 5_000,
  cleanupTimeoutMs: 20_000,
  processSignalTimeoutMs: 5_000,
  survivorCheckTimeoutMs: 5_000,
}, async (context, abortSignal) => {
  const result = {
    diagnostic: "AUTH_CAPACITY_HTTP_DIAGNOSTIC_ONLY",
    deviceLimit: DEVICE_LIMIT,
    capacityOverrideUsed: false,
    browserStarted: false,
    providerRequested: false,
    baseline: { loginStatus: null, loginClass: "not-run", logoutStatus: null, staleCookieStatus: null },
    grants: { attempts: 0, statusCounts: {}, successful: 0, uniqueDeviceCount: 0, allMobileRefreshV1: true, activeBefore: null, activeAfter: null },
    fullTableLogin: { status: null, classification: "not-run", cookieIssued: false },
    cleanup: { revokeAttempts: 0, revokeStatusCounts: {}, revoked: 0, logoutAttempts: 0, logoutStatusCounts: {}, activeAfter: null, storedRowsAfter: null, revokedRowsAfter: null },
    freshControl: { loginStatus: null, loginClass: "not-run", logoutStatus: null, staleCookieStatus: null },
    capacityBoundaryObserved: false,
    exactGeneric404Observed: false,
    failures: [],
  };
  const failures = new Set();
  const ownedAccessTokens = [];
  const deviceIds = new Set();
  const pendingCookies = new Set();
  const mainDeadline = Date.now() + MAIN_BUDGET_MS;
  let gateway;
  let deviceStorePath;
  let stage = "fixture";
  const fail = code => failures.add(`${stage}:${code}`);

  try {
    const workspace = context.pathInState("auth-capacity-workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const serversFile = await context.writeStateJson("auth-capacity-servers.json", [{
      id: "auth-capacity-fixture",
      label: "Owned auth capacity fixture",
      transport: "local",
      workspace,
    }]);
    const serversStore = context.pathInState("gateway-store/servers.json");
    deviceStorePath = resolve(serversStore, "..", "mobile-device-auth", "devices.json");

    stage = "gateway-start";
    gateway = await startGateway(context, {
      auth: true,
      label: "auth-capacity-http-gateway",
      workspace,
      serversFile,
      serversStore,
      kcoderBin: resolve(repoRoot, "target/debug/kcoder"),
      env: {
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_AUTH_SESSION_TTL_MS: ONE_HOUR_MS,
        KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: ONE_HOUR_MS,
      },
    });
    const request = (path, init = {}, deadline = mainDeadline, requestBudgetMs = 2_000) =>
      http(`${gateway.baseUrl}${path}`, init, deadline, abortSignal, requestBudgetMs);
    const deviceCounts = () => readOwnedDeviceCounts(deviceStorePath);

    stage = "empty-state-count";
    const before = await deviceCounts();
    result.grants.activeBefore = before.active;
    if (before.active !== 0 || before.stored !== 0) fail("owned-store-not-empty");

    stage = "baseline-login";
    const baseline = await login(request, context, pendingCookies, gateway.authToken);
    result.baseline.loginStatus = baseline.status;
    result.baseline.loginClass = baseline.classification;
    if (baseline.status !== 303 || !baseline.cookie) {
      fail("empty-state-login-not-303");
    } else {
      result.baseline.logoutStatus = await logout(request, pendingCookies, baseline.cookie);
      if (result.baseline.logoutStatus !== 303) fail("baseline-logout-not-303");
      result.baseline.staleCookieStatus = await protectedStatus(request, baseline.cookie);
      if (result.baseline.staleCookieStatus !== 401) fail("baseline-cookie-still-authorized");
    }

    if (failures.size === 0) {
      stage = "durable-device-grants";
      for (let index = 0; index < DEVICE_LIMIT; index += 1) {
        result.grants.attempts += 1;
        const response = await request("/api/mobile/session", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            token: gateway.authToken,
            durableDeviceAuthorization: true,
            deviceLabel: "owned-auth-capacity-probe",
            requestInitialServers: false,
          }),
        });
        countStatus(result.grants.statusCounts, response.status);
        if (response.status !== 200) {
          fail("pair-not-200");
          break;
        }
        const grant = parseJson(response.body);
        if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
          fail("pair-response-not-json");
          break;
        }
        for (const key of ["accessToken", "refreshToken", "rpcToken"]) {
          if (typeof grant[key] === "string" && grant[key].length >= 8) context.registerSecret(grant[key]);
        }
        if (typeof grant.accessToken === "string" && grant.accessToken.length >= 16) ownedAccessTokens.push(grant.accessToken);
        else fail("access-token-missing");
        if (typeof grant.deviceId === "string" && grant.deviceId.length >= 16) deviceIds.add(grant.deviceId);
        else fail("device-id-missing");
        if (typeof grant.refreshToken !== "string" || grant.refreshToken.length < 16) fail("refresh-token-missing");
        if (grant.capabilities?.mobileRefreshV1 !== true) {
          result.grants.allMobileRefreshV1 = false;
          fail("durable-capability-not-true");
        }
        result.grants.successful += 1;
        const current = await deviceCounts();
        if (current.active !== index + 1) fail("active-device-count-not-incremented");
      }
      result.grants.uniqueDeviceCount = deviceIds.size;
      result.grants.activeAfter = (await deviceCounts()).active;
      const full = result.grants.attempts === DEVICE_LIMIT
        && result.grants.successful === DEVICE_LIMIT
        && ownedAccessTokens.length === DEVICE_LIMIT
        && deviceIds.size === DEVICE_LIMIT
        && result.grants.allMobileRefreshV1
        && result.grants.activeAfter === DEVICE_LIMIT;
      if (!full) {
        fail("did-not-establish-32-distinct-durable-devices");
      } else {
        stage = "login-with-full-device-table";
        const fullLogin = await login(request, context, pendingCookies, gateway.authToken);
        result.fullTableLogin = {
          status: fullLogin.status,
          classification: fullLogin.classification,
          cookieIssued: Boolean(fullLogin.cookie),
        };
        result.exactGeneric404Observed = fullLogin.status === 404 && fullLogin.classification === "generic-not-found";
        result.capacityBoundaryObserved = result.exactGeneric404Observed && !fullLogin.cookie;
        if (!result.capacityBoundaryObserved) fail("full-table-login-not-source-predicted-generic-404");
      }
    }
  } catch (error) {
    fail(errorClass(error));
  } finally {
    if (gateway) {
      const cleanupDeadline = Date.now() + CLEANUP_BUDGET_MS;
      stage = "revoke-owned-devices";
      for (const accessToken of [...ownedAccessTokens].reverse()) {
        result.cleanup.revokeAttempts += 1;
        try {
          const response = await http(`${gateway.baseUrl}/api/mobile/session`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
          }, cleanupDeadline, undefined, 1_500);
          countStatus(result.cleanup.revokeStatusCounts, response.status);
          if (response.status === 204) result.cleanup.revoked += 1;
          else fail("owned-device-revoke-not-204");
        } catch (error) {
          countStatus(result.cleanup.revokeStatusCounts, errorClass(error));
          fail("owned-device-revoke-failed");
        }
      }

      stage = "logout-owned-cookies";
      await logoutPendingCookies(gateway.baseUrl, pendingCookies, result.cleanup, cleanupDeadline, fail);
      stage = "verify-device-cleanup";
      try {
        const counts = await readOwnedDeviceCounts(deviceStorePath);
        result.cleanup.activeAfter = counts.active;
        result.cleanup.storedRowsAfter = counts.stored;
        result.cleanup.revokedRowsAfter = counts.revoked;
        if (counts.active !== 0) fail("owned-device-remained-active");
        if (result.cleanup.revoked !== ownedAccessTokens.length) fail("not-all-owned-access-tokens-revoked");
      } catch (error) {
        fail(errorClass(error));
      }

      const cleanupComplete = result.cleanup.activeAfter === 0
        && result.cleanup.revoked === ownedAccessTokens.length
        && pendingCookies.size === 0;
      if (cleanupComplete) {
        stage = "fresh-state-control-login";
        try {
          const requestCleanup = (path, init = {}) => http(`${gateway.baseUrl}${path}`, init, cleanupDeadline, undefined, 1_500);
          const fresh = await login(requestCleanup, context, pendingCookies, gateway.authToken);
          result.freshControl.loginStatus = fresh.status;
          result.freshControl.loginClass = fresh.classification;
          if (fresh.status !== 303 || !fresh.cookie) fail("fresh-login-not-303");
          else {
            result.freshControl.logoutStatus = await logout(requestCleanup, pendingCookies, fresh.cookie);
            if (result.freshControl.logoutStatus !== 303) fail("fresh-logout-not-303");
            result.freshControl.staleCookieStatus = await protectedStatus(requestCleanup, fresh.cookie);
            if (result.freshControl.staleCookieStatus !== 401) fail("fresh-cookie-still-authorized");
          }
        } catch (error) {
          fail(errorClass(error));
        }
      }
      stage = "final-cookie-cleanup";
      await logoutPendingCookies(gateway.baseUrl, pendingCookies, result.cleanup, cleanupDeadline, fail);
      if (pendingCookies.size !== 0) fail("owned-cookie-remained-unlogged-out");
      try {
        const finalCounts = await readOwnedDeviceCounts(deviceStorePath);
        result.cleanup.activeAfter = finalCounts.active;
        result.cleanup.storedRowsAfter = finalCounts.stored;
        result.cleanup.revokedRowsAfter = finalCounts.revoked;
        if (finalCounts.active !== 0) fail("owned-device-active-at-exit");
      } catch (error) {
        fail(errorClass(error));
      }
    }

    result.failures = [...failures];
    await context.writeArtifactJson("auth-session-capacity-http.json", result);
  }

  if (failures.size) throw new Error(`auth capacity HTTP diagnostic failed: ${[...failures].join(",")}`);
  return result;
});

async function http(url, init, deadline, abortSignal, requestBudgetMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw namedError("TimeoutError");
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(remaining, requestBudgetMs)));
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  const response = await fetch(url, { ...init, redirect: "manual", signal });
  const body = await boundedText(response, RESPONSE_LIMIT);
  return { status: response.status, headers: response.headers, body };
}

async function boundedText(response, maximumBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size).toString("utf8");
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw namedError("ResponseTooLargeError");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

async function login(request, context, pendingCookies, gatewayToken) {
  const response = await request("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    body: new URLSearchParams({ token: gatewayToken }).toString(),
  });
  const cookie = cookieFrom(response.headers.get("set-cookie"));
  if (cookie) {
    context.registerSecret(cookie);
    pendingCookies.add(cookie);
  }
  return { status: response.status, classification: classifyLogin(response.status, response.body), cookie };
}

async function logout(request, pendingCookies, cookie) {
  const response = await request("/logout", { method: "POST", headers: { cookie, accept: "text/html" } });
  if (response.status === 303) pendingCookies.delete(cookie);
  return response.status;
}

async function protectedStatus(request, cookie) {
  const response = await request("/api/servers", { method: "GET", headers: { cookie, accept: "application/json" } });
  return response.status;
}

async function logoutPendingCookies(baseUrl, pendingCookies, cleanup, deadline, fail) {
  for (const cookie of [...pendingCookies]) {
    cleanup.logoutAttempts += 1;
    try {
      const response = await http(`${baseUrl}/logout`, {
        method: "POST",
        headers: { cookie, accept: "text/html" },
      }, deadline, undefined, 1_500);
      countStatus(cleanup.logoutStatusCounts, response.status);
      if (response.status === 303) pendingCookies.delete(cookie);
      else fail("owned-cookie-logout-not-303");
    } catch (error) {
      countStatus(cleanup.logoutStatusCounts, errorClass(error));
      fail("owned-cookie-logout-failed");
    }
  }
}

function cookieFrom(setCookie) {
  const value = typeof setCookie === "string"
    ? setCookie.match(/(?:^|,\s*)kcoder_studio_session=([^;,]+)/)?.[1]
    : null;
  return value ? `kcoder_studio_session=${value}` : null;
}

function classifyLogin(status, body) {
  if (status === 303) return "redirect";
  if (status === 429) return "rate-limit-or-explicit-capacity";
  if (status === 401) return "invalid-token";
  if (status === 404 && body.trim() === "Not found") return "generic-not-found";
  if (status === 404) return "http-404-other-body";
  if (status >= 500) return "http-server-error";
  return `http-${status}`;
}

async function readOwnedDeviceCounts(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { stored: 0, active: 0, revoked: 0 };
    throw error;
  }
  const store = JSON.parse(raw);
  if (!store || store.version !== 1 || !Array.isArray(store.devices)) throw namedError("InvalidOwnedDeviceStoreError");
  const now = Date.now();
  return {
    stored: store.devices.length,
    active: store.devices.filter(device => device && device.revoked !== true
      && Number.isSafeInteger(device.expiresAt) && device.expiresAt > now
      && Number.isSafeInteger(device.absoluteExpiresAt) && device.absoluteExpiresAt > now).length,
    revoked: store.devices.filter(device => device?.revoked === true).length,
  };
}

function parseJson(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function countStatus(counts, value) {
  const key = String(value);
  counts[key] = (counts[key] || 0) + 1;
}

function errorClass(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "bounded-request-timeout";
  if (error?.name === "ResponseTooLargeError") return "response-over-limit";
  if (error?.name === "InvalidOwnedDeviceStoreError") return "owned-store-invalid";
  if (error?.name === "SyntaxError") return "owned-store-invalid-json";
  return "request-or-fixture-error";
}

function namedError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}
