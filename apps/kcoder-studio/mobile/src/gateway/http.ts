import { canCoordinateDeviceAuthorization } from "@/storage/context-lock";
import { t } from "@/i18n";
import type {
  GatewayAuthorizationDenialWitness,
  GatewayProfile,
  KCoderServer,
  KCoderServerDraft,
  ServerStatus,
} from "./types";
import {
  GatewayRouteResolutionError,
  invalidateGatewayRoute,
  normalizeGatewayConnectionRoutes,
  resolveGatewayRoute,
  selectPairingGatewayRoute,
  type GatewayConnectionRoutes,
} from "./connection-routes";
import {
  peerFetch,
  releasePeerTransports,
} from "./peer-transport";
import { GatewayHttpError } from "./http-errors";

export class GatewaySessionExpiredError extends Error {
  constructor() {
    super("Gateway 会话已失效，请重新授权");
    this.name = "GatewaySessionExpiredError";
  }
}

const GATEWAY_HTTP_TIMEOUT_MS = 5_000;
const GATEWAY_ROUTE_TIMEOUT_MS = 15_000;
const GATEWAY_UNAVAILABLE_MESSAGE =
  "无法访问 Gateway，请检查地址、网络和防火墙设置";
let mobileProfileSequence = 0;
let authorizationDenialRecorder: ((witness: GatewayAuthorizationDenialWitness) => Promise<boolean>) | undefined;
let authorizationDenialChecker: ((witness: GatewayAuthorizationDenialWitness) => boolean) | undefined;
const sessionExpiredWitnesses = new WeakMap<GatewaySessionExpiredError, GatewayAuthorizationDenialWitness>();

function timedRequestController(parent: AbortSignal | undefined, timeoutMs: number): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function throwIfRequestAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Gateway request was cancelled");
  error.name = "AbortError";
  throw error;
}

async function resolveGatewayRouteWithDeadline(
  profile: GatewayProfile,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = timedRequestController(signal, GATEWAY_ROUTE_TIMEOUT_MS);
  try {
    return await resolveGatewayRoute(profile, { signal: timeout.controller.signal });
  } finally {
    timeout.dispose();
  }
}

function gatewayTransportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (/^kcoder-p2p:/i.test(url)) return peerFetch(input, init);
  return fetch(input, init);
}

function pairingPeerScope(baseUrl: string, routes: GatewayConnectionRoutes, pairingToken: string): GatewayProfile {
  const sequence = ++mobileProfileSequence;
  const identity = `${Date.now().toString(36)}-${sequence.toString(36)}`;
  return {
    id: `pairing-${identity}`,
    label: "Gateway pairing",
    baseUrl,
    // Used only to create the signed pairing HMAC. This short-lived object is
    // never persisted, logged, or passed into model context.
    accessToken: pairingToken,
    expiresAt: Date.now(),
    rpcToken: "",
    authorizationGeneration: `pairing-${identity}`,
    authMode: "legacy",
    connectionRoutes: routes,
  };
}

function captureDenialWitness(profile: GatewayProfile, accessToken = profile.accessToken): GatewayAuthorizationDenialWitness {
  return {
    profileId: profile.id,
    baseUrl: profile.baseUrl,
    authMode: profile.authMode,
    authorizationGeneration: profile.authorizationGeneration,
    deviceId: profile.deviceId,
    accessToken,
    refreshToken: profile.refreshToken,
  };
}

function denialWitnessMatchesProfile(witness: GatewayAuthorizationDenialWitness, profile: GatewayProfile): boolean {
  return denialScopeMatchesProfile(witness, profile) &&
    witness.accessToken === profile.accessToken && witness.refreshToken === profile.refreshToken;
}

function denialScopeMatchesProfile(witness: GatewayAuthorizationDenialWitness, profile: GatewayProfile): boolean {
  return witness.profileId === profile.id && witness.baseUrl === profile.baseUrl &&
    (witness.authMode ?? "legacy") === (profile.authMode ?? "legacy") &&
    witness.authorizationGeneration === profile.authorizationGeneration && witness.deviceId === profile.deviceId;
}

