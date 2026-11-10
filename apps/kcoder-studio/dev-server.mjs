import { createBrowserSessionCookies } from './src/browser-session-cookie.js';
import { requestBody } from './src/gateway-http-body.js';
import { createServerMutationQueue, writeServerConfiguration } from './src/server-mutation.mjs';
import { targetWorkspaceBrokerKey } from './src/remotes/target-workspace-path.mjs';
import { captureGatewayStartupResources } from './src/gateway-startup-resources.js';
import { createStudioPublicAssets } from './src/studio-public-assets.js';
import { createGatewayStartupObservation } from './src/gateway-startup-observation.js';
import { consumeGatewayNativeComponentImageStartup, captureGatewayWindowsComponentImage, nativeWindowsComponentEnvironment } from './src/integrations/native-component-image.mjs';
import { settleSourceConnectivityLaunch } from './src/integrations/connectivity/resource-host.mjs';
import { createServerInventoryRoutes } from "./src/server-inventory-routes.js";
import { createGatewayMigrationSourceSessions } from './src/migration-source-session-gateway.js';
import { terminateMigrationSourceSessionChild as terminateOwnedAppServer } from './src/migration-source-session-launch.js';
import { createStudioStaticRoute } from './src/studio-static-route.js';
import { sourceAppServerBinary } from './src/source-app-server-binary.js';
import { createStudioViteRenderer, studioRendererMode } from './src/studio-vite-renderer.js';
import { safeReturnTo, escapeHtml, loginPage } from './src/gateway-login-presentation.js';
import { createMobileWebCors } from './src/mobile-web-cors.js';
import { createWebSocketFrameCodec } from "./src/websocket-frame-codec.js";
import { watchWebSocketUpgrade } from './src/websocket-upgrade-guard.mjs';
import { createMobileWebStatic } from "./src/mobile-web-static.js";
import { createMobileWebDevProxy } from "./src/mobile-web-dev-proxy.js";
import { loadGatewayPublicAccess, publicRequestSurface } from "./src/gateway-public-access.js";
import { captureRetentionAuthority, registerMobileDeviceGrantState, retentionTargetFingerprint } from "./src/retention-context.js";
import { captureTrustedLocalAppServer } from "./src/trusted-local-app-server.js";
import { localRetentionRoute } from "./src/retention-device-revocation.js";
import { createRetentionRevocationPump } from "./src/retention-revocation-pump.js";
import { createWidgetSandboxRoute } from "./src/widget-sandbox-route.js";
import { createMobileDeviceAuth, mobileDeviceStoreIdentity } from "./src/mobile-device-auth.js";
import { accountPairingProofMatches, gatewayRelaySecret, relaySecretMatches, createRelayPairingHandler, createRelayAccountEntryHandler, gatewayMobilePairingToken, fixedMobilePairingTokenMatches, selectMobilePairingCredential } from './src/gateway-relay-auth.js';
import { createMobilePeerGateway } from "./src/mobile-peer-gateway.js";
import { gatewayListenHost, gatewayPeerOptions } from "./src/gateway-connectivity.js";
import { createGatewayAuthSessionRegistry } from './src/browser-session-recovery.js';
import { attachMobileConnectionRoutes, createMobileConnectionProofHandler, createMobileConnectionRoutesProvider, createPublicPairingReadiness } from "./src/mobile-connection-routes.js";
import { createMobileRouteAuthorizationHandler } from "./src/mobile-route-authorization.js";
import { McpOAuthCallbackRegistry } from "./src/mcp-oauth-callback-registry.js";
import { createGatewayAdmission } from "./src/gateway-admission.js";
import { isGatewayBrowserAdminRequest, websocketSessionCredential } from "./src/gateway-browser-access.js";
import { createGatewayToken, studioDataDirectory, writeStudioLoginUrl, loginUrl } from "./src/studio-login-link.js";
import { authenticatedAccountProcess } from "./src/account-process.js";
import { createAccountCredentialStore } from "./src/account-credentials.js";
import { createAccountAdministrationRoute } from "./src/account-administration.js";
import { createOrganizationOidcRoutes } from "./src/account-oidc-routes.js";
import { deliverNativeOidcLogout } from "./src/account-oidc-logout.js";
import { diagnosticBuildVersion, diagnosticProtocolVersion, respondWithServerStatusSnapshot } from "./src/server-status-snapshot.js";
import {
  ANONYMOUS_LOGIN_OWNER,
  authorityIdFor,
  createAccountLoginContexts,
} from "./src/account-login-context.js";
import { spawn } from "node:child_process";
import { MockThreadStore } from "./src/mock-thread-store.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  CONNECTION_REFUSAL,
  connectionCapacityRefusal,
  connectionRefusalDiagnostic,
} from "./src/connection-admission.js";
import {
  accountLogoutCleanupPlan,
  runAccountLogoutCleanup,
} from "./src/account-logout.js";
import { realpathSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadResourcePolicy } from "./src/resource-policy.js";
import { GatewayResourceBudget } from "./src/gateway-resource-budget.js";
import { mergeRequestLoad, requestLoadDiagnostic } from "./src/request-load.js";
import { WebSocketLivenessLease } from "./src/websocket-liveness-lease.js";
import { BoundedJsonlDecoder } from "./src/bounded-jsonl-decoder.js";
import { pendingWorkIdleDelay, releaseIdleBrokers, retireRestartScopeAdmissions, workspaceIdleDelay } from "./src/workspace-broker-release.js";
import { inspectGatewayChannelMessage } from "./src/gateway-channel.js";
import { createRuntimeTargetAdapter } from "./src/runtime-target-adapter.js";
import {
  appServerEnvironment,
  hasFullServerAccess,
  reconcileServerAccess,
  workspaceReceiptParentAttempt,
  nativeComponentParentAttempt,
  launchSpec,
  loadServers,
  normalizeServer,
  publicServer,
  runtimeCapabilities,
  storedServer,
} from "./src/server-config.js";
import { WorkspaceAppServerBroker } from "./src/workspace-app-server-broker.js";
import { createWorkspaceAppServerBridge } from "./src/workspace-app-server-bridge.mjs";
import { createNativeSshEndpointFactory } from "./src/remotes/native-ssh-endpoint.mjs";
import { createNativeRemoteHostBackchannel } from "./src/remotes/host-backchannel.mjs";
import { nativeRemoteSourceClientForAttempt, nativeRemoteSourceClientForManagement } from "./src/remotes/source-client-owner.mjs";
import { pauseWikiBeforeLogout } from "./src/wiki-logout.js";
import { createSshConnectionStore } from "./src/ssh-terminal-store.js";
import { bridgeSshTerminal } from "./src/ssh-channel.js";
import { createWorkspaceCwdObserver, createWorkspaceCwdObservationHttpHandler, workspaceCwdObservationTargetIdentity } from "./src/workspace-cwd-observation.js";
import { createChannelsController } from './src/channels-controller.mjs';
import { createChannelsHttpHandler } from './src/channels-http.mjs';
import { createLiveGatewayRelay, gatewayPublicOriginSet, replacePublicOrigin } from './src/gateway-relay-live.js';
import { observeGatewayRelayConnectionStatus, restoreGatewayRelay, createGatewayRelayManagement, gatewayRelayOptions } from './src/gateway-relay-management.js';

const nativeComponentImageInput = consumeGatewayNativeComponentImageStartup();
const startupObservation = createGatewayStartupObservation();
const nativeStartupResources = await captureGatewayStartupResources({ observation: startupObservation });
const nativeOfficeStartupBinding = nativeStartupResources.office;
const nativeConnectivityStartupBinding = nativeStartupResources.channel;

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(root, "../..");
let relayRestoreFailed = false;
let relayConnectionStatus = 'offline';
const relayExternallyConfigured = Boolean(process.env.KCODER_STUDIO_PUBLIC_ACCESS_URL || process.env.KCODER_STUDIO_RELAY_SECRET);
const ownedRelay = await restoreGatewayRelay(process.env, error => {
  relayRestoreFailed = true;
  if (error?.status === 401 || error?.status === 403) relayConnectionStatus = 'denied';
  console.warn('GATEWAY_RELAY_RESTORE_UNAVAILABLE');
}, {
  onOnline: () => { relayConnectionStatus = 'online'; },
  onDiagnostic: event => { relayConnectionStatus = observeGatewayRelayConnectionStatus(relayConnectionStatus, event); },
});
const relayExternallyManaged = !ownedRelay && relayExternallyConfigured;
const webRoot = resolve(
  process.env.KCODER_STUDIO_WEB_ROOT || resolve(root, "renderer/dist"),
);
const host = gatewayListenHost(process.env);
const configuredPort = Number(process.env.KCODER_STUDIO_PORT || 4173);
if (
  !Number.isInteger(configuredPort) ||
  configuredPort < 0 ||
  configuredPort > 65_535
) {
  throw new Error("KCODER_STUDIO_PORT must be an integer from 0 to 65535");
}
let listeningPort = configuredPort;
if (!["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"].includes(host))
  throw new Error("KCoder Studio host must be loopback or a supported wildcard address");
const maxConnections = Number(process.env.KCODER_STUDIO_MAX_CONNECTIONS || 256);
if (
  !Number.isInteger(maxConnections) ||
  maxConnections < 1 ||
  maxConnections > 256
)
  throw new Error(
    "KCODER_STUDIO_MAX_CONNECTIONS must be an integer from 1 to 256",
  );
const maxBrowserConnections = Number(
  process.env.KCODER_STUDIO_MAX_BROWSER_CONNECTIONS || 4,
);
if (
  !Number.isInteger(maxBrowserConnections) ||
  maxBrowserConnections < 1 ||
  maxBrowserConnections > Math.min(16, maxConnections)
)
  throw new Error(
    "KCODER_STUDIO_MAX_BROWSER_CONNECTIONS must be an integer from 1 to min(16, KCODER_STUDIO_MAX_CONNECTIONS)",
  );
// Keep enough headroom for a 256 KiB text-file response after JSON escaping while retaining a
// strict per-connection bound. Browser attachments use base64 and stay well below this limit.
const maxMessageBytes = 2 * 1024 * 1024;
const { frame, decodeFrames } = createWebSocketFrameCodec({ maxMessageBytes });
let relaySecret = gatewayRelaySecret();
const mobilePairingToken = gatewayMobilePairingToken();
if (["0.0.0.0", "::"].includes(host) && !process.env.KCODER_STUDIO_AUTH_TOKEN && !relaySecret && !mobilePairingToken &&
    !(process.env.NODE_ENV === "test" && process.env.KCODER_STUDIO_TEST_DISABLE_AUTH === "1")) {
  throw new Error("A configured browser, mobile pairing or Relay credential is required when listening on 0.0.0.0 or ::");
}
const authToken = createGatewayToken(process.env);
const authRequired = Boolean(authToken);
const desktopHost = process.env.KCODER_STUDIO_DESKTOP_HOST === "1";
const publicOrigins = gatewayPublicOriginSet(process.env.KCODER_STUDIO_PUBLIC_ORIGINS);
const retiredAuthorities = new Set();
const trustedTunnelAuthorities = new Set();
const { isAllowedAuthority, isAllowedOrigin } = createGatewayAdmission({
  authRequired, publicOrigins, listeningPort: () => listeningPort, trustedTunnelAuthorities, retiredAuthorities,
});
let publicAccessUrl = (() => {
  const configured = process.env.KCODER_STUDIO_PUBLIC_ACCESS_URL;
  if (!configured) return null;
  const parsed = new URL(configured);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !publicOrigins.has(parsed.origin)) {
    throw new Error("KCODER_STUDIO_PUBLIC_ACCESS_URL must be an HTTP(S) URL on a configured KCODER_STUDIO_PUBLIC_ORIGINS origin");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed;
})();
const mobileWebOrigins = new Set(
  (process.env.KCODER_STUDIO_MOBILE_WEB_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = new URL(value);
      if (
        !/^https?:$/.test(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error(
          `Invalid KCODER_STUDIO_MOBILE_WEB_ORIGINS entry: ${value}`,
        );
      }
      return parsed.origin;
    }),
);
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:",
  "worker-src 'self' blob:",
  "frame-src 'self' http: https:",
  "media-src 'self' blob: http: https:",
].join("; ");
const loginHtmlHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": contentSecurityPolicy,
};
if (["0.0.0.0", "::"].includes(host) && !authRequired) {
  throw new Error(
    "KCODER_STUDIO_AUTH_TOKEN is required when listening on a wildcard address",
  );
}
const gatewayToken = authRequired ? "cookie-auth" : randomUUID();
const sessionSockets = new Map();
const mobileDeviceFamilies = new Map();
const loginAttempts = new Map();
const mobileRefreshFailures = new Map();
const authSessionTtlMs = Number(
  process.env.KCODER_STUDIO_AUTH_SESSION_TTL_MS || 12 * 60 * 60 * 1000,
);
if (
  !Number.isInteger(authSessionTtlMs) ||
  authSessionTtlMs < 100 ||
  authSessionTtlMs > 7 * 24 * 60 * 60 * 1000
) {
  throw new Error(
    "KCODER_STUDIO_AUTH_SESSION_TTL_MS must be an integer from 100 to 604800000",
  );
}
const maxAuthSessions = 32;
const maxMobileDevices = 32;
let activeConnections = 0;
let activeBrowserConnections = 0;
// Refusals are counted per limit so a browser-class cap is never reported as
// global connection exhaustion (A3/R131).
const connectionRefusals = {
  [CONNECTION_REFUSAL.RUNTIME_UNSUPPORTED]: 0,
  [CONNECTION_REFUSAL.GLOBAL_LIMIT]: 0,
  [CONNECTION_REFUSAL.BROWSER_LIMIT]: 0,
};
const mock = process.env.KCODER_STUDIO_MOCK === "1";
const appServerBin =
  process.env.KCODER_STUDIO_KCODER_BIN ||
  sourceAppServerBinary(repoRoot);
const trustedWindowsComponentImage = await startupObservation.run('component_image', () => captureGatewayWindowsComponentImage(appServerBin, nativeComponentImageInput));
const workspace = resolve(process.env.KCODER_STUDIO_WORKSPACE || repoRoot);
const workspaceCwdObserver = createWorkspaceCwdObserver({ delayMs: process.env.NODE_ENV === "test" ? Number(process.env.KCODER_STUDIO_TEST_CWD_OBSERVATION_DELAY_MS || 0) : 0 });
const scenario = process.env.KCODER_STUDIO_SCENARIO || "";
const serverDefaults = {
  repoRoot,
  appServerBin,
  workspace,
  chromiumBin: process.env.KCODER_STUDIO_CHROMIUM_BIN,
  chromiumNoSandbox: process.env.KCODER_STUDIO_CHROMIUM_NO_SANDBOX === "1",
};
let servers = await startupObservation.run('server_configuration', () => loadServers({ env: process.env, ...serverDefaults }));
let serversById = new Map(servers.map((server) => [server.id, server]));
const serversStore = process.env.KCODER_STUDIO_SERVERS_STORE
  ? resolve(process.env.KCODER_STUDIO_SERVERS_STORE)
  : null;
const accountStorageRoot = studioDataDirectory({ serversStore, dataDirectory: process.env.KCODER_STUDIO_DATA_DIR });
const publicAccess = await loadGatewayPublicAccess(accountStorageRoot);
const browserCookies = createBrowserSessionCookies({
  publicOrigins, forceSecure: process.env.KCODER_STUDIO_SECURE_COOKIE === "1",
});

const liveRelay = createLiveGatewayRelay({ initial: ownedRelay, environment: { ...process.env },
  initialStatus: () => relayConnectionStatus, options: gatewayRelayOptions(), localBase: localAccessBase, present: setRelayPresentation });
