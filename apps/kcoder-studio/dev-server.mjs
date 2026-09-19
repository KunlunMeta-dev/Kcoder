import { McpOAuthCallbackRegistry } from "./src/mcp-oauth-callback-registry.js";
import { authenticatedAccountProcess } from "./src/account-process.js";
import { createAccountCredentialStore } from "./src/account-credentials.js";
import { administerAccount } from "./src/account-administration.js";
import {
  ANONYMOUS_LOGIN_OWNER,
  authorityIdFor,
  createAccountLoginContexts,
} from "./src/account-login-context.js";
import { spawn } from "node:child_process";
import { MockThreadStore } from "./src/mock-thread-store.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, realpathSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadResourcePolicy } from "./src/resource-policy.js";
import { GatewayResourceBudget } from "./src/gateway-resource-budget.js";
import { WebSocketLivenessLease } from "./src/websocket-liveness-lease.js";
import { BoundedJsonlDecoder } from "./src/bounded-jsonl-decoder.js";
import { pendingWorkIdleDelay, releaseIdleBrokers } from "./src/workspace-broker-release.js";
import { inspectGatewayChannelMessage } from "./src/gateway-channel.js";
import { createRuntimeTargetAdapter } from "./src/runtime-target-adapter.js";
import {
  appServerEnvironment,
  launchSpec,
  loadServers,
  normalizeServer,
  publicServer,
  runtimeCapabilities,
  storedServer,
} from "./src/server-config.js";
import { WorkspaceAppServerBroker } from "./src/workspace-app-server-broker.js";
import { createSshConnectionStore } from "./src/ssh-terminal-store.js";
import { bridgeSshTerminal } from "./src/ssh-channel.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(root, "../..");
const webRoot = resolve(
  process.env.KCODER_STUDIO_WEB_ROOT || resolve(root, "renderer/dist"),
);
const host = process.env.KCODER_STUDIO_HOST || "127.0.0.1";
const configuredPort = Number(process.env.KCODER_STUDIO_PORT || 4173);
if (
  !Number.isInteger(configuredPort) ||
  configuredPort < 0 ||
  configuredPort > 65_535
) {
  throw new Error("KCODER_STUDIO_PORT must be an integer from 0 to 65535");
}
let listeningPort = configuredPort;
if (!["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(host))
  throw new Error("KCoder Studio host must be loopback or 0.0.0.0");
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
const authToken = process.env.KCODER_STUDIO_AUTH_TOKEN || "";
const authRequired = Boolean(authToken);
const desktopHost = process.env.KCODER_STUDIO_DESKTOP_HOST === "1";
const publicOrigins = new Set(
  (process.env.KCODER_STUDIO_PUBLIC_ORIGINS || "")
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
        throw new Error(`Invalid KCODER_STUDIO_PUBLIC_ORIGINS entry: ${value}`);
      }
      return parsed.origin;
    }),
);
const publicAuthorities = new Set(
  [...publicOrigins].map((value) => new URL(value).host),
);
const publicProxyPorts = new Set(
  [...publicOrigins].map((value) => new URL(value).port).filter(Boolean),
);
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
  "content-security-policy": contentSecurityPolicy,
};
if (host === "0.0.0.0" && !authRequired) {
  throw new Error(
    "KCODER_STUDIO_AUTH_TOKEN is required when listening on 0.0.0.0",
  );
}
const gatewayToken = authRequired ? "cookie-auth" : randomUUID();
const authSessions = new Map();
const sessionSockets = new Map();
const loginAttempts = new Map();
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
let activeConnections = 0;
let activeBrowserConnections = 0;
const mock = process.env.KCODER_STUDIO_MOCK === "1";
const appServerBin =
  process.env.KCODER_STUDIO_KCODER_BIN ||
  resolve(repoRoot, "target/debug/kcoder");
const workspace = resolve(process.env.KCODER_STUDIO_WORKSPACE || repoRoot);
mkdirSync(workspace, { recursive: true });
const scenario = process.env.KCODER_STUDIO_SCENARIO || "";
const serverDefaults = {
  repoRoot,
  appServerBin,
  workspace,
  chromiumBin: process.env.KCODER_STUDIO_CHROMIUM_BIN,
  chromiumNoSandbox: process.env.KCODER_STUDIO_CHROMIUM_NO_SANDBOX === "1",
};
let servers = await loadServers({ env: process.env, ...serverDefaults });
for (const configuredServer of servers) {
  if (configuredServer.transport !== "local") continue;
  const workspaceInfo = await stat(configuredServer.cwd).catch(() => null);
  if (!workspaceInfo?.isDirectory())
    throw new Error(
      `local runtime target workspace is not an existing directory: ${configuredServer.cwd}`,
    );
}
let serversById = new Map(servers.map((server) => [server.id, server]));
const serversStore = process.env.KCODER_STUDIO_SERVERS_STORE
  ? resolve(process.env.KCODER_STUDIO_SERVERS_STORE)
  : null;
