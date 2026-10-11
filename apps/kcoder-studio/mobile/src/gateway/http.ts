import { canCoordinateDeviceAuthorization } from "@/storage/context-lock";
import type {
  GatewayProfile,
  KCoderServer,
  KCoderServerDraft,
  ServerStatus,
} from "./types";

export class GatewaySessionExpiredError extends Error {
  constructor() {
    super("Gateway 会话已失效，请重新授权");
    this.name = "GatewaySessionExpiredError";
  }
}

const GATEWAY_HTTP_TIMEOUT_MS = 5_000;
const GATEWAY_UNAVAILABLE_MESSAGE =
  "无法访问 Gateway，请检查地址、网络和防火墙设置";
let mobileProfileSequence = 0;

function normalizedBaseUrl(value: string, allowHttp = true): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请输入 Gateway 地址");
  const withScheme = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `${allowHttp ? "http" : "https"}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Gateway 地址格式无效，请输入例如 http://127.0.0.1:4173");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Gateway 地址只支持 http:// 或 https://");
  }
  if (parsed.protocol === "http:" && !allowHttp) {
    throw new Error(
      "此构建只允许 HTTPS Gateway；开发内网调试需同时启用 KCODER_STUDIO_ALLOW_HTTP=1 和 EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP=1",
    );
  }
  if (parsed.username || parsed.password) throw new Error("Gateway 地址不能包含用户名或密码，请使用授权令牌");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function readError(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string") return payload.error;
  } catch {
    if (signal?.aborted) throw new Error(GATEWAY_UNAVAILABLE_MESSAGE);
    // Fall back to generic status text for non-JSON errors.
  }
  return `${response.status} ${response.statusText}`.trim();
}

export interface MobileSessionBootstrap {
  profile: GatewayProfile;
  /** Ephemeral inventory from this newly issued session; never profile metadata. */
  initialServers?: KCoderServer[];
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function initialServer(value: unknown): value is KCoderServer {
  if (!plainRecord(value)) return false;
  const allowed = new Set(["id", "label", "labelKey", "description", "runtime", "transport",
    "workspacePath", "host", "user", "port", "command", "profile", "settingsFile",
    "accountIdentity", "authorityId", "security", "chromiumBin", "chromiumNoSandbox",
    "acceptNewHostKey", "capabilities"]);
  if (Object.keys(value).some(key => !allowed.has(key)) ||
      typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id) ||
      typeof value.label !== "string" || typeof value.description !== "string" ||
      value.runtime !== "kcoder" || (value.transport !== "local" && value.transport !== "ssh")) return false;
  for (const key of ["id", "label", "description", "labelKey", "workspacePath", "host", "user", "command",
    "profile", "settingsFile", "authorityId", "chromiumBin"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 4096)) return false;
  }
  if (value.port !== undefined && (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) return false;
  for (const key of ["chromiumNoSandbox", "acceptNewHostKey"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  }
  if (value.capabilities !== undefined && (!plainRecord(value.capabilities) ||
      Object.keys(value.capabilities).length > 64 || Object.keys(value.capabilities).some(key => /token|password|credential|loginOwner/i.test(key)) ||
      Object.values(value.capabilities).some(flag => typeof flag !== "boolean"))) return false;
  if (value.accountIdentity !== undefined) {
    const account = value.accountIdentity;
    if (!plainRecord(account) || Object.keys(account).some(key => !["principalId", "username", "role"].includes(key)) ||
        typeof account.principalId !== "string" || typeof account.username !== "string" ||
        (account.role !== undefined && account.role !== "user" && account.role !== "admin")) return false;
  }
  if (value.security !== undefined) {
    const security = value.security;
    if (!plainRecord(security) || Object.keys(security).some(key => key !== "identity") || !plainRecord(security.identity)) return false;
    const identity = security.identity;
    if (Object.keys(identity).some(key => !["mode", "username"].includes(key)) || identity.mode !== "kcoder-account" ||
        (identity.username !== undefined && typeof identity.username !== "string")) return false;
  }
  return true;
}

/** Invalid or future bootstrap versions fall back to the ordinary authenticated GET. */
export function parseInitialMobileServers(value: unknown): KCoderServer[] | undefined {
  if (!plainRecord(value) || value.version !== 1 || Object.keys(value).some(key => !["version", "servers"].includes(key)) ||
      !Array.isArray(value.servers) || value.servers.length > 32 || !value.servers.every(initialServer)) return undefined;
  if (new Set(value.servers.map(server => server.id)).size !== value.servers.length) return undefined;
  return value.servers;
}

export async function exchangeMobileSession(
  rawBaseUrl: string, token: string, label?: string, signal?: AbortSignal,
): Promise<GatewayProfile> {
  return (await exchangeMobileSessionResult(rawBaseUrl, token, label, signal)).profile;
}

export function exchangeMobileSessionWithBootstrap(
  rawBaseUrl: string, token: string, label?: string, signal?: AbortSignal,
): Promise<MobileSessionBootstrap> {
  return exchangeMobileSessionResult(rawBaseUrl, token, label, signal, true);
}

async function exchangeMobileSessionResult(
  rawBaseUrl: string,
  token: string,
  label?: string,
  signal?: AbortSignal,
  requestInitialServers = false,
): Promise<MobileSessionBootstrap> {
  if (signal?.aborted) throw new Error("Gateway 连接已取消");
  const allowHttp =
    typeof document !== "undefined" ||
    process.env.EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP === "1";
  const baseUrl = normalizedBaseUrl(rawBaseUrl, allowHttp);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    GATEWAY_HTTP_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/mobile/session`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, durableDeviceAuthorization: canCoordinateDeviceAuthorization(), deviceLabel: label || "KCoder mobile", ...(requestInitialServers ? { requestInitialServers: true } : {}) }),
        signal: controller.signal,
      });
    } catch {
      if (signal?.aborted) throw new Error("Gateway 连接已取消");
      throw new Error(GATEWAY_UNAVAILABLE_MESSAGE);
    }
    if (!response.ok)
      throw new Error(
        `连接失败：${await readError(response, controller.signal)}`,
      );
    let payload: {
      accessToken?: unknown;
      expiresAt?: unknown;
      rpcToken?: unknown;
      refreshToken?: unknown; refreshExpiresAt?: unknown; deviceId?: unknown; authorizationGeneration?: unknown; capabilities?: { mobileRefreshV1?: boolean; mobileInitialServersV1?: boolean }; accessTtlMs?: unknown; initialServers?: unknown;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(GATEWAY_UNAVAILABLE_MESSAGE);
      throw error;
    }
    if (
      typeof payload.accessToken !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      throw new Error("Gateway 返回了无效的移动会话");
    }
    const endpoint = new URL(baseUrl);
    const originId = endpoint.origin.replace(/[^A-Za-z0-9._-]/g, "-");
    const pathId = Array.from(endpoint.pathname, (character) =>
      character.codePointAt(0)!.toString(16),
    ).join(".");
    const gatewayRouteId = endpoint.pathname.match(/^\/g\/([A-Za-z0-9_-]+)$/)?.[1];
    const profile: GatewayProfile = {
      id: `${originId}-${pathId}-${Date.now().toString(36)}-${(++mobileProfileSequence).toString(36)}`,
      label: label?.trim() || (gatewayRouteId ? `Gateway ${gatewayRouteId}` : endpoint.host),
      baseUrl,
      authorizationGeneration: typeof payload.authorizationGeneration === "string" ? payload.authorizationGeneration : `auth-${Date.now().toString(36)}-${mobileProfileSequence.toString(36)}-${Math.random().toString(36).slice(2)}`,
      authMode: payload.capabilities?.mobileRefreshV1 === true ? "device" : "legacy",
      ...(payload.capabilities?.mobileRefreshV1 === true ? parseDeviceCredential(payload) : {}),
      accessToken: payload.accessToken,
      expiresAt: payload.expiresAt,
      rpcToken:
        typeof payload.rpcToken === "string" ? payload.rpcToken : "cookie-auth",
    };
    const initialServers = requestInitialServers && payload.capabilities?.mobileInitialServersV1 === true
      ? parseInitialMobileServers(payload.initialServers) : undefined;
    return { profile, ...(initialServers !== undefined ? { initialServers } : {}) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

function parseDeviceCredential(payload: { accessTtlMs?: unknown; refreshToken?: unknown; refreshExpiresAt?: unknown; deviceId?: unknown; authorizationGeneration?: unknown }) {
  if (typeof payload.refreshToken !== "string" || !/^[a-f0-9]{64}$/.test(payload.refreshToken) || typeof payload.refreshExpiresAt !== "number" || !Number.isFinite(payload.refreshExpiresAt) || typeof payload.deviceId !== "string" || typeof payload.authorizationGeneration !== "string") throw new Error("Gateway 返回了无效的设备授权");
  return { accessTtlMs: typeof payload.accessTtlMs === "number" && payload.accessTtlMs >= 100 ? payload.accessTtlMs : undefined, refreshToken: payload.refreshToken, refreshExpiresAt: payload.refreshExpiresAt, deviceId: payload.deviceId, authorizationGeneration: payload.authorizationGeneration };
}
let authorizationResolver: ((profile: GatewayProfile, force?: boolean) => Promise<void>) | undefined;
export function installGatewayAuthorizationResolver(resolver: typeof authorizationResolver): () => void {
  authorizationResolver = resolver; return () => { if (authorizationResolver === resolver) authorizationResolver = undefined; };
}
export function ensureGatewayAuthorization(profile: GatewayProfile, force = false): Promise<void> {
  return authorizationResolver?.(profile, force) ?? Promise.resolve();
}
export async function refreshMobileSession(profile: GatewayProfile, rotationId: string): Promise<GatewayProfile> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), GATEWAY_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`${profile.baseUrl}/api/mobile/session/refresh`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: profile.refreshToken, rotationId, deviceId: profile.deviceId }), signal: controller.signal });
    if (response.status === 401 || response.status === 409) throw new GatewaySessionExpiredError();
    if (!response.ok) throw new Error(await readError(response));
    const payload = await response.json(); const credentials = parseDeviceCredential(payload);
    if (credentials.deviceId !== profile.deviceId || credentials.authorizationGeneration !== profile.authorizationGeneration || typeof payload.accessToken !== "string" || typeof payload.rpcToken !== "string" || typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt)) throw new Error("Gateway 设备授权身份不一致");
    return { ...profile, ...credentials, accessToken: payload.accessToken, rpcToken: payload.rpcToken, expiresAt: payload.expiresAt, pendingRotationId: undefined };
  } finally { clearTimeout(timer); }
}
export async function listMobileDevices(profile: GatewayProfile, signal?: AbortSignal): Promise<{ id: string; label: string; lastUsedAt: number; expiresAt: number }[]> {
  const payload = await gatewayRequest<{ devices: { id: string; label: string; lastUsedAt: number; expiresAt: number }[] }>(profile, "/api/mobile/devices", { signal }); return payload.devices;
}
export function revokeMobileDevice(profile: GatewayProfile, deviceId: string): Promise<void> {
  return gatewayRequest(profile, `/api/mobile/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
}

export async function gatewayRequest<T>(
  profile: GatewayProfile,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const requestIdentity = JSON.stringify([profile.id, profile.baseUrl, profile.authorizationGeneration, profile.deviceId]);
  const requestBaseUrl = profile.baseUrl;
  const assertIdentity = () => {
    if (JSON.stringify([profile.id, profile.baseUrl, profile.authorizationGeneration, profile.deviceId]) !== requestIdentity) throw new Error("Gateway 授权范围已改变，旧请求已取消");
  };
  await ensureGatewayAuthorization(profile);
  assertIdentity();
  const headers = new Headers(init.headers);
  const attemptedAccessToken = profile.accessToken;
  headers.set("authorization", `Bearer ${attemptedAccessToken}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${requestBaseUrl}${path}`, {
    ...init,
    credentials: "omit",
    headers,
  });
  assertIdentity();
  if (response.status === 401) {
    if (authorizationResolver && (init.method ?? "GET").toUpperCase() === "GET" && profile.refreshToken) {
      // Another tab may have committed a winner while this GET was in flight.
      // Its old 401 must not rotate and invalidate that fresh grant again.
      const winnerFresh = profile.accessToken !== attemptedAccessToken && !profile.pendingRotationId && profile.expiresAt > Date.now();
      if (!winnerFresh) await ensureGatewayAuthorization(profile, profile.accessToken === attemptedAccessToken);
      assertIdentity();
      headers.set("authorization", `Bearer ${profile.accessToken}`);
      const retried = await fetch(`${requestBaseUrl}${path}`, { ...init, credentials: "omit", headers });
      assertIdentity();
      if (retried.status === 401) throw new GatewaySessionExpiredError();
      if (!retried.ok) throw new Error(await readError(retried));
      const result = await retried.json() as T; assertIdentity(); return result;
    }
    throw new GatewaySessionExpiredError();
  }
  if (!response.ok) throw new Error(await readError(response));
  if (response.status === 204) return undefined as T;
  const result = await response.json() as T; assertIdentity(); return result;
}

export async function listServers(
  profile: GatewayProfile,
): Promise<KCoderServer[]> {
  const payload = await gatewayRequest<{ servers?: KCoderServer[] }>(
    profile,
    "/api/servers",
  );
  return Array.isArray(payload.servers) ? payload.servers : [];
}

export async function listServerStatuses(
  profile: GatewayProfile,
): Promise<ServerStatus[]> {
  const payload = await gatewayRequest<{ statuses?: ServerStatus[] }>(
    profile,
    "/api/servers/status",
  );
  return Array.isArray(payload.statuses) ? payload.statuses : [];
}

export async function testServer(
  profile: GatewayProfile,
  draft: KCoderServerDraft,
): Promise<{ ok: boolean; error?: string }> {
  return gatewayRequest(profile, "/api/servers/test", {
    method: "POST",
    body: JSON.stringify(draft),
  });
}

export async function saveServer(
  profile: GatewayProfile,
  draft: KCoderServerDraft,
): Promise<KCoderServer> {
  const result = await gatewayRequest<{ server: KCoderServer }>(
    profile,
    `/api/servers/${encodeURIComponent(draft.id)}`,
    { method: "PUT", body: JSON.stringify(draft) },
  );
  return result.server;
}

export async function deleteServer(
  profile: GatewayProfile,
  id: string,
): Promise<void> {
  await gatewayRequest(profile, `/api/servers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: "{}",
  });
}

export async function revokeMobileSession(profile: GatewayProfile): Promise<void> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), GATEWAY_HTTP_TIMEOUT_MS);
  try {
    // Also used to roll back a pairing response before it enters the profile store.
    const response = await fetch(`${profile.baseUrl}/api/mobile/session`, { method: "DELETE", credentials: "omit", headers: { authorization: `Bearer ${profile.accessToken}` }, signal: controller.signal });
    if (response.status === 401) throw new GatewaySessionExpiredError();
    if (!response.ok) throw new Error(await readError(response));
  } finally { clearTimeout(timer); }
}

export { normalizedBaseUrl };

/** WebSocket errors do not expose HTTP status on native clients. Only an explicit
 * authenticated HTTP 401 can distinguish revoked login from an offline target. */
export async function gatewaySessionExpired(profile: GatewayProfile): Promise<boolean> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), GATEWAY_HTTP_TIMEOUT_MS);
  try { await gatewayRequest(profile, "/api/servers", { signal: controller.signal }); return false; }
  catch (error) { return error instanceof GatewaySessionExpiredError; }
  finally { clearTimeout(timer); }
}
