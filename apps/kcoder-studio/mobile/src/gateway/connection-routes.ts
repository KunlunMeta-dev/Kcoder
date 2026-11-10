import { ed25519 } from "@noble/curves/ed25519";
import { Platform } from "react-native";
import {
  canonicalGatewayConnectionUrl,
  connectionProofMessage,
  parseGatewayConnectionRoutes,
} from "../../../shared/gatewayConnectionRoutes.js";
import { digestGatewayRouteBytes, getGatewayRouteRandomBytes } from "./connection-route-crypto";
import {
  invalidatePeerTransport,
  isPeerTransportAlive,
  isPeerTransportUrl,
  releasePeerTransports,
  tryCreatePeerTransport,
} from "./peer-transport";
import type { GatewayProfile } from "./types";

export type GatewayConnectionRoutes = NonNullable<
  ReturnType<typeof parseGatewayConnectionRoutes>
>;

export type GatewayRouteErrorCode =
  | "GATEWAY_ROUTE_DESCRIPTOR_INVALID"
  | "GATEWAY_ROUTE_UNAVAILABLE"
  | "GATEWAY_ROUTE_CANCELLED";

export type GatewayRouteFailure =
  | "descriptor" | "key_digest" | "nonce" | "network" | "http"
  | "body" | "identity" | "signature" | "timeout";

export class GatewayRouteResolutionError extends Error {
  readonly failure?: GatewayRouteFailure;
  readonly status?: number;

