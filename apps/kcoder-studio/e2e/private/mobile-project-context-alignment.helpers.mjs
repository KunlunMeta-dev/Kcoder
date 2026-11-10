import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from "../harness/rpc.mjs";

const PROJECT_KEY = "owned-project-context-same-key";
const rpcSessionCredentials = new WeakMap();

export async function createProjectContextFixture(context) {
  const scratch = await context.createOwnedScratchDirectory("project-context-alignment", {
    baseDirectory: "/tmp",
  });
  const sharedPath = context.pathInScratch(scratch, "Shared");
  const deployments = [
    { id: "gateway-alpha", serverId: "local-one", targetAlias: "Alpha-One", serverLabel: "Local", projectName: "Alpha Project One" },
    { id: "gateway-alpha", serverId: "local-two", targetAlias: "Alpha-Two", serverLabel: "Local", projectName: "Alpha Project Two" },
    { id: "gateway-beta", serverId: "local-one", targetAlias: "Beta-One", serverLabel: "Local", projectName: "Beta Project One" },
    { id: "gateway-beta", serverId: "local-two", targetAlias: "Beta-Two", serverLabel: "Local", projectName: "Beta Project Two" },
  ].map(target => ({
    ...target,
    defaultCwd: context.pathInScratch(scratch, target.targetAlias),
    roots: [sharedPath, context.pathInScratch(scratch, target.targetAlias)],
    projectKey: PROJECT_KEY,
  }));

  await Promise.all([...new Set([sharedPath, ...deployments.map(target => target.defaultCwd)])]
    .map(path => mkdir(path, { recursive: true, mode: 0o700 })));

  return {
    scratch,
    sharedPath: resolve(sharedPath),
    deployments: deployments.map(target => ({
      ...target,
      defaultCwd: resolve(target.defaultCwd),
      roots: target.roots.map(path => resolve(path)),
    })),
  };
}

export function gatewayServerConfiguration(targets) {
  assert.ok(Array.isArray(targets) && targets.length === 2,
    "each owned Gateway must expose exactly two local target fixtures");
  return targets.map(target => ({
    id: target.serverId,
    label: target.serverLabel,
    transport: "local",
    workspace: target.defaultCwd,
  }));
}