const handleRelayManagement = createGatewayRelayManagement({ restoreFailed: relayRestoreFailed, externallyManaged: relayExternallyManaged,
  getConnectionStatus: () => liveRelay.status, liveRelay,
  isAdmin: (request, session) => isGatewayBrowserAdminRequest(request, session, servers, authRequired), sameOrigin: requireSameOriginMutation,
  requestBody, jsonResponse, cookiePath: requestCookiePath, accountCookies: browserCookies,
  publicAccess: { get state() { return publicAccess.state; }, update: input => publicAccess.update(input, () => mobilePeerGateway.closeDisabled()) } });
const sshConnections = createSshConnectionStore({
  filePath: resolve(accountStorageRoot, "ssh_connections.jsonc"),
});
let mobileConnectionRoutesProvider;
const mobileDeviceAuth = createMobileDeviceAuth({ directory: accountStorageRoot, identity: relaySecret || mobilePairingToken ? null : mobileDeviceStoreIdentity(authToken), fixedPairingToken: mobilePairingToken, accessTtlMs: Number(process.env.KCODER_STUDIO_MOBILE_ACCESS_TTL_MS || 15 * 60_000), idleTtlMs: Number(process.env.KCODER_STUDIO_MOBILE_DEVICE_IDLE_TTL_MS ?? 0), absoluteTtlMs: Number(process.env.KCODER_STUDIO_MOBILE_DEVICE_ABSOLUTE_TTL_MS ?? 0), socketGraceMs: Number(process.env.KCODER_STUDIO_MOBILE_SOCKET_GRACE_MS || 5 * 60_000), maximumDevices: maxMobileDevices, isConnectionEndpointAllowed: endpoint => mobileConnectionRoutesProvider?.allows(endpoint) === true });
let accountOidcRoutes;
const authSessionRegistry = createGatewayAuthSessionRegistry({ authRequired, getServerIds: () => servers.map(item => item.id),
  observe: process.env.KCODER_E2E_AUTH_OBSERVE === '1'
    ? value => console.log('KCODER_AUTH_OBSERVE ' + JSON.stringify(value)) : undefined,
  maximumSessions: maxAuthSessions, ttlMs: authSessionTtlMs, persistence: authRequired ? await startupObservation.run('browser_sessions', () => mobileDeviceAuth.browserSessions()) : null,
  sessionSockets, invalidateOwner: id => { invalidateServerHealthOwner(id); accountOidcRoutes?.expireOwner(id); }, expireDevice: id => expireMobileDeviceFamily(id) });
const authSessions = authSessionRegistry.sessions;
const authSessionById = id => authSessionRegistry.get(id);
const createAuthSession = options => authSessionRegistry.create(options);
const deleteAuthSession = id => authSessionRegistry.delete(id);
if (publicAccessUrl) {
  mobileConnectionRoutesProvider = createMobileConnectionRoutesProvider({ identity: await mobileDeviceAuth.getConnectionIdentity(), publicAccessUrl, isAllowedAuthority });
}
// Purpose-derived installation key remains in this process and authenticated
// LocalOs child startup only. Never add it to initialize, pairing or public data.
const trustedRetentionAppServer = captureTrustedLocalAppServer(appServerBin, process.platform, accountStorageRoot);
const retentionRevocationVerifier = ['linux', 'darwin'].includes(process.platform) ? await mobileDeviceAuth.privateRetentionVerifier() : undefined;
const retentionRevocationPump = createRetentionRevocationPump({ auth: mobileDeviceAuth,
  brokerForRoute(route) {
    const target = serversById.get(route.targetId);
    if (!target || !trustedRetentionAppServer?.matches(target) || !workspaceReceiptParentAttempt(target)) return null;
    const workspace = realpathSync(route.workspacePath);
    if (workspace !== route.workspacePath) return null;
    const key = workspaceBrokerKey(target, route.workspaceSelection ?? undefined);
    if (retentionTargetFingerprint(target, route.workspaceSelection ?? undefined, key) !== route.targetFingerprint) return null;
    return [...(workspaceAppServerBrokers.get(key) ?? [])].find(broker => !broker.closed && !broker.nativeManagementOnly && broker.retentionRevocationTrusted) ?? createWorkspaceBroker(target, route.workspaceSelection ?? undefined, key);
  },
});
async function revokeMobileDeviceAndScheduleCleanup(deviceId) {
  // Failure before this await resolves cannot expire authority as if a durable
  // revocation fact existed. Cleanup delivery failure never restores authority.
  await mobileDeviceAuth.revokeAndReadProof(deviceId);
  expireMobileDeviceFamily(deviceId);
  void retentionRevocationPump.drain().catch(() => {});
}
const accountCredentials = createAccountCredentialStore({
  filePath: resolve(accountStorageRoot, 'account_credentials.json'),
  keyPath: resolve(accountStorageRoot, '.account-credential-key'),
});
await startupObservation.run('account_credentials', () => accountCredentials.load());
const loginContexts = createAccountLoginContexts();
const contextSockets = new Map();
const accountLoginAttempts = new Map();
const publicAccountServer = (target, loginOwner) => {
  const principal = loginOwner ? loginContexts.identity(loginOwner, target.id) : null;
  return { ...publicServer(target),
    observationTargetIdentity: workspaceCwdObservationTargetIdentity(serverHealthSignature(target)),
    ...(target.transport === "ssh" ? { authorityId: authorityIdFor(target) } : {}),
    ...(principal ? { accountIdentity: principal } : {}) };
};
function publicServerInventory(session, loginOwner) {
  return { servers: servers
    .filter(item => session.allowedServerIds.has(item.id))
    .map(item => publicAccountServer(item, loginOwner)) };
}
function initialServerBootstrap(session, loginOwner) {
  return { initialServers: { version: 1, ...publicServerInventory(session, loginOwner) } };
}
function requestLoginOwner(request, session) {
  if (!authRequired) return ANONYMOUS_LOGIN_OWNER;
  const id = authenticatedSessionId(request);
  return session && id ? (session.stableLoginOwner || id) : null;
}
function contextSocketKey(loginOwner, targetId) {
  return `${loginOwner} ${targetId}`;
}
function closeContextSockets(loginOwner, targetId) {
  const key = contextSocketKey(loginOwner, targetId);
  const sockets = contextSockets.get(key);
  contextSockets.delete(key);
  for (const socket of sockets ?? []) socket.destroy();
}
function closeTargetSockets(targetId) {
  const suffix = ` ${targetId}`;
  for (const [key, sockets] of contextSockets) {
    if (!key.endsWith(suffix)) continue;
    contextSockets.delete(key);
    for (const socket of sockets) socket.destroy();
  }
}
function accountLoginRateLimited(key) {
  const now = Date.now();
  const attempts = (accountLoginAttempts.get(key) || []).filter(
    (timestamp) => now - timestamp < 60_000,
  );
  if (attempts.length) accountLoginAttempts.set(key, attempts);
  else accountLoginAttempts.delete(key);
  return attempts.length >= 5;
}
function recordAccountLoginFailure(key) {
  const attempts = accountLoginAttempts.get(key) || [];
  attempts.push(Date.now());
  accountLoginAttempts.set(key, attempts);
}
const appServerChildren = new Set();
const channelAppServerChildren = new WeakSet();
const nativeRemoteEndpointOwners = new Set();
const appServerChildTargets = new Map();
const workspaceAppServerBrokers = new Map();
const resourceBudgetBrokers = new Set();
const resourcePolicy = await startupObservation.run('resource_policy', () => loadResourcePolicy(
  process.env.KCODER_STUDIO_RESOURCE_POLICY_FILE || resolve(accountStorageRoot, 'resource_policy.jsonc'),
  { required: Boolean(process.env.KCODER_STUDIO_RESOURCE_POLICY_FILE) },
));
let lastResourceBudgetSummary;
const resourceBudget = new GatewayResourceBudget({ policy: resourcePolicy, getBrokers: () => resourceBudgetBrokers,
  onError: () => process.stderr.write('{"event":"broker-resource-budget-error"}\n'),
  onResult: results => {
    const summary = JSON.stringify({ event: 'broker-resource-budget', results });
    if (summary !== lastResourceBudgetSummary) {
      lastResourceBudgetSummary = summary;
      process.stderr.write(`${summary}\n`);
    }
  },
});
resourceBudget.start();

// Unfinished requests are the other half of "is anything still happening": a client
// can be waiting on the Gateway without any connection being near its limit. Only
// counts are written, and only when they change.
let lastRequestLoadSummary = null;
const requestLoadDiagnosticTimer = setInterval(() => {
  const merged = mergeRequestLoad([...resourceBudgetBrokers].map(broker => broker.requestLoad));
  const summary = JSON.stringify(requestLoadDiagnostic(merged));
  if (summary === lastRequestLoadSummary) return;
  lastRequestLoadSummary = summary;
  process.stderr.write(`${summary}\n`);
}, 60_000);
requestLoadDiagnosticTimer.unref?.();
const workspaceAppServerIdleMs = Number(
  process.env.KCODER_STUDIO_APP_SERVER_IDLE_MS || 5 * 60_000,
);
if (
  !Number.isInteger(workspaceAppServerIdleMs) ||
  workspaceAppServerIdleMs < 0 ||
  workspaceAppServerIdleMs > 3_600_000
) {
  throw new Error(
    "KCODER_STUDIO_APP_SERVER_IDLE_MS must be an integer from 0 to 3600000",
  );
}
function trackAppServerChild(child, serverId, loginOwner) {
  appServerChildren.add(child);
  if (serverId) appServerChildTargets.set(child, { serverId, loginOwner });
  child.once("close", () => {
    appServerChildren.delete(child);
    appServerChildTargets.delete(child);
  });
  return child;
}

async function terminateAppServerChild(child, { eofMs = 5_000 } = {}) {
  if (!appServerChildren.has(child)) return;
  await terminateOwnedAppServer({ child }, { eofMs, graceMs: 750, killMs: 5_000 });
}

async function terminateServerChildren(serverId) {
  const children = [...appServerChildTargets.entries()]
    .filter(([, ownership]) => ownership?.serverId === serverId)
    .map(([child]) => child);
  await Promise.all(children.map(child => terminateAppServerChild(child)));
}

// Logout/switch only reclaims the processes of one login context; other
// accounts on the same target keep running.
async function terminateContextChildren(serverId, loginOwner) {
  const children = [...appServerChildTargets.entries()]
    .filter(([, ownership]) => ownership?.serverId === serverId && ownership.loginOwner === loginOwner)
    .map(([child]) => child);
  await Promise.all(children.map(child => terminateAppServerChild(child)));
}
const serverHealth = new Map();
const serverHealthInFlight = new Map();
const serverHealthTtlMs = 15_000;
const serverHealthTimeoutMs = Number(
  process.env.KCODER_STUDIO_HEALTH_TIMEOUT_MS || 12_000,
);
if (
  !Number.isInteger(serverHealthTimeoutMs) ||
  serverHealthTimeoutMs < 100 ||
  serverHealthTimeoutMs > 30_000
) {
  throw new Error(
    "KCODER_STUDIO_HEALTH_TIMEOUT_MS must be an integer from 100 to 30000",
  );
}

function bearerValue(request) {
  const match = String(request.headers.authorization || "").match(
    /^Bearer ([A-Za-z0-9-]{32,128})$/,
  );
  return match?.[1] || null;
}

function authenticatedSessionId(request) {
  return request.headers.authorization !== undefined ? bearerValue(request) : browserCookies.read(request);
}

function authenticatedSession(request) {
  return authSessionById(authenticatedSessionId(request));
}

function expireMobileDeviceFamily(deviceId) {
  const family = mobileDeviceFamilies.get(deviceId);
  if (!family) return;
  clearTimeout(family.timer); mobileDeviceFamilies.delete(deviceId);
  for (const [id, session] of authSessions) if (session.deviceId === deviceId) { authSessions.delete(id); sessionSockets.delete(id); }
  for (const socket of family.sockets) socket.destroy();
  family.sockets.clear();
  loginContexts.invalidateOwner(`mobile-device:${deviceId}`);
}
function registerMobileDeviceGrant(payload) {
  const { family, session, publicPayload } = registerMobileDeviceGrantState({
    families: mobileDeviceFamilies, payload, allowedServerIds: servers.map(item => item.id),
  });
  clearTimeout(family.timer);
  // Access rotation invalidates new handshakes, while preserving existing broker
  // owners and resource channels under the bounded device family socket lease.
  for (const [id, session] of authSessions) if (session.deviceId === payload.deviceId) { authSessions.delete(id); sessionSockets.delete(id); }
  const expire = () => { const remaining = family.expiresAt - Date.now(); if (remaining <= 0) expireMobileDeviceFamily(payload.deviceId); else { family.timer = setTimeout(expire, Math.min(remaining, 2_147_000_000)); family.timer.unref?.(); } };
  authSessions.set(payload.accessToken, session);
  expire();
  return attachMobileConnectionRoutes({ ...publicPayload, rpcToken: gatewayToken }, mobileConnectionRoutesProvider?.get());
}

function tokenMatches(value) {
  if (!authRequired) return true;
  const expected = createHash("sha256").update(authToken).digest();
  const actual = createHash("sha256").update(value).digest();
  return timingSafeEqual(expected, actual);
}

function localAccessBase() {
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : ["::", "::1"].includes(host) ? "[::1]" : host;
  return `http://${localHost}:${listeningPort}`;
}

function requestPublicPrefix(request) {
  return publicAccessUrl && request.headers.host === publicAccessUrl.host
    ? publicAccessUrl.pathname
    : "";
}

function requestCookiePath(request) {
  const prefix = requestPublicPrefix(request);
  return prefix ? `${prefix}/` : "/";
}

function prefixedLocation(request, path) {
  const prefix = requestPublicPrefix(request);
  return `${prefix}${path.startsWith("/") ? path : `/${path}`}` || "/";
}

function isLoopbackHostHeader(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(`http://${value}`);
    return !parsed.username && !parsed.password && (parsed.hostname === "localhost" || parsed.hostname === "[::1]" || /^127\./.test(parsed.hostname));
  } catch { return false; }
}

function loginRateLimited(request) {
  const key = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  for (const [address, attempts] of loginAttempts) {
    const recent = attempts.filter((timestamp) => now - timestamp < 60_000);
    if (recent.length) loginAttempts.set(address, recent);
    else loginAttempts.delete(address);
  }
  return (loginAttempts.get(key) || []).length >= 5;
}

function recordLoginFailure(request) {
  const key = request.socket.remoteAddress || "unknown";
  const attempts = loginAttempts.get(key) || [];
  attempts.push(Date.now());
  loginAttempts.set(key, attempts);
}