  constructor(readonly code: GatewayRouteErrorCode, message: string,
    options?: { failure?: GatewayRouteFailure; status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "GatewayRouteResolutionError";
    this.failure = options?.failure;
    this.status = options?.status;
  }
}

export interface GatewayRouteSnapshot {
  url: string;
  kind: "peer" | "public";
  verifiedAt: number;
  expiresAt: number;
}

export interface GatewayRouteResolveOptions {
  signal?: AbortSignal;
  force?: boolean;
}

const MAX_ROUTE_CANDIDATES = 8;
const PUBLIC_PROBE_BUDGET_MS = 5_000;
const FIRST_PAIRING_PROBE_BUDGET_MS = 30_000;
const ROUTE_CACHE_TTL_MS = 15_000;
const FAILED_ROUTE_COOLDOWN_MS = 5_000;
const PEER_ROUTE_COOLDOWN_KEY = "kcoder-p2p://scope";

type RouteCandidate = GatewayConnectionRoutes["endpoints"][number];
type ProbeOutcome = { candidate: RouteCandidate; valid: boolean; error?: GatewayRouteResolutionError };
type RouteFlight = {
  key: string;
  revision: number;
  controller: AbortController;
  waiters: Set<symbol>;
  settled: boolean;
  promise: Promise<GatewayRouteSnapshot>;
};

const routeCache = new Map<string, GatewayRouteSnapshot>();
const knownPeerRoutes = new Map<string, string>();
const routeFlights = new Map<string, RouteFlight>();
const routeRevisions = new Map<string, number>();
const failedRouteUntil = new Map<string, Map<string, number>>();
const observedProfileScopes = new Map<string, {
  authorizationScope: string;
  routeKey?: string;
  baseUrl: string;
  deviceId?: string;
  authorizationGeneration?: string;
  authMode: NonNullable<GatewayProfile["authMode"]>;
}>();

function descriptorIdentity(descriptor: GatewayConnectionRoutes): string {
  return JSON.stringify([
    descriptor.version,
    descriptor.gatewayId,
    descriptor.publicKey,
    descriptor.endpoints.map(({ kind, url }) => [kind, url]),
  ]);
}

function gatewayAuthorizationScope(profile: GatewayProfile, descriptor: GatewayConnectionRoutes): string {
  return JSON.stringify([
    profile.id,
    profile.baseUrl,
    profile.deviceId ?? "",
    profile.authorizationGeneration ?? `legacy:${profile.id}`,
    profile.authMode ?? "legacy",
    descriptor.gatewayId,
    descriptor.publicKey,
  ]);
}

function routeCacheKey(profile: GatewayProfile, descriptor: GatewayConnectionRoutes): string {
  return JSON.stringify([
    gatewayAuthorizationScope(profile, descriptor),
    descriptorIdentity(descriptor),
  ]);
}

function observeProfileScope(profile: GatewayProfile, descriptor?: GatewayConnectionRoutes): void {
  const ownerKey = profile.id;
  const authorizationScope = JSON.stringify([
    profile.baseUrl,
    profile.deviceId ?? "",
    profile.authorizationGeneration ?? `legacy:${profile.id}`,
    profile.authMode ?? "legacy",
    descriptor ? descriptorIdentity(descriptor) : "no-routes",
  ]);
  const nextRouteKey = descriptor ? routeCacheKey(profile, descriptor) : undefined;
  const previous = observedProfileScopes.get(ownerKey);
  if (previous && previous.authorizationScope !== authorizationScope) {
    if (previous.routeKey) {
      routeCache.delete(previous.routeKey);
      knownPeerRoutes.delete(previous.routeKey);
      failedRouteUntil.delete(previous.routeKey);
      const flight = routeFlights.get(previous.routeKey);
      if (flight) abortFlight(flight);
    }
    releasePeerTransports({
      profileId: profile.id,
      baseUrl: previous.baseUrl,
      ...(previous.deviceId !== undefined ? { deviceId: previous.deviceId } : {}),
      ...(previous.authorizationGeneration !== undefined
        ? { authorizationGeneration: previous.authorizationGeneration }
        : {}),
      authMode: previous.authMode,
    });
  }
  observedProfileScopes.set(ownerKey, {
    authorizationScope,
    baseUrl: profile.baseUrl,
    ...(nextRouteKey ? { routeKey: nextRouteKey } : {}),
    ...(profile.deviceId !== undefined ? { deviceId: profile.deviceId } : {}),
    ...(profile.authorizationGeneration !== undefined
      ? { authorizationGeneration: profile.authorizationGeneration }
      : {}),
    authMode: profile.authMode ?? "legacy",
  });
}

function bumpRevision(key: string): number {
  const revision = (routeRevisions.get(key) ?? 0) + 1;
  routeRevisions.set(key, revision);
  return revision;
}

function cancelledError(): GatewayRouteResolutionError {
  return new GatewayRouteResolutionError(
    "GATEWAY_ROUTE_CANCELLED",
    "Gateway route selection was cancelled",
  );
}

function unavailableError(failure?: GatewayRouteFailure, cause?: unknown, status?: number): GatewayRouteResolutionError {
  return new GatewayRouteResolutionError(
    "GATEWAY_ROUTE_UNAVAILABLE",
    "No advertised Gateway route passed the connection proof",
    { failure, cause, status },
  );
}

function descriptorError(): GatewayRouteResolutionError {
  return new GatewayRouteResolutionError(
    "GATEWAY_ROUTE_DESCRIPTOR_INVALID",
    "Gateway connection descriptor is invalid",
    { failure: "descriptor" },
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

export function normalizeGatewayConnectionRoutes(
  value: unknown,
): GatewayConnectionRoutes | undefined {
  const descriptor = parseGatewayConnectionRoutes(value);
  return descriptor && descriptor.endpoints.length > 0 ? descriptor : undefined;
}

function bytesFromHex(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function hexFromBytes(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}

function asciiBytes(value: string): Uint8Array | undefined {
  const result = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) return undefined;
    result[index] = code;
  }
  return result;
}

async function descriptorHasMatchingKeyIdentity(
  descriptor: GatewayConnectionRoutes,
): Promise<boolean> {
  const publicKey = bytesFromHex(descriptor.publicKey);
  if (publicKey.length !== 32) return false;
  const rawKeyBuffer = new ArrayBuffer(publicKey.byteLength);
  new Uint8Array(rawKeyBuffer).set(publicKey);
  let digestBytes: Uint8Array;
  try { digestBytes = await digestGatewayRouteBytes(rawKeyBuffer); }
  catch (error) { throw unavailableError("key_digest", error); }
  return hexFromBytes(digestBytes) === descriptor.gatewayId;
}

function httpCandidateAllowed(url: URL): boolean {
  if (Platform.OS === "web") {
    const browserProtocol = typeof globalThis.location === "undefined"
      ? undefined
      : globalThis.location.protocol;
    if (browserProtocol === "https:") return url.protocol === "https:";
    if (browserProtocol === "http:") return url.protocol === "http:" || url.protocol === "https:";
    return url.protocol === "https:";
  }

  const nativeDevelopmentHttpAllowed =
    process.env.KCODER_STUDIO_ALLOW_HTTP === "1" &&
    process.env.EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP === "1";
  return url.protocol === "https:" ||
    (url.protocol === "http:" && nativeDevelopmentHttpAllowed);
}

function permittedCandidates(descriptor: GatewayConnectionRoutes): RouteCandidate[] {
  return descriptor.endpoints
    .slice(0, MAX_ROUTE_CANDIDATES)
    .filter(candidate => {
      try {
        return httpCandidateAllowed(new URL(candidate.url));
      } catch {
        return false;
      }
    });
}

function isCoolingDown(key: string, url: string, now = Date.now()): boolean {
  const cooldowns = failedRouteUntil.get(key);
  if (!cooldowns) return false;
  const until = cooldowns.get(url);
  if (until === undefined) return false;
  if (until <= now) {
    cooldowns.delete(url);
    if (cooldowns.size === 0) failedRouteUntil.delete(key);
    return false;
  }
  return true;
}

function setPeerCooldown(key: string): void {
  const cooldowns = failedRouteUntil.get(key) ?? new Map<string, number>();
  cooldowns.set(PEER_ROUTE_COOLDOWN_KEY, Date.now() + FAILED_ROUTE_COOLDOWN_MS);
  failedRouteUntil.set(key, cooldowns);
}

function clearPeerCooldown(key: string): void {
  const cooldowns = failedRouteUntil.get(key);
  if (!cooldowns) return;
  cooldowns.delete(PEER_ROUTE_COOLDOWN_KEY);
  if (cooldowns.size === 0) failedRouteUntil.delete(key);
}

async function selectPeerOrPublicRoute(
  profile: GatewayProfile,
  descriptor: GatewayConnectionRoutes,
  publicCandidate: RouteCandidate,
  key: string,
  signal: AbortSignal,
): Promise<{ url: string; kind: "peer" | "public" }> {
  if (publicCandidate.kind !== "public" || isCoolingDown(key, PEER_ROUTE_COOLDOWN_KEY)) {
    return { url: publicCandidate.url, kind: "public" };
  }

  try {
    const peerUrl = await tryCreatePeerTransport(profile, descriptor, publicCandidate.url, { signal });
    if (signal.aborted) throw cancelledError();
    if (peerUrl && isPeerTransportUrl(peerUrl)) {
      clearPeerCooldown(key);
      return { url: peerUrl, kind: "peer" };
    }
  } catch {
    if (signal.aborted) throw cancelledError();
  }

  setPeerCooldown(key);
  return { url: publicCandidate.url, kind: "public" };
}

async function selectProfileRoute(
  profile: GatewayProfile,
  descriptor: GatewayConnectionRoutes,
  candidates: RouteCandidate[],
  key: string,
  signal: AbortSignal,
): Promise<RouteCandidate | { url: string; kind: "peer" | "public" }> {
  const knownPeerUrl = knownPeerRoutes.get(key);
  if (knownPeerUrl && isPeerTransportAlive(knownPeerUrl)) return { url: knownPeerUrl, kind: "peer" };
  if (knownPeerUrl) {
    knownPeerRoutes.delete(key);
    invalidatePeerTransport(knownPeerUrl);
    setPeerCooldown(key);
  }
  const selected = await selectVerifiedCandidate(
    descriptor, candidates, signal, candidate => !isCoolingDown(key, candidate.url),
  );
  return selectPeerOrPublicRoute(profile, descriptor, selected, key, signal);
}

function routeMatchesProfileScope(
  profile: GatewayProfile,
  key: string,
): boolean {
  const currentDescriptor = profile.connectionRoutes === undefined
    ? undefined
    : normalizeGatewayConnectionRoutes(profile.connectionRoutes);
  return currentDescriptor !== undefined && routeCacheKey(profile, currentDescriptor) === key;
}

function abortFlight(flight: RouteFlight): void {
  if (flight.settled) return;
  flight.controller.abort();
  if (routeFlights.get(flight.key) === flight) {
    routeFlights.delete(flight.key);
    bumpRevision(flight.key);
  }
}

function joinFlight(flight: RouteFlight, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    if (flight.waiters.size === 0) abortFlight(flight);
    return Promise.reject(cancelledError());
  }
  const waiter = Symbol("gateway-route-waiter");
  flight.waiters.add(waiter);

  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      flight.waiters.delete(waiter);
      if (!flight.settled && flight.waiters.size === 0) abortFlight(flight);
    };
    const onAbort = () => {
      finish();
      reject(cancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(
      snapshot => {
        finish();
        resolve(snapshot.url);
      },
      error => {
        finish();
        reject(error instanceof GatewayRouteResolutionError ? error : unavailableError());
      },
    );
  });
}