export async function seedProjectContextTarget(context, gateway, target) {
  const { accessToken, rpcToken } = await ownedGatewaySession(context, gateway);
  const rpcUrl = new URL(gatewayRpcUrl(gateway, target.serverId, rpcToken));
  rpcUrl.searchParams.set("workspace", target.defaultCwd);
  const rpc = await openRpc(rpcUrl.toString(), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  context.addCleanup(`close project metadata seeding RPC ${target.targetAlias}`, () =>
    closeRpcAndWait(rpc, `project metadata seeding RPC ${target.targetAlias}`));

  try {
    await initializeRpc(rpc, `project-context-seed-${target.targetAlias}`);
    const request = {
      deviceId: target.serverId,
      projectKey: target.projectKey,
      name: target.projectName,
      roots: target.roots,
      runtime: "kcoder",
    };
    const upsert = await rpc.request("runtime.projects.upsert_local", request, 30_000);
    assert.equal(upsert?.accepted, true, `${target.targetAlias} project metadata must be registered by the real app-server RPC`);
    assert.equal(upsert?.deviceId, target.serverId);
    assert.equal(upsert?.projectKey, target.projectKey);

    const [workspaceList, worktreeList] = await Promise.all([
      rpc.request("runtime.workspaces.list", { deviceId: target.serverId }, 30_000),
      rpc.request("runtime.worktrees.list", { deviceId: target.serverId }, 30_000),
    ]);
    assert.ok(Array.isArray(workspaceList?.items), `${target.targetAlias} app-server must return real registered workspace metadata`);
    assert.ok(Array.isArray(worktreeList?.items), `${target.targetAlias} app-server must return a real worktree list`);
    const projectItems = workspaceList.items.filter(item => item?.projectKey === target.projectKey);
    assert.equal(projectItems.length, 2, `${target.targetAlias} must expose the two roots registered under one project key`);
    assert.deepEqual(
      projectItems.map(item => resolve(String(item.workspacePath))).sort(),
      [...target.roots].sort(),
      `${target.targetAlias} app-server must preserve both canonical project roots`,
    );
    assert.ok(projectItems.every(item => item.projectName === target.projectName),
      `${target.targetAlias} app-server must return the registered project name for both roots`);
    assert.ok(projectItems.every(item => Array.isArray(item.projectRoots) &&
      item.projectRoots.map(path => resolve(String(path))).sort().join("\0") === [...target.roots].sort().join("\0")),
    `${target.targetAlias} app-server must return the same full root set for each project member`);

    return {
      targetAlias: target.targetAlias,
      gatewayId: target.id,
      serverId: target.serverId,
      requestCwd: target.defaultCwd,
      projectKey: target.projectKey,
      projectName: target.projectName,
      registeredRoots: target.roots,
      upsertAccepted: true,
      listedProjectItems: projectItems.map(item => ({
        workspacePath: resolve(String(item.workspacePath)),
        projectKey: item.projectKey,
        projectName: item.projectName,
        projectRoots: item.projectRoots.map(path => resolve(String(path))),
        workspaceKind: item.workspaceKind ?? null,
        available: item.available ?? null,
      })),
      worktreeListCount: worktreeList.items.length,
      worktreeItems: worktreeList.items.map(item => ({
        path: typeof item?.path === "string" ? resolve(item.path) : null,
        state: typeof item?.state === "string" ? item.state : null,
        repositoryName: typeof item?.repositoryName === "string" ? item.repositoryName : null,
      })),
    };
  } finally {
    await closeRpcAndWait(rpc, `project metadata seeding RPC ${target.targetAlias}`);
  }
}

export function observeMobileProjectRuntime(page, { gateways, targets, pathLabels, verifiedProfiles }) {
  assert.ok(verifiedProfiles instanceof Map, "verified UI profile mapping must be a mutable Map owned by this acceptance run");
  const calls = [];
  const forbiddenStarts = [];
  const identityErrors = [];
  const pairingObservationErrors = [];
  const pairingObservationPromises = [];
  const verifiedPairGateways = new Set();
  const pairingResponses = [];
  let socketOrdinal = 0;
  const pending = new Map();
  const aliases = new Map(Object.entries(pathLabels).map(([alias, path]) => [resolve(path), alias]));
  const targetByOwner = new Map(targets.map(target => [`${target.id}:${target.serverId}`, target]));
  const gatewayByAuthority = new Map(Object.entries(gateways).map(([id, gateway]) => {
    const url = new URL(gateway.wsUrl);
    const basePath = url.pathname.replace(/\/+$/, "");
    return [`${url.host}${basePath}/rpc`, { id, gateway }];
  }));

  page.on("response", response => {
    const observation = (async () => {
      let responseUrl;
      try { responseUrl = new URL(response.url()); } catch { return; }
      const request = response.request();
      if (!responseUrl.pathname.endsWith("/api/mobile/session") || request.method() !== "POST") return;
      const gatewayEntry = Object.entries(gateways).find(([, gateway]) => new URL(gateway.baseUrl).origin === responseUrl.origin);
      if (!gatewayEntry) return;
      const requestHeaders = await request.allHeaders();
      let pageOriginAtRequest = null;
      try { pageOriginAtRequest = safePageUrl(request.frame().url())?.origin ?? null; } catch {}
      const [gatewayId] = gatewayEntry;
      pairingResponses.push({
        gatewayId,
        sourceOrigin: requestHeaders.origin ?? requestHeaders.Origin ?? null,
        pageOriginAtRequest,
        destinationOrigin: responseUrl.origin,
        status: response.status(),
      });
      if (response.status() === 200) verifiedPairGateways.add(gatewayId);
    })().catch(error => {
      pairingObservationErrors.push(error instanceof Error ? error.name : "unknown-observer-error");
    });
    pairingObservationPromises.push(observation);
  });

  page.on("websocket", socket => {
    const ordinal = ++socketOrdinal;
    let url;
    try { url = new URL(socket.url()); } catch { return; }
    if (!url.pathname.endsWith("/rpc") || !["ws:", "wss:"].includes(url.protocol)) return;
    const owner = gatewayByAuthority.get(`${url.host}${url.pathname}`);
    const gatewayId = owner?.id ?? null;
    const serverId = url.searchParams.get("server");
    const target = gatewayId && serverId ? targetByOwner.get(`${gatewayId}:${serverId}`) : null;
    const explicitWorkspace = url.searchParams.get("workspace");
    const explicitWorkspaceAlias = explicitWorkspace ? workspaceAlias(explicitWorkspace, aliases) : null;
    const workspace = explicitWorkspace
      ? explicitWorkspaceAlias
      : target ? `default:${target.targetAlias}` : null;
    const socketScope = {
      gatewayId,
      gatewayOrigin: owner ? new URL(owner.gateway.baseUrl).origin : null,
      pageOriginAtSocketOpen: safePageUrl(page.url())?.origin ?? null,
      socketOrdinal: ordinal,
      serverId,
      targetAlias: target?.targetAlias ?? null,
      workspace,
      workspaceSource: explicitWorkspace ? "rpc-workspace-query" : target ? "owned-target-default" : null,
    };
    const missing = [
      !gatewayId && "unowned-gateway-origin",
      !serverId && "missing-server-query",
      serverId && !target && "server-not-in-owned-gateway-config",
      !workspace && "missing-or-unknown-workspace-route",
    ].filter(Boolean);
    if (missing.length) identityErrors.push({ socketOrdinal: ordinal, issues: missing, ...socketScope });

    const requestScope = () => {
      const pageRouteProfileId = profileIdFromUrl(safePageUrl(page.url()));
      let pairedProfileId = gatewayId ? profileIdForGateway(verifiedProfiles, gatewayId) : null;
      if (!pairedProfileId && gatewayId && verifiedPairGateways.has(gatewayId) && pageRouteProfileId) {
        verifiedProfiles.set(gatewayId, pageRouteProfileId);
        pairedProfileId = pageRouteProfileId;
      }
      return {
        ...socketScope,
        profileId: pairedProfileId,
        profileIdentitySource: pairedProfileId ? "verified-ui-pair-and-home-route" : null,
        pageRouteProfileId,
        pageOriginAtSend: safePageUrl(page.url())?.origin ?? null,
      };
    };

    socket.on("framesent", event => {
      const frame = parseFrame(event.payload);
      if (!frame || typeof frame.method !== "string") return;
      const tracked = ["runtime.workspaces.list", "runtime.worktrees.list", "thread/history/refresh", "thread/start", "turn/start"]
        .includes(frame.method);
      if (!tracked) return;
      const scope = requestScope();
      const profileIssues = [
        !scope.profileId && "missing-verified-ui-pair-profile",
        !scope.pageRouteProfileId && "missing-home-or-new-route-profile",
        scope.profileId && scope.pageRouteProfileId && scope.profileId !== scope.pageRouteProfileId && "profile-route-does-not-match-ui-pair",
      ].filter(Boolean);
      if (profileIssues.length) identityErrors.push({ socketOrdinal: ordinal, method: frame.method, issues: profileIssues, ...scope });
      if (frame.method === "thread/start" || frame.method === "turn/start") {
        forbiddenStarts.push({ ...scope, method: frame.method });
      }
      const id = frame.id === undefined ? null : String(frame.id);
      const call = {
        ...scope,
        pageRouteProfileIdAtSend: profileIdFromUrl(safePageUrl(page.url())),
        requestId: id,
        method: frame.method,
        params: summarizeParams(frame.method, frame.params),
        response: null,
      };
      calls.push(call);
      if (id !== null) pending.set(`${ordinal}:${id}`, call);
    });

    socket.on("framereceived", event => {
      const frame = parseFrame(event.payload);
      if (!frame || frame.id === undefined) return;
      const call = pending.get(`${ordinal}:${String(frame.id)}`);
      if (!call) return;
      call.response = summarizeResponse(call.method, frame, aliases);
      pending.delete(`${ordinal}:${String(frame.id)}`);
    });
  });

  return {
    calls,
    forbiddenStarts,
    identityErrors,
    pairingObservationErrors,
    verifiedPairGateways,
    verifiedProfiles,
    pairingResponses,
    settlePairingObservations: async () => Promise.all(pairingObservationPromises),
  };
}

export function recordVerifiedUiPair(observer, { gateways, responseMethod, responseStatus, responseUrl, homeUrl }) {
  assert.ok(observer?.verifiedProfiles instanceof Map,
    "verified UI profile mapping must be a mutable Map owned by this acceptance observer");
  assert.ok(observer.verifiedPairGateways instanceof Set,
    "pairing evidence must be recorded by the Mobile runtime observer");
  assert.equal(responseMethod, "POST", "Mobile pairing must be a real POST session exchange");
  assert.equal(responseStatus, 200, "Gateway pairing must complete through the real Mobile UI session exchange");
  const pairUrl = safePageUrl(responseUrl);
  assert.ok(pairUrl && pairUrl.pathname.endsWith("/api/mobile/session"),
    "verified UI pairing response must be the actual Mobile session endpoint");
  const responseOrigin = pairUrl.origin;
  const gatewayEntry = Object.entries(gateways).find(([, gateway]) => new URL(gateway.baseUrl).origin === responseOrigin);
  assert.ok(gatewayEntry, "the successful Mobile pairing response must come from an owned Gateway origin");
  const [gatewayId] = gatewayEntry;
  const profileId = profileIdFromUrl(safePageUrl(homeUrl));
  assert.ok(profileId, "the paired Mobile UI must reach a Home/new route carrying its created profileId");
  observer.verifiedProfiles.set(gatewayId, profileId);
  observer.verifiedPairGateways.add(gatewayId);
  return { gatewayId, profileId, pairingStatus: responseStatus, responseOrigin };
}

export function assertOwnedProjectRuntimeIdentity(observer, { gateways, targets, verifiedProfiles, uiOrigin }) {
  const targetByOwner = new Map(targets.map(target => [`${target.id}:${target.serverId}`, target]));
  const knownGateways = new Set(Object.keys(gateways));
  assert.ok(observer.calls.length > 0, "the real Mobile page must emit observed project/runtime RPC requests");
  assert.deepEqual([...observer.verifiedPairGateways].sort(), [...knownGateways].sort(),
    "each owned Gateway must have a successful Mobile UI pairing exchange recorded by the observer");
  for (const gatewayId of knownGateways) {
    const pairing = observer.pairingResponses.find(response => response.gatewayId === gatewayId && response.status === 200);
    assert.ok(pairing, `${gatewayId} pairing must have a real successful Mobile session response`);
    assert.equal(pairing.pageOriginAtRequest, uiOrigin,
      `${gatewayId} pairing request must originate from the one shared Mobile Web page origin`);
    assert.equal(pairing.destinationOrigin, new URL(gateways[gatewayId].baseUrl).origin,
      `${gatewayId} pairing response must come from that owned Gateway origin`);
    if (pairing.destinationOrigin === uiOrigin) {
      assert.ok(pairing.sourceOrigin === null || pairing.sourceOrigin === uiOrigin,
        `${gatewayId} same-origin session POST may omit Origin, but any Origin header must match the Mobile page`);
    } else {
      assert.equal(pairing.sourceOrigin, uiOrigin,
        `${gatewayId} cross-origin session POST must carry the Alpha Mobile Web Origin`);
    }
  }
  assert.deepEqual(observer.pairingObservationErrors, [], "pairing HTTP origin observations must complete without errors");
  const profileIds = [...knownGateways].map(gatewayId => profileIdForGateway(verifiedProfiles, gatewayId));
  assert.ok(profileIds.every(value => typeof value === "string" && value.length > 0),
    "each owned Gateway must have a non-empty verified Mobile profile ID");
  assert.equal(new Set(profileIds).size, profileIds.length,
    "each owned Gateway must be paired to a distinct Mobile profile in the shared Web origin storage");
  assert.deepEqual(observer.identityErrors, [], "every observed runtime socket must have a known Gateway/profile/server/workspace identity");
  for (const call of [...observer.calls, ...observer.forbiddenStarts]) {
    assert.ok(knownGateways.has(call.gatewayId), "runtime request must belong to an owned Gateway origin");
    assert.ok(typeof call.gatewayOrigin === "string" && call.gatewayOrigin.length > 0,
      "runtime request must retain the actual owned Gateway origin that matched its socket route");
    assert.equal(call.gatewayOrigin, new URL(gateways[call.gatewayId].baseUrl).origin,
      "runtime request Gateway origin must match the owned Gateway selected by its actual WebSocket endpoint");
    assert.equal(call.pageOriginAtSocketOpen, uiOrigin,
      "owned runtime WebSocket must be opened from the shared Mobile Web origin");
    assert.ok(typeof call.profileId === "string" && call.profileId.length > 0,
      "runtime request must carry a non-empty profile ID established by a successful UI pairing and route");
    assert.equal(call.profileId, profileIdForGateway(verifiedProfiles, call.gatewayId),
      "runtime request profileId must match a profile created by that Gateway's verified UI pairing");
    assert.ok(call.pageRouteProfileIdAtSend, "runtime request page route must carry a profileId");
    assert.equal(call.pageOriginAtSend, uiOrigin,
      "all Gateway profiles must be switched from the same Mobile Web origin so local profile storage is shared");
    assert.equal(call.pageRouteProfileIdAtSend, call.profileId,
      "runtime request page route profileId must match the profile paired to the actual Gateway socket origin");
    assert.ok(call.serverId, "runtime request must carry its selected server ID");
    const target = targetByOwner.get(`${call.gatewayId}:${call.serverId}`);
    assert.ok(target, "runtime request server must belong to the matched Gateway config");
    assert.equal(call.targetAlias, target.targetAlias, "runtime request must retain the matched target configuration identity");
    assert.ok(call.workspace && call.workspace !== "other-owned",
      "runtime request workspace must map to an explicit owned path or its known target default");
    assert.ok(["rpc-workspace-query", "owned-target-default"].includes(call.workspaceSource),
      "runtime request workspace identity must record its explicit source");
    if (call.workspaceSource === "owned-target-default") {
      assert.equal(call.workspace, `default:${target.targetAlias}`, "implicit RPC workspace must resolve to that target's configured default cwd");
    }
    if (call.method === "runtime.workspaces.list" || call.method === "runtime.worktrees.list") {
      assert.equal(call.params?.deviceId, call.serverId, `${call.method} clientRequest deviceId must match the socket target query`);
    }
  }
  const browserTargetReads = new Set(observer.calls
    .filter(call => call.method === "runtime.workspaces.list" || call.method === "runtime.worktrees.list")
    .map(call => `${call.gatewayId}:${call.serverId}`));
  for (const target of targets) {
    assert.ok(browserTargetReads.has(`${target.id}:${target.serverId}`),
      `Mobile UI must read real workspace/worktree metadata for ${target.targetAlias} through its own Gateway/server route`);
  }
  assert.deepEqual(observer.forbiddenStarts, [], "project-context navigation must remain draft-only with zero thread/start or turn/start calls");
}

export function assertSharedWorkspaceRoutedAcrossProfiles(observer) {
  const requiredTargets = ["Alpha-One", "Beta-One"];
  const sharedWorkspaceCalls = observer.calls.filter(call => call.workspace === "Shared" && call.workspaceSource === "rpc-workspace-query");
  for (const targetAlias of requiredTargets) {
    assert.ok(sharedWorkspaceCalls.some(call => call.targetAlias === targetAlias),
      `the same registered Shared absolute path must be requested through ${targetAlias}'s distinct Gateway/profile route`);
  }
  const owners = sharedWorkspaceCalls
    .filter(call => requiredTargets.includes(call.targetAlias))
    .map(call => ({ gatewayId: call.gatewayId, serverId: call.serverId, profileId: call.profileId, workspace: call.workspace }));
  assert.equal(new Set(owners.map(owner => owner.profileId)).size, requiredTargets.length,
    "the same Shared workspace path must remain scoped to distinct Mobile profile identities");
  return owners;
}

export function assertDraftRouteIdentity(page, { profileId, serverId, cwd }) {
  const url = safePageUrl(page.url());
  assert.ok(url, "Mobile draft route URL must be valid");
  assert.match(url.pathname, /\/new\/?$/, "workspace Plus must navigate to the Mobile new-task draft route");
  assert.equal(url.searchParams.get("profileId"), profileId, "Plus draft route must preserve the selected profile ID");
  assert.equal(url.searchParams.get("serverId"), serverId, "Plus draft route must preserve the selected server ID");
  assert.equal(url.searchParams.get("cwd"), cwd, "Plus draft route must preserve the exact selected workspace path");
  return { pathname: url.pathname, profileId, serverId, cwd };
}

function profileIdForGateway(verifiedProfiles, gatewayId) {
  if (verifiedProfiles instanceof Map) return verifiedProfiles.get(gatewayId) ?? null;
  return verifiedProfiles?.[gatewayId] ?? null;
}

async function ownedGatewaySession(context, gateway) {
  const cached = rpcSessionCredentials.get(gateway);
  if (cached) return cached;
  const pending = (async () => {
    assert.ok(typeof gateway.authToken === "string" && gateway.authToken.length >= 32,
      "owned Gateway pairing credential is required to create an isolated app session");
    context.registerSecret(gateway.authToken);
    const response = await fetch(new URL("/api/mobile/session", gateway.baseUrl), {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { origin: gateway.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ token: gateway.authToken }),
    });
    assert.equal(response.status, 200, "owned Gateway must issue an authenticated Mobile session through its pairing endpoint");
    const body = await response.json();
    assert.ok(typeof body?.accessToken === "string" && body.accessToken.length >= 32,
      "owned Gateway session response must contain an access token");
    context.registerSecret(body.accessToken);
    assert.ok(typeof body?.rpcToken === "string" && body.rpcToken.length > 0,
      "owned Gateway session response must contain the RPC token used by Mobile Web");
    context.registerSecret(body.rpcToken);
    return { accessToken: body.accessToken, rpcToken: body.rpcToken };
  })();
  rpcSessionCredentials.set(gateway, pending);
  try {
    const session = await pending;
    rpcSessionCredentials.set(gateway, Promise.resolve(session));
    return session;
  } catch (error) {
    rpcSessionCredentials.delete(gateway);
    throw error;
  }
}