async function throwForFinalUnauthorized(
  profile: GatewayProfile,
  witness: GatewayAuthorizationDenialWitness,
): Promise<never> {
  if (!denialWitnessMatchesProfile(witness, profile)) throw new Error("Gateway 授权范围已改变，旧请求已取消");
  if (authorizationDenialRecorder) {
    const denied = await authorizationDenialRecorder(witness);
    if (!denied || !denialWitnessMatchesProfile(witness, profile) ||
        (authorizationDenialChecker && !authorizationDenialChecker(witness)))
      throw new Error("Gateway 授权响应已过期，旧请求已取消");
  }
  const error = new GatewaySessionExpiredError();
  sessionExpiredWitnesses.set(error, witness);
  throw error;
}

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
    throw new Error(t("connect.gateway_address_invalid"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Gateway 地址只支持 http:// 或 https://");
  }
  if (!allowHttp && (["localhost", "[::1]", "0.0.0.0"].includes(parsed.hostname) || parsed.hostname.startsWith("127."))) {
    throw new Error(t("connect.gateway_loopback"));
  }
  if (parsed.protocol === "http:" && !allowHttp) {
    throw new Error(t("connect.gateway_https_required"));
  }
  if (parsed.username || parsed.password) throw new Error("Gateway 地址不能包含用户名或密码，请使用授权令牌");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function routeDescriptorContainsBaseUrl(
  descriptor: GatewayConnectionRoutes,
  baseUrl: string,
): boolean {
  try {
    const parsed = new URL(baseUrl);
    const canonical = `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    return descriptor.endpoints.some(endpoint => endpoint.url === canonical);
  } catch {
    return false;
  }
}

function sameGatewayRouteKey(
  left: GatewayConnectionRoutes,
  right: GatewayConnectionRoutes,
): boolean {
  return left.gatewayId === right.gatewayId && left.publicKey === right.publicKey;
}

function normalizePairingRoutes(
  baseUrl: string,
  value: unknown,
): GatewayConnectionRoutes {
  const descriptor = normalizeGatewayConnectionRoutes(value);
  if (!descriptor || !routeDescriptorContainsBaseUrl(descriptor, baseUrl)) {
    throw new Error("Gateway 配对二维码中的连接地址无效");
  }
  return descriptor;
}

async function readError(
  response: Response,
  signal?: AbortSignal,
  responseBytes?: number,
): Promise<GatewayHttpError> {
  const detailLimit = Math.min(responseBytes ?? 8 * 1024, 8 * 1024);
  try {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
      try {
        void response.body?.cancel().catch(() => undefined);
      } catch {
        // The response body is best-effort discarded after an HTML error.
      }
    } else {
      const payload = await gatewayJson<unknown>(response, detailLimit);
      if (plainRecord(payload) && typeof payload.error === "string") {
        return new GatewayHttpError(response.status, payload.error);
      }
    }
  } catch {
    if (signal?.aborted) throw new Error(GATEWAY_UNAVAILABLE_MESSAGE);
    // An empty, oversized, HTML, or malformed body falls back to its HTTP status.
  }
  return new GatewayHttpError(response.status);
}

async function bestEffortRevokePairingGrant(transportUrl: string, accessToken: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    await gatewayTransportFetch(`${transportUrl}/api/mobile/session`, {
      method: "DELETE",
      credentials: "omit",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch {
    // The pair transaction keeps its original validation error. A later device
    // revoke remains the recovery path if this bounded cleanup cannot reach it.
  } finally {
    clearTimeout(timer);
  }
}

export interface MobileSessionBootstrap {
  profile: GatewayProfile;
  /** Ephemeral inventory from this newly issued session; never profile metadata. */
  initialServers?: KCoderServer[];
}

export interface GatewayServerStatusSnapshot {
  /** Package version reported by the authenticated Gateway, or null for older/unversioned runtimes. */
  gatewayRuntimeVersion: string | null;
  statuses: ServerStatus[];
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function initialServer(value: unknown): value is KCoderServer {
  if (!plainRecord(value)) return false;
  const allowed = new Set(["id", "label", "labelKey", "description", "runtime", "transport",
    "workspacePath", "host", "user", "port", "command", "profile", "settingsFile",
    "accountIdentity", "authorityId", "security", "chromiumBin", "chromiumNoSandbox",
    "acceptNewHostKey", "capabilities", "observationTargetIdentity"]);
  if (Object.keys(value).some(key => !allowed.has(key)) ||
      typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id) ||
      typeof value.label !== "string" || typeof value.description !== "string" ||
      value.runtime !== "kcoder" || (value.transport !== "local" && value.transport !== "ssh")) return false;
  for (const key of ["id", "label", "description", "labelKey", "workspacePath", "host", "user", "command",
    "profile", "settingsFile", "authorityId", "chromiumBin"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 4096)) return false;
  }
  if (value.port !== undefined && (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) return false;
  if (value.observationTargetIdentity !== undefined &&
      (typeof value.observationTargetIdentity !== "string" || !/^[a-f0-9]{64}$/.test(value.observationTargetIdentity))) return false;
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
  connectionRoutes?: GatewayConnectionRoutes,
): Promise<GatewayProfile> {
  return (await exchangeMobileSessionResult(rawBaseUrl, token, label, signal, false, connectionRoutes)).profile;
}

export function exchangeMobileSessionWithBootstrap(
  rawBaseUrl: string, token: string, label?: string, signal?: AbortSignal,
  connectionRoutes?: GatewayConnectionRoutes,
): Promise<MobileSessionBootstrap> {
  return exchangeMobileSessionResult(rawBaseUrl, token, label, signal, true, connectionRoutes);
}

async function exchangeMobileSessionResult(
  rawBaseUrl: string,
  token: string,
  label?: string,
  signal?: AbortSignal,
  requestInitialServers = false,
  advertisedRoutes?: GatewayConnectionRoutes,
): Promise<MobileSessionBootstrap> {
  if (signal?.aborted) throw new Error("Gateway 连接已取消");
  const durableDeviceAuthorization = canCoordinateDeviceAuthorization();
  const allowHttp =
    typeof document !== "undefined"
      ? globalThis.location?.protocol === "http:"
      : process.env.EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP === "1";
  const baseUrl = normalizedBaseUrl(rawBaseUrl, allowHttp);
  const pairingRoutes = advertisedRoutes === undefined
    ? undefined
    : normalizePairingRoutes(baseUrl, advertisedRoutes);
  let transportUrl = baseUrl;
  const pairingScope = pairingRoutes && durableDeviceAuthorization
    ? pairingPeerScope(baseUrl, pairingRoutes, token)
    : undefined;
  if (pairingRoutes) {
    try {
      transportUrl = await selectPairingGatewayRoute(
        baseUrl,
        pairingRoutes,
        signal,
        pairingScope,
        pairingScope ? token : undefined,
      );
    } catch (error) {
      if (pairingScope) releasePeerTransports(pairingScope);
      if (error instanceof GatewayRouteResolutionError && error.code === "GATEWAY_ROUTE_CANCELLED")
        throw new Error("Gateway 连接已取消");
      if (error instanceof GatewayRouteResolutionError)
        throw new GatewayRouteResolutionError(error.code,
          "无法验证此 Gateway 的公网地址，请检查连接二维码或网络",
          { failure: error.failure, status: error.status, cause: error });
      throw new Error("无法验证此 Gateway 的公网地址，请检查连接二维码或网络", { cause: error });
    }
  }
  if (signal?.aborted) {
    if (pairingScope) releasePeerTransports(pairingScope);
    throw new Error("Gateway 连接已取消");
  }
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
      response = await gatewayTransportFetch(`${transportUrl}/api/mobile/session`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, durableDeviceAuthorization, deviceLabel: label || "KCoder mobile", ...(requestInitialServers ? { requestInitialServers: true } : {}) }),
        signal: controller.signal,
      });
    } catch {
      if (signal?.aborted) throw new Error("Gateway 连接已取消");
      throw new Error(GATEWAY_UNAVAILABLE_MESSAGE);
    }
    if (!response.ok) {
      const httpError = await readError(response, controller.signal).catch(error => {
        if (signal?.aborted) throw new Error("Gateway 连接已取消");
        throw error;
      });
      throw httpError;
    }
    let payload: {
      accessToken?: unknown;
      expiresAt?: unknown;
      rpcToken?: unknown;
      refreshToken?: unknown; refreshExpiresAt?: unknown; deviceId?: unknown; authorizationGeneration?: unknown; capabilities?: { mobileRefreshV1?: boolean; mobileInitialServersV1?: boolean }; accessTtlMs?: unknown; initialServers?: unknown; connectionRoutes?: unknown;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(GATEWAY_UNAVAILABLE_MESSAGE);
      throw error;
    }
    const sessionAccessToken = plainRecord(payload) && typeof payload.accessToken === "string" && payload.accessToken
      ? payload.accessToken
      : undefined;
    try {
      if (
        !plainRecord(payload) || !sessionAccessToken ||
        typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt)
      ) {
        throw new Error("Gateway 返回了无效的移动会话");
      }
      const responseRoutes = normalizeGatewayConnectionRoutes(payload.connectionRoutes);
      let acceptedRoutes: GatewayConnectionRoutes | undefined;
      if (pairingRoutes) {
        if (!responseRoutes || !sameGatewayRouteKey(pairingRoutes, responseRoutes) ||
            !routeDescriptorContainsBaseUrl(responseRoutes, baseUrl)) {
          throw new Error("Gateway 返回的连接身份与配对二维码不一致");
        }
        acceptedRoutes = responseRoutes;
      } else if (responseRoutes && routeDescriptorContainsBaseUrl(responseRoutes, baseUrl)) {
        // A direct/local pairing may not have a QR trust descriptor. Accept only
        // routes that include the endpoint the user used for this session.
        acceptedRoutes = responseRoutes;
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
        ...(acceptedRoutes ? { connectionRoutes: acceptedRoutes } : {}),
        authorizationGeneration: typeof payload.authorizationGeneration === "string" ? payload.authorizationGeneration : `auth-${Date.now().toString(36)}-${mobileProfileSequence.toString(36)}-${Math.random().toString(36).slice(2)}`,
        authMode: payload.capabilities?.mobileRefreshV1 === true ? "device" : "legacy",
        ...(payload.capabilities?.mobileRefreshV1 === true ? parseDeviceCredential(payload) : {}),
        accessToken: sessionAccessToken,
        expiresAt: payload.expiresAt,
        rpcToken:
          typeof payload.rpcToken === "string" ? payload.rpcToken : "cookie-auth",
      };
      const initialServers = requestInitialServers && payload.capabilities?.mobileInitialServersV1 === true
        ? parseInitialMobileServers(payload.initialServers) : undefined;
      return { profile, ...(initialServers !== undefined ? { initialServers } : {}) };
    } catch (error) {
      if (sessionAccessToken) await bestEffortRevokePairingGrant(transportUrl, sessionAccessToken);
      throw error;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
    if (pairingScope) releasePeerTransports(pairingScope);
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
export function installGatewayAuthorizationDenialRecorder(
  recorder: (witness: GatewayAuthorizationDenialWitness) => Promise<boolean>,
  isCurrentDenial?: (witness: GatewayAuthorizationDenialWitness) => boolean,
): () => void {
  authorizationDenialRecorder = recorder;
  authorizationDenialChecker = isCurrentDenial;
  return () => {
    if (authorizationDenialRecorder === recorder) {
      authorizationDenialRecorder = undefined;
      authorizationDenialChecker = undefined;
    }
  };
}
export function ensureGatewayAuthorization(profile: GatewayProfile, force = false): Promise<void> {
  return authorizationResolver?.(profile, force) ?? Promise.resolve();
}
export async function refreshMobileSession(
  profile: GatewayProfile,
  rotationId: string,
  signal?: AbortSignal,
): Promise<GatewayProfile> {
  const requestWitness = captureDenialWitness(profile);
  throwIfRequestAborted(signal);
  const transportUrl = await resolveGatewayRouteWithDeadline(profile, signal);
  throwIfRequestAborted(signal);
  const timeout = timedRequestController(signal, GATEWAY_HTTP_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await gatewayTransportFetch(`${transportUrl}/api/mobile/session/refresh`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: profile.refreshToken, rotationId, deviceId: profile.deviceId }), signal: timeout.controller.signal });
    } catch (error) {
      if (signal?.aborted) throwIfRequestAborted(signal);
      invalidateGatewayRoute(profile, transportUrl);
      throw error;
    }
    if (response.status === 401) await throwForFinalUnauthorized(profile, requestWitness);
    if (response.status === 409) throw new GatewaySessionExpiredError();
    if (!response.ok) throw await readError(response, timeout.controller.signal);
    const payload = await response.json(); const credentials = parseDeviceCredential(payload);
    if (credentials.deviceId !== profile.deviceId || credentials.authorizationGeneration !== profile.authorizationGeneration || typeof payload.accessToken !== "string" || typeof payload.rpcToken !== "string" || typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt)) throw new Error("Gateway 设备授权身份不一致");
    return { ...profile, ...credentials, accessToken: payload.accessToken, rpcToken: payload.rpcToken, expiresAt: payload.expiresAt, pendingRotationId: undefined };
  } finally { timeout.dispose(); }
}
export async function listMobileDevices(profile: GatewayProfile, signal?: AbortSignal): Promise<{ id: string; label: string; lastUsedAt: number; expiresAt: number }[]> {
  const payload = await gatewayRequest<{ devices: { id: string; label: string; lastUsedAt: number; expiresAt: number }[] }>(profile, "/api/mobile/devices", { signal }); return payload.devices;
}
export function revokeMobileDevice(profile: GatewayProfile, deviceId: string): Promise<void> {
  const requestScope = captureDenialWitness(profile);
  const revokesCurrentDevice = deviceId === requestScope.deviceId;
  return gatewayRequest(profile, `/api/mobile/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" }).then(async () => {
    // A successful explicit self-device revoke is authoritative for the current
    // grant too, but an old response cannot deny a replacement authorization.
    if (revokesCurrentDevice && denialScopeMatchesProfile(requestScope, profile)) {
      if (authorizationDenialRecorder) await authorizationDenialRecorder(captureDenialWitness(profile));
    }
  }).finally(() => {
    // A lost DELETE receipt can still mean the Gateway revoked this device.
    // Close only the current profile family's peer sessions; never replay it.
    if (revokesCurrentDevice && denialScopeMatchesProfile(requestScope, profile)) {
      invalidateGatewayRoute(profile);
      releasePeerTransports(profile);
    }
  });
}