const sshConnections = createSshConnectionStore({
  filePath: serversStore ? resolve(dirname(serversStore), "ssh_connections.jsonc") : undefined,
});
const accountStorageRoot = serversStore ? dirname(serversStore) : resolve(homedir(), '.config', 'kcoder-studio');
const accountCredentials = createAccountCredentialStore({
  filePath: resolve(accountStorageRoot, 'account_credentials.json'),
  keyPath: resolve(accountStorageRoot, '.account-credential-key'),
});
await accountCredentials.load();
const loginContexts = createAccountLoginContexts();
const contextSockets = new Map();
const accountLoginAttempts = new Map();
const publicAccountServer = (target, loginOwner) => {
  const principal = loginOwner ? loginContexts.identity(loginOwner, target.id) : null;
  return { ...publicServer(target),
    ...(target.transport === "ssh" ? { authorityId: authorityIdFor(target) } : {}),
    ...(principal ? { accountIdentity: principal } : {}) };
};
function requestLoginOwner(request, session) {
  if (!authRequired) return ANONYMOUS_LOGIN_OWNER;
  const id = authenticatedSessionId(request);
  return session && id ? id : null;
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
const appServerChildTargets = new Map();
const workspaceAppServerBrokers = new Map();
const resourceBudgetBrokers = new Set();
const resourcePolicy = await loadResourcePolicy(
  process.env.KCODER_STUDIO_RESOURCE_POLICY_FILE || resolve(
    serversStore ? dirname(serversStore) : resolve(homedir(), '.config', 'kcoder-studio'), 'resource_policy.jsonc'),
  { required: Boolean(process.env.KCODER_STUDIO_RESOURCE_POLICY_FILE) },
);
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

function waitForAppServerClose(child, timeoutMs) {
  if (!appServerChildren.has(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      child.off("close", closed);
      resolveWait(false);
    }, timeoutMs);
    timer.unref?.();
    const closed = () => {
      clearTimeout(timer);
      resolveWait(true);
    };
    child.once("close", closed);
  });
}

async function terminateAppServerChild(child) {
  if (!appServerChildren.has(child)) return;
  if (child.stdin.writable && !child.stdin.destroyed) child.stdin.end();
  child.kill("SIGTERM");
  if (await waitForAppServerClose(child, 750)) return;
  child.kill("SIGKILL");
  await waitForAppServerClose(child, 750);
}

async function terminateServerChildren(serverId) {
  const children = [...appServerChildTargets.entries()]
    .filter(([, ownership]) => ownership?.serverId === serverId)
    .map(([child]) => child);
  await Promise.all(children.map(terminateAppServerChild));
}

// Logout/switch only reclaims the processes of one login context; other
// accounts on the same target keep running.
async function terminateContextChildren(serverId, loginOwner) {
  const children = [...appServerChildTargets.entries()]
    .filter(([, ownership]) => ownership?.serverId === serverId && ownership.loginOwner === loginOwner)
    .map(([child]) => child);
  await Promise.all(children.map(terminateAppServerChild));
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
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
};

async function collectStaticHtmlRoutes(directory = webRoot, prefix = "") {
  const routes = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (
        entry.name === "assets" ||
        entry.name === "_expo" ||
        entry.name.startsWith(".")
      )
        continue;
      routes.push(
        ...(await collectStaticHtmlRoutes(
          resolve(directory, entry.name),
          `${prefix}${entry.name}/`,
        )),
      );
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      routes.push(`${prefix}${entry.name}`);
    }
  }
  return routes;
}

function staticRouteExpression(relativeFile) {
  let route = relativeFile.replaceAll("\\", "/").replace(/\.html$/, "");
  route = route === "index" ? "" : route.replace(/\/index$/, "");
  const pattern = route
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      /^\[[^/]+\]$/.test(segment)
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${pattern}$`);
}

let staticHtmlRoutesPromise;
async function staticRouteFile(relative) {
  const directHtml = resolve(webRoot, `${relative}.html`);
  try {
    if ((await stat(directHtml)).isFile()) return directHtml;
  } catch {
    // Dynamic static routes are matched below using Expo Router [param] templates.
  }
  staticHtmlRoutesPromise ??= collectStaticHtmlRoutes().catch(() => []);
  const route = relative.replace(/^\/+|\/+$/g, "");
  const matched = (await staticHtmlRoutesPromise).find((file) =>
    staticRouteExpression(file).test(route),
  );
  return matched ? resolve(webRoot, matched) : null;
}

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function bearerValue(request) {
  const match = String(request.headers.authorization || "").match(
    /^Bearer ([A-Za-z0-9-]{32,128})$/,
  );
  return match?.[1] || null;
}

function removeExpiredAuthSessions(now = Date.now()) {
  for (const [id, session] of authSessions) {
    if (session.expiresAt <= now) deleteAuthSession(id);
  }
}

function deleteAuthSession(id) {
  const session = authSessions.get(id);
  if (session?.expiryTimer) clearTimeout(session.expiryTimer);
  authSessions.delete(id);
  const sockets = sessionSockets.get(id);
  sessionSockets.delete(id);
  for (const socket of sockets ?? []) socket.destroy();
}

function authenticatedSessionId(request) {
  return bearerValue(request) || cookieValue(request, "kcoder_studio_session");
}

function authSessionById(id) {
  if (!authRequired)
    return { allowedServerIds: new Set(servers.map((item) => item.id)) };
  const now = Date.now();
  removeExpiredAuthSessions(now);
  const session = id ? authSessions.get(id) : null;
  if (!session || session.expiresAt <= now) return null;
  return session;
}

function authenticatedSession(request) {
  return authSessionById(authenticatedSessionId(request));
}

function websocketSessionId(request) {
  for (const protocol of String(
    request.headers["sec-websocket-protocol"] || "",
  ).split(",")) {
    const match = protocol
      .trim()
      .match(/^kcoder-session\.([A-Za-z0-9-]{32,128})$/);
    if (match) return match[1];
  }
  return null;
}

function createAuthSession() {
  removeExpiredAuthSessions();
  while (authSessions.size >= maxAuthSessions)
    deleteAuthSession(authSessions.keys().next().value);
  const id = randomUUID();
  const session = {
    expiresAt: Date.now() + authSessionTtlMs,
    allowedServerIds: new Set(servers.map((item) => item.id)),
    expiryTimer: null,
  };
  authSessions.set(id, session);
  session.expiryTimer = setTimeout(
    () => deleteAuthSession(id),
    authSessionTtlMs,
  );
  session.expiryTimer.unref?.();
  return { id, session };
}

function tokenMatches(value) {
  if (!authRequired) return true;
  const expected = createHash("sha256").update(authToken).digest();
  const actual = createHash("sha256").update(value).digest();
  return timingSafeEqual(expected, actual);
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

async function requestBody(request, maxBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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

async function persistServers(values = servers) {
  if (!serversStore) return;
  await mkdir(dirname(serversStore), { recursive: true, mode: 0o700 });
  const temporary = `${serversStore}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(values.map(storedServer), null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, serversStore);
}