function nextProbeResult(
  pending: Promise<ProbeOutcome>[],
  delayMs: number,
  signal: AbortSignal,
): Promise<{ type: "probe"; value: ProbeOutcome } | { type: "timeout" }> {
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      finish();
      resolve({ type: "timeout" });
    }, Math.max(1, delayMs));
    const onAbort = () => {
      finish();
      reject(cancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.race(pending).then(
      value => {
        finish();
        resolve({ type: "probe", value });
      },
      () => {
        finish();
        resolve({ type: "timeout" });
      },
    );
  });
}

async function verifyCandidateProof(
  descriptor: GatewayConnectionRoutes,
  candidate: RouteCandidate,
  signal: AbortSignal,
): Promise<boolean> {
  let nonce: string;
  try { nonce = hexFromBytes(await getGatewayRouteRandomBytes(24)); }
  catch (error) { throw unavailableError("nonce", error); }
  const requestUrl = new URL(`${candidate.url}/api/mobile/connection-proof`);
  requestUrl.searchParams.set("nonce", nonce);
  requestUrl.searchParams.set("endpoint", candidate.url);

  let response: Response;
  try {
    response = await fetch(requestUrl.toString(), {
      method: "GET",
      credentials: "omit",
      headers: {
        accept: "application/json",
      },
      signal,
    });
  } catch (error) {
    throw unavailableError("network", error);
  }
  if (!response.ok) throw unavailableError("http", undefined, response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw unavailableError("body", error);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw unavailableError("body");
  const proof = payload as Record<string, unknown>;
  if (proof.version !== 1 || proof.gatewayId !== descriptor.gatewayId ||
      proof.nonce !== nonce || proof.endpoint !== candidate.url ||
      typeof proof.signature !== "string" || !/^[a-f0-9]{128}$/.test(proof.signature)) throw unavailableError("identity");

  const message = asciiBytes(connectionProofMessage(descriptor.gatewayId, nonce, candidate.url));
  if (!message) throw unavailableError("identity");
  try {
    const valid = ed25519.verify(
      bytesFromHex(proof.signature),
      message,
      bytesFromHex(descriptor.publicKey),
    );
    if (!valid) throw unavailableError("signature");
    return true;
  } catch (error) {
    if (error instanceof GatewayRouteResolutionError) throw error;
    throw unavailableError("signature", error);
  }
}

async function selectVerifiedCandidate(
  descriptor: GatewayConnectionRoutes,
  candidates: RouteCandidate[],
  signal: AbortSignal,
  candidateAllowed: (candidate: RouteCandidate) => boolean = () => true,
  budgetMs = PUBLIC_PROBE_BUDGET_MS,
  retryPublic = false,
): Promise<RouteCandidate> {
  if (signal.aborted) throw cancelledError();
  const probeController = new AbortController();
  const abortProbes = () => probeController.abort();
  signal.addEventListener("abort", abortProbes, { once: true });
  const startedAt = Date.now();
  const pending = new Map<RouteCandidate, Promise<ProbeOutcome>>();
  const retry = new Set(retryPublic ? candidates.filter(candidate => candidate.kind === "public") : []);
  let lastFailure: GatewayRouteResolutionError | undefined;
  for (const candidate of candidates) {
    pending.set(candidate, verifyCandidateProof(descriptor, candidate, probeController.signal)
      .then(valid => ({ candidate, valid }))
      .catch(error => ({ candidate, valid: false,
        error: error instanceof GatewayRouteResolutionError ? error : unavailableError(undefined, error) })));
  }
  try {
    while (pending.size > 0) {
      if (signal.aborted) throw cancelledError();
      const remainingBudget = budgetMs - (Date.now() - startedAt);
      if (remainingBudget <= 0) { lastFailure = unavailableError("timeout"); break; }
      const result = await nextProbeResult([...pending.values()], remainingBudget, signal);
      if (result.type === "timeout") { lastFailure = unavailableError("timeout"); break; }
      const { candidate, valid } = result.value;
      pending.delete(candidate);
      if (valid && candidateAllowed(candidate)) return candidate;
      if (result.value.error) {
        lastFailure = result.value.error;
        if (lastFailure.failure !== "network") retry.delete(candidate);
      }
    }
    const retryBudget = FIRST_PAIRING_PROBE_BUDGET_MS - (Date.now() - startedAt);
    if (retry.size && retryBudget > 0) {
      return selectVerifiedCandidate(descriptor, [...retry], signal, candidateAllowed, retryBudget);
    }
    throw lastFailure ?? unavailableError();
  } finally {
    signal.removeEventListener("abort", abortProbes);
    probeController.abort();
  }
}

function startRouteFlight(
  profile: GatewayProfile,
  descriptor: GatewayConnectionRoutes,
  key: string,
): RouteFlight {
  const controller = new AbortController();
  const revision = bumpRevision(key);
  let flight!: RouteFlight;
  const promise = Promise.resolve().then(async () => {
    if (!await descriptorHasMatchingKeyIdentity(descriptor)) throw descriptorError();
    const candidates = permittedCandidates(descriptor)
      .filter(candidate => !isCoolingDown(key, candidate.url));
    if (candidates.length === 0) throw unavailableError();

    const route = await selectProfileRoute(profile, descriptor, candidates, key, controller.signal);
    if (controller.signal.aborted || routeFlights.get(key) !== flight ||
        routeRevisions.get(key) !== revision || !routeMatchesProfileScope(profile, key)) {
      if (route.kind === "peer" && isPeerTransportUrl(route.url)) invalidatePeerTransport(route.url);
      throw cancelledError();
    }
    if (route.kind === "peer") knownPeerRoutes.set(key, route.url);
    if (isPeerTransportUrl(route.url) ? isCoolingDown(key, PEER_ROUTE_COOLDOWN_KEY) : isCoolingDown(key, route.url))
      throw unavailableError();
    const verifiedAt = Date.now();
    const snapshot: GatewayRouteSnapshot = {
      url: route.url,
      kind: route.kind,
      verifiedAt,
      expiresAt: verifiedAt + ROUTE_CACHE_TTL_MS,
    };
    routeCache.set(key, snapshot);
    return snapshot;
  }).finally(() => {
    flight.settled = true;
    if (routeFlights.get(key) === flight) routeFlights.delete(key);
  });
  flight = { key, revision, controller, waiters: new Set(), settled: false, promise };
  routeFlights.set(key, flight);
  return flight;
}

export async function resolveGatewayRoute(
  profile: GatewayProfile,
  options: GatewayRouteResolveOptions = {},
): Promise<string> {
  throwIfAborted(options.signal);
  if (profile.connectionRoutes === undefined) {
    observeProfileScope(profile);
    return profile.baseUrl;
  }
  const descriptor = normalizeGatewayConnectionRoutes(profile.connectionRoutes);
  if (!descriptor) throw descriptorError();
  observeProfileScope(profile, descriptor);
  const key = routeCacheKey(profile, descriptor);
  let cached = routeCache.get(key);
  if (cached?.kind === "peer" && !isPeerTransportAlive(cached.url)) {
    routeCache.delete(key);
    if (knownPeerRoutes.get(key) === cached.url) knownPeerRoutes.delete(key);
    invalidatePeerTransport(cached.url);
    setPeerCooldown(key);
    cached = undefined;
  }
  if (!options.force && cached && cached.expiresAt > Date.now() &&
      !isCoolingDown(key, cached.url)) return cached.url;
  if (cached) routeCache.delete(key);

  let flight = routeFlights.get(key);
  if (!flight) flight = startRouteFlight(profile, descriptor, key);
  return joinFlight(flight, options.signal);
}

export function invalidateGatewayRoute(profile: GatewayProfile, failedUrl?: string): void {
  if (profile.connectionRoutes === undefined) return;
  const descriptor = normalizeGatewayConnectionRoutes(profile.connectionRoutes);
  if (!descriptor) return;
  const key = routeCacheKey(profile, descriptor);
  if (failedUrl !== undefined) {
    if (isPeerTransportUrl(failedUrl)) {
      invalidatePeerTransport(failedUrl);
      setPeerCooldown(key);
      if (knownPeerRoutes.get(key) === failedUrl) knownPeerRoutes.delete(key);
      if (routeCache.get(key)?.url === failedUrl) routeCache.delete(key);
      return;
    }
    if (!descriptor.endpoints.some(endpoint => endpoint.url === failedUrl)) return;
    if (!isCoolingDown(key, failedUrl)) {
      const cooldowns = failedRouteUntil.get(key) ?? new Map<string, number>();
      cooldowns.set(failedUrl, Date.now() + FAILED_ROUTE_COOLDOWN_MS);
      failedRouteUntil.set(key, cooldowns);
    }
    if (routeCache.get(key)?.url === failedUrl) routeCache.delete(key);
    return;
  }

  routeCache.delete(key);
  knownPeerRoutes.delete(key);
  observedProfileScopes.delete(profile.id);
  const flight = routeFlights.get(key);
  if (flight) abortFlight(flight);
  releasePeerTransports(profile);
}

export function getGatewayRouteSnapshot(
  profile: GatewayProfile,
): GatewayRouteSnapshot | undefined {
  if (profile.connectionRoutes === undefined) return undefined;
  const descriptor = normalizeGatewayConnectionRoutes(profile.connectionRoutes);
  if (!descriptor) return undefined;
  const key = routeCacheKey(profile, descriptor);
  const snapshot = routeCache.get(key);
  if (!snapshot || snapshot.expiresAt <= Date.now() || isCoolingDown(key, snapshot.url) ||
      (snapshot.kind === "peer" && !isPeerTransportAlive(snapshot.url))) return undefined;
  return { ...snapshot };
}

export async function selectPairingGatewayRoute(
  baseUrl: string,
  descriptorValue: unknown,
  signal?: AbortSignal,
  peerScope?: GatewayProfile,
  pairingToken?: string,
): Promise<string> {
  throwIfAborted(signal);
  if (descriptorValue == null) return baseUrl;
  const descriptor = normalizeGatewayConnectionRoutes(descriptorValue);
  if (!descriptor) throw descriptorError();
  const canonicalBaseUrl = canonicalGatewayConnectionUrl(baseUrl);
  if (canonicalBaseUrl !== baseUrl || !descriptor.endpoints.some(endpoint => endpoint.url === canonicalBaseUrl)) {
    throw descriptorError();
  }
  if (!await descriptorHasMatchingKeyIdentity(descriptor)) throw descriptorError();
  const candidates = permittedCandidates(descriptor);
  if (candidates.length === 0) throw unavailableError();
  const selected = await selectVerifiedCandidate(
    descriptor, candidates, signal ?? new AbortController().signal, undefined, PUBLIC_PROBE_BUDGET_MS, true,
  );
  if (peerScope && pairingToken !== undefined) {
    const peerDescriptor = peerScope.connectionRoutes === undefined
      ? undefined
      : normalizeGatewayConnectionRoutes(peerScope.connectionRoutes);
    if (!peerDescriptor || descriptorIdentity(peerDescriptor) !== descriptorIdentity(descriptor)) throw descriptorError();
    try {
      const peerUrl = await tryCreatePeerTransport(peerScope, descriptor, selected.url, {
        signal,
        auth: { kind: "pairing", token: pairingToken },
      });
      throwIfAborted(signal);
      if (peerUrl && isPeerTransportUrl(peerUrl)) return peerUrl;
    } catch {
      throwIfAborted(signal);
      // Pairing can use the signed public route only if peer setup failed before
      // the session POST is dispatched. The caller sends that POST exactly once.
    }
  }
  return selected.url;
}