export async function gatewayRequest<T>(
  profile: GatewayProfile,
  path: string,
  init: RequestInit = {},
  limits?: { responseBytes: number; beforeDispatch?(): void },
): Promise<T> {
  if (limits && (!Number.isSafeInteger(limits.responseBytes) || limits.responseBytes < 1 || limits.responseBytes > 2 * 1024 * 1024)) throw new Error('Invalid bounded Gateway response budget');
  const requestIdentity = JSON.stringify([profile.id, profile.baseUrl, profile.authMode ?? "legacy", profile.authorizationGeneration, profile.deviceId]);
  const assertIdentity = () => {
    if (JSON.stringify([profile.id, profile.baseUrl, profile.authMode ?? "legacy", profile.authorizationGeneration, profile.deviceId]) !== requestIdentity) throw new Error("Gateway 授权范围已改变，旧请求已取消");
  };
  await ensureGatewayAuthorization(profile);
  assertIdentity();
  const routeSignal = init.signal ?? undefined;
  let transportUrl = await resolveGatewayRoute(profile, { signal: routeSignal ?? undefined });
  let routeRetryUsed = false;
  const headers = new Headers(init.headers);
  const attemptedWitness = captureDenialWitness(profile);
  const attemptedAccessToken = attemptedWitness.accessToken;
  headers.set("authorization", `Bearer ${attemptedAccessToken}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const isRead = (init.method ?? "GET").toUpperCase() === "GET";
  const send = async (): Promise<Response> => {
    limits?.beforeDispatch?.();
    try {
      return await gatewayTransportFetch(`${transportUrl}${path}`, {
        ...init,
        credentials: "omit",
        headers,
      });
    } catch (error) {
      if (routeSignal?.aborted) throw error;
      const failedUrl = transportUrl;
      invalidateGatewayRoute(profile, failedUrl);
      if (!isRead || routeRetryUsed) throw error;
      routeRetryUsed = true;
      try {
        const nextUrl = await resolveGatewayRoute(profile, {
          signal: routeSignal ?? undefined,
        });
        if (nextUrl === failedUrl) throw error;
        transportUrl = nextUrl;
      } catch {
        throw error;
      }
      assertIdentity();
      limits?.beforeDispatch?.();
      try {
        return await gatewayTransportFetch(`${transportUrl}${path}`, {
          ...init,
          credentials: "omit",
          headers,
        });
      } catch (retryError) {
        if (!routeSignal?.aborted) invalidateGatewayRoute(profile, transportUrl);
        throw retryError;
      }
    }
  };
  const response = await send();
  assertIdentity();
  if (response.status === 401) {
    if (authorizationResolver && (init.method ?? "GET").toUpperCase() === "GET" && profile.refreshToken) {
      // Another tab may have committed a winner while this GET was in flight.
      // Its old 401 must not rotate and invalidate that fresh grant again.
      const winnerFresh = profile.accessToken !== attemptedAccessToken && !profile.pendingRotationId && profile.expiresAt > Date.now();
      if (!winnerFresh) await ensureGatewayAuthorization(profile, profile.accessToken === attemptedAccessToken);
      assertIdentity();
      const retryWitness = captureDenialWitness(profile);
      headers.set("authorization", `Bearer ${retryWitness.accessToken}`);
      const retried = await send();
      assertIdentity();
      if (retried.status === 401) await throwForFinalUnauthorized(profile, retryWitness);
      if (!retried.ok) throw await readError(retried, init.signal ?? undefined, limits?.responseBytes);
      const result = await gatewayJson<T>(retried, limits?.responseBytes); assertIdentity(); return result;
    }
    await throwForFinalUnauthorized(profile, attemptedWitness);
  }
  if (!response.ok) throw await readError(response, init.signal ?? undefined, limits?.responseBytes);
  if (response.status === 204) return undefined as T;
  const result = await gatewayJson<T>(response, limits?.responseBytes); assertIdentity(); return result;
}

/** A source catalog is bounded before JSON decoding, including a missing length header. */
async function gatewayJson<T>(response: Response, limit?: number): Promise<T> {
  if (limit === undefined) return response.json() as Promise<T>;
  if (!response.body) throw new Error('Missing bounded Gateway response body');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error('Gateway response budget exceeded'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as T;
}

export async function listServers(
  profile: GatewayProfile,
  options: { signal?: AbortSignal } = {},
): Promise<KCoderServer[]> {
  const payload = await gatewayRequest<{ servers?: KCoderServer[] }>(
    profile,
    "/api/servers",
    options,
  );
  return Array.isArray(payload.servers) ? payload.servers : [];
}

export async function listServerStatuses(
  profile: GatewayProfile,
): Promise<ServerStatus[]> {
  return (await getServerStatusSnapshot(profile)).statuses;
}

function reportedBuildVersion(value: unknown): string | null {
  return typeof value === "string" && value.length <= 128 &&
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : null;
}

function reportedProtocolVersion(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
    ? value
    : null;
}

function reportedServerStatus(value: unknown): ServerStatus | null {
  if (!plainRecord(value) || typeof value.id !== "string" || value.id.length > 64 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id) ||
      (value.status !== "online" && value.status !== "offline" && value.status !== "checking")) return null;
  const latencyMs = typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs) && value.latencyMs >= 0
    ? value.latencyMs
    : undefined;
  const checkedAt = typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt) && value.checkedAt > 0
    ? value.checkedAt
    : undefined;
  const error = typeof value.error === "string" ? value.error.slice(0, 1024) : undefined;
  const capabilities = plainRecord(value.capabilities)
    ? value.capabilities as ServerStatus["capabilities"]
    : undefined;
  return {
    id: value.id,
    status: value.status,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(checkedAt !== undefined ? { checkedAt } : {}),
    ...(error !== undefined ? { error } : {}),
    appServerVersion: reportedBuildVersion(value.appServerVersion),
    protocolVersion: reportedProtocolVersion(value.protocolVersion),
    ...(capabilities ? { capabilities } : {}),
  };
}

export async function getServerStatusSnapshot(
  profile: GatewayProfile,
): Promise<GatewayServerStatusSnapshot> {
  const payload = await gatewayRequest<{ gatewayRuntimeVersion?: unknown; statuses?: unknown }>(
    profile,
    "/api/servers/status",
  );
  const statuses = Array.isArray(payload.statuses)
    ? payload.statuses.map(reportedServerStatus).filter((status): status is ServerStatus => status !== null)
    : [];
  return {
    gatewayRuntimeVersion: reportedBuildVersion(payload.gatewayRuntimeVersion),
    statuses,
  };
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

export async function revokeMobileSession(profile: GatewayProfile, signal?: AbortSignal): Promise<void> {
  let transportUrl: string | undefined;
  try {
    // Also used to roll back a pairing response before it enters the profile store.
    throwIfRequestAborted(signal);
    transportUrl = await resolveGatewayRouteWithDeadline(profile, signal);
    throwIfRequestAborted(signal);
    const timeout = timedRequestController(signal, GATEWAY_HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await gatewayTransportFetch(`${transportUrl}/api/mobile/session`, { method: "DELETE", credentials: "omit", headers: { authorization: `Bearer ${profile.accessToken}` }, signal: timeout.controller.signal });
    } catch (error) {
      if (signal?.aborted) throwIfRequestAborted(signal);
      invalidateGatewayRoute(profile, transportUrl);
      throw error;
    } finally {
      timeout.dispose();
    }
    if (response.status === 401) throw new GatewaySessionExpiredError();
    if (!response.ok) throw await readError(response, timeout.controller.signal);
  } finally {
    invalidateGatewayRoute(profile);
    releasePeerTransports(profile);
  }
}

export { normalizedBaseUrl };

/** WebSocket errors do not expose HTTP status on native clients. Only an explicit
 * authenticated HTTP 401 can distinguish revoked login from an offline target. */
export async function gatewaySessionExpired(profile: GatewayProfile): Promise<boolean> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), GATEWAY_HTTP_TIMEOUT_MS);
  try { await gatewayRequest(profile, "/api/servers", { signal: controller.signal }); return false; }
  catch (error) {
    if (!(error instanceof GatewaySessionExpiredError)) return false;
    const witness = sessionExpiredWitnesses.get(error);
    return Boolean(witness && denialWitnessMatchesProfile(witness, profile) &&
      (!authorizationDenialChecker || authorizationDenialChecker(witness)));
  }
  finally { clearTimeout(timer); }
}