function refreshSessionServerAccess() {
  const currentIds = new Set(servers.map((item) => item.id));
  for (const session of authSessions.values())
    session.allowedServerIds = new Set(currentIds);
}

async function testServerConnection(
  target,
  { fresh = false, loginOwner, authentication } = {},
) {
  const key = workspaceBrokerKey(target);
  const sameContext = (candidate) =>
    target.security ? candidate.loginOwner === loginOwner : true;
  const broker =
    (fresh ? undefined : [...(workspaceAppServerBrokers.get(key) ?? [])].find(
      (candidate) => !candidate.closed && sameContext(candidate),
    )) ?? createWorkspaceBroker(target, undefined, key, { authentication, loginOwner });
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
    } else {
      removeWorkspaceBroker(key, broker);
      await terminateAppServerChild(broker.child);
    }
  }
}

function serverHealthSignature(target) {
  return target ? JSON.stringify(storedServer(target)) : "";
}

function updateServerHealth(
  target,
  startedAt,
  error = null,
  connection = null,
) {
  const result = {
    id: target.id,
    status: error ? "offline" : "online",
    latencyMs: Math.max(0, Date.now() - startedAt),
    checkedAt: Date.now(),
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
  serverHealth.set(target.id, {
    signature: serverHealthSignature(target),
    result,
  });
  return result;
}

async function probeServerHealth(target, loginOwner) {
  const signature = serverHealthSignature(target);
  const cached = serverHealth.get(target.id);
  if (
    cached?.signature === signature &&
    Date.now() - cached.result.checkedAt < serverHealthTtlMs
  ) {
    return cached.result;
  }
  // An isolated target without an authenticated login context is never
  // probed: saved credentials must not silently bring a target back online
  // after logout, and anonymous fallback to a shared app-server is forbidden.
  if (target.security && !loginOwner) {
    return {
      id: target.id,
      status: "offline",
      latencyMs: 0,
      checkedAt: Date.now(),
      error: "需要登录 KCoder 账号",
    };
  }
  if (target.security && !loginContexts.identity(loginOwner, target.id)) {
    return {
      id: target.id,
      status: "offline",
      latencyMs: 0,
      checkedAt: Date.now(),
      error: "需要登录 KCoder 账号",
    };
  }
  const existing = serverHealthInFlight.get(target.id);
  if (existing?.signature === signature) return existing.promise;
  const startedAt = Date.now();
  const promise = testServerConnection(target, { loginOwner })
    .then((connection) =>
      updateServerHealth(target, startedAt, null, connection),
    )
    .catch((error) => updateServerHealth(target, startedAt, error))
    .finally(() => {
      if (serverHealthInFlight.get(target.id)?.promise === promise)
        serverHealthInFlight.delete(target.id);
    });
  serverHealthInFlight.set(target.id, { signature, promise });
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

function safeReturnTo(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n]/.test(value)
  )
    return null;
  try {
    const parsed = new URL(value, "http://kcoder.local");
    if (
      parsed.origin !== "http://kcoder.local" ||
      parsed.pathname === "/login" ||
      parsed.pathname.startsWith("/login/")
    )
      return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function loginPage(error = "", returnTo = null) {
  const message = error ? `<p class="error">${error}</p>` : "";
  const returnInput = returnTo
    ? `<input name="returnTo" type="hidden" value="${escapeHtml(returnTo)}">`
    : "";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KCoder Studio 登录</title><style>body{margin:0;background:#111;color:#eee;font:14px system-ui;display:grid;place-items:center;min-height:100vh}.card{box-sizing:border-box;width:min(360px,calc(100vw - 40px));padding:28px;border:1px solid #333;border-radius:14px;background:#1b1b1b}h1{font-size:20px;margin:0 0 8px}p{color:#aaa}input,button{box-sizing:border-box;width:100%;padding:11px 12px;border-radius:8px;border:1px solid #444;background:#111;color:#fff}button{margin-top:12px;background:#e8e8e8;color:#111;border:0;font-weight:600;cursor:pointer}.error{color:#ff7777}</style><body><form class="card" method="post" action="/login"><h1>KCoder Studio</h1><p>请输入服务器访问令牌后进入远程工作台。</p>${message}${returnInput}<input name="token" type="password" autocomplete="current-password" autofocus required><button type="submit">登录</button></form></body></html>`;
}

function isAllowedAuthority(authority) {
  if (!authority) return false;
  if (publicAuthorities.has(authority)) return true;
  try {
    const parsed = new URL(`http://${authority}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      return false;
    const directPort = parsed.port ? Number(parsed.port) : 80;
    return directPort === listeningPort || publicProxyPorts.has(parsed.port);
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin, authority) {
  if (!origin || !authority) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.host !== authority) return false;
    if (publicAuthorities.has(authority))
      return publicOrigins.has(parsed.origin);
    return /^https?:$/.test(parsed.protocol) && isAllowedAuthority(authority);
  } catch {
    return false;
  }
}

function isAllowedMobileWebOrigin(origin) {
  if (!origin) return false;
  try {
    return mobileWebOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function isMobileApiPath(pathname) {
  return (
    pathname === "/api/mobile/session" ||
    pathname === "/api/servers" ||
    pathname === "/api/servers/status" ||
    pathname === "/api/servers/test" ||
    /^\/api\/servers\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(pathname)
  );
}

function applyMobileCors(request, response, pathname) {
  if (!isMobileApiPath(pathname) || !request.headers.origin)
    return { handled: false, allowed: true };
  let origin;
  try {
    origin = new URL(request.headers.origin).origin;
  } catch {
    return { handled: false, allowed: false };
  }
  const allowed =
    isAllowedOrigin(origin, request.headers.host) ||
    isAllowedMobileWebOrigin(origin);
  if (!allowed) {
    if (request.method === "OPTIONS") {
      jsonResponse(response, 403, {
        error: "Mobile Web origin is not allowed",
      });
      return { handled: true, allowed: false };
    }
    return { handled: false, allowed: false };
  }
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader(
    "access-control-allow-methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  response.setHeader(
    "access-control-allow-headers",
    "Authorization, Content-Type",
  );
  response.setHeader("access-control-max-age", "600");
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return { handled: true, allowed: true };
  }
  return { handled: false, allowed: true };
}

const mcpCallbacks = new McpOAuthCallbackRegistry();
const server = createServer(async (request, response) => {
  try {
    if (!isAllowedAuthority(request.headers.host)) {
      response.writeHead(421, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("Misdirected request");
      return;
    }
    const requestUrl = new URL(request.url, "http://localhost");
    const pathname = requestUrl.pathname;
    if (mcpCallbacks.handle(request, response)) return;
    const mobileCors = applyMobileCors(request, response, pathname);
    if (mobileCors.handled) return;
    if (!mobileCors.allowed) {
      jsonResponse(response, 403, {
        error: "Mobile Web origin is not allowed",
      });
      return;
    }
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
      let token = "";
      try {
        const payload = JSON.parse(await requestBody(request));
        token = typeof payload?.token === "string" ? payload.token : "";
      } catch {
        jsonResponse(response, 400, { error: "登录请求不是有效 JSON" });
        return;
      }
      if (!tokenMatches(token)) {
        recordLoginFailure(request);
        jsonResponse(response, 401, { error: "访问令牌不正确。" });
        return;
      }
      loginAttempts.delete(request.socket.remoteAddress || "unknown");
      const { id, session } = createAuthSession();
      const secure =
        process.env.KCODER_STUDIO_SECURE_COOKIE === "1" ? "; Secure" : "";
      const currentCookieId = cookieValue(request, "kcoder_studio_session");
      const preserveAuthenticatedHostCookie = Boolean(
        currentCookieId && authSessionById(currentCookieId),
      );
      jsonResponse(
        response,
        200,
        {
          accessToken: id,
          expiresAt: session.expiresAt,
          rpcToken: gatewayToken,
        },
        preserveAuthenticatedHostCookie
          ? {}
          : {
              // Preserve same-origin Mobile Web cookie authentication when no independent web-login session exists.
              "set-cookie": `kcoder_studio_session=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(authSessionTtlMs / 1000)}${secure}`,
            },
      );
      return;
    }
    if (pathname === "/api/mobile/session" && request.method === "DELETE") {
      const id = bearerValue(request);
      const session = id ? authSessions.get(id) : null;
      if (!id || !session || session.expiresAt <= Date.now()) {
        jsonResponse(response, 401, { error: "Authentication required" });
        return;
      }
      deleteAuthSession(id);
      const deletingCurrentCookie =
        cookieValue(request, "kcoder_studio_session") === id;
      response.writeHead(204, {
        "cache-control": "no-store",
        ...(deletingCurrentCookie
          ? {
              "set-cookie":
                "kcoder_studio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
            }
          : {}),
      });
      response.end();
      return;
    }
    if (authRequired && pathname === "/login") {
      if (request.method === "POST") {
        if (loginRateLimited(request)) {
          response.writeHead(429, loginHtmlHeaders);
          response.end(loginPage("尝试次数过多，请一分钟后重试。"));
          return;
        }
        const form = new URLSearchParams(await requestBody(request));
        const returnTo = safeReturnTo(form.get("returnTo"));
        if (tokenMatches(form.get("token") || "")) {
          loginAttempts.delete(request.socket.remoteAddress || "unknown");
          let id = form.get("renewSession") === "1" ? authenticatedSessionId(request) : null;
          const existing = id ? authSessionById(id) : null;
          if (existing) {
            clearTimeout(existing.expiryTimer);
            existing.expiresAt = Date.now() + authSessionTtlMs;
            existing.expiryTimer = setTimeout(() => deleteAuthSession(id), authSessionTtlMs);
            existing.expiryTimer.unref?.();
          } else {
            id = createAuthSession().id;
          }
          const secure =
            process.env.KCODER_STUDIO_SECURE_COOKIE === "1" ? "; Secure" : "";
          response.writeHead(303, {
            location: returnTo || "/",
            "set-cookie": `kcoder_studio_session=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(authSessionTtlMs / 1000)}${secure}`,
            "cache-control": "no-store",
            "x-kcoder-session-ttl-ms": String(authSessionTtlMs),
          });
          response.end();
          return;
        }
        recordLoginFailure(request);
        response.writeHead(401, loginHtmlHeaders);
        response.end(loginPage("访问令牌不正确。", returnTo));
        return;
      }
      response.writeHead(200, loginHtmlHeaders);
      response.end(
        loginPage("", safeReturnTo(requestUrl.searchParams.get("returnTo"))),
      );
      return;
    }
    if (authRequired && pathname === "/logout" && request.method === "POST") {
      const id = cookieValue(request, "kcoder_studio_session");
      if (id) deleteAuthSession(id);
      response.writeHead(303, {
        location: "/login",
        "set-cookie":
          "kcoder_studio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    const authSession = authenticatedSession(request);
    if (!authSession) {
      const navigation = request.headers.accept?.includes("text/html");
      const returnTo = navigation
        ? safeReturnTo(`${requestUrl.pathname}${requestUrl.search}`)
        : null;
      const loginLocation =
        returnTo && returnTo !== "/"
          ? `/login?returnTo=${encodeURIComponent(returnTo)}`
          : "/login";
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
    if (pathname === "/api/ssh-connections" || pathname.startsWith("/api/ssh-connections/")) {
      if (!servers.every(item => authSession.allowedServerIds.has(item.id))) {
        jsonResponse(response, 403, { error: "Full Gateway access required" });
        return;
      }
      try {
        if (pathname === "/api/ssh-connections" && request.method === "GET") {
          jsonResponse(response, 200, { connections: await sshConnections.list() });
          return;
        }
        if (!requireSameOriginMutation(request)) {
          jsonResponse(response, 403, { error: "Same-origin JSON request required" });
          return;
        }
        const id = pathname.slice("/api/ssh-connections/".length);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new Error("Invalid SSH connection ID");
        if (request.method === "PUT") {
          const profile = JSON.parse(await requestBody(request, 32 * 1024));
          if (profile.id !== id) throw new Error("SSH connection ID does not match");
          jsonResponse(response, 200, { connection: await sshConnections.upsert(profile) });
        } else if (request.method === "DELETE") {
          await sshConnections.delete(id);
          jsonResponse(response, 200, { ok: true });
        } else jsonResponse(response, 405, { error: "Method not allowed" });
      } catch {
        jsonResponse(response, 400, { error: "Unable to read or update SSH connections; check fields and Gateway storage permissions" });
      }
      return;
    }
    if (pathname === "/api/servers" && request.method === "GET") {
      const loginOwner = requestLoginOwner(request, authSession);
      const body = JSON.stringify({
        servers: servers
          .filter((item) => authSession.allowedServerIds.has(item.id))
          .map((item) => publicAccountServer(item, loginOwner)),
      });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
      return;
    }
    if (pathname === "/api/servers/status" && request.method === "GET") {
      const loginOwner = requestLoginOwner(request, authSession);
      const targets = servers.filter((item) =>
        authSession.allowedServerIds.has(item.id),
      );
      // In mock mode the WebSocket is the built-in app-server. Do not probe a live
      // command on disk, which would make test/demo UI report the available mock runtime as offline and disable input.
      const statuses = mock
        ? targets.map((item) => ({
            id: item.id,
            status: "online",
            latencyMs: 0,
            checkedAt: Date.now(),
          }))
        : await probeServerHealthBounded(targets, loginOwner);
      jsonResponse(response, 200, { statuses: statuses.map(item => ({ ...item,
        ...(loginOwner && loginContexts.identity(loginOwner, item.id)
          ? { accountIdentity: loginContexts.identity(loginOwner, item.id) } : {}) })) });
      return;
    }
    const accountAdministration = pathname.match(/^\/api\/servers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/accounts$/);
    if (accountAdministration && request.method === 'POST') {
      if (!requireSameOriginMutation(request)) {
        jsonResponse(response, 403, { error: 'Same-origin JSON request required' });
        return;
      }
      const target = serversById.get(accountAdministration[1]);
      if (!target?.security || !authSession.allowedServerIds.has(target.id)) {
        jsonResponse(response, 404, { error: 'KCoder account target is unavailable' });
        return;
      }
      try {
        let operation;
        try { operation = JSON.parse(await requestBody(request, 4 * 1024 * 1024)); }
        catch { throw new Error('Invalid account administration request'); }
        const loginOwner = requestLoginOwner(request, authSession);
        const principal = loginOwner ? loginContexts.identity(loginOwner, target.id) : null;
        const credential = loginOwner ? loginContexts.credential(loginOwner, target.id) : null;
        if (!principal || principal.role !== 'admin' || !credential) {
          jsonResponse(response, 403, { error: 'KCoder 账号管理失败：请检查管理员身份和操作参数' });
          return;
        }
        const spec = launchSpec(target);
        const result = await administerAccount(spec, appServerEnvironment(process.env, spec.env),
          { username: principal.username, password: credential.password }, operation,
          { track: child => trackAppServerChild(child, target.id) });
        jsonResponse(response, 200, { result });
      } catch {
        jsonResponse(response, 403, { error: 'KCoder 账号管理失败：请检查管理员身份和操作参数' });
      }
      return;
    }
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
          await loginContexts.mutate(loginOwner, target.id, async () => {
            const principal = loginContexts.identity(loginOwner, target.id);
            loginContexts.invalidate(loginOwner, target.id);
            closeContextSockets(loginOwner, target.id);
            await terminateContextChildren(target.id, loginOwner);
            serverHealth.delete(target.id);
            if (typeof deviceId === 'string') {
              if (principal) await accountCredentials.forgetIdentity({ deviceId, username: principal.username }, target);
              else await accountCredentials.forgetDevice(deviceId, target);
            }
          });
          jsonResponse(response, 200, { authenticated: false });
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
            serverHealth.delete(target.id);
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
          if (
            serverHealthSignature(serversById.get(target.id)) ===
            serverHealthSignature(target)
          ) {
            updateServerHealth(target, startedAt);
          }
          jsonResponse(response, 200, result);
        } catch (error) {
          if (
            serverHealthSignature(serversById.get(target.id)) ===
            serverHealthSignature(target)
          ) {
            updateServerHealth(target, startedAt, error);
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
        const id = serverMutation[1];
        if (request.method === "PUT") {
          const draft = JSON.parse(await requestBody(request, 16 * 1024));
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
          servers = nextServers;
          serversById = new Map(servers.map((item) => [item.id, item]));
          serverHealth.delete(id);
          refreshSessionServerAccess();
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
          servers = nextServers;
          serversById = new Map(servers.map((item) => [item.id, item]));
          serverHealth.delete(id);
          refreshSessionServerAccess();
          await terminateServerChildren(id);
          loginContexts.invalidateTarget(id);
          closeTargetSockets(id);
          await accountCredentials.forgetTarget(existing);
          jsonResponse(response, 200, { removed: id });
        }
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
    const relative =
      pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    let file = resolve(webRoot, relative);
    if (file !== webRoot && !file.startsWith(webRoot + sep))
      throw new Error("path outside root");
    let body;
    try {
      body = await readFile(file);
    } catch (error) {
      const requestedExtension = extname(relative).toLowerCase();
      if (requestedExtension && mime[requestedExtension]) throw error;
      file =
        (await staticRouteFile(relative)) ?? resolve(webRoot, "index.html");
      body = await readFile(file);
    }
    if (extname(file) === ".html") {
      const desktopMeta = desktopHost
        ? '<meta name="kcoder-desktop-host" content="1">\n'
        : "";
      body = Buffer.from(
        body
          .toString("utf8")
          .replace(
            "</head>",
            `<meta name="kcoder-rpc-token" content="${gatewayToken}">\n${desktopMeta}</head>`,
          ),
      );
    }
    response.writeHead(200, {
      "content-type": mime[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": contentSecurityPolicy,
    });
    response.end(body);
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

function frame(value, opcode = 1) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const first = 0x80 | opcode;
  if (payload.length < 126)
    return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const head = Buffer.alloc(4);
    head[0] = first;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = first;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([head, payload]);
}

function decodeFrames(buffer, fragments) {
  const messages = [];
  const controls = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const fin = Boolean(buffer[offset] & 0x80);
    if (buffer[offset] & 0x70)
      throw new Error("WebSocket extensions are not supported");
    const opcode = buffer[offset] & 0x0f;
    const second = buffer[offset + 1];
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      const wide = buffer.readBigUInt64BE(cursor);
      cursor += 8;
      if (wide > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("WebSocket frame too large");
      length = Number(wide);
    }
    if (!masked) throw new Error("Client WebSocket frames must be masked");
    if (length > maxMessageBytes)
      throw new Error("WebSocket message is too large");
    if (opcode >= 8 && (!fin || length > 125))
      throw new Error("Invalid WebSocket control frame");
    const maskSize = 4;
    if (cursor + maskSize + length > buffer.length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskSize;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask)
      for (let index = 0; index < payload.length; index++)
        payload[index] ^= mask[index % 4];
    if (opcode === 1) {
      if (fragments.length)
        throw new Error("Unexpected text frame during fragmented message");
      if (fin) messages.push(payload.toString("utf8"));
      else fragments.push(payload);
    } else if (opcode === 0) {
      if (!fragments.length) throw new Error("Unexpected continuation frame");
      fragments.push(payload);
      if (
        fragments.reduce((sum, part) => sum + part.length, 0) > maxMessageBytes
      )
        throw new Error("WebSocket message is too large");
      if (fin) {
        messages.push(Buffer.concat(fragments).toString("utf8"));
        fragments.length = 0;
      }
    } else if (opcode === 8 || opcode === 9 || opcode === 10)
      controls.push({ opcode, payload });
    else throw new Error("Binary WebSocket frames are not supported");
    offset = cursor + length;
  }
  if (buffer.length - offset > maxMessageBytes + 14)
    throw new Error("WebSocket receive buffer is too large");
  return { messages, controls, rest: buffer.subarray(offset) };
}

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
  const requested =
    workspacePath ||
    (target.transport === "local" ? target.cwd : target.remoteCwd);
  if (
    target.transport === "ssh" &&
    (typeof requested !== "string" || requested.length === 0)
  ) {
    // An SSH target may omit remoteCwd, allowing its remote shell to start app-server
    // in the default home. The sentinel is shared only with the default directory on
    // the same target and never merged with an explicit absolute path.
    return JSON.stringify([
      serverHealthSignature(target),
      "<remote-default-cwd>",
    ]);
  }
  if (typeof requested !== "string" || !(target.transport === "local" ? isAbsolute(requested) : posix.isAbsolute(requested))) {
    throw new Error(
      `runtime target ${target.id} has no absolute workspace path`,
    );
  }
  const normalized =
    target.transport === "local"
      ? realpathSync.native(requested)
      : posix.normalize(requested);
  return JSON.stringify([serverHealthSignature(target), normalized]);
}

function removeWorkspaceBroker(key, broker) {
  if (broker.idleTimer) clearTimeout(broker.idleTimer);
  const brokers = workspaceAppServerBrokers.get(key);
  brokers?.delete(broker);
  if (!brokers?.size) workspaceAppServerBrokers.delete(key);
}

function scheduleWorkspaceBrokerIdle(key, broker, delay = workspaceAppServerIdleMs) {
  if (broker.idleTimer) clearTimeout(broker.idleTimer);
  broker.idleTimer = null;
  if (broker.clientCount !== 0 || broker.closed || broker.idleShutdown.closing || broker.hasLiveTerminals || broker.hasProjectAutomations)
    return;
  broker.idleTimer = setTimeout(() => {
    broker.idleTimer = null;
    if (broker.clientCount !== 0 || broker.closed || broker.hasLiveTerminals || broker.hasProjectAutomations) return;
    if (broker.hasProtectedIdleResources) {
      scheduleWorkspaceBrokerIdle(key, broker, pendingWorkIdleDelay(workspaceAppServerIdleMs));
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
        scheduleWorkspaceBrokerIdle(key, broker, pendingWorkIdleDelay(workspaceAppServerIdleMs));
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

function createWorkspaceBroker(target, workspacePath, key, { authentication, loginOwner } = {}) {
  const spec = launchSpec(target, { scenario, workspacePath });
  if (target.security) {
    authentication ??= loginOwner ? loginContexts.credential(loginOwner, target.id) : null;
    if (!authentication) {
      throw new Error("请先登录此连接的 KCoder 账号");
    }
  }
  const spawnedProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: appServerEnvironment(process.env, spec.env),
    stdio: spec.stdio ?? ["pipe", "pipe", "pipe"],
  });
  const authenticated = authentication ? authenticatedAccountProcess(spawnedProcess, {
    ...authentication, workspace: workspacePath || target.remoteCwd,
  }, {
    onAuthenticated: principal => {
      if (target.security && loginOwner) loginContexts.publish(loginOwner, target.id, principal, authentication);
    },
    onFailure: ({ authenticationRejected }) => {
      if (target.security && loginOwner && authenticationRejected) {
        loginContexts.invalidate(loginOwner, target.id);
        closeContextSockets(loginOwner, target.id);
        serverHealth.delete(target.id);
      }
    },
  }) : spawnedProcess;
  const child = trackAppServerChild(
    authenticated,
    target.id,
    target.security ? loginOwner : undefined,
  );
  const broker = new WorkspaceAppServerBroker({
    child,
    adapter: createRuntimeTargetAdapter(target.runtime),
    maxMessageBytes,
    serverId: target.id,
    residentThreads: serverHealth.get(target.id)?.result?.capabilities
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
      removeWorkspaceBroker(key, restarting);
      serverHealth.delete(target.id);
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
  return broker;
}

async function reusableWorkspaceBroker(target, workspacePath, loginOwner) {
  const key = workspaceBrokerKey(target, workspacePath);
  const sameOwner = (candidate) =>
    target.security ? candidate.loginOwner === loginOwner : true;
  const brokers = workspaceAppServerBrokers.get(key);
  let broker = [...(brokers ?? [])].find(
    (candidate) => candidate.acceptsClient && sameOwner(candidate),
  );
  if (!broker) {
    const closing = [...(brokers ?? [])].find(candidate => !candidate.closed && candidate.idleShutdown.closing && sameOwner(candidate));
    if (closing) {
      await closing.idleShutdown.operation;
      if (!closing.closed && closing.idleShutdown.closing)
        throw new Error("workspace shutdown is not yet confirmed; retry after the target exits");
      return reusableWorkspaceBroker(target, workspacePath, loginOwner);
    }
    const probing = [...(brokers ?? [])].find(
      (candidate) => !candidate.closed && candidate.shareability === "unknown" && sameOwner(candidate),
    );
    if (probing) {
      const shareability = await new Promise((resolveWait, rejectWait) => {
        const timeout = setTimeout(
          () =>
            rejectWait(
              new Error(
                `app-server initialize timed out after ${serverHealthTimeoutMs}ms`,
              ),
            ),
          serverHealthTimeoutMs,
        );
        probing.whenShareabilityKnown().then((value) => {
          clearTimeout(timeout);
          resolveWait(value);
        });
      });
      if (shareability === "resident" && !probing.closed) broker = probing;
      else if (shareability === "closed")
        return reusableWorkspaceBroker(target, workspacePath, loginOwner);
    }
  }
  broker ??= createWorkspaceBroker(target, workspacePath, key, { loginOwner });
  if (broker.idleTimer) {
    clearTimeout(broker.idleTimer);
    broker.idleTimer = null;
  }
  return { broker, key };
}

function bridgeWorkspaceAppServer(
  socket,
  target,
  channel,
  selectedBroker,
  initialData = Buffer.alloc(0),
  callbackOrigin,
) {
  const { broker, key } = selectedBroker;
  const client = {
    channel,
    createMcpCallbackReceiver: options => mcpCallbacks.create(callbackOrigin, options),
    send(message) {
      if (!socket.writable) return false;
      const raw =
        typeof message === "string" ? message : JSON.stringify(message);
      if (Buffer.byteLength(raw) > maxMessageBytes)
        throw new Error("Adapted app-server response is too large");
      const writable = socket.write(frame(raw));
      if (!writable) {
        broker.blockStdout(client);
        socket.once("drain", () => broker.releaseStdout(client));
      }
      return writable;
    },
    pause() {
      socket.pause();
    },
    resume() {
      if (!socket.destroyed) socket.resume();
    },
    close() {
      if (!socket.destroyed) socket.end();
    },
  };
  broker.attach(client);
  let buffered = Buffer.from(initialData);
  const fragments = [];
  let detached = false;
  let liveness;
  const detach = () => {
    if (detached) return;
    detached = true;
    liveness?.stop();
    broker.detach(client);
    scheduleWorkspaceBrokerIdle(key, broker);
  };
  liveness = new WebSocketLivenessLease({
    sendPing: payload => socket.write(frame(payload, 9)),
    canProbe: () => !socket.isPaused(),
    onExpired: () => { try { detach(); } finally { socket.destroy(); } },
  });
  liveness.start();
  socket.on("data", (chunk) => {
    try {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = decodeFrames(buffered, fragments);
      buffered = decoded.rest;
      for (const control of decoded.controls) {
        if (control.opcode === 8) {
          socket.end(frame(control.payload, 8));
          return;
        }
        if (control.opcode === 9) socket.write(frame(control.payload, 10));
        if (control.opcode === 10) liveness.pong(control.payload);
      }
      for (const raw of decoded.messages) broker.receive(client, raw);
    } catch (error) {
      client.send({
        jsonrpc: "2.0",
        method: "server/transportError",
        params: { serverId: target.id, message: error.message },
      });
      socket.end(frame(Buffer.from([0x03, 0xea]), 8));
    }
  });
  if (buffered.length) socket.emit("data", Buffer.alloc(0));
  socket.on("end", () => {
    detach();
    if (!socket.destroyed) socket.destroy();
  });
  socket.on("close", detach);
  socket.on("error", detach);
}

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
  try {
    const authority = request.headers.host;
    const origin = request.headers.origin;
    const requestUrl = new URL(request.url, "http://localhost");
    const channel = requestUrl.searchParams.get("channel") || "runtime";
    const workspacePath = requestUrl.searchParams.get("workspace") || undefined;
    const target = serversById.get(
      requestUrl.searchParams.get("server") || servers[0].id,
    );
    const headerSessionId = authenticatedSessionId(request);
    const protocolSessionId = websocketSessionId(request);
    const headerSession = headerSessionId
      ? authSessionById(headerSessionId)
      : null;
    const protocolSession = protocolSessionId
      ? authSessionById(protocolSessionId)
      : null;
    const authSessionId = headerSession
      ? headerSessionId
      : protocolSession
        ? protocolSessionId
        : null;
    const authSession =
      headerSession ||
      protocolSession ||
      (!authRequired ? authSessionById(null) : null);
    const mobileBearerSession = Boolean(bearerValue(request) && headerSession);
    const mobileWebSession = Boolean(protocolSessionId && protocolSession);
    const allowedAuthority = isAllowedAuthority(authority);
    const trustedOrigin =
      (!origin && (!authRequired || mobileBearerSession)) ||
      isAllowedOrigin(origin, authority) ||
      (mobileWebSession && isAllowedMobileWebOrigin(origin));
    const loginOwner = authRequired ? authSessionId : ANONYMOUS_LOGIN_OWNER;
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
        !runtimeCapabilities(target.runtime).browserSessions) ||
      activeConnections >= maxConnections ||
      (channel === "browser" &&
        activeBrowserConnections >= maxBrowserConnections)
    ) {
      socket.destroy();
      return;
    }
    const selectedBroker = mock || channel === "ssh-terminal"
      ? null
      : await reusableWorkspaceBroker(target, workspacePath, loginOwner);
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
    else
      bridgeWorkspaceAppServer(socket, target, channel, selectedBroker, head,
        isAllowedOrigin(origin, authority) ? new URL(origin).origin
          : [...publicOrigins].find(value => new URL(value).host === authority && value.startsWith("https:"))
            ?? (publicOrigins.size === 1 ? [...publicOrigins][0] : `http://${authority}`));
  } catch {
    socket.destroy();
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  resourceBudget.stop();
  mcpCallbacks.close();
  server.close();
  for (const socket of openSockets) socket.destroy();
  const waitUntil = async (deadline) => {
    while (appServerChildren.size && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  };
  await waitUntil(Date.now() + 1_500);
  for (const child of appServerChildren) child.kill("SIGTERM");
  await waitUntil(Date.now() + 400);
  for (const child of appServerChildren) child.kill("SIGKILL");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

server.listen(configuredPort, host, () => {
  const address = server.address();
  if (typeof address === "object" && address) listeningPort = address.port;
  console.log(`KCoder Studio: http://${host}:${listeningPort}`);
  console.log(`Web root: ${webRoot}`);
  if (mock) console.log("JavaScript mock /rpc gateway enabled");
  else
    console.log(
      `Rust app-server gateway: ${appServerBin}${scenario ? ` --scenario ${scenario}` : ""}`,
    );
  console.log(
    `Configured servers: ${servers.map((server) => `${server.id}(${server.runtime}/${server.transport})`).join(", ")}`,
  );
});
