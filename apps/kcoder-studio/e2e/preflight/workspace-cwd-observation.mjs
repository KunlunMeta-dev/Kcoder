import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startGateway } from "../harness/gateway.mjs";
import { runE2E, waitFor } from "../harness/run-context.mjs";

const OBSERVATION_DELAY_MS = 5_000;
const WORKSPACE_PATH = "/api/servers/local/cwd-observation";
const MOBILE_ORIGIN = "https://mobile.test";

await runE2E(import.meta.url, {
  testId: "workspace-cwd-observation-v1",
  tier: "smoke",
  modelPolicy: "model-independent owned loopback Gateway HTTP observation; no Browser, app-server, SSH connection, Provider, or model call",
  retainSuccessLogs: true,
  processSignalTimeoutMs: 5_000,
  cleanupTimeoutMs: 12_000,
}, async (context, signal) => {
  const webRoot = context.pathInState("web-root");
  const workspaceParent = context.pathInState("workspaces");
  const deletedWorkspace = join(workspaceParent, "deleted-local-cwd");
  const missingDefaultWorkspace = context.pathInState("missing-gateway-default-cwd");
  await Promise.all([
    mkdir(webRoot, { recursive: true }),
    mkdir(workspaceParent, { recursive: true }),
  ]);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Owned observer preflight</title>\n");
  await mkdir(deletedWorkspace);
  await rm(deletedWorkspace, { recursive: true, force: false });

  const servers = [
    {
      id: "local",
      label: "Local observer target",
      transport: "local",
      workspace: deletedWorkspace,
    },
    {
      id: "ssh-plain",
      label: "Plain SSH observer target",
      transport: "ssh",
      host: "plain-observer.invalid",
    },
    {
      id: "ssh-account",
      label: "Account SSH observer target",
      transport: "ssh",
      host: "account-observer.invalid",
      security: { identity: { mode: "kcoder-account", username: "observer" } },
    },
  ];
  const serversStore = context.pathInState("servers-store.json");
  const sharedEnvironment = {
    KCODER_CONFIG_DIR: context.pathInState("gateway-config"),
    KCODER_STUDIO_SERVERS: JSON.stringify(servers),
    KCODER_STUDIO_SERVERS_STORE: serversStore,
    KCODER_STUDIO_MOCK: "",
    KCODER_STUDIO_MOBILE_WEB_ORIGINS: MOBILE_ORIGIN,
    KCODER_STUDIO_WEB_ROOT: webRoot,
  };
  const firstGatewayLabel = "workspace-cwd-observer-held-gateway";
  const firstGateway = await startGateway(context, {
    auth: true,
    label: firstGatewayLabel,
    workspace: missingDefaultWorkspace,
    env: {
      ...sharedEnvironment,
      KCODER_STUDIO_TEST_CWD_OBSERVATION_DELAY_MS: String(OBSERVATION_DELAY_MS),
    },
    startTimeoutMs: 15_000,
  });
  const baseUrl = firstGateway.baseUrl;
  let localUrl = observationUrl(baseUrl, "local", deletedWorkspace);
  const anonymous = await boundedFetch(localUrl, { signal });
  assert.equal(anonymous.status, 401);

  const preflight = await boundedFetch(localUrl, {
    method: "OPTIONS",
    headers: {
      origin: MOBILE_ORIGIN,
      "access-control-request-method": "GET",
    },
    signal,
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), MOBILE_ORIGIN);

  const firstCookie = await loginCookie(context, firstGateway, signal);
  const inventory = await (await boundedFetch(`${baseUrl}/api/servers`, { headers: { cookie: firstCookie }, signal })).json();
  const identities = new Map(inventory.servers.map(target => [target.id, target.observationTargetIdentity]));
  const localIdentity = identities.get("local");
  assert.match(localIdentity, /^[a-f0-9]{64}$/);
  const unbound = await boundedFetch(localUrl, { headers: { cookie: firstCookie }, signal });
  assert.deepEqual(await observationState(unbound), { status: "unknown", reason: "unbound_target" });
  const stale = await boundedFetch(observationUrl(baseUrl, "local", deletedWorkspace,
    localIdentity === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64)), { headers: { cookie: firstCookie }, signal });
  assert.deepEqual(await observationState(stale), { status: "unknown", reason: "target_changed" });
  localUrl = observationUrl(baseUrl, "local", deletedWorkspace, localIdentity);
  const bootstrapReply = await boundedFetch(`${baseUrl}/api/mobile/session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: firstGateway.authToken, requestInitialServers: true, durableDeviceAuthorization: false }), signal,
  });
  assert.equal(bootstrapReply.status, 200);
  const bootstrap = await bootstrapReply.json();
  for (const key of ["accessToken", "rpcToken", "refreshToken"]) if (typeof bootstrap[key] === "string") context.registerSecret(bootstrap[key]);
  assert.equal(bootstrap.initialServers?.servers?.find(target => target.id === "local")?.observationTargetIdentity, localIdentity);
  const foreignTarget = await boundedFetch(
    observationUrl(baseUrl, "not-authorized", deletedWorkspace),
    { headers: { cookie: firstCookie }, signal },
  );
  assert.equal(foreignTarget.status, 404);
  const wrongMethod = await boundedFetch(localUrl, {
    method: "POST",
    headers: { cookie: firstCookie },
    signal,
  });
  assert.equal(wrongMethod.status, 405);

  const heldRequest = boundedFetch(localUrl, {
    headers: { cookie: firstCookie },
    timeoutMs: 6_000,
    signal,
  });
  await waitFor(async () => {
    const probe = await boundedFetch(localUrl, {
      headers: { cookie: firstCookie },
      signal,
    });
    if (probe.status !== 200) return null;
    const body = await probe.json();
    return body.status === "unknown" && body.reason === "observation_in_progress" ? body : null;
  }, 2_000, "shared Gateway observation permit", 25, signal);

  const logout = await boundedFetch(`${baseUrl}/logout`, {
    method: "POST",
    headers: { cookie: firstCookie },
    redirect: "manual",
    signal,
  });
  assert.equal(logout.status, 303);
  const secondCookie = await loginCookie(context, firstGateway, signal);
  assert.notEqual(secondCookie, firstCookie);
  const newOwnerDuringPending = await boundedFetch(localUrl, {
    headers: { cookie: secondCookie },
    signal,
  });
  assert.equal(newOwnerDuringPending.status, 200);
  const pendingBody = await newOwnerDuringPending.json();
  assert.equal(pendingBody.status, "unknown");
  assert.equal(pendingBody.reason, "observation_in_progress");

  const oldOwnerAfterRotation = await heldRequest;
  assert.equal(oldOwnerAfterRotation.status, 401);
  const oldOwnerBody = await oldOwnerAfterRotation.json();
  assert.equal(oldOwnerBody.error, "Authentication required");

  const sshPlain = await boundedFetch(
    observationUrl(baseUrl, "ssh-plain", "/remote/workspace", identities.get("ssh-plain")),
    { headers: { cookie: secondCookie }, signal },
  );
  assert.equal(sshPlain.status, 200);
  assert.deepEqual(await observationState(sshPlain), {
    status: "unknown",
    reason: "unsupported_transport",
  });
  const sshAccount = await boundedFetch(
    observationUrl(baseUrl, "ssh-account", "/remote/private-workspace", identities.get("ssh-account")),
    { headers: { cookie: secondCookie }, signal },
  );
  assert.equal(sshAccount.status, 200);
  assert.deepEqual(await observationState(sshAccount), {
    status: "unknown",
    reason: "unsupported_transport",
  });

  const heldSettled = await waitFor(async () => {
    const response = await boundedFetch(localUrl, {
      headers: { cookie: secondCookie },
      signal,
    });
    if (response.status !== 200) return null;
    const body = await response.json();
    return body.status === "absent" ? body : null;
  }, 4_000, "timed-out underlying observer settlement", 50, signal);
  assert.equal(heldSettled.workspacePath, deletedWorkspace);
  await assertMissing(deletedWorkspace);
  await assertMissing(missingDefaultWorkspace);

  await context.stopOwned(firstGatewayLabel);
  const restartGatewayLabel = "workspace-cwd-observer-restart-gateway";
  const restartedGateway = await startGateway(context, {
    auth: true,
    label: restartGatewayLabel,
    workspace: missingDefaultWorkspace,
    env: sharedEnvironment,
    startTimeoutMs: 15_000,
  });
  const restartCookie = await loginCookie(context, restartedGateway, signal);
  const restartInventory = await (await boundedFetch(`${restartedGateway.baseUrl}/api/servers`, { headers: { cookie: restartCookie }, signal })).json();
  const restartIdentity = restartInventory.servers.find(target => target.id === "local")?.observationTargetIdentity;
  assert.match(restartIdentity, /^[a-f0-9]{64}$/);
  const afterRestart = await boundedFetch(
    observationUrl(restartedGateway.baseUrl, "local", deletedWorkspace, restartIdentity),
    { headers: { cookie: restartCookie }, signal },
  );
  assert.equal(afterRestart.status, 200);
  const restartObservation = await afterRestart.json();
  assert.equal(restartObservation.status, "absent");
  assert.equal(restartObservation.workspacePath, deletedWorkspace);
  await assertMissing(deletedWorkspace);
  await assertMissing(missingDefaultWorkspace);

  const evidence = {
    schema: "kcoder.workspace-cwd-observation-preflight-v1",
    scope: "real loopback Gateway HTTP host with RunContext-owned process, profile, workspace paths, and ports",
    processes: [firstGatewayLabel, restartGatewayLabel],
    ports: [firstGateway.port, restartedGateway.port],
    route: {
      anonymousGetStatus: anonymous.status,
      mobileCorsPreflightStatus: preflight.status,
      authorizedTargetId: "local",
      unavailableTargetStatus: foreignTarget.status,
      wrongMethodStatus: wrongMethod.status,
      unboundInventoryRejected: true,
      staleInventoryRejectedBeforeObservation: true,
      catalogBootstrapIdentityMatched: true,
      authRotatedWhileObservationHeld: true,
      oldOwnerStatusAfterRotation: oldOwnerAfterRotation.status,
      newOwnerDuringSharedPending: { status: pendingBody.status, reason: pendingBody.reason },
      localCwdAfterUnderlyingSettle: { status: heldSettled.status, pathSha256: sha256(deletedWorkspace) },
      localCwdAfterGatewayRestart: { status: restartObservation.status, pathSha256: sha256(restartObservation.workspacePath) },
    },
    ssh: {
      plainTarget: { status: "unknown", reason: "unsupported_transport" },
      accountTarget: { status: "unknown", reason: "unsupported_transport" },
      connectionAttempted: false,
    },
    appServerStarted: false,
    pathsStayedMissing: true,
    authValuesPersisted: false,
    cleanupOwner: "RunContext: target/test/apps/kcoder-studio/e2e/preflight/workspace-cwd-observation",
  };
  await context.writeArtifactJson("workspace-cwd-observation-preflight-v1.json", evidence);
  return evidence;
});

function observationUrl(baseUrl, targetId, workspacePath, expectedTargetIdentity) {
  return `${baseUrl}/api/servers/${targetId}/cwd-observation?workspace=${encodeURIComponent(workspacePath)}${expectedTargetIdentity ? `&expectedTargetIdentity=${expectedTargetIdentity}` : ""}`;
}

async function loginCookie(context, gateway, signal) {
  const response = await boundedFetch(`${gateway.baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: gateway.authToken }),
    redirect: "manual",
    signal,
  });
  assert.equal(response.status, 303);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  context.registerSecret(setCookie);
  const cookie = setCookie.split(";", 1)[0];
  context.registerSecret(cookie);
  return cookie;
}

async function boundedFetch(url, options = {}) {
  const { timeoutMs = 7_000, signal: runSignal, ...requestOptions } = options;
  const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(runSignal ? [runSignal] : [])]);
  return fetch(url, { ...requestOptions, signal: requestSignal });
}

async function observationState(response) {
  const body = await response.json();
  return { status: body.status, reason: body.reason };
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