function profileIdFromUrl(url) {
  if (!url) return null;
  const routeId = url.pathname.match(/\/mobile\/h\/([^/]+)/)?.[1];
  const value = routeId ?? url.searchParams.get("profileId");
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}

function workspaceAlias(value, pathAliasMap) {
  if (typeof value !== "string" || !value) return null;
  return pathAliasMap.get(resolve(value)) ?? null;
}

export function assertNoTaskCreation(observer, label) {
  assert.deepEqual(observer.forbiddenStarts, [], `${label} must remain a draft-only flow with zero thread/start and turn/start calls`);
}

function summarizeParams(method, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  if (method === "runtime.workspaces.list" || method === "runtime.worktrees.list") {
    return { deviceId: typeof params.deviceId === "string" ? params.deviceId : null };
  }
  if (method === "thread/history/refresh") {
    return {
      acknowledgeExternalWriters: params.acknowledgeExternalWriters === true,
      cancel: params.cancel === true,
      cursorPresent: typeof params.cursor === "string",
    };
  }
  return {};
}

function summarizeResponse(method, frame, pathAliases) {
  if (frame.error) {
    const diagnostic = sanitizeDiagnosticText(frame.error.message, pathAliases);
    return {
      rpcError: true,
      errorCode: Number.isInteger(frame.error.code) ? frame.error.code : null,
      errorMessage: diagnostic.message,
      pathAliases: diagnostic.pathAliases,
      osErrorCode: diagnostic.osErrorCode,
    };
  }
  const result = frame.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  if (method === "runtime.workspaces.list") {
    return {
      success: result.success === true,
      items: Array.isArray(result.items) ? result.items.map(item => ({
        workspace: typeof item?.workspacePath === "string" ? pathAliases.get(resolve(item.workspacePath)) ?? "other-owned" : null,
        projectKey: typeof item?.projectKey === "string" ? item.projectKey : null,
        projectName: typeof item?.projectName === "string" ? item.projectName : null,
        roots: Array.isArray(item?.projectRoots)
          ? item.projectRoots.map(path => typeof path === "string" ? pathAliases.get(resolve(path)) ?? "other-owned" : null)
          : [],
        workspaceKind: typeof item?.workspaceKind === "string" ? item.workspaceKind : null,
      })) : null,
    };
  }
  if (method === "runtime.worktrees.list") {
    return {
      success: result.success === true,
      items: Array.isArray(result.items) ? result.items.map(item => ({
        path: typeof item?.path === "string" ? pathAliases.get(resolve(item.path)) ?? "other-owned" : null,
        state: typeof item?.state === "string" ? item.state : null,
        repositoryName: typeof item?.repositoryName === "string" ? item.repositoryName : null,
      })) : null,
    };
  }
  if (method === "thread/history/refresh") {
    const issues = Array.isArray(result.issues) ? result.issues.slice(0, 8).map(issue => {
      const diagnostic = sanitizeDiagnosticText(issue?.reason, pathAliases);
      return {
        issueCode: diagnostic.osErrorCode === null ? null : `os-error-${diagnostic.osErrorCode}`,
        sessionIdPresent: typeof issue?.sessionId === "string" && issue.sessionId.length > 0,
        message: diagnostic.message,
        pathAliases: diagnostic.pathAliases,
        osErrorCode: diagnostic.osErrorCode,
      };
    }) : [];
    return {
      status: typeof result.status === "string" ? result.status : null,
      issueCount: Number.isSafeInteger(result.issueCount) ? result.issueCount : null,
      hasNextCursor: typeof result.nextCursor === "string",
      issues,
    };
  }
  return null;
}

