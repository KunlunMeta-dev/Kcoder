import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import * as routeCrypto from "./connection-route-crypto";
import { connectionProofMessage } from "../../../shared/gatewayConnectionRoutes.js";
import type { GatewayProfile } from "./types";

const peerApi = vi.hoisted(() => ({
  tryCreate: vi.fn(),
  invalidate: vi.fn(),
  alive: vi.fn(() => true),
  release: vi.fn(),
}));

vi.mock("./connection-route-crypto", async () => {
  const { createHash: hash } = await import("node:crypto");
  let randomByte = 0;
  return {
    digestGatewayRouteBytes: async (data: ArrayBuffer) => new Uint8Array(
      hash("sha256").update(new Uint8Array(data)).digest(),
    ),
    getGatewayRouteRandomBytes: async (count: number) => new Uint8Array(count).fill(++randomByte),
  };
});

vi.mock("./peer-transport", () => ({
  tryCreatePeerTransport: peerApi.tryCreate,
  isPeerTransportUrl: (value: string) => value.startsWith("kcoder-p2p://"),
  invalidatePeerTransport: peerApi.invalidate,
  isPeerTransportAlive: peerApi.alive,
  createPeerSocket: vi.fn(),
  peerFetch: vi.fn(),
  releasePeerTransports: peerApi.release,
}));

import {
  normalizeGatewayConnectionRoutes,
  getGatewayRouteSnapshot,
  invalidateGatewayRoute,
  resolveGatewayRoute,
  selectPairingGatewayRoute,
} from "./connection-routes";

const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKeyBytes = ed25519.getPublicKey(privateKey);
const publicKey = Array.from(publicKeyBytes, byte => byte.toString(16).padStart(2, "0")).join("");
const gatewayId = createHash("sha256").update(publicKeyBytes).digest("hex");
const alternateUrl = "https://alternate-relay.example/g/route-a";
const publicUrl = "https://public.example/g/route-a";
const peerUrl = "kcoder-p2p://route-test-session";
let profileSequence = 0;

function descriptor(endpoints: { kind: "public"; url: string }[]) {
  return { version: 1 as const, gatewayId, publicKey, endpoints };
}

function profile(connectionRoutes?: ReturnType<typeof descriptor>): GatewayProfile {
  profileSequence += 1;
  return {
    id: `route-test-${profileSequence}`,
    label: "Route test",
    baseUrl: publicUrl,
    accessToken: "must-not-be-used-by-probes",
    expiresAt: Date.now() + 60_000,
    rpcToken: "must-not-be-used-by-probes",
    authorizationGeneration: "generation-a",
    authMode: "device",
    deviceId: "device-a",
    ...(connectionRoutes ? { connectionRoutes } : {}),
  };
}

function toAsciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, character => character.charCodeAt(0));
}

function signedPayload(
  endpoint: string,
  nonce: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const message = connectionProofMessage(gatewayId, nonce, endpoint);
  const signature = ed25519.sign(toAsciiBytes(message), privateKey);
  const signatureHex = Array.from(signature, byte => byte.toString(16).padStart(2, "0")).join("");
  return {
    version: 1,
    gatewayId,
    nonce,
    endpoint,
    signature: signatureHex,
    ...overrides,
  };
}

function proofResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installSignedFetch(
  options: {
    publicDelayMs?: number;
    tamper?: (endpoint: string, nonce: string, payload: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(String(input));
    const endpoint = requestUrl.searchParams.get("endpoint")!;
    const nonce = requestUrl.searchParams.get("nonce")!;
    if (endpoint === publicUrl && options.publicDelayMs) {
      await new Promise(resolve => setTimeout(resolve, options.publicDelayMs));
    }
    const payload = signedPayload(endpoint, nonce);
    return proofResponse(options.tamper?.(endpoint, nonce, payload) ?? payload);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function expectNoCredentials(fetchMock: ReturnType<typeof installSignedFetch>): void {
  for (const [input, init] of fetchMock.mock.calls) {
    expect(String(input)).not.toMatch(/accessToken|rpcToken|Bearer/i);
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("omit");
    expect(init?.headers).not.toHaveProperty("authorization");
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  peerApi.tryCreate.mockReset().mockResolvedValue(undefined);
  peerApi.invalidate.mockReset();
  peerApi.alive.mockReset().mockReturnValue(true);
  peerApi.release.mockReset();
});

describe("Gateway connection route selection", () => {
  it.each([403, 502])("retains the proof HTTP status %i without accepting the route", async status => {
    const request = vi.fn(async () => new Response("private proxy error", { status }));
    vi.stubGlobal("fetch", request);
    await expect(selectPairingGatewayRoute(publicUrl, descriptor([{ kind: "public", url: publicUrl }])))
      .rejects.toMatchObject({ code: "GATEWAY_ROUTE_UNAVAILABLE", failure: "http", status });
    expect(request).toHaveBeenCalledOnce();
    expectNoCredentials(request as ReturnType<typeof installSignedFetch>);
  });

  it("distinguishes native key hashing failures before making a proof request", async () => {
    const cause = new Error("native digest failed");
    vi.spyOn(routeCrypto, "digestGatewayRouteBytes").mockRejectedValueOnce(cause);
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(selectPairingGatewayRoute(publicUrl, descriptor([{ kind: "public", url: publicUrl }])))
      .rejects.toMatchObject({ failure: "key_digest", cause });
    expect(request).not.toHaveBeenCalled();
  });

  it("distinguishes a failed proof request from invalid response data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network request failed"); }));
    await expect(selectPairingGatewayRoute(publicUrl, descriptor([{ kind: "public", url: publicUrl }])))
      .rejects.toMatchObject({ failure: "network" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON")));
    await expect(selectPairingGatewayRoute(publicUrl, descriptor([{ kind: "public", url: publicUrl }])))
      .rejects.toMatchObject({ failure: "body" });
  });

  it("requires a valid Ed25519 proof bound to descriptor identity, nonce, and endpoint", async () => {
    const forged = installSignedFetch({
      tamper: (_endpoint, _nonce, payload) => ({ ...payload, signature: "0".repeat(128) }),
    });
    await expect(resolveGatewayRoute(profile(descriptor([{ kind: "public", url: publicUrl }]))))
      .rejects.toMatchObject({ code: "GATEWAY_ROUTE_UNAVAILABLE", failure: "signature" });
    expectNoCredentials(forged);

    const wrongIdentity = descriptor([{ kind: "public", url: publicUrl }]);
    wrongIdentity.gatewayId = "f".repeat(64);
    const noProbe = vi.fn();
    vi.stubGlobal("fetch", noProbe);
    await expect(resolveGatewayRoute(profile(wrongIdentity)))
      .rejects.toMatchObject({ code: "GATEWAY_ROUTE_DESCRIPTOR_INVALID" });
    expect(noProbe).not.toHaveBeenCalled();
  });

  it("rejects replayed nonce and a proof for a different endpoint", async () => {
    const replay = installSignedFetch({
      tamper: (_endpoint, _nonce, payload) => ({
        ...payload,
        ...signedPayload(publicUrl, "0".repeat(48)),
      }),
    });
    await expect(resolveGatewayRoute(profile(descriptor([{ kind: "public", url: publicUrl }]))))
      .rejects.toMatchObject({ code: "GATEWAY_ROUTE_UNAVAILABLE" });
    expect(replay).toHaveBeenCalledTimes(1);

    const wrongEndpoint = installSignedFetch({
      tamper: (_endpoint, nonce, payload) => ({
        ...payload,
        ...signedPayload("https://other.example/g/route-a", nonce),
      }),
    });
    await expect(resolveGatewayRoute(profile(descriptor([{ kind: "public", url: publicUrl }]))))
      .rejects.toMatchObject({ code: "GATEWAY_ROUTE_UNAVAILABLE" });
    expect(wrongEndpoint).toHaveBeenCalledTimes(1);
  });

  it("accepts a correctly signed public proof that takes multiple seconds", async () => {
    const fetchMock = installSignedFetch({ publicDelayMs: 1_900 });
    const startedAt = Date.now();

    await expect(resolveGatewayRoute(profile(descriptor([{ kind: "public", url: publicUrl }]))))
      .resolves.toBe(publicUrl);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_800);
    expect(fetchMock).toHaveBeenCalledOnce();
    expectNoCredentials(fetchMock);
  });

  it("still rejects an invalid public signature after a delayed proof response", async () => {
    const fetchMock = installSignedFetch({
      publicDelayMs: 1_900,
      tamper: (_endpoint, _nonce, payload) => ({ ...payload, signature: "0".repeat(128) }),
    });

    await expect(resolveGatewayRoute(profile(descriptor([{ kind: "public", url: publicUrl }]))))
      .rejects.toMatchObject({ code: "GATEWAY_ROUTE_UNAVAILABLE" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expectNoCredentials(fetchMock);
  });

  it("keeps public proof probing bounded to five seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const pending = resolveGatewayRoute(profile(descriptor([{ kind: "public", url: publicUrl }])));
    const rejected = expect(pending).rejects.toMatchObject({ code: "GATEWAY_ROUTE_UNAVAILABLE" });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("discards retired LAN candidates before probing or attempting P2P", async () => {
    const raw = { version: 1, gatewayId, publicKey, endpoints: [
      { kind: "lan", url: "https://192.168.1.20" }, { kind: "public", url: publicUrl },
    ] };
    const routes = normalizeGatewayConnectionRoutes(raw)!;
    expect(routes.endpoints).toEqual([{ kind: "public", url: publicUrl }]);
    const fetchMock = installSignedFetch();
    peerApi.tryCreate.mockResolvedValueOnce(peerUrl);
    await expect(resolveGatewayRoute(profile(routes))).resolves.toBe(peerUrl);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(String(fetchMock.mock.calls[0][0])).origin).toBe(new URL(publicUrl).origin);
  });


  it("prefers a signed-peer route over the verified public Relay route", async () => {
    const current = profile(descriptor([{ kind: "public", url: publicUrl }]));
    const fetchMock = installSignedFetch();
    peerApi.tryCreate.mockResolvedValueOnce(peerUrl);

    await expect(resolveGatewayRoute(current)).resolves.toBe(peerUrl);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peerApi.tryCreate).toHaveBeenCalledOnce();
    expect(peerApi.tryCreate).toHaveBeenCalledWith(current, current.connectionRoutes, publicUrl, {
      signal: expect.any(AbortSignal),
    });
    expect(getGatewayRouteSnapshot(current)).toMatchObject({ url: peerUrl, kind: "peer" });
  });

  it("falls back to a verified public Relay when peer negotiation fails", async () => {
    const current = profile(descriptor([{ kind: "public", url: publicUrl }]));
    installSignedFetch();
    peerApi.tryCreate.mockRejectedValueOnce(new Error("peer negotiation unavailable"));

    await expect(resolveGatewayRoute(current)).resolves.toBe(publicUrl);

    expect(peerApi.tryCreate).toHaveBeenCalledOnce();
    expect(getGatewayRouteSnapshot(current)).toMatchObject({ url: publicUrl, kind: "public" });
    expect(await resolveGatewayRoute(current)).toBe(publicUrl);
    expect(peerApi.tryCreate).toHaveBeenCalledOnce();
  });

  it("reuses an alive peer after cache expiry without probing any HTTP endpoint", async () => {
    const current = profile(descriptor([{ kind: "public", url: publicUrl }]));
    installSignedFetch();
    peerApi.tryCreate.mockResolvedValueOnce(peerUrl);
    await expect(resolveGatewayRoute(current)).resolves.toBe(peerUrl);
    vi.useFakeTimers();
    current.accessToken = "rotated-access-token";
    await vi.advanceTimersByTimeAsync(15_001);
    const proofFetch = vi.fn();
    vi.stubGlobal("fetch", proofFetch);
    await expect(resolveGatewayRoute(current)).resolves.toBe(peerUrl);
    expect(proofFetch).not.toHaveBeenCalled();
    expect(peerApi.tryCreate).toHaveBeenCalledOnce();
  });

  it("propagates cancellation through peer setup and does not cache a late session", async () => {
    const current = profile(descriptor([{ kind: "public", url: publicUrl }]));
    installSignedFetch();
    let release!: (value: string | undefined) => void;
    let capturedSignal: AbortSignal | undefined;
    peerApi.tryCreate.mockImplementationOnce((_profile, _descriptor, _publicUrl, options) => {
      capturedSignal = options.signal;
      return new Promise(resolve => { release = resolve; });
    });
    const controller = new AbortController();
    const pending = resolveGatewayRoute(current, { signal: controller.signal });

    await vi.waitFor(() => expect(peerApi.tryCreate).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "GATEWAY_ROUTE_CANCELLED" });
    expect(capturedSignal?.aborted).toBe(true);
    release(peerUrl);
    await Promise.resolve();
    expect(getGatewayRouteSnapshot(current)).toBeUndefined();
  });

  it("does not cache cancelled or late responses after the authorization scope changes", async () => {
    let release: (() => void)[] = [];
    const pendingFetch = vi.fn((input: RequestInfo | URL) => {
      const requestUrl = new URL(String(input));
      const endpoint = requestUrl.searchParams.get("endpoint")!;
      const nonce = requestUrl.searchParams.get("nonce")!;
      return new Promise<Response>(resolve => {
        release.push(() => resolve(proofResponse(signedPayload(endpoint, nonce))));
      });
    });
    vi.stubGlobal("fetch", pendingFetch);
    const cancelledProfile = profile(descriptor([
      { kind: "public", url: alternateUrl },
      { kind: "public", url: publicUrl },
    ]));
    const controller = new AbortController();
    const cancelled = resolveGatewayRoute(cancelledProfile, { signal: controller.signal });
    await vi.waitFor(() => expect(pendingFetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "GATEWAY_ROUTE_CANCELLED" });
    release.forEach(resolve => resolve());
    await Promise.resolve();
    expect(getGatewayRouteSnapshot(cancelledProfile)).toBeUndefined();

    release = [];
    const staleProfile = profile(descriptor([{ kind: "public", url: publicUrl }]));
    const stale = resolveGatewayRoute(staleProfile);
    await vi.waitFor(() => expect(pendingFetch).toHaveBeenCalledTimes(3));
    staleProfile.authorizationGeneration = "generation-b";
    release.forEach(resolve => resolve());
    await expect(stale).rejects.toMatchObject({ code: "GATEWAY_ROUTE_CANCELLED" });
    expect(getGatewayRouteSnapshot(staleProfile)).toBeUndefined();
  });

  it("filters HTTP from secure browser contexts and keeps legacy profiles on their original URL", async () => {
    vi.stubGlobal("location", { protocol: "https:" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveGatewayRoute(profile(descriptor([
      { kind: "public", url: "http://alternate-relay.example/g/route-a" },
      { kind: "public", url: "http://public.example/g/route-a" },
    ]))))
      .rejects.toMatchObject({ code: "GATEWAY_ROUTE_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();

    const legacy = profile();
    await expect(resolveGatewayRoute(legacy)).resolves.toBe(legacy.baseUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cools down an explicitly failed verified route before force selection", async () => {
    const fetchMock = installSignedFetch();
    const current = profile(descriptor([
      { kind: "public", url: alternateUrl },
      { kind: "public", url: publicUrl },
    ]));
    await expect(resolveGatewayRoute(current)).resolves.toBe(alternateUrl);
    invalidateGatewayRoute(current, alternateUrl);
    await expect(resolveGatewayRoute(current, { force: true })).resolves.toBe(publicUrl);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("endpoint")))
      .toEqual([alternateUrl, publicUrl, publicUrl]);
  });

  it("keeps an active route flight and rejects a late proof for a newly cooled public route", async () => {
    const current = profile(descriptor([
      { kind: "public", url: alternateUrl },
      { kind: "public", url: publicUrl },
    ]));
    installSignedFetch();
    await expect(resolveGatewayRoute(current)).resolves.toBe(alternateUrl);

    let releaseAlternate!: () => void;
    let releasePublic!: () => void;
    const alternateGate = new Promise<void>(resolve => { releaseAlternate = resolve; });
    const publicGate = new Promise<void>(resolve => { releasePublic = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input));
      const endpoint = requestUrl.searchParams.get("endpoint")!;
      const nonce = requestUrl.searchParams.get("nonce")!;
      const gate = endpoint === alternateUrl ? alternateGate : publicGate;
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
        gate.then(() => resolve(proofResponse(signedPayload(endpoint, nonce))));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const reselection = resolveGatewayRoute(current, { force: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    invalidateGatewayRoute(current, alternateUrl);
    releaseAlternate();
    await Promise.resolve();
    await Promise.resolve();
    releasePublic();

    await expect(reselection).resolves.toBe(publicUrl);
    expect(getGatewayRouteSnapshot(current)).toMatchObject({ url: publicUrl, kind: "public" });
    expect(getGatewayRouteSnapshot(current)?.url).not.toBe(alternateUrl);
  });

  it("joins concurrent forced selections and repeated route invalidation does not cancel fallback", async () => {
    const current = profile(descriptor([
      { kind: "public", url: alternateUrl },
      { kind: "public", url: publicUrl },
    ]));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstFetch = installSignedFetch();
    const first = resolveGatewayRoute(current, { force: true });
    const second = resolveGatewayRoute(current, { force: true });
    await expect(Promise.all([first, second])).resolves.toEqual([alternateUrl, alternateUrl]);
    expect(firstFetch).toHaveBeenCalledTimes(2);

    invalidateGatewayRoute(current, alternateUrl);
    const fallbackFetch = vi.fn(async (input: RequestInfo | URL) => {
      await gate;
      const requestUrl = new URL(String(input));
      return proofResponse(signedPayload(
        requestUrl.searchParams.get("endpoint")!,
        requestUrl.searchParams.get("nonce")!,
      ));
    });
    vi.stubGlobal("fetch", fallbackFetch);
    const fallback = resolveGatewayRoute(current, { force: true });
    await vi.waitFor(() => expect(fallbackFetch).toHaveBeenCalledTimes(1));
    // This second invalidation must leave the already-running fallback probe intact.
    invalidateGatewayRoute(current, alternateUrl);
    const concurrentFallback = resolveGatewayRoute(current, { force: true });
    expect(fallbackFetch).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([fallback, concurrentFallback])).resolves.toEqual([publicUrl, publicUrl]);
    expect(fallbackFetch).toHaveBeenCalledTimes(1);
    invalidateGatewayRoute(current, alternateUrl);
    expect(getGatewayRouteSnapshot(current)).toMatchObject({ url: publicUrl, kind: "public" });
  });

  it("selects a trusted pairing route and preserves the base URL without a descriptor", async () => {
    installSignedFetch();
    await expect(selectPairingGatewayRoute(publicUrl, descriptor([
      { kind: "public", url: publicUrl },
    ]))).resolves.toBe(publicUrl);
    await expect(selectPairingGatewayRoute(publicUrl, undefined)).resolves.toBe(publicUrl);
    await expect(selectPairingGatewayRoute("https://other.example/g/route-a", descriptor([
      { kind: "public", url: publicUrl },
    ]))).rejects.toMatchObject({ code: "GATEWAY_ROUTE_DESCRIPTOR_INVALID" });
    await expect(resolveGatewayRoute(profile(descriptor([]))))
      .rejects.toMatchObject({ code: "GATEWAY_ROUTE_DESCRIPTOR_INVALID" });
  });

  it("retries the first public pairing through a slow TLS handshake", async () => {
    vi.useFakeTimers();
    const fetchMock = installSignedFetch({ publicDelayMs: 14_500 });
    const pairing = selectPairingGatewayRoute(publicUrl, descriptor([{ kind: "public", url: publicUrl }]));
    const result = expect(pairing).resolves.toBe(publicUrl);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(14_500);
    await result;
  });

  it("uses peer setup only for verified public pairing routes and scopes the HMAC as pairing", async () => {
    const routes = descriptor([{ kind: "public", url: publicUrl }]);
    const pairingProfile = profile(routes);
    installSignedFetch();
    peerApi.tryCreate.mockResolvedValueOnce(peerUrl);

    await expect(selectPairingGatewayRoute(publicUrl, routes, undefined, pairingProfile, "pairing-secret"))
      .resolves.toBe(peerUrl);

    expect(peerApi.tryCreate).toHaveBeenCalledWith(pairingProfile, routes, publicUrl, {
      signal: undefined,
      auth: { kind: "pairing", token: "pairing-secret" },
    });

    const noTokenScope = profile(routes);
    await expect(selectPairingGatewayRoute(publicUrl, routes, undefined, noTokenScope))
      .resolves.toBe(publicUrl);
    expect(peerApi.tryCreate).toHaveBeenCalledOnce();
  });

  it("reuses a single in-flight peer negotiation for concurrent route waiters", async () => {
    const current = profile(descriptor([{ kind: "public", url: publicUrl }]));
    installSignedFetch();
    let release!: (value: string | undefined) => void;
    peerApi.tryCreate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));

    const first = resolveGatewayRoute(current, { force: true });
    await vi.waitFor(() => expect(peerApi.tryCreate).toHaveBeenCalledOnce());
    const second = resolveGatewayRoute(current, { force: true });
    release(peerUrl);

    await expect(Promise.all([first, second])).resolves.toEqual([peerUrl, peerUrl]);
    expect(peerApi.tryCreate).toHaveBeenCalledOnce();
  });

  it("releases the previous peer family when authorization generation changes", async () => {
    const current = profile(descriptor([{ kind: "public", url: publicUrl }]));
    installSignedFetch();
    peerApi.tryCreate.mockResolvedValueOnce(peerUrl).mockResolvedValueOnce("kcoder-p2p://next-generation");
    await expect(resolveGatewayRoute(current)).resolves.toBe(peerUrl);

    current.authorizationGeneration = "generation-b";
    await expect(resolveGatewayRoute(current)).resolves.toBe("kcoder-p2p://next-generation");

    expect(peerApi.release).toHaveBeenCalledWith({
      profileId: current.id,
      baseUrl: current.baseUrl,
      deviceId: current.deviceId,
      authorizationGeneration: "generation-a",
      authMode: "device",
    });
  });

  it("invalidates a failed peer session and selects the public Relay during its cooldown", async () => {
    const current = profile(descriptor([{ kind: "public", url: publicUrl }]));
    installSignedFetch();
    peerApi.tryCreate.mockResolvedValueOnce(peerUrl);

    await expect(resolveGatewayRoute(current)).resolves.toBe(peerUrl);
    invalidateGatewayRoute(current, peerUrl);
    await expect(resolveGatewayRoute(current, { force: true })).resolves.toBe(publicUrl);

    expect(peerApi.invalidate).toHaveBeenCalledWith(peerUrl);
    expect(peerApi.tryCreate).toHaveBeenCalledOnce();
    expect(getGatewayRouteSnapshot(current)).toMatchObject({ url: publicUrl, kind: "public" });
  });
});