function jsonResponse(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

let gatewayRuntimeVersionPromise;
function gatewayRuntimeVersion() {
  gatewayRuntimeVersionPromise ??= readFile(resolve(root, "package.json"), "utf8")
    .then((contents) => diagnosticBuildVersion(JSON.parse(contents)?.version))
    .catch(() => null);
  return gatewayRuntimeVersionPromise;
}

function requireSameOriginMutation(request) {
  return (
    request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() ===
      "application/json" &&
    ((!request.headers.origin && Boolean(bearerValue(request))) ||
      isAllowedOrigin(request.headers.origin, request.headers.host) ||
      (Boolean(bearerValue(request)) &&
        isAllowedMobileWebOrigin(request.headers.origin)))
  );
}

const runServerMutation = createServerMutationQueue();
async function persistServers(values = servers) {
  await writeServerConfiguration(serversStore, values.map(storedServer));
}

async function refreshSessionServerAccess(previousIds) {
  const currentIds = servers.map((item) => item.id);
  await authSessionRegistry.saveAccess(previousIds, currentIds, reconcileServerAccess);
}

async function testServerConnection(
  target,
  { fresh = false, loginOwner, authentication } = {},
) {
  const key = workspaceBrokerKey(target);
  const sameContext = (candidate) =>
    target.security ? candidate.loginOwner === loginOwner : true;
  const existingBroker =
    (fresh ? undefined : [...(workspaceAppServerBrokers.get(key) ?? [])].find(
      (candidate) => !candidate.closed && !candidate.nativeManagementOnly && sameContext(candidate),
    ));
  const broker = existingBroker ?? createWorkspaceBroker(target, undefined, key, { authentication, loginOwner });
  if (broker.child.oidcAuthorizationPending) throw new Error("Complete the original organization SSO request first");
  if (broker.idleTimer) {
    clearTimeout(broker.idleTimer);
    broker.idleTimer = null;
  }
  let rejectHealth;
  const initialized = new Promise((resolveInitialize, rejectInitialize) => {
    rejectHealth = rejectInitialize;
    const timeout = setTimeout(
      () =>
        rejectInitialize(
          new Error(
            `app-server initialize timed out after ${serverHealthTimeoutMs}ms`,
          ),
        ),
      serverHealthTimeoutMs,
    );
    broker.healthResolve = (message) => {
      clearTimeout(timeout);
      if (message.error)
        rejectInitialize(
          new Error(message.error.message || "app-server initialize failed"),
        );
      else resolveInitialize(message.result);
    };
  });
  const healthClient = {
    channel: "runtime",
    send(message) {
      if (message.id === 1) broker.healthResolve?.(message);
      else if (
        ["server/transportError", "server/disconnected"].includes(
          message.method,
        )
      ) {
        const failure = new Error(
          message.params?.message ||
            "app-server exited before initialize completed",
        );
        if (message.params?.authenticationRejected === true) {
          failure.authenticationRejected = true;
        }
        rejectHealth(failure);
      }
      return true;
    },
    pause() {},
    resume() {},
    close() {
      rejectHealth(new Error("app-server exited before initialize completed"));
    },
  };
  broker.attach(healthClient);
  let healthy = false;
  try {
    broker.receive(
      healthClient,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-27",
          clientInfo: {
            name: "kcoder-studio-connection-test",
            version: "0.1.0",
          },
        },
      }),
    );
    const result = await initialized;
    healthy = true;
    return {
      ok: true,
      runtime: target.runtime,
      serverInfo: result?.serverInfo,
      protocolVersion: result?.protocolVersion,
      capabilities: result?.capabilities,
    };
  } finally {
    broker.healthResolve = null;
    broker.detach(healthClient);
    if (healthy) {
      scheduleWorkspaceBrokerIdle(key, broker);
    } else if (!existingBroker && broker.clientCount === 0 && !broker.ownsChannelHost) {
      // A failed probe cannot dispose a peer's runtime or an owned channel host.
      removeWorkspaceBroker(key, broker);
      await terminateAppServerChild(broker.child, { eofMs: 0 });
    }
  }
}

function serverHealthSignature(target) {
  return target ? JSON.stringify(storedServer(target)) : "";
}

function serverHealthScopeKey(target, loginOwner) {
  const principal = target?.security && loginOwner
    ? loginContexts.identity(loginOwner, target.id)
    : null;
  const generation = target?.security && loginOwner
    ? loginContexts.generation(loginOwner, target.id)
    : null;
  return JSON.stringify([
    target?.security ? [loginOwner ?? null,
      principal ? [principal.principalId, principal.username, principal.role] : null,
      generation] : null,
    serverHealthSignature(target),
  ]);
}

function invalidateServerHealth(targetId) {
  for (const [key, entry] of serverHealth) {
    if (entry.targetId === targetId) serverHealth.delete(key);
  }
  for (const [key, entry] of serverHealthInFlight) {
    if (entry.targetId === targetId) serverHealthInFlight.delete(key);
  }
}

function invalidateServerHealthOwner(loginOwner) {
  if (loginOwner === null || loginOwner === undefined) return;
  for (const [key, entry] of serverHealth) {
    if (entry.loginOwner === loginOwner) serverHealth.delete(key);
  }
  for (const [key, entry] of serverHealthInFlight) {
    if (entry.loginOwner === loginOwner) serverHealthInFlight.delete(key);
  }
}

function pruneExpiredServerHealth(now = Date.now()) {
  for (const [key, entry] of serverHealth) {
    if (now - entry.result.checkedAt >= serverHealthTtlMs) serverHealth.delete(key);
  }
}

function updateServerHealth(
  target,
  startedAt,
  scopeKey,
  error = null,
  connection = null,
  loginOwner = null,
) {
  const result = {
    id: target.id,
    status: error ? "offline" : "online",
    latencyMs: Math.max(0, Date.now() - startedAt),
    checkedAt: Date.now(),
    appServerVersion: diagnosticBuildVersion(connection?.serverInfo?.version),
    protocolVersion: diagnosticProtocolVersion(connection?.protocolVersion),
    ...(connection?.capabilities
      ? { capabilities: connection.capabilities }
      : {}),
    ...(error
      ? {
          error: String(error instanceof Error ? error.message : error).slice(
            0,
            1024,
          ),
        }
      : {}),
  };
  serverHealth.set(scopeKey, {
    targetId: target.id,
    loginOwner: target.security ? loginOwner : null,
    signature: serverHealthSignature(target),
    result,
  });
  return result;
}

async function probeServerHealth(target, loginOwner) {
  pruneExpiredServerHealth();
  const signature = serverHealthSignature(target);
  // An isolated target without an authenticated login context is never
  // probed: saved credentials must not silently bring a target back online
  // after logout, and anonymous fallback to a shared app-server is forbidden.
  if (target.security && !loginOwner) {
    return {
      id: target.id,
      status: "offline",
      latencyMs: 0,
      checkedAt: Date.now(),
      appServerVersion: null,
      protocolVersion: null,
      error: "需要登录 KCoder 账号",
    };
  }
  if (target.security && !loginContexts.identity(loginOwner, target.id)) {
    return {
      id: target.id,
      status: "offline",
      latencyMs: 0,
      checkedAt: Date.now(),
      appServerVersion: null,
      protocolVersion: null,
      error: "需要登录 KCoder 账号",
    };
  }
  const scopeKey = serverHealthScopeKey(target, loginOwner);
  const cached = serverHealth.get(scopeKey);
  if (
    cached?.signature === signature &&
    Date.now() - cached.result.checkedAt < serverHealthTtlMs
  ) {
    return cached.result;
  }
  const existing = serverHealthInFlight.get(scopeKey);
  if (existing?.signature === signature) return existing.promise;
  const startedAt = Date.now();
  const promise = testServerConnection(target, { loginOwner })
    .then((connection) => serverHealthScopeKey(target, loginOwner) === scopeKey
      ? updateServerHealth(target, startedAt, scopeKey, null, connection, loginOwner)
      : {
          id: target.id,
          status: "offline",
          latencyMs: Math.max(0, Date.now() - startedAt),
          checkedAt: Date.now(),
          appServerVersion: null,
          protocolVersion: null,
          error: "账号状态在检查期间已变更，请重新检查",
        })
    .catch((error) => serverHealthScopeKey(target, loginOwner) === scopeKey
      ? updateServerHealth(target, startedAt, scopeKey, error, null, loginOwner)
      : {
          id: target.id,
          status: "offline",
          latencyMs: Math.max(0, Date.now() - startedAt),
          checkedAt: Date.now(),
          appServerVersion: null,
          protocolVersion: null,
          error: "账号状态在检查期间已变更，请重新检查",
        })
    .finally(() => {
      if (serverHealthInFlight.get(scopeKey)?.promise === promise)
        serverHealthInFlight.delete(scopeKey);
    });
  serverHealthInFlight.set(scopeKey, {
    targetId: target.id, loginOwner: target.security ? loginOwner : null, signature, promise,
  });
  return promise;
}

async function probeServerHealthBounded(targets, loginOwner, concurrency = 4) {
  const results = new Array(targets.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < targets.length) {
      const index = nextIndex++;
      results[index] = await probeServerHealth(targets[index], loginOwner);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker),
  );
  return results;
}

const { isAllowedMobileWebOrigin, isMobileApiPath, applyMobileCors } = createMobileWebCors({
  mobileWebOrigins, isAllowedOrigin, jsonResponse,
});
const handleMobileConnectionProof = createMobileConnectionProofHandler({
  getConnectionRoutes: () => mobileConnectionRoutesProvider?.get(),
  signConnectionProof: (nonce, endpoint) => mobileDeviceAuth.signConnectionProof(nonce, endpoint),
  jsonResponse,
});
const publicPairingReadiness = createPublicPairingReadiness({
  signConnectionProof: (nonce, endpoint) => mobileDeviceAuth.signConnectionProof(nonce, endpoint),
});
const handleMobileRouteAuthorization = createMobileRouteAuthorizationHandler({
  authRequired, tokenMatches: value => relaySecret ? relaySecretMatches(relaySecret, value) : tokenMatches(value), authSessions, inspectAccessAuthorization: accessToken => mobileDeviceAuth.inspectAccessAuthorization(accessToken),
  rpcToken: gatewayToken, readBody: requestBody, jsonResponse, allowsSurface: publicAccess.allows,
});
const createPeerGateway = (env, url) => createMobilePeerGateway({ ...gatewayPeerOptions(env, url),
  mobileDeviceAuth, authSessionById, authSessions, mobileDeviceFamilies, sessionSockets, contextSockets, loginContexts, contextSocketKey,
  getServers: () => servers, getTarget: id => serversById.get(id), jsonResponse, getLocalBase: localAccessBase, rpcToken: gatewayToken, allowsSurface: surface => !url || publicAccess.allows(surface) });

let mobilePeerGateway = createPeerGateway(process.env, publicAccessUrl);
const mobileWebRoot = resolve(process.env.KCODER_STUDIO_MOBILE_WEB_ROOT || resolve(root, "mobile/dist"));
const serveMobileWeb = createMobileWebStatic({
  root: mobileWebRoot, publicOrigins, contentSecurityPolicy, directPort: () => listeningPort,
  getPresentation: () => ({ publicAccessUrl, pairingToken: relaySecret || authToken }),
});
const mobileDev = createMobileWebDevProxy({
  port: process.env.KCODER_STUDIO_MOBILE_DEV_PORT, rendererMode: studioRendererMode(), publicAccessUrl, allowedOrigin: isAllowedOrigin,
});

const mcpCallbacks = new McpOAuthCallbackRegistry();
const workspaceCwdObservationHandler = createWorkspaceCwdObservationHttpHandler({
  gateway: { getTarget: (id) => serversById.get(id), authenticatedSession, requestLoginOwner, loginContexts, serverHealthSignature, jsonResponse },
  observe: workspaceCwdObserver,
});
const serveWidgetSandbox = createWidgetSandboxRoute({
  roots: [webRoot, resolve(root, 'renderer/public')],
});
const servePublicStudioAsset = createStudioPublicAssets({ webRoot });
const serveStudioStatic = createStudioStaticRoute({
  webRoot, gatewayToken, desktopHost, contentSecurityPolicy, requestPublicPrefix,
});
const initialPublicUrl = publicAccessUrl;
const makeVite = (url, cache) => createStudioViteRenderer({ rendererRoot: resolve(root, 'renderer'),
  cacheDir: resolve(accountStorageRoot, cache), publicAccessUrl: url, gatewayToken, desktopHost, contentSecurityPolicy, requestPublicPrefix });
const localVite = studioRendererMode() === 'vite' ? await makeVite(initialPublicUrl, 'renderer-vite-cache') : null;
let relayVite = null;
const viteFor = request => requestPublicPrefix(request) && relayVite ? relayVite : localVite;
const mobileDevFor = request => requestPublicPrefix(request) && publicAccessUrl?.href !== initialPublicUrl?.href ? null : mobileDev;
async function setRelayPresentation(env) {
  const url = env.KCODER_STUDIO_PUBLIC_ACCESS_URL ? new URL(env.KCODER_STUDIO_PUBLIC_ACCESS_URL) : null;
  if (url?.href === publicAccessUrl?.href) return;
  const identity = url ? await mobileDeviceAuth.getConnectionIdentity() : null;
  const peer = createPeerGateway({ ...process.env, ...env }, url);
  const vite = url && localVite && url.href !== initialPublicUrl?.href ? await makeVite(url, 'renderer-vite-relay-cache') : null;
  replacePublicOrigin(publicOrigins, retiredAuthorities, publicAccessUrl, url);
  publicAccessUrl = url;
  relaySecret = gatewayRelaySecret(env);
  mobileConnectionRoutesProvider = identity ? createMobileConnectionRoutesProvider({ identity, publicAccessUrl, isAllowedAuthority }) : undefined;
  mobileConnectionRoutesProvider?.setListeningPort(listeningPort);
  void mobilePeerGateway.close().catch(() => {});
  mobilePeerGateway = peer;
  void relayVite?.close().catch(() => {});
  relayVite = vite;
  if (authRequired) void writeStudioLoginUrl(loginUrl(url || localAccessBase(), authToken), { dataDirectory: accountStorageRoot }).catch(() => {});
}
const migrationSourceSessions = createGatewayMigrationSourceSessions({
  maxMessageBytes, trackAppServerChild, loginContexts, closeContextSockets,
  requireSameOriginMutation, requestBody, jsonResponse, requestLoginOwner,
  authenticatedSessionId, authSessionById, serverHealthSignature,
  getTarget: id => serversById.get(id), isMock: () => mock,
});

const handleAccountAdministration = createAccountAdministrationRoute({ getTarget: id => serversById.get(id), requireSameOriginMutation, requestBody, requestLoginOwner, loginContexts, launchSpec, environment: spec => appServerEnvironment(process.env, spec.env), track: trackAppServerChild, jsonResponse });
const channels = createChannelsController({ directory: resolve(accountStorageRoot, 'channels'),
  settingsDirectory: accountStorageRoot,
  selectBroker: async target => {
    const serverTarget = serversById.get(target.serverId);
    if (!serverTarget) throw new Error('CHANNEL_TASK_TARGET_UNAVAILABLE');
    return reusableWorkspaceBroker(serverTarget, target.workspacePath, target.loginOwner);
  },
});
const handleChannels = createChannelsHttpHandler({ controller: channels, requestBody, jsonResponse, requireSameOriginMutation,
  targetLabel: id => serversById.get(id)?.label ?? id,
  resolveTarget: async (target, { session, loginOwner }) => {
    if (!target || typeof target.threadId !== 'string' || !target.threadId || target.threadId.length > 512
      || (target.workspacePath !== undefined && typeof target.workspacePath !== 'string')
      || !session.allowedServerIds.has(target.serverId) || !serversById.has(target.serverId)) {
      throw new Error('CHANNEL_TASK_TARGET_UNAVAILABLE');
    }
    return { serverId: target.serverId, workspacePath: target.workspacePath, threadId: target.threadId,
      ...(serversById.get(target.serverId).security ? { loginOwner } : {}) };
  },
});
accountOidcRoutes = createOrganizationOidcRoutes({ getTarget: id => serversById.get(id), targetSignature: serverHealthSignature, loginContexts, loginOwner: requestLoginOwner,
  captureOwner: (request, session, targetId) => ({ id: authenticatedSessionId(request), session, targetId, origin: request.headers.origin, localStart: ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.localAddress) }),
  ownerActive: proof => !authRequired || (authSessions.get(proof.id) === proof.session && (proof.session.accessExpiresAt ?? proof.session.expiresAt) > Date.now() && proof.session.allowedServerIds.has(proof.targetId)),
  isAllowedRedirectOrigin: (origin, proof) => publicOrigins.has(origin) || (proof?.localStart === true && [`http://127.0.0.1:${listeningPort}`, `http://[::1]:${listeningPort}`].includes(origin) && [`http://127.0.0.1:${listeningPort}`, `http://localhost:${listeningPort}`, `http://[::1]:${listeningPort}`].includes(proof?.origin)),
  callbackOwner: async request => requestLoginOwner(request, await authenticatedSession(request)), deliverLogout: (target, token) => { const spec = launchSpec(target); return deliverNativeOidcLogout(spec, appServerEnvironment(process.env, spec.env), token, child => trackAppServerChild(child, target.id)); },
  listeningPort: () => listeningPort, publicCallbackPath: request => `${requestPublicPrefix(request) || ''}/api/account/oidc/callback`,
  createBroker: (target, options) => createWorkspaceBroker(target, undefined, workspaceBrokerKey(target), options), finishBroker: (target, loginOwner) => testServerConnection(target, { loginOwner }),
  stopBroker: broker => terminateAppServerChild(broker.child), stopOwner: (owner, targetId) => terminateContextChildren(targetId, owner), closeSockets: closeContextSockets, invalidateHealth: invalidateServerHealth,
  requireSameOriginMutation, requestBody, jsonResponse });