function sanitizeDiagnosticText(value, pathAliases) {
  const raw = typeof value === "string" ? value : "";
  const matchedAliases = new Set();
  let message = raw;
  const knownPaths = [...pathAliases.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [path, alias] of knownPaths) {
    const normalizedPath = path.replaceAll("\\", "/");
    if (message.includes(path) || message.includes(normalizedPath)) matchedAliases.add(alias);
    message = message.replaceAll(path, `<${alias}>`);
    if (normalizedPath !== path) message = message.replaceAll(normalizedPath, `<${alias}>`);
  }
  const osError = raw.match(/\((?:os )?error (\d+)\)/i);
  message = message
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:[^\s/"'<>]+\/){1,})[^\s"'<>]*/g, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<opaque-id>")
    .replace(/\b[0-9a-f]{24,}\b/gi, "<opaque-id>")
    .replace(/\b[\w.-]{8,}\.(?:jsonl|json)\b/gi, "<history-entry>")
    .replace(/\s+/g, " ")
    .trim();
  return {
    message: message.slice(0, 480),
    pathAliases: [...matchedAliases].sort(),
    osErrorCode: osError ? Number(osError[1]) : null,
  };
}

function safePageUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function parseFrame(payload) {
  try {
    const value = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
    const frame = JSON.parse(value);
    return frame && typeof frame === "object" && !Array.isArray(frame) ? frame : null;
  } catch { return null; }
}