describe("React Native fetch polyfill proof requests", () => {
  it("keeps the proof URL intact with the installed whatwg-fetch implementation", async () => {
    type CapturedRequest = { method: string; url: string; headers: Record<string, string> };
    const requests: CapturedRequest[] = [];
    class RecordingXmlHttpRequest {
      readyState = 0;
      status = 200;
      statusText = "OK";
      responseText = "{}";
      responseURL = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      onreadystatechange: (() => void) | null = null;
      private method = "";
      private url = "";
      private requestHeaders: Record<string, string> = {};

      open(method: string, url: string) {
        this.method = method;
        this.url = url;
        this.responseURL = url;
        this.readyState = 1;
      }

      setRequestHeader(name: string, value: string) {
        this.requestHeaders[name.toLowerCase()] = value;
      }

      getAllResponseHeaders() {
        return "content-type: application/json\r\n";
      }

      send() {
        requests.push({ method: this.method, url: this.url, headers: { ...this.requestHeaders } });
        const requestUrl = new URL(this.url);
        const nonce = requestUrl.searchParams.get("nonce");
        const endpoint = requestUrl.searchParams.get("endpoint");
        this.responseText = nonce && endpoint ? JSON.stringify(signedPayload(endpoint, nonce)) : "{}";
        this.readyState = 4;
        this.onreadystatechange?.();
        setTimeout(() => this.onload?.(), 0);
      }

      abort() {}
    }

    vi.stubGlobal("fetch", undefined);
    vi.stubGlobal("Headers", globalThis.Headers);
    vi.stubGlobal("Request", globalThis.Request);
    vi.stubGlobal("Response", globalThis.Response);
    vi.stubGlobal("XMLHttpRequest", RecordingXmlHttpRequest);

    const mobileRequire = createRequire(join(
      dirname(fileURLToPath(import.meta.url)),
      "../../package.json",
    ));
    const polyfillPath = mobileRequire.resolve("whatwg-fetch");
    delete mobileRequire.cache[polyfillPath];
    mobileRequire(polyfillPath);
    try {
      const nativeFetch = globalThis.fetch as typeof fetch & { polyfill?: boolean };
      expect(nativeFetch.polyfill).toBe(true);

      const nonce = "a".repeat(48);
      const probeUrl = `${publicUrl}/api/mobile/connection-proof?nonce=${nonce}&endpoint=${encodeURIComponent(publicUrl)}`;
      await nativeFetch(probeUrl, { method: "GET", credentials: "omit", cache: "no-store" });
      const polyfillControlUrl = new URL(requests[0].url);
      expect([...polyfillControlUrl.searchParams.keys()]).toEqual(["nonce", "endpoint", "_"]);
      expect(polyfillControlUrl.searchParams.get("_")).toMatch(/^[0-9]{1,16}$/);

      requests.length = 0;
      await expect(selectPairingGatewayRoute(publicUrl, descriptor([
        { kind: "public", url: publicUrl },
      ]))).resolves.toBe(publicUrl);

      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("GET");
      const actualProbeUrl = new URL(requests[0].url);
      expect([...actualProbeUrl.searchParams.keys()]).toEqual(["nonce", "endpoint"]);
      expect(actualProbeUrl.searchParams.get("nonce")).toMatch(/^[a-f0-9]{48}$/);
      expect(actualProbeUrl.searchParams.get("endpoint")).toBe(publicUrl);
      expect(requests[0].headers).not.toHaveProperty("cache-control");
    } finally {
      delete mobileRequire.cache[polyfillPath];
    }
  });
});