const handleServerInventory = createServerInventoryRoutes({
  getServers: () => servers, sshConnections, jsonResponse, requireSameOriginMutation, requestBody,
  requestLoginOwner, publicServerInventory, serverHealthScopeKey, mock, probeServerHealthBounded,
  respondWithServerStatusSnapshot, loginContexts, gatewayRuntimeVersion, remoteTransportMetadata: { getEnvironment: () => liveRelay.environment, canRead: (request, session) => isGatewayBrowserAdminRequest(request, session, servers, authRequired) },
});

const handleRelayPairing = createRelayPairingHandler({ getSecret: () => relaySecret, jsonResponse,
  getPairing: async mode => attachMobileConnectionRoutes({ ...await selectMobilePairingCredential(mode, mobilePairingToken, () => mobileDeviceAuth.getPairingCredential()),
    publicBaseUrl: publicAccessUrl?.toString().replace(/\/$/, '') || null }, mobileConnectionRoutesProvider?.get()),
});
const handleRelayAccountEntry = createRelayAccountEntryHandler({
  getSecret: () => authRequired ? relaySecret : '', publicPrefix: requestPublicPrefix, requestBody, jsonResponse, allowsSurface: publicAccess.allows,
  async browserCookie(request, browserAdmin) {
    const current = await authSessionById(browserCookies.read(request));
    if (current && (!browserAdmin || isGatewayBrowserAdminRequest(request, current, servers, authRequired))) return null;
    const { id } = await createAuthSession({ browserAdmin });
    return browserCookies.header(request, id, Math.floor(authSessionTtlMs / 1000), requestCookiePath(request));
  },
});
const server = createServer(async (request, response) => {
  try {
    const initialUrl = new URL(request.url, "http://localhost");
    const tunnelLogin = authRequired && request.method === "GET" && initialUrl.pathname === "/login" &&
      isLoopbackHostHeader(request.headers.host) && tokenMatches(initialUrl.searchParams.get("token") || "");
    if (tunnelLogin) trustedTunnelAuthorities.add(request.headers.host);
    if (!isAllowedAuthority(request.headers.host)) {
      response.writeHead(421, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("Misdirected request");
      return;
    }
    const requestUrl = initialUrl;
    const pathname = requestUrl.pathname;
    const publicRequest = Boolean(requestPublicPrefix(request));
    if (!authRequired && request.headers.origin &&
        !isAllowedOrigin(request.headers.origin, request.headers.host) &&
        !(isMobileApiPath(pathname) && isAllowedMobileWebOrigin(request.headers.origin))) {
      jsonResponse(response, 403, { error: "Origin is not allowed" });
      return;
    }
    if (await handleRelayPairing(request, response, requestUrl)) return;
    if (await handleRelayAccountEntry(request, response, requestUrl)) return;
    if (await handleMobileRouteAuthorization(request, response, requestUrl)) return;
    if (publicRequest && !await publicAccess.admitHttp(request, response, pathname, authenticatedSession, jsonResponse)) return;
    if (await serveWidgetSandbox(request, response, pathname)) return;
    if (!mobileDevFor(request)?.matches(pathname) && await serveMobileWeb(request, response, pathname)) return;
    if (mcpCallbacks.handle(request, response)) return;
    if (await accountOidcRoutes.handleCallback(request, response, requestUrl)) return;
    const mobileCors = applyMobileCors(request, response, pathname);
    if (mobileCors.handled) return;
    if (!mobileCors.allowed) {
      jsonResponse(response, 403, {
        error: "Mobile Web origin is not allowed",
      });
      return;
    }
    if (await mobilePeerGateway.handleHttp(request, response, requestUrl)) return;
    if (await handleMobileConnectionProof(request, response, requestUrl)) return;
    if (pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "public, max-age=3600" });
      response.end();
      return;
    }
    if (pathname === "/api/mobile/session" && request.method === "POST") {
      if (loginRateLimited(request)) {
        jsonResponse(response, 429, {
          error: "尝试次数过多，请一分钟后重试。",
        });
        return;
      }
      if (
        request.headers["content-type"]
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase() !== "application/json"
      ) {
        jsonResponse(response, 415, {
          error: "移动端登录必须使用 application/json",
        });
        return;
      }
      let token = ""; let deviceAuthorization = false; let deviceLabel; let requestInitialServers = false;
      try {
        const payload = JSON.parse(await requestBody(request));
        token = typeof payload?.token === "string" ? payload.token : "";
        deviceAuthorization = payload?.durableDeviceAuthorization === true; deviceLabel = payload?.deviceLabel;
        requestInitialServers = payload?.requestInitialServers === true;
      } catch {
        jsonResponse(response, 400, { error: "登录请求不是有效 JSON" });
        return;
      }
      const webPairing = authRequired && (accountPairingProofMatches(relaySecret, token, request.headers['x-kcoder-relay-account-pairing'], 'mobileWeb') || await mobileDeviceAuth.matchesPairingCredential(token, 'mobileWeb').catch(() => false));
      const surface = webPairing ? 'mobileWeb' : 'mobileApp';
      if (publicRequest && !publicAccess.allows(surface)) { jsonResponse(response, 403, { error: 'Public access is disabled' }); return; }
      const devicePairingToken = authRequired && (webPairing || accountPairingProofMatches(relaySecret, token, request.headers['x-kcoder-relay-account-pairing']) || fixedMobilePairingTokenMatches(mobilePairingToken, token) || (/^[a-f0-9]{64}$/.test(token)
        && await mobileDeviceAuth.matchesPairingCredential(token).catch(() => false)));
      if (((relaySecret || !tokenMatches(token)) && !devicePairingToken) || (devicePairingToken && !deviceAuthorization)) {
        recordLoginFailure(request);
        jsonResponse(response, 401, { error: "访问令牌不正确。" });
        return;
      }
      loginAttempts.delete(request.socket.remoteAddress || "unknown");
      if (deviceAuthorization && authRequired) {
        try {
          const { grant, evictedDeviceIds } = await mobileDeviceAuth.pairWithEviction(deviceLabel, surface);
          for (const deviceId of evictedDeviceIds) expireMobileDeviceFamily(deviceId);
          if (evictedDeviceIds.length) void retentionRevocationPump.drain().catch(() => {});
          const granted = registerMobileDeviceGrant(grant);
          const session = authSessions.get(granted.accessToken);
          if (!session) throw new Error("New device session unavailable");
          jsonResponse(response, 200, requestInitialServers ? {
            ...granted,
            capabilities: { ...granted.capabilities, mobileInitialServersV1: true },
            ...initialServerBootstrap(session, session.stableLoginOwner),
          } : granted);
        }
        catch (error) { jsonResponse(response, error.status || 503, { error: error.status === 429 ? error.message : 'Device authorization unavailable' }); }
        return;
      }
      let id; let session;
      try { ({ id, session } = await createAuthSession()); }
      catch (error) {
        if (error.status !== 429) throw error;
        jsonResponse(response, 429, { error: "Gateway session limit reached. Revoke an unused device and retry." });
        return;
      }
      const currentCookieId = browserCookies.read(request);
      const preserveAuthenticatedHostCookie = Boolean(
        currentCookieId && await authSessionById(currentCookieId),
      );
      jsonResponse(
        response,
        200,
        attachMobileConnectionRoutes({
          accessToken: id,
          expiresAt: session.expiresAt,
          rpcToken: gatewayToken,
          capabilities: { mobileRefreshV1: false, mobileDeviceManagementV1: false,
            ...(requestInitialServers ? { mobileInitialServersV1: true } : {}) },
          ...(requestInitialServers ? initialServerBootstrap(session, authRequired ? id : ANONYMOUS_LOGIN_OWNER) : {}),
        }, mobileConnectionRoutesProvider?.get()),
        preserveAuthenticatedHostCookie
          ? {}
          : {
              // Preserve same-origin Mobile Web cookie authentication when no independent web-login session exists.
              "set-cookie": browserCookies.header(request, id, Math.floor(authSessionTtlMs / 1000)),
            },
      );
      return;
    }
    if (pathname === "/api/mobile/session/refresh" && request.method === "POST") {
      if (!authRequired) { jsonResponse(response, 403, { error: "Persistent device authorization requires Gateway authentication" }); return; }
      if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') { jsonResponse(response, 415, { error: 'Refresh requires application/json' }); return; }
      try {
        const payload = JSON.parse(await requestBody(request));
        const grant = await mobileDeviceAuth.refresh(payload?.refreshToken, payload?.rotationId, publicRequest ? publicAccess.allows : undefined);
        if (payload?.deviceId && payload.deviceId !== grant.deviceId) { jsonResponse(response, 401, { error: 'Device authorization rejected' }); return; }
        jsonResponse(response, 200, registerMobileDeviceGrant(grant));
      } catch (error) {
        // Reverse-relay traffic shares a loopback peer. Validate strong refresh
        // credentials first; invalid requests must not block valid devices.
        const peer = request.socket.remoteAddress || 'unknown'; const now = Date.now();
        for (const [address, timestamps] of mobileRefreshFailures) if (timestamps.every(time => now - time >= 60_000)) mobileRefreshFailures.delete(address);
        if (!mobileRefreshFailures.has(peer) && mobileRefreshFailures.size >= 1024) mobileRefreshFailures.delete(mobileRefreshFailures.keys().next().value);
        const attempts = (mobileRefreshFailures.get(peer) || []).filter(time => now - time < 60_000);
        const limited = attempts.length >= 5;
        if (!limited) attempts.push(now); mobileRefreshFailures.set(peer, attempts);
        jsonResponse(response, limited ? 429 : error.status || 400, { error: 'Device refresh rejected' });
      }
      return;
    }
    if (pathname === "/api/mobile/session" && request.method === "DELETE") {
      const id = bearerValue(request);
      const session = id ? authSessions.get(id) : null;
      if (!id || !session || (session.accessExpiresAt ?? session.expiresAt) <= Date.now()) {
        jsonResponse(response, 401, { error: "Authentication required" });
        return;
      }
      if (session.deviceId) await revokeMobileDeviceAndScheduleCleanup(session.deviceId);
      await deleteAuthSession(id);
      const deletingCurrentCookie =
        browserCookies.read(request) === id;
      response.writeHead(204, {
        "cache-control": "no-store",
        ...(deletingCurrentCookie
          ? {
              "set-cookie":
                browserCookies.header(request, '', 0),
            }
          : {}),
      });
      response.end();
      return;
    }
    if (authRequired && pathname === "/login") {
      if (request.method === "GET" && requestUrl.searchParams.has("token")) {
        response.setHeader("referrer-policy", "no-referrer");
        if (loginRateLimited(request)) {
          response.writeHead(429, loginHtmlHeaders);
          response.end(loginPage("尝试次数过多，请一分钟后重试。", null, prefixedLocation(request, "/login")));
          return;
        }
        if (!tokenMatches(requestUrl.searchParams.get("token") || "")) {
          recordLoginFailure(request);
          const cleanLogin = prefixedLocation(request, "/login?linkError=1");
          response.writeHead(303, { location: cleanLogin, "cache-control": "no-store", "referrer-policy": "no-referrer" });
          response.end();
          return;
        }
        loginAttempts.delete(request.socket.remoteAddress || "unknown");
        const { id } = await createAuthSession({ browserAdmin: true });
        const returnTo = safeReturnTo(requestUrl.searchParams.get("returnTo"));
        response.writeHead(303, {
          location: returnTo || prefixedLocation(request, "/"),
          "set-cookie": browserCookies.header(request, id, Math.floor(authSessionTtlMs / 1000), requestCookiePath(request)),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-kcoder-session-ttl-ms": String(authSessionTtlMs),
        });
        response.end();
        return;
      }
      if (request.method === "POST") {
        if (loginRateLimited(request)) {
          response.writeHead(429, loginHtmlHeaders);
          response.end(loginPage("尝试次数过多，请一分钟后重试。", null, prefixedLocation(request, "/login")));
          return;
        }
        const form = new URLSearchParams(await requestBody(request));
        const returnTo = safeReturnTo(form.get("returnTo"));
        if (tokenMatches(form.get("token") || "")) {
          loginAttempts.delete(request.socket.remoteAddress || "unknown");
          let id = form.get("renewSession") === "1" && request.headers.authorization === undefined
            ? browserCookies.read(request)
            : null;
          const renewed = Boolean(id) && await authSessionRegistry.renew(id);
          if (!renewed) {
            try { ({ id } = await createAuthSession({ browserAdmin: true })); }
            catch (error) {
              if (error.status !== 429) throw error;
              response.writeHead(429, loginHtmlHeaders);
              response.end(loginPage("登录会话已满，请先撤销一个不再使用的设备后重试。", returnTo));
              return;
            }
          }
          response.writeHead(303, {
            location: returnTo || prefixedLocation(request, "/"),
            "set-cookie": browserCookies.header(request, id, Math.floor(authSessionTtlMs / 1000), requestCookiePath(request)),
            "cache-control": "no-store",
            "x-kcoder-session-ttl-ms": String(authSessionTtlMs),
          });
          response.end();
          return;
        }
        recordLoginFailure(request);
        response.writeHead(401, loginHtmlHeaders);
        response.end(loginPage("访问令牌不正确。", returnTo, prefixedLocation(request, "/login")));
        return;
      }
      const linkError = requestUrl.searchParams.has("linkError") ? "登录链接无效或已失效，请手动输入访问令牌。" : "";
      response.writeHead(200, { ...loginHtmlHeaders, "referrer-policy": "no-referrer" });
      response.end(
        loginPage(linkError, safeReturnTo(requestUrl.searchParams.get("returnTo")), prefixedLocation(request, "/login")),
      );
      return;
    }
    if (authRequired && pathname === "/logout" && request.method === "POST") {
      const id = browserCookies.read(request);
      if (id) await deleteAuthSession(id);
      response.writeHead(303, {
        location: prefixedLocation(request, "/login"),
        "set-cookie":
          browserCookies.header(request, '', 0),
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (await servePublicStudioAsset(request, response, pathname)) return;
    const authSession = await authenticatedSession(request);
    if (!authSession) {
      const navigation = request.headers.accept?.includes("text/html");
      const requestedReturnTo = navigation
        ? safeReturnTo(`${requestUrl.pathname}${requestUrl.search}`)
        : null;
      const publicPrefix = requestPublicPrefix(request);
      const returnTo = requestedReturnTo && publicPrefix && !requestedReturnTo.startsWith(`${publicPrefix}/`)
        ? `${publicPrefix}${requestedReturnTo === "/" ? "/" : requestedReturnTo}`
        : requestedReturnTo;
      const loginLocation =
        returnTo && returnTo !== "/"
          ? prefixedLocation(request, `/login?returnTo=${encodeURIComponent(returnTo)}`)
          : prefixedLocation(request, "/login");
      response.writeHead(
        navigation ? 303 : 401,
        navigation
          ? { location: loginLocation, "cache-control": "no-store" }
          : { "content-type": "application/json", "cache-control": "no-store" },
      );
      response.end(
        navigation ? "" : JSON.stringify({ error: "Authentication required" }),
      );
      return;
    }
    if (mobileDevFor(request)?.matches(pathname)) {
      if (!isGatewayBrowserAdminRequest(request, authSession, servers, authRequired)) { jsonResponse(response, 403, { error: "Gateway browser authorization required" }); return; }
      await mobileDevFor(request).handle(request, response, requestUrl);
      return;
    }
    if (await migrationSourceSessions.handle({ pathname, request, response, authSession })) return;
    if (await handleRelayManagement(request, response, pathname, authSession)) return;
    if (await workspaceCwdObservationHandler({ pathname, request, response, requestUrl, authSession })) return;
    if (pathname === '/api/channels') {
      if (!isGatewayBrowserAdminRequest(request, authSession, servers, authRequired)) { jsonResponse(response, 403, { error: 'Gateway browser authorization required' }); return; }
      await handleChannels({ request, response, pathname, session: authSession, loginOwner: requestLoginOwner(request, authSession) });
      return;
    }
    if (pathname === "/api/gateway/browser-access" && request.method === "GET") {
      if (!isGatewayBrowserAdminRequest(request, authSession, servers, authRequired)) { jsonResponse(response, 403, { error: "Gateway browser authorization required" }); return; }
      const publicBaseUrl = publicAccessUrl?.toString().replace(/\/$/, "") || null;
      jsonResponse(response, 200, {
        token: authToken,
        localBaseUrl: localAccessBase(),
        publicBaseUrl,
      });
      return;
    }
    const mobilePairingAdminDevices = pathname.match(/^\/api\/mobile\/pairing\/devices\/([a-zA-Z0-9-]{16,128})$/);
    if (pathname === "/api/mobile/pairing" || mobilePairingAdminDevices) {
      const browserAdmin = isGatewayBrowserAdminRequest(request, authSession, servers, authRequired);
      if (!browserAdmin) { jsonResponse(response, 403, { error: "Gateway browser authorization required" }); return; }
      if (pathname === "/api/mobile/pairing" && request.method === "GET") {
        try {
          const pairing = await mobileDeviceAuth.getPairingCredential();
          const routes = mobileConnectionRoutesProvider?.get();
          jsonResponse(response, 200, attachMobileConnectionRoutes({
            ...pairing,
            publicBaseUrl: publicAccessUrl?.toString().replace(/\/$/, "") || null,
            publicReadiness: publicPairingReadiness(routes?.endpoints[0]?.url),
            devices: await mobileDeviceAuth.list(),
          }, routes));
        } catch {
          jsonResponse(response, 503, { error: "Mobile pairing is unavailable" });
        }
        return;
      }
      if (pathname === "/api/mobile/pairing" && request.method === "POST") {
        if (!requireSameOriginMutation(request)) { jsonResponse(response, 403, { error: "Same-origin JSON request required" }); return; }
        try {
          const pairing = await mobileDeviceAuth.rotatePairingCredential();
          jsonResponse(response, 200, pairing);
        } catch {
          jsonResponse(response, 503, { error: "Mobile pairing is unavailable" });
        }
        return;
      }
      if (mobilePairingAdminDevices && request.method === "DELETE") {
        if (!requireSameOriginMutation(request)) { jsonResponse(response, 403, { error: "Same-origin JSON request required" }); return; }
        await revokeMobileDeviceAndScheduleCleanup(mobilePairingAdminDevices[1]);
        response.writeHead(204, { "cache-control": "no-store" }); response.end();
        return;
      }
      jsonResponse(response, 405, { error: "Method not allowed" });
      return;
    }
    if (pathname === '/api/mobile/devices' && request.method === 'GET') {
      if (!authRequired || !bearerValue(request) || !authSession.deviceId || !servers.every(target => authSession.allowedServerIds.has(target.id))) { jsonResponse(response, 401, { error: 'Bearer authorization required' }); return; }
      jsonResponse(response, 200, { devices: await mobileDeviceAuth.list() }); return;
    }
    const mobileDeviceMatch = pathname.match(/^\/api\/mobile\/devices\/([a-zA-Z0-9-]{16,128})$/);
    if (mobileDeviceMatch && request.method === 'DELETE') {
      if (!authRequired || !bearerValue(request) || !authSession.deviceId || !servers.every(target => authSession.allowedServerIds.has(target.id))) { jsonResponse(response, 401, { error: 'Bearer authorization required' }); return; }
      await revokeMobileDeviceAndScheduleCleanup(mobileDeviceMatch[1]);
      response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return;
    }
    if (await handleServerInventory(request, response, pathname, authSession)) return;
    if (await handleAccountAdministration(request, response, pathname, authSession)) return;
    if (await accountOidcRoutes.handle(request, response, requestUrl, authSession)) return;
    const accountMutation = pathname.match(/^\/api\/servers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/account$/);
    if (accountMutation && ['GET', 'POST', 'DELETE'].includes(request.method)) {
      if (request.method !== 'GET' && !requireSameOriginMutation(request)) {
        jsonResponse(response, 403, { error: 'Same-origin JSON request required' });
        return;
      }
      const target = serversById.get(accountMutation[1]);
      if (!target?.security || !authSession.allowedServerIds.has(target.id)) {
        jsonResponse(response, 404, { error: 'KCoder account target is unavailable' });
        return;
      }
      const loginOwner = requestLoginOwner(request, authSession);
      if (!loginOwner) {
        jsonResponse(response, 401, { error: 'Authentication required' });
        return;
      }
      const throttleKey = `${loginOwner}:${target.id}`;
      try {
        if (request.method === 'GET') {
          const principal = loginContexts.identity(loginOwner, target.id);
          jsonResponse(response, 200, {
            authenticated: Boolean(principal),
            generation: loginContexts.generation(loginOwner, target.id),
            authorityId: authorityIdFor(target),
            ...(principal ? {
              username: principal.username,
              role: principal.role,
              principalId: principal.principalId,
            } : {}),
          });
          return;
        }
        if (request.method === 'DELETE') {
          let body = {};
          try { body = JSON.parse(await requestBody(request, 1024)); }
          catch { body = {}; }
          if (!body || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).some(key => key !== 'deviceId')) throw new Error('Invalid account logout request');
          const deviceId = body.deviceId;
          let wikiPauseUnconfirmed = false;
          await loginContexts.mutate(loginOwner, target.id, async () => {
            const principal = loginContexts.identity(loginOwner, target.id);
            if (principal) {
              // Stop new client submissions before the target-side pause barrier.
              closeContextSockets(loginOwner, target.id);
              try {
                const key = workspaceBrokerKey(target);
                const broker = [...(workspaceAppServerBrokers.get(key) ?? [])].find(
                  candidate => !candidate.closed && !candidate.nativeManagementOnly && candidate.loginOwner === loginOwner,
                ) ?? createWorkspaceBroker(target, undefined, key, { loginOwner });
                await pauseWikiBeforeLogout(broker);
              } catch { wikiPauseUnconfirmed = true; }
            }
            loginContexts.invalidate(loginOwner, target.id);
            closeContextSockets(loginOwner, target.id);
            await terminateContextChildren(target.id, loginOwner);
            invalidateServerHealth(target.id);
            const cleanupFailure = await runAccountLogoutCleanup(
              accountLogoutCleanupPlan({ principal, deviceId }),
              accountCredentials,
              target,
            );
            if (cleanupFailure) {
              // The context is already invalidated, so the account stays logged
              // out; this only reports that no remembered credential could be
              // dropped for this device profile and target.
              process.stderr.write(`${JSON.stringify({
                event: "account-logout-cleanup-failed",
                targetId: target.id,
              })}\n`);
            }
          });
          jsonResponse(response, wikiPauseUnconfirmed ? 409 : 200, {
            authenticated: false,
            ...(wikiPauseUnconfirmed ? {
              errorCode: 'wiki_pause_unconfirmed',
              error: '已退出账号，但目标未确认暂停 Wiki 后台任务。请重新连接目标检查。',
            } : {}),
          });
          return;
        }
        // POST: login with username+password, or auto-restore a remembered
        // credential that is re-verified by the remote account entry.
        if (accountLoginRateLimited(throttleKey)) {
          jsonResponse(response, 429, { error: '登录尝试过于频繁，请稍后再试' });
          return;
        }
        let body;
        try { body = JSON.parse(await requestBody(request, 8192)); }
        catch { throw new Error('Invalid account login request'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some(key => !['username', 'password', 'remember', 'deviceId', 'auto'].includes(key))) {
          throw new Error('Invalid account login request');
        }
        const outcome = await loginContexts.mutate(loginOwner, target.id, async () => {
          if (loginContexts.identity(loginOwner, target.id)) return { conflict: true };
          let credential;
          if (body.auto === true) {
            credential = typeof body.deviceId === 'string'
              ? await accountCredentials.recall({ deviceId: body.deviceId }, target)
              : null;
            if (!credential) return { missing: true };
          } else {
            if (typeof body.username !== 'string' || !/^[a-z][a-z0-9_.-]{1,31}$/.test(body.username) ||
                typeof body.password !== 'string' || body.password.length === 0) {
              throw new Error('请输入 KCoder 账号用户名和密码');
            }
            credential = { username: body.username, password: body.password };
          }
          loginContexts.invalidate(loginOwner, target.id);
          try {
            await testServerConnection(target, { fresh: true, loginOwner, authentication: credential });
            const principal = loginContexts.identity(loginOwner, target.id);
            if (!principal || principal.username !== credential.username) {
              throw new Error('KCoder account identity was not verified');
            }
            if (body.remember === true && typeof body.deviceId === 'string') {
              await accountCredentials.save({ deviceId: body.deviceId, username: credential.username }, target, credential.password);
            }
            return { principal };
          } catch (error) {
            loginContexts.invalidate(loginOwner, target.id);
            invalidateServerHealth(target.id);
            if (error?.authenticationRejected && typeof body.deviceId === 'string') {
              await accountCredentials.forgetIdentity({ deviceId: body.deviceId, username: credential.username }, target).catch(() => {});
            }
            throw error;
          }
        });
        if (outcome.conflict) {
          jsonResponse(response, 409, { error: '此连接已有登录账号，请先退出或切换账号' });
          return;
        }
        if (outcome.missing) {
          jsonResponse(response, 404, { error: '没有可恢复的保存登录' });
          return;
        }
        accountLoginAttempts.delete(throttleKey);
        jsonResponse(response, 200, {
          authenticated: true,
          identity: outcome.principal,
          generation: loginContexts.generation(loginOwner, target.id),
          authorityId: authorityIdFor(target),
        });
      } catch (error) {
        if (request.method === 'POST') recordAccountLoginFailure(throttleKey);
        if (error?.authenticationRejected) {
          jsonResponse(response, 401, { error: 'KCoder 账号认证失败：请检查用户名和密码，或联系管理员确认账号状态' });
        } else {
          jsonResponse(response, 400, { error: error instanceof Error ? error.message : 'KCoder account operation failed' });
        }
      }
      return;
    }
    if (pathname === "/api/servers/test" && request.method === "POST") {
      if (!hasFullServerAccess(authSession, servers)) {
        jsonResponse(response, 403, { error: "Full Gateway authorization required" });
        return;
      }
      if (!requireSameOriginMutation(request)) {
        jsonResponse(response, 403, {
          error: "Same-origin JSON request required",
        });
        return;
      }
      try {
        const draft = JSON.parse(await requestBody(request, 16 * 1024));
        const target = normalizeServer(draft, serverDefaults);
        const startedAt = Date.now();
        try {
          const result = await testServerConnection(target);
          if (!target.security &&
            serverHealthSignature(serversById.get(target.id)) ===
            serverHealthSignature(target)
          ) {
            const loginOwner = requestLoginOwner(request, authSession);
            updateServerHealth(target, startedAt, serverHealthScopeKey(target, loginOwner), null, result, loginOwner);
          }
          jsonResponse(response, 200, result);
        } catch (error) {
          if (!target.security &&
            serverHealthSignature(serversById.get(target.id)) ===
            serverHealthSignature(target)
          ) {
            const loginOwner = requestLoginOwner(request, authSession);
            updateServerHealth(target, startedAt, serverHealthScopeKey(target, loginOwner), error, null, loginOwner);
          }
          jsonResponse(response, 200, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } catch (error) {
        jsonResponse(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    const serverMutation = pathname.match(
      /^\/api\/servers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})$/,
    );
    if (serverMutation && ["PUT", "DELETE"].includes(request.method || "")) {
      if (!requireSameOriginMutation(request)) {
        jsonResponse(response, 403, {
          error: "Same-origin JSON request required",
        });
        return;
      }
      try {
        const draft = request.method === "PUT"
          ? JSON.parse(await requestBody(request, 16 * 1024)) : null;
        await runServerMutation(async () => {
        if (!hasFullServerAccess(await authenticatedSession(request), servers)) {
          jsonResponse(response, 403, { error: "Full Gateway authorization required" });
          return;
        }
        const id = serverMutation[1];
        if (request.method === "PUT") {
          if (draft.id !== id)
            throw new Error("runtime target id does not match request path");
          const target = normalizeServer(draft, serverDefaults);
          const existingIndex = servers.findIndex((item) => item.id === id);
          const previous = existingIndex >= 0 ? servers[existingIndex] : null;
          // Changing connection parameters (including the account-mode flag)
          // invalidates every login context on this target instead of forcing
          // a new connection; the login identity itself is never part of the
          // connection configuration.
          const connectionChanged = previous !== null && (
            JSON.stringify(previous.security ?? null) !== JSON.stringify(target.security ?? null) ||
            previous.host !== target.host ||
            (previous.port ?? undefined) !== (target.port ?? undefined) ||
            (previous.user ?? undefined) !== (target.user ?? undefined) ||
            previous.command !== target.command ||
            (previous.remoteCwd ?? undefined) !== (target.remoteCwd ?? undefined)
          );
          if (id === "local")
            throw new Error("the built-in local target cannot be replaced");
          let nextServers;
          if (existingIndex >= 0) {
            nextServers = servers.map((item, index) =>
              index === existingIndex ? target : item,
            );
          } else {
            if (servers.length >= 32)
              throw new Error("servers configuration cannot exceed 32 entries");
            nextServers = [...servers, target];
          }
          if (target.transport === "local") {
            const workspaceInfo = await stat(target.cwd).catch(() => null);
            if (!workspaceInfo?.isDirectory())
              throw new Error(
                "local runtime target workspace must be an existing directory",
              );
          }
          await persistServers(nextServers);
          const previousServerIds = servers.map(item => item.id);
          servers = nextServers;
          serversById = new Map(servers.map((item) => [item.id, item]));
          invalidateServerHealth(id);
          await refreshSessionServerAccess(previousServerIds);
          if (existingIndex >= 0 && connectionChanged) {
            loginContexts.invalidateTarget(id);
            closeTargetSockets(id);
            await accountCredentials.forgetTarget(target).catch(() => {});
          }
          if (existingIndex >= 0) await terminateServerChildren(id);
          jsonResponse(response, 200, { server: publicServer(target) });
        } else {
          const existing = serversById.get(id);
          if (!existing) throw new Error("runtime target does not exist");
          if (id === "local")
            throw new Error("the built-in local target cannot be deleted");
          if (servers.length <= 1)
            throw new Error("the last runtime target cannot be deleted");
          const nextServers = servers.filter((item) => item.id !== id);
          await persistServers(nextServers);
          const previousServerIds = servers.map(item => item.id);
          servers = nextServers;
          serversById = new Map(servers.map((item) => [item.id, item]));
          invalidateServerHealth(id);
          await refreshSessionServerAccess(previousServerIds);
          await terminateServerChildren(id);
          loginContexts.invalidateTarget(id);
          closeTargetSockets(id);
          await accountCredentials.forgetTarget(existing);
          jsonResponse(response, 200, { removed: id });
        }
        });
      } catch (error) {
        jsonResponse(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      jsonResponse(response, 404, { error: "API endpoint not found" });
      return;
    }
    const viteRenderer = viteFor(request);
    if (viteRenderer) {
      if (!isGatewayBrowserAdminRequest(request, authSession, servers, authRequired)) { jsonResponse(response, 403, { error: 'Gateway browser authorization required' }); return; }
      await viteRenderer.handle(request, response, pathname);
    } else await serveStudioStatic(request, response, pathname);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

const openSockets = new Set();
server.on("connection", (socket) => {
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));
});

function acceptWebSocket(request, socket) {
  const key = request.headers["sec-websocket-key"];
  if (!key) return false;
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  const protocols = String(request.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((value) => value.trim());
  const selectedProtocol = protocols.includes("kcoder-studio")
    ? "Sec-WebSocket-Protocol: kcoder-studio\r\n"
    : "";
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${selectedProtocol}\r\n`,
  );
  return true;
}

function workspaceBrokerKey(target, workspacePath) {
  return targetWorkspaceBrokerKey(target, workspacePath, serverHealthSignature(target));
}

function hasOwnedChannelAppServer(target) {
  return Boolean(nativeConnectivityStartupBinding && (
    (target.transport === "local" && !target.security && nativeComponentParentAttempt(target) &&
      trustedRetentionAppServer?.matches(target)) || trustedWindowsComponentImage?.matches(target)
  ));
}

function removeWorkspaceBroker(key, broker) {
  if (broker.idleTimer) clearTimeout(broker.idleTimer);
  const brokers = workspaceAppServerBrokers.get(key);
  brokers?.delete(broker);
  if (!brokers?.size) workspaceAppServerBrokers.delete(key);
}

function scheduleWorkspaceBrokerIdle(key, broker, delay = workspaceAppServerIdleMs, expediteDuplicates = true) {
  if (broker.child.ownsOidcSessionAuthority && !broker.closed) return;
  if (broker.idleTimer) clearTimeout(broker.idleTimer);
  broker.idleTimer = null;
  if (broker.clientCount !== 0 || broker.closed || broker.idleShutdown.closing || broker.hasLiveTerminals || broker.hasProjectAutomations)
    return;
  delay = workspaceIdleDelay(workspaceAppServerBrokers.get(key) ?? [], broker, delay, expediteDuplicates);
  broker.idleTimer = setTimeout(() => {
    broker.idleTimer = null;
    if (broker.clientCount !== 0 || broker.closed || broker.hasLiveTerminals || broker.hasProjectAutomations) return;
    if (broker.hasProtectedIdleResources) {
      scheduleWorkspaceBrokerIdle(key, broker, pendingWorkIdleDelay(workspaceAppServerIdleMs), false);
      return;
    }
    void broker.stopWhenIdle().then(result => {
      const summary = JSON.stringify({ event: 'broker-idle-shutdown', ...result });
      if (broker.lastIdleShutdownSummary !== summary) {
        broker.lastIdleShutdownSummary = summary;
        process.stderr.write(`${summary}\n`);
      }
      if (result.status === 'stopped') removeWorkspaceBroker(key, broker);
      else if (!broker.closed && !broker.idleShutdown.closing)
        scheduleWorkspaceBrokerIdle(key, broker, pendingWorkIdleDelay(workspaceAppServerIdleMs), false);
    });
  }, delay);
  broker.idleTimer.unref?.();
}

async function terminateWorkspaceBrokers(target, workspacePath) {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) return;
  let key;
  try {
    key = workspaceBrokerKey(target, workspacePath);
  } catch {
    return;
  }
  const brokers = [...(workspaceAppServerBrokers.get(key) ?? [])];
  for (const broker of brokers) removeWorkspaceBroker(key, broker);
  await Promise.all(
    brokers.map((broker) => terminateAppServerChild(broker.child)),
  );
}

async function releaseIdleWorkspaceBrokers(target, workspacePath, loginOwner) {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) {
    throw new Error("workspacePath is required");
  }
  const key = workspaceBrokerKey(target, workspacePath);
  const brokers = [...(workspaceAppServerBrokers.get(key) ?? [])]
    .filter((broker) => (target.security ? broker.loginOwner === loginOwner : true));
  return releaseIdleBrokers(brokers, {
    remove: broker => removeWorkspaceBroker(key, broker),
  });
}

function createWorkspaceBroker(target, workspacePath, key, { authentication, loginOwner, onAuthorizationRequired, onAccountAuthenticated, nativeManagementOnly = false } = {}) {
  // Original argv and login shape keep unknown old binaries/entries usable.
  // A new backend advertises readiness only after its own actual capture.
  const retentionParentV1 = nativeComponentParentAttempt(target);
  const retentionRevocationTrusted = retentionParentV1 && Boolean(trustedRetentionAppServer?.matches(target));
  const originalSpec = launchSpec(target, { scenario, workspacePath });
  const spec = retentionRevocationTrusted ? trustedRetentionAppServer.launch(target, originalSpec) : originalSpec;
  if (target.security) {
    authentication ??= loginOwner ? loginContexts.credential(loginOwner, target.id) : null;
    if (!authentication) {
      throw new Error("请先登录此连接的 KCoder 账号");
    }
  }
  const windowsComponents = trustedWindowsComponentImage?.matches(target)
    ? nativeWindowsComponentEnvironment(trustedWindowsComponentImage, target, nativeOfficeStartupBinding, nativeConnectivityStartupBinding) : {};
  const configuredChannelChild = hasOwnedChannelAppServer(target);
  const authenticationGeneration = target.security && loginOwner ? loginContexts.generation(loginOwner, target.id) : 0;
  const authenticationSignature = serverHealthSignature(target);
  let issuedOidcHandle = authentication?.resumeAuthority?.handle;
  const spawnedProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...appServerEnvironment(process.env, spec.env, retentionParentV1 && !target.security ? "localOs" : undefined,
      retentionRevocationTrusted ? retentionRevocationVerifier : undefined,
      retentionRevocationTrusted && target.transport === "local" && !target.security ? nativeOfficeStartupBinding : undefined,
      retentionRevocationTrusted && target.transport === "local" && !target.security ? nativeConnectivityStartupBinding : undefined), ...windowsComponents },
    stdio: spec.stdio ?? ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const authenticated = authentication ? authenticatedAccountProcess(spawnedProcess, {
    ...authentication, workspace: workspacePath || target.remoteCwd,
  }, {
    // The new root-owned entry supplies facts after authentication/UID drop;
    // do not add a login field that an old entry rejects.
    onAuthorizationRequired,
    onAuthenticated: (principal, nativeResume) => {
      if (authentication?.authentication && (serverHealthSignature(serversById.get(target.id)) !== authenticationSignature || loginContexts.generation(loginOwner, target.id) !== authenticationGeneration)) return false;
      if (onAccountAuthenticated?.(principal, nativeResume) === false) return false;
      issuedOidcHandle = nativeResume?.handle ?? issuedOidcHandle;
      if (target.security && loginOwner) loginContexts.publish(loginOwner, target.id, principal, nativeResume ? { username: principal.username, authentication: 'oidcResume', resumeAuthority: nativeResume } : authentication);
    },
    onFailure: ({ authenticationRejected }) => {
      if (authentication?.authentication && loginContexts.generation(loginOwner, target.id) !== authenticationGeneration && (!issuedOidcHandle || loginContexts.credential(loginOwner, target.id)?.resumeAuthority?.handle !== issuedOidcHandle)) return;
      if (target.security && loginOwner && authenticationRejected) {
        loginContexts.invalidate(loginOwner, target.id);
        closeContextSockets(loginOwner, target.id);
        invalidateServerHealth(target.id);
      }
    },
  }) : spawnedProcess;
  const child = trackAppServerChild(
    authenticated,
    target.id,
    target.security ? loginOwner : undefined,
  );
  if (configuredChannelChild) channelAppServerChildren.add(child);
  let broker;
  let nativeRemoteHostBackchannel;
  if (retentionRevocationTrusted || trustedWindowsComponentImage?.matches(target)) {
    const assertSourceNativeChild = ({ child: observed, serverId }) => {
      const current = serversById.get(target.id);
      const imageMatches = current && (retentionRevocationTrusted
        ? trustedRetentionAppServer?.matches(current) : trustedWindowsComponentImage?.matches(current));
      if (observed !== child || observed !== spawnedProcess || serverId !== target.id ||
          !appServerChildren.has(child) || child.exitCode !== null || child.signalCode !== null ||
          broker?.closed || !imageMatches || serverHealthSignature(current) !== authenticationSignature)
        throw new Error('REMOTE_HOST_SOURCE_OWNER_CHANGED');
    };
    const owner = createNativeSshEndpointFactory({ assertSourceNativeChild,
      sourceClientForAttempt: attempt => nativeRemoteSourceClientForAttempt(broker, attempt),
      sourceClientForManagement: reference => nativeRemoteSourceClientForManagement(broker, reference) });
    let closingOwner;
    const closeOwner = () => closingOwner ??= owner.close().finally(() => nativeRemoteEndpointOwners.delete(closeOwner));
    nativeRemoteEndpointOwners.add(closeOwner);
    child.once('close', () => { void closeOwner(); });
    const backchannel = createNativeRemoteHostBackchannel({ child, serverId: target.id,
      assertSourceOwner: assertSourceNativeChild,
      handleOwnedRequest: context => owner.handleOwnedRequest(context),
      reply: message => broker.writeRaw(JSON.stringify(message), null) });
    nativeRemoteHostBackchannel = { receiveBackend: message => backchannel.receiveBackend(message),
      close: () => { backchannel.close(); void closeOwner(); } };
  }
  broker = new WorkspaceAppServerBroker({
    child,
    nativeManagementOnly,
    ownsChannelHost: configuredChannelChild,
    nativeRemoteHostBackchannel,
    retentionParentV1,
    retentionRevocationTrusted,
    registerRetentionRoute: retentionRevocationTrusted ? authority => {
      if (!authority || authority.principal?.kind !== 'localOs' || authority.workspaceTargetId !== target.id ||
          authority.targetFingerprint !== retentionTargetFingerprint(target, workspacePath, key)) throw new Error('Retention route authority changed');
      const canonicalWorkspace = realpathSync(workspacePath || target.cwd || spec.cwd || process.cwd());
      const route = localRetentionRoute({ targetId: target.id, targetFingerprint: authority.targetFingerprint, workspacePath: canonicalWorkspace, workspaceSelection: workspacePath ?? null });
      return mobileDeviceAuth.registerRetentionRoute({ deviceId: authority.deviceId, authorizationGeneration: authority.authorizationGeneration, route });
    } : undefined,
    adapter: createRuntimeTargetAdapter(target.runtime),
    maxMessageBytes,
    serverId: target.id,
    targetTransport: target.transport,
    remotePlatform: target.remotePlatform,
    residentThreads: serverHealth.get(serverHealthScopeKey(target, loginOwner))?.result?.capabilities
      ?.experimental?.residentThreads,
    onClose: (closed) => removeWorkspaceBroker(key, closed),
    onLifecycleMetrics: (metrics) => {
      let brokerCount = 0;
      for (const brokers of workspaceAppServerBrokers.values()) brokerCount += brokers.size;
      process.stderr.write(`${JSON.stringify({
        event: "broker-lifecycle",
        transport: target.transport === "ssh" ? "ssh" : "local",
        brokerCount,
        ...metrics,
      })}\n`);
    },
    onRestart: async (restarting) => {
      retireRestartScopeAdmissions(workspaceAppServerBrokers, key, { targetId: target.id, loginOwner: target.security ? loginOwner : undefined });
      removeWorkspaceBroker(key, restarting);
      invalidateServerHealth(target.id);
      await terminateAppServerChild(restarting.child);
      if (appServerChildren.has(restarting.child)) throw new Error("app-server did not stop");
    },
    onIdleStateChange: (changed) => scheduleWorkspaceBrokerIdle(key, changed),
    onWorkspaceRemoved: (params) => {
      void terminateWorkspaceBrokers(target, params?.workspacePath);
    },
    onReleaseWorkspace: (releasedPath) =>
      releaseIdleWorkspaceBrokers(target, releasedPath, loginOwner),
  });
  broker.loginOwner = target.security ? loginOwner : undefined;
  broker.targetId = target.id;
  const brokers = workspaceAppServerBrokers.get(key) ?? new Set();
  resourceBudgetBrokers.add(broker);
  child.once('close', () => resourceBudgetBrokers.delete(broker));
  brokers.add(broker);
  workspaceAppServerBrokers.set(key, brokers);
  for (const peer of brokers) {
    if (peer !== broker && peer.clientCount === 0 && peer.targetId === broker.targetId &&
        peer.loginOwner === broker.loginOwner) scheduleWorkspaceBrokerIdle(key, peer);
  }
  return broker;
}

async function reusableWorkspaceBroker(target, workspacePath, loginOwner, nativeManagementOnly = false, isCancelled = () => false) {
  if (isCancelled()) return null;
  const key = workspaceBrokerKey(target, workspacePath);
  const dedicatedManagement = nativeManagementOnly && !hasOwnedChannelAppServer(target);
  const sameOwner = (candidate) =>
    target.security ? candidate.loginOwner === loginOwner : true;
  if (!dedicatedManagement && nativeConnectivityStartupBinding && key === workspaceBrokerKey(target)) {
    const starting = serverHealthInFlight.get(serverHealthScopeKey(target, loginOwner));
    if (starting?.signature === serverHealthSignature(target)) await starting.promise;
    if (isCancelled()) return null;
  }
  const brokers = workspaceAppServerBrokers.get(key);
  let broker = [...(brokers ?? [])].find(
    (candidate) => candidate.acceptsClient && candidate.nativeManagementOnly === dedicatedManagement && sameOwner(candidate),
  );
  if (!broker) {
    const closing = [...(brokers ?? [])].find(candidate => !candidate.closed && candidate.nativeManagementOnly === dedicatedManagement && candidate.idleShutdown.closing && sameOwner(candidate));
    if (closing) {
      await closing.idleShutdown.operation;
      if (isCancelled()) return null;
      if (!closing.closed && closing.idleShutdown.closing)
        throw new Error("workspace shutdown is not yet confirmed; retry after the target exits");
      return reusableWorkspaceBroker(target, workspacePath, loginOwner, nativeManagementOnly, isCancelled);
    }
    // A legacy backend stays exclusive until negotiation. A configured
    // channel owner accepts peers while its single backend initializes.
  }
  broker ??= createWorkspaceBroker(target, workspacePath, key, { loginOwner, nativeManagementOnly: dedicatedManagement });
  if (broker.idleTimer) {
    clearTimeout(broker.idleTimer);
    broker.idleTimer = null;
  }
  return { broker, key, nativeManagementOnly };
}

const bridgeWorkspaceAppServer = createWorkspaceAppServerBridge({
  captureRetentionAuthority, mobileDeviceFamilies, serversById, workspaceBrokerKey,
  loginContexts, mcpCallbacks, maxMessageBytes, frame, decodeFrames, WebSocketLivenessLease,
  scheduleWorkspaceBrokerIdle, serverHealthSignature,
  verifySession: (id, session) => !authRequired ||
    (authSessions.get(id) === session && (session.accessExpiresAt ?? session.expiresAt) > Date.now()),
});

const mockThreadsByTarget = new Map();
function runMock(socket, initialData = Buffer.alloc(0), channel = "runtime", target, workspacePath) {
  const key = JSON.stringify([target.id, workspacePath ?? target.cwd ?? target.remoteCwd]);
  if (!mockThreadsByTarget.has(key)) mockThreadsByTarget.set(key, new MockThreadStore(workspacePath ?? target.cwd ?? target.remoteCwd ?? process.cwd()));
  const mockThreads = mockThreadsByTarget.get(key);
  let buffered = Buffer.from(initialData);
  const fragments = [];
  let activeTurn = null;
  let stopped = false;
  let nextInteractionId = 9_000;
  const pendingServerRequests = new Map();
  const terminalSessions = new Map();
  const browserSessions = new Map();
  let workspaceFile = "# KCoder Studio\n\n移动端文件编辑测试。\n";
  let workspaceRevision = "mock-revision-1";
  let forcedFileConflict = false;
  const workspacePreviewPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  let mockGitState = "working";
  let mockContext = {
    instructions: "",
    personality: "friendly",
    instructionsConfigured: false,
    personalityConfigured: false,
    configPath: null,
  };
  const mockGitDiff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,2 +1,3 @@",
    " # KCoder Studio",
    "+Mobile Git workflow",
    " ",
    "diff --git a/mobile-new.ts b/mobile-new.ts",
    "--- /dev/null",
    "+++ b/mobile-new.ts",
    "@@ -0,0 +1 @@",
    "+export const mobile = true;",
  ].join("\n");
  const clearActiveTurn = () => {
    if (!activeTurn) return null;
    const turn = activeTurn;
    activeTurn = null;
    for (const timer of turn.timers) clearTimeout(timer);
    for (const [requestId, interaction] of pendingServerRequests) {
      if (interaction.turn === turn) pendingServerRequests.delete(requestId);
    }
    return turn;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearActiveTurn();
    pendingServerRequests.clear();
    terminalSessions.clear();
    browserSessions.clear();
  };
  const send = (message) => {
    if (stopped || socket.destroyed || !socket.writable) return;
    try {
      socket.write(frame(JSON.stringify({ jsonrpc: "2.0", ...message })));
    } catch {
      stop();
      if (!socket.destroyed) socket.destroy();
    }
  };
  const schedule = (turn, callback, delay) => {
    const timer = setTimeout(() => {
      turn.timers.delete(timer);
      if (!stopped && activeTurn === turn) callback();
    }, delay);
    turn.timers.add(timer);
  };
  const completeMockTurn = (turn, responseText) => {
    if (activeTurn !== turn) return;
    if (responseText)
      send({
        method: "item/delta",
        params: {
          threadId: turn.threadId,
          turnId: turn.turnId,
          itemId: turn.itemId,
          delta: { text: responseText },
        },
      });
    clearActiveTurn();
    send({
      method: "item/completed",
      params: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        item: { id: turn.itemId, type: "agentMessage" },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        turn: { id: turn.turnId, threadId: turn.threadId, status: "completed" },
      },
    });
  };
  socket.on("data", (chunk) => {
    if (stopped) return;
    try {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = decodeFrames(buffered, fragments);
      buffered = decoded.rest;
      for (const control of decoded.controls) {
        if (control.opcode === 8) {
          stop();
          socket.end(frame(control.payload, 8));
          return;
        }
        if (control.opcode === 9) socket.write(frame(control.payload, 10));
      }
      for (const raw of decoded.messages) {
        let requestMessage;
        try {
          requestMessage = JSON.parse(raw);
        } catch {
          continue;
        }
        const { id, method, params = {} } = requestMessage;
        if (
          id !== undefined &&
          method === undefined &&
          pendingServerRequests.has(id)
        ) {
          const interaction = pendingServerRequests.get(id);
          pendingServerRequests.delete(id);
          if (interaction.kind === "approval") {
            const decision = String(
              requestMessage.result?.decision || "unknown",
            );
            send({
              method: "approval/resolved",
              params: {
                requestId: id,
                approvalId: interaction.identity,
                decision,
              },
            });
            completeMockTurn(
              interaction.turn,
              `MOBILE_APPROVAL_ACCEPTED: ${decision}`,
            );
          } else {
            const answers = requestMessage.result?.answers || {};
            send({
              method: "question/resolved",
              params: { requestId: id, questionId: interaction.identity },
            });
            completeMockTurn(
              interaction.turn,
              `MOBILE_QUESTION_ANSWERED: ${JSON.stringify(answers)}`,
            );
          }
        } else if (method === "initialize")
          send({
            id,
            result: {
              protocolVersion: "2026-07-27",
              serverInfo: { name: "kcoder-studio-mock", version: "0.1.0 mock" },
              capabilities: {
                threadResume: true,
                experimental: {
                  workspaceFiles: true,
                  browserAttachments: true,
                  terminalSessions: true,
                },
              },
            },
          });
        else if (method === "thread/list") {
          const archived = params.archived === true;
          send({
            id,
            result: {
              threads: mockThreads.list(archived),
              nextCursor: null,
            },
          });
        } else if (method === "thread/read") {
          send({
            id,
            result: {
              thread: mockThreads.read(params.threadId),
              messages: [
                {
                  id: "mock-history-attachment",
                  role: "user",
                  content: "历史附件",
                  timestampMs: Date.now() - 1_000,
                  blocks: [
                    {
                      id: "mock-image",
                      type: "attachment",
                      status: "done",
                      attachment: {
                        filename: "mobile-preview.png",
                        mimeType: "image/png",
                        fileSize: 68,
                        path: "/mock/attachments/mobile-preview.png",
                      },
                    },
                  ],
                },
              ],
              rangeStart: 0,
              rangeEnd: 1,
              hasMoreBefore: false,
              beforeCursor: null,
            },
          });
        } else if (method === "thread/metadata/update")
          send({ id, result: { updated: true, thread: mockThreads.update(params.threadId, params) } });
        else if (method === "thread/delete")
          send({ id, result: { deleted: mockThreads.delete(params.threadId) } });
        else if (method === "thread/goal/get")
          send({ id, result: { threadId: params.threadId, goal: null } });
        else if (method === "runtime.models.list")
          send({
            id,
            result: {
              data: [
                {
                  id: "mock-minimax",
                  model: "MiniMax-M3",
                  displayName: "MiniMax-M3",
                  providerId: "kunlunmeta",
                  providerName: "KCoder Meta",
                  isDefault: true,
                  supportedReasoningEfforts: ["low", "medium", "high"],
                  defaultReasoningEffort: "medium",
                },
                {
                  id: "mock-kimi",
                  model: "kimi-for-coding",
                  displayName: "Kimi for Coding",
                  providerId: "kimi",
                  providerName: "Kimi",
                  supportedReasoningEfforts: ["medium", "high"],
                  defaultReasoningEffort: "medium",
                },
              ],
              providers: [],
            },
          });
        else if (method === "runtime.context.get")
          send({ id, result: { ...mockContext } });
        else if (method === "runtime.context.update") {
          if (
            typeof params.instructions === "string" &&
            (params.onlyIfUnconfigured !== true ||
              !mockContext.instructionsConfigured)
          ) {
            mockContext.instructions = params.instructions;
            mockContext.instructionsConfigured = true;
          }
          if (
            (params.personality === "friendly" ||
              params.personality === "pragmatic") &&
            (params.onlyIfUnconfigured !== true ||
              !mockContext.personalityConfigured)
          ) {
            mockContext.personality = params.personality;
            mockContext.personalityConfigured = true;
          }
          send({ id, result: { ...mockContext } });
        } else if (method === "runtime.worktrees.list")
          send({ id, result: { success: true, items: [] } });
        else if (method === "runtime.workspaces.list")
          send({
            id,
            result: {
              success: true,
              items: [],
              pinnedTaskIds: [],
              taskOrders: {},
            },
          });
        else if (method === "device/execute") {
          try {
            const command = params.command_key;
            const stdout =
              command === "home_dir" || command === "project_workspace_root"
                ? `${process.cwd()}\n`
                : command === "workspace_tree"
                  ? {
                      path: params.path || process.cwd(),
                      entries: [
                        {
                          name: "README.md",
                          path: `${params.path || process.cwd()}/README.md`,
                          is_directory: false,
                          size: Buffer.byteLength(workspaceFile),
                        },
                        {
                          name: "mobile-preview.png",
                          path: `${params.path || process.cwd()}/mobile-preview.png`,
                          is_directory: false,
                          size: Buffer.from(workspacePreviewPng, "base64")
                            .length,
                        },
                      ],
                    }
                  : command === "workspace_read_file_chunk"
                    ? {
                        content_base64:
                          String(params.args?.[0]) === "mobile-preview.png"
                            ? workspacePreviewPng
                            : "",
                        offset: Number(params.args?.[1] || 0),
                        eof: true,
                        size: Buffer.from(workspacePreviewPng, "base64").length,
                      }
                    : command === "workspace_read_text_file"
                      ? {
                          content: workspaceFile,
                          revision: workspaceRevision,
                          editable: true,
                          truncated: false,
                          size: Buffer.byteLength(workspaceFile),
                        }
                      : command === "workspace_write_text_file"
                        ? (() => {
                            if (
                              !forcedFileConflict &&
                              String(params.stdin ?? "").includes(
                                "MOBILE_FORCE_CONFLICT",
                              )
                            ) {
                              forcedFileConflict = true;
                              workspaceRevision = `mock-external-revision-${Date.now()}`;
                            }
                            if (params.args?.[1] !== workspaceRevision)
                              throw new Error("文件版本冲突");
                            workspaceFile = String(params.stdin ?? "");
                            workspaceRevision = `mock-revision-${Date.now()}`;
                            return {
                              revision: workspaceRevision,
                              size: Buffer.byteLength(workspaceFile),
                            };
                          })()
                        : command === "git_branch"
                          ? "codex/mobile-workflow\n"
                          : command === "git_status_porcelain_z"
                            ? mockGitState === "working"
                              ? " M README.md\0?? mobile-new.ts\0"
                              : mockGitState === "staged"
                                ? "M  README.md\0A  mobile-new.ts\0"
                                : ""
                            : command === "git_diff_working"
                              ? mockGitState === "working"
                                ? mockGitDiff
                                : ""
                              : command === "git_diff_staged"
                                ? mockGitState === "staged"
                                  ? mockGitDiff
                                  : ""
                                : command === "git_diff_last_commit"
                                  ? mockGitState === "committed"
                                    ? mockGitDiff
                                    : ""
                                  : command === "git_add_all"
                                    ? (() => {
                                        mockGitState = "staged";
                                        return "";
                                      })()
                                    : command === "git_generate_commit_message"
                                      ? {
                                          success: mockGitState === "staged",
                                          message: "Update mobile workflow",
                                          error:
                                            mockGitState === "staged"
                                              ? undefined
                                              : "No staged changes",
                                        }
                                      : command === "git_commit"
                                        ? (() => {
                                            mockGitState = "committed";
                                            return `[codex/mobile-workflow abc1234] ${String(params.args?.[1] || "Update files")}\n`;
                                          })()
                                        : command === "ls_dirs" ||
                                            command === "ls_skills"
                                          ? []
                                          : "";
            send({
              id,
              result: { success: true, exit_code: 0, stdout, stderr: "" },
            });
          } catch (error) {
            send({
              id,
              error: {
                code: -32009,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        } else if (method === "attachment/save") {
          send({
            id,
            result: {
              path: `/tmp/kcoder-mobile-mock/${String(params.filename || "attachment")}`,
            },
          });
        } else if (method === "gateway/attachments/retain") {
          send({
            id,
            result: {
              retained: true,
              paths: Array.isArray(params.paths) ? params.paths : [],
            },
          });
        } else if (method === "attachment/read") {
          const png =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
          send({
            id,
            result: {
              contentBase64: png,
              size: Buffer.from(png, "base64").length,
            },
          });
        } else if (method === "attachment/read/chunk") {
          const bytes = Buffer.from("mock attachment");
          const offset = Math.max(0, Number(params.offset) || 0);
          const length = Math.max(
            1,
            Math.min(512 * 1024, Number(params.length) || 512 * 1024),
          );
          const chunk = bytes.subarray(offset, offset + length);
          send({
            id,
            result: {
              contentBase64: chunk.toString("base64"),
              offset,
              size: chunk.length,
              totalSize: bytes.length,
              eof: offset + chunk.length >= bytes.length,
            },
          });
        } else if (method === "terminal/start") {
          const sessionId = `terminal-${randomUUID().slice(0, 8)}`;
          terminalSessions.set(sessionId, { sequence: 0, transcript: "" });
          send({
            id,
            result: { session_id: sessionId, cwd: params.cwd || process.cwd() },
          });
          const terminal = terminalSessions.get(sessionId);
          const data = "\u001b[1;32mMock terminal ready\u001b[0m\r\n$ ";
          terminal.sequence += 1;
          terminal.transcript += data;
          send({
            method: "terminal/output",
            params: {
              session_id: sessionId,
              sequence: terminal.sequence,
              data,
            },
          });
        } else if (method === "terminal/list") {
          send({
            id,
            result: {
              sessions: [...terminalSessions].map(([session_id, terminal]) => ({
                session_id,
                cwd: process.cwd(),
                rows: 24,
                cols: 80,
                through_sequence: terminal.sequence,
                truncated: false,
              })),
            },
          });
        } else if (method === "terminal/attach") {
          if (!terminalSessions.has(params.session_id))
            send({
              id,
              error: { code: -32004, message: "terminal session not found" },
            });
          else {
            const terminal = terminalSessions.get(params.session_id);
            send({
              id,
              result: {
                session_id: params.session_id,
                cwd: process.cwd(),
                rows: params.rows || 24,
                cols: params.cols || 80,
                transcript: terminal.transcript,
                through_sequence: terminal.sequence,
                truncated: false,
              },
            });
          }
        } else if (method === "terminal/write") {
          if (!terminalSessions.has(params.session_id))
            send({
              id,
              error: { code: -32004, message: "terminal session not found" },
            });
          else {
            send({ id, result: { accepted: true } });
            const terminal = terminalSessions.get(params.session_id);
            for (const data of [
              String(params.data || ""),
              ...(/\r|\n/.test(String(params.data || ""))
                ? ["MOBILE_TERMINAL_OK\r\n$ "]
                : []),
            ]) {
              terminal.sequence += 1;
              terminal.transcript += data;
              send({
                method: "terminal/output",
                params: {
                  session_id: params.session_id,
                  sequence: terminal.sequence,
                  data,
                },
              });
            }
          }
        } else if (method === "terminal/resize")
          send({
            id,
            result: {
              resized: terminalSessions.has(params.session_id),
              rows: params.rows,
              cols: params.cols,
            },
          });
        else if (method === "terminal/close") {
          terminalSessions.delete(params.session_id);
          send({ id, result: { closed: true } });
        } else if (method === "browser/start" && channel === "browser") {
          const sessionId = `browser-${randomUUID().slice(0, 8)}`;
          browserSessions.set(sessionId, {
            url: params.url,
            width: params.width,
            height: params.height,
            history: [params.url],
            historyIndex: 0,
          });
          send({ id, result: { session_id: sessionId } });
        } else if (method === "browser/action" && channel === "browser") {
          const session = browserSessions.get(params.session_id);
          if (!session)
            send({
              id,
              error: { code: -32004, message: "browser session not found" },
            });
          else {
            if (params.action === "navigate") {
              session.history = session.history.slice(
                0,
                session.historyIndex + 1,
              );
              session.history.push(params.url);
              session.historyIndex = session.history.length - 1;
              session.url = params.url;
            }
            if (params.action === "back" && session.historyIndex > 0) {
              session.historyIndex -= 1;
              session.url = session.history[session.historyIndex];
            }
            if (
              params.action === "forward" &&
              session.historyIndex + 1 < session.history.length
            ) {
              session.historyIndex += 1;
              session.url = session.history[session.historyIndex];
            }
            if (params.action === "resize") {
              session.width = params.width;
              session.height = params.height;
            }
            send({ id, result: { success: true } });
          }
        } else if (method === "browser/screenshot" && channel === "browser") {
          const session = browserSessions.get(params.session_id);
          if (!session)
            send({
              id,
              error: { code: -32004, message: "browser session not found" },
            });
          else {
            const width = Number(session.width || 390);
            const height = Number(session.height || 640);
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f7f7f7"/><text x="24" y="48" font-family="sans-serif" font-size="22" fill="#111">KCoder Browser</text><text x="24" y="82" font-family="sans-serif" font-size="14" fill="#555">${String(session.url).replace(/[<>&]/g, "")}</text></svg>`;
            send({
              id,
              result: {
                data_base64: Buffer.from(svg).toString("base64"),
                mime_type: "image/svg+xml",
                width,
                height,
                page: {
                  url: session.url,
                  title: "KCoder Browser",
                  canGoBack: session.historyIndex > 0,
                  canGoForward:
                    session.historyIndex + 1 < session.history.length,
                },
              },
            });
          }
        } else if (method === "browser/close" && channel === "browser") {
          browserSessions.delete(params.session_id);
          send({ id, result: { closed: true } });
        } else if (method === "thread/resume") {
          socket.threadId = params.threadId;
          send({
            id,
            result: {
              thread: {
                id: params.threadId,
                ...(String(params.threadId || "").includes("archived")
                  ? { archivedAt: "2026-07-29T00:00:00Z" }
                  : {}),
              },
            },
          });
        } else if (method === "thread/start") {
          const threadId = `thread-${randomUUID().slice(0, 8)}`;
          socket.threadId = threadId;
          send({ id, result: { thread: { id: threadId } } });
          send({
            method: "thread/started",
            params: { threadId, thread: { id: threadId } },
          });
        } else if (method === "turn/start") {
          if (activeTurn) {
            send({
              id,
              error: { code: -32003, message: "Turn already running" },
            });
            continue;
          }
          const turnId = `turn-${randomUUID().slice(0, 8)}`;
          const itemId = `item-${randomUUID().slice(0, 8)}`;
          const threadId = params.threadId || socket.threadId;
          const turn = { turnId, itemId, threadId, timers: new Set() };
          activeTurn = turn;
          send({ id, result: { turn: { id: turnId, threadId } } });
          send({
            method: "turn/started",
            params: { threadId, turnId, turn: { id: turnId, threadId } },
          });
          send({
            method: "item/started",
            params: {
              threadId,
              turnId,
              item: { id: itemId, type: "agentMessage" },
            },
          });
          const prompt = params.input?.[0]?.text || "这条消息";
          if (prompt.includes("MOBILE_APPROVAL")) {
            const requestId = nextInteractionId++;
            const approvalId = `approval-${requestId}`;
            pendingServerRequests.set(requestId, {
              kind: "approval",
              identity: approvalId,
              turn,
            });
            send({
              jsonrpc: "2.0",
              id: requestId,
              method: "approval/request",
              params: {
                approvalId,
                reason: "需要运行移动端审批测试命令",
                action: { type: "command", command: "echo MOBILE_APPROVAL" },
                availableDecisions: [
                  "accept",
                  "accept_for_session",
                  "decline",
                  "cancel",
                ],
              },
            });
            continue;
          }
          if (prompt.includes("MOBILE_QUESTION")) {
            const requestId = nextInteractionId++;
            const questionId = `question-${requestId}`;
            pendingServerRequests.set(requestId, {
              kind: "question",
              identity: questionId,
              turn,
            });
            send({
              jsonrpc: "2.0",
              id: requestId,
              method: "question/request",
              params: {
                questionId,
                questions: [
                  {
                    id: "deployment",
                    header: "部署方式",
                    prompt: "选择本次移动端验证方式",
                    options: [
                      {
                        label: "自动验证",
                        value: "automatic",
                        description: "由 E2E 自动提交回答",
                      },
                      { label: "手动验证", value: "manual" },
                    ],
                    allowsFreeform: true,
                    multiSelect: false,
                  },
                ],
              },
            });
            continue;
          }
          const mockChecklist = Array.from(
            { length: 18 },
            (_, index) =>
              `- 移动端验证记录 ${String(index + 1).padStart(2, "0")}`,
          ).join("\n");
          const chunks = [
            `已连接当前虚拟机。\n\n`,
            `我收到了：“${prompt}”。`,
            `\n\n${mockChecklist}\n\n[打开 README 第一行](README.md:1:1)\n\n也可以点 \`README.md:2\`。`,
          ];
          chunks.forEach((text, index) =>
            schedule(
              turn,
              () =>
                send({
                  method: "item/delta",
                  params: { threadId, turnId, itemId, delta: { text } },
                }),
              250 + index * 380,
            ),
          );
          schedule(turn, () => completeMockTurn(turn, ""), 1500);
        } else if (method === "turn/interrupt") {
          const matches =
            activeTurn &&
            activeTurn.threadId === (params.threadId || socket.threadId) &&
            activeTurn.turnId === params.turnId;
          const interrupted = matches ? clearActiveTurn() : null;
          send({ id, result: { interrupted: Boolean(interrupted) } });
          if (interrupted)
            send({
              method: "turn/completed",
              params: {
                threadId: interrupted.threadId,
                turnId: interrupted.turnId,
                turn: {
                  id: interrupted.turnId,
                  threadId: interrupted.threadId,
                  status: "interrupted",
                },
              },
            });
        } else if (id !== undefined)
          send({
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
      }
    } catch {
      stop();
      if (!socket.destroyed) socket.destroy();
    }
  });
  if (buffered.length) socket.emit("data", Buffer.alloc(0));
  socket.on("end", stop);
  socket.on("close", stop);
  socket.on("error", stop);
}

server.on("upgrade", async (request, socket, head) => {
  const guard = watchWebSocketUpgrade(socket);
  let selectedBroker = null;
  let brokerAttached = false;
  try {
    const authority = request.headers.host;
    const origin = request.headers.origin;
    const requestUrl = new URL(request.url, "http://localhost");
    const channel = requestUrl.searchParams.get("channel") || "runtime";
    const workspacePath = requestUrl.searchParams.get("workspace") || undefined;
    const target = serversById.get(
      requestUrl.searchParams.get("server") || servers[0].id,
    );
    const explicitBearer = bearerValue(request);
    const hasMobileProtocol = String(request.headers['sec-websocket-protocol'] || '').split(',').some(value => value.trim().startsWith('kcoder-session.'));
    const headerSessionId = request.headers.authorization !== undefined ? explicitBearer : (hasMobileProtocol ? null : browserCookies.read(request));
    const protocolCredential = websocketSessionCredential(request);
    const protocolSessionId = protocolCredential.id;
    const headerSession = headerSessionId
      ? await authSessionById(headerSessionId)
      : null;
    const protocolSession = protocolSessionId
      ? await authSessionById(protocolSessionId)
      : null;
    const authSessionId = headerSession
      ? headerSessionId
      : protocolSession
        ? protocolSessionId
        : null;
    const credentialsConflict = explicitBearer && protocolSessionId && explicitBearer !== protocolSessionId;
    const authSession = credentialsConflict || protocolCredential.invalid ? null :
      headerSession ||
      protocolSession ||
      (!authRequired ? await authSessionById(null) : null);
    const mobileBearerSession = Boolean(bearerValue(request) && headerSession);
    const mobileWebSession = Boolean(protocolSessionId && protocolSession);
    if (requestPublicPrefix(request) && !publicAccess.track(publicRequestSurface(requestUrl.pathname, authSession, mobileBearerSession || mobileWebSession), socket)) { socket.destroy(); return; }
    const allowedAuthority = isAllowedAuthority(authority);
    const trustedOrigin =
      (!origin && (!authRequired || mobileBearerSession)) ||
      isAllowedOrigin(origin, authority) ||
      (mobileWebSession && isAllowedMobileWebOrigin(origin));
    if (!guard.isAlive()) { socket.destroy(); return; }
    const viteRenderer = viteFor(request), mobilePreview = mobileDevFor(request);
    const devUpgrade = mobilePreview?.isUpgrade(requestUrl.pathname);
    if (devUpgrade || viteRenderer?.isUpgrade(requestUrl.pathname)) {
      if (!authSession || !allowedAuthority || !trustedOrigin || !origin ||
          !isGatewayBrowserAdminRequest(request, authSession, servers, authRequired)) { socket.destroy(); return; }
      if (authSessionId) {
        const sockets = sessionSockets.get(authSessionId) ?? new Set();
        sockets.add(socket); sessionSockets.set(authSessionId, sockets);
        socket.once('close', () => { sockets.delete(socket); if (!sockets.size) sessionSockets.delete(authSessionId); });
      }
      if (devUpgrade) mobilePreview.upgrade(request, socket, head, requestUrl);
      else viteRenderer.upgrade(request, socket, head);
      return;
    }
    const loginOwner = authRequired ? (authSession?.stableLoginOwner || authSessionId) : ANONYMOUS_LOGIN_OWNER;
    // An isolated target only serves authenticated login contexts; a socket
    // bound to an anonymous context is rejected instead of falling back to a
    // shared app-server.
    if (
      target.security &&
      (!loginOwner || !loginContexts.identity(loginOwner, target.id))
    ) {
      socket.destroy();
      return;
    }
    if (
      requestUrl.pathname !== "/rpc" ||
      requestUrl.searchParams.get("token") !== gatewayToken ||
      !authSession ||
      !target ||
      !authSession.allowedServerIds.has(target.id) ||
      !allowedAuthority ||
      !trustedOrigin ||
      !["runtime", "browser", "ssh-terminal"].includes(channel) ||
      (channel === "ssh-terminal" && !servers.every(item => authSession.allowedServerIds.has(item.id))) ||
      (channel === "browser" &&
        !runtimeCapabilities(target.runtime).browserSessions)
    ) {
      socket.destroy();
      return;
    }
    if (!request.headers["sec-websocket-key"]) { socket.destroy(); return; }
    const atCapacity = () => {
      const refusal = connectionCapacityRefusal({
      channel,
        browserSessionsAvailable: runtimeCapabilities(target.runtime).browserSessions === true,
        activeConnections, maxConnections, activeBrowserConnections, maxBrowserConnections,
    });
      if (!refusal) return false;
      connectionRefusals[refusal.reason] += 1;
      // Counts only: no token, session, account, or request data.
      process.stderr.write(
        `${JSON.stringify(connectionRefusalDiagnostic(refusal, connectionRefusals))}\n`,
      );
      return true;
    };
    if (atCapacity()) {
      socket.destroy();
      return;
    }
    selectedBroker = mock || channel === "ssh-terminal"
      ? null
      : await reusableWorkspaceBroker(target, workspacePath, loginOwner, requestUrl.searchParams.get('nativeManagement') === '1', () => !guard.isAlive());
    if (!guard.isAlive()) { socket.destroy(); return; }
    if (atCapacity()) { socket.destroy(); return; }
    if (!acceptWebSocket(request, socket)) {
      socket.destroy();
      return;
    }
    if (target.security && loginOwner && channel !== "ssh-terminal") {
      const sockets = contextSockets.get(contextSocketKey(loginOwner, target.id)) ?? new Set();
      sockets.add(socket);
      contextSockets.set(contextSocketKey(loginOwner, target.id), sockets);
      socket.on("close", () => {
        sockets.delete(socket);
        if (!sockets.size) contextSockets.delete(contextSocketKey(loginOwner, target.id));
      });
    }
    if (authSession?.deviceId) {
      const family = mobileDeviceFamilies.get(authSession.deviceId);
      family?.sockets.add(socket); socket.on('close', () => family?.sockets.delete(socket));
    }
    if (authSessionId) {
      const sockets = sessionSockets.get(authSessionId) ?? new Set();
      sockets.add(socket);
      sessionSockets.set(authSessionId, sockets);
      socket.on("close", () => {
        sockets.delete(socket);
        if (sockets.size === 0) sessionSockets.delete(authSessionId);
      });
    }
    activeConnections += 1;
    if (channel === "browser") activeBrowserConnections += 1;
    let released = false;
    socket.on("close", () => {
      if (!released) {
        released = true;
        activeConnections -= 1;
        if (channel === "browser") activeBrowserConnections -= 1;
      }
    });
    if (channel === "ssh-terminal") bridgeSshTerminal(socket, head, { store: sshConnections, frame, decodeFrames });
    else if (mock) runMock(socket, head, channel, target, workspacePath);
    else {
      bridgeWorkspaceAppServer(socket, target, channel, selectedBroker, head,
        isAllowedOrigin(origin, authority) ? new URL(origin).origin
          : [...publicOrigins].find(value => new URL(value).host === authority && value.startsWith("https:"))
            ?? (publicOrigins.size === 1 ? [...publicOrigins][0] : `http://${authority}`), loginOwner, authSession, workspacePath, authSessionId);
      brokerAttached = true;
    }
  } catch {
    socket.destroy();
  } finally {
    if (selectedBroker && !brokerAttached) scheduleWorkspaceBrokerIdle(selectedBroker.key, selectedBroker.broker);
    guard.release();
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  liveRelay.close();
  await Promise.all([localVite?.close(), relayVite?.close()]);
  await mobilePeerGateway.close();
  await migrationSourceSessions.close();
  await Promise.allSettled([...nativeRemoteEndpointOwners].map(closeOwner => closeOwner()));
  trustedRetentionAppServer?.close();
  resourceBudget.stop();
  mcpCallbacks.close();
  server.close();
  await channels.close();
  for (const socket of openSockets) socket.destroy();
  const waitUntil = async (deadline) => {
    while (appServerChildren.size && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  };
  // Closing the real stdin lets app-server settle tasks and reap Node on all
  // platforms. Windows process.kill() does not deliver a graceful SIGTERM.
  for (const child of appServerChildren) {
    if (child.stdin.writable && !child.stdin.destroyed) child.stdin.end();
  }
  await waitUntil(Date.now() + 1_500);
  for (const child of appServerChildren) {
    if (!channelAppServerChildren.has(child)) child.kill("SIGTERM");
  }
  await waitUntil(Date.now() + 400);
  for (const child of appServerChildren) {
    if (!channelAppServerChildren.has(child)) child.kill("SIGKILL");
  }
  if ([...appServerChildren].some(child => channelAppServerChildren.has(child))) {
    await waitUntil(Date.now() + 15_000);
    for (const child of appServerChildren) child.kill("SIGKILL");
  }
  await settleSourceConnectivityLaunch(nativeConnectivityStartupBinding, appServerChildren);
  trustedWindowsComponentImage?.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

server.listen(configuredPort, host, () => {
  void channels.start().catch(() => console.warn('CHANNEL_STARTUP_FAILED'));
  void retentionRevocationPump.drain().catch(() => {});
  const address = server.address();
  if (typeof address === "object" && address) listeningPort = address.port;
  void ownedRelay?.connect(`http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${listeningPort}`).catch(() => console.warn('GATEWAY_RELAY_CONNECTION_UNAVAILABLE'));
  mobileConnectionRoutesProvider?.setListeningPort(listeningPort);
  if (!mock && nativeConnectivityStartupBinding) {
    // Only the verified, explicitly configured local channel target starts
    // before a browser opens. Normal broker negotiation owns the same child.
    for (const target of servers) {
      if (target.transport !== "local" || target.security ||
          !(trustedRetentionAppServer?.matches(target) || trustedWindowsComponentImage?.matches(target))) continue;
      void probeServerHealth(target).catch(() => {});
    }
  }
  console.log(`KCoder Studio: http://${host.includes(":") ? `[${host}]` : host}:${listeningPort}`);
  if (authRequired) {
    const localLoginUrl = loginUrl(localAccessBase(), authToken);
    const publicLoginUrl = publicAccessUrl ? loginUrl(publicAccessUrl, authToken) : null;
    const primaryLoginUrl = publicLoginUrl || localLoginUrl;
    console.log(`浏览器登录链接（本机）: ${localLoginUrl}`);
    if (publicLoginUrl) console.log(`浏览器登录链接（公网中继，手机可访问）: ${publicLoginUrl}`);
    void writeStudioLoginUrl(primaryLoginUrl, { dataDirectory: accountStorageRoot }).then(({ path }) => {
      console.log(`浏览器登录链接已保存: ${path}`);
    }).catch(error => {
      console.error(`无法安全保存浏览器登录链接: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  console.log(`Web root: ${webRoot}`);
  console.log(`Mobile Web (local listener): http://${host.includes(":") ? `[${host}]` : host}:${listeningPort}/mobile/`);
  if (mock) console.log("JavaScript mock /rpc gateway enabled");
  else
    console.log(
      `Rust app-server gateway: ${appServerBin}${scenario ? ` --scenario ${scenario}` : ""}`,
    );
  console.log(
    `Configured servers: ${servers.map((server) => `${server.id}(${server.runtime}/${server.transport})`).join(", ")}`,
  );
});
const retentionRevocationTimer = setInterval(() => { void retentionRevocationPump.drain().catch(() => {}); }, 30_000);
retentionRevocationTimer.unref();
server.once('close', () => clearInterval(retentionRevocationTimer));
