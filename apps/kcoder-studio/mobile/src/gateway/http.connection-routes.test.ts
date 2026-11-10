import { afterEach, expect, it, vi } from "vitest";
import type { GatewayProfile } from "./types";

const routeApi = vi.hoisted(() => ({
  resolve: vi.fn(async (profile: { baseUrl: string }, _options?: { signal?: AbortSignal; force?: boolean }) => profile.baseUrl),
  invalidate: vi.fn(),
  selectPairing: vi.fn(async (baseUrl: string) => baseUrl),
  normalize: vi.fn((value: unknown) => value),
}));
const peerApi = vi.hoisted(() => ({
  fetch: vi.fn(),
  release: vi.fn(),
}));
const authorizationApi = vi.hoisted(() => ({
  canCoordinate: false,
}));

vi.mock("./connection-routes", async importOriginal => ({
  ...await importOriginal<typeof import("./connection-routes")>(),
  resolveGatewayRoute: routeApi.resolve,
  invalidateGatewayRoute: routeApi.invalidate,
  selectPairingGatewayRoute: routeApi.selectPairing,
  normalizeGatewayConnectionRoutes: routeApi.normalize,
}));
vi.mock("./peer-transport", async importOriginal => {
  const actual = await importOriginal<typeof import("./peer-transport")>();
  return {
    ...actual,
    peerFetch: peerApi.fetch,
    releasePeerTransports: peerApi.release,
  };
});
vi.mock("@/storage/context-lock", () => ({
  canCoordinateDeviceAuthorization: () => authorizationApi.canCoordinate,
}));

import { isPeerTransportUrl } from "./peer-transport";
import { GatewayRouteResolutionError } from "./connection-routes";

import {
  exchangeMobileSessionWithBootstrap,
  gatewayRequest,
  refreshMobileSession,
  revokeMobileSession,
} from "./http";

const canonicalUrl = "https://gateway.example/g/tenant-a";
const alternateUrl = "https://alternate-relay.example/g/tenant-a";
const publicUrl = "https://relay.example/g/tenant-a";
const routes = {
  version: 1 as const,
  gatewayId: "a".repeat(64),
  publicKey: "b".repeat(64),
  endpoints: [
    { kind: "public" as const, url: alternateUrl },
    { kind: "public" as const, url: canonicalUrl },
  ],
};

it("rejects HTTP and loopback pairing before sending a token from HTTPS Mobile Web", async () => {
  vi.stubGlobal("document", {})
  vi.stubGlobal("location", { protocol: "https:" })
  const send = vi.fn()
  vi.stubGlobal("fetch", send)
  await expect(exchangeMobileSessionWithBootstrap("http://127.0.0.1:49542", "pairing-token")).rejects.toThrow()
  await expect(exchangeMobileSessionWithBootstrap("http://gateway.example", "pairing-token")).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})

function makeProfile(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return {
    id: "route-profile",
    label: "Route profile",
    baseUrl: canonicalUrl,
    accessToken: "access-token",
    expiresAt: Date.now() + 60_000,
    rpcToken: "rpc-token",
    connectionRoutes: routes,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  routeApi.resolve.mockReset().mockImplementation(async profile => profile.baseUrl);
  routeApi.invalidate.mockReset();
  routeApi.selectPairing.mockReset().mockImplementation(async baseUrl => baseUrl);
  routeApi.normalize.mockReset().mockImplementation(value => value);
  peerApi.fetch.mockReset();
  peerApi.release.mockReset();
  authorizationApi.canCoordinate = false;
});

it("preserves the route verification cause without exposing it or submitting the pairing token", async () => {
  const failure = new Error("native crypto failure with private diagnostic data");
  routeApi.selectPairing.mockRejectedValueOnce(failure);
  authorizationApi.canCoordinate = true;
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  await expect(exchangeMobileSessionWithBootstrap(canonicalUrl, "pairing-token", "Phone", undefined, routes))
    .rejects.toMatchObject({
      message: "无法验证此 Gateway 的公网地址，请检查连接二维码或网络",
      cause: failure,
    });

  expect(fetch).not.toHaveBeenCalled();
  expect(peerApi.fetch).not.toHaveBeenCalled();
  expect(peerApi.release).toHaveBeenCalledOnce();
});

it("preserves proof stage metadata on the pairing error itself", async () => {
  const failure = new GatewayRouteResolutionError("GATEWAY_ROUTE_UNAVAILABLE", "private original error", {
    failure: "http", status: 502,
  });
  routeApi.selectPairing.mockRejectedValueOnce(failure);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(exchangeMobileSessionWithBootstrap(canonicalUrl, "pairing-token", "Phone", undefined, routes))
    .rejects.toMatchObject({
      message: "无法验证此 Gateway 的公网地址，请检查连接二维码或网络",
      code: "GATEWAY_ROUTE_UNAVAILABLE", failure: "http", status: 502, cause: failure,
    });
  expect(fetch).not.toHaveBeenCalled();
});

it("probes QR routes before the single session POST and keeps canonical profile identity", async () => {
  routeApi.selectPairing.mockResolvedValue(alternateUrl);
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    accessToken: "paired-access",
    expiresAt: Date.now() + 60_000,
    rpcToken: "paired-rpc",
    connectionRoutes: routes,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);

  const result = await exchangeMobileSessionWithBootstrap(
    canonicalUrl,
    "pairing-token",
    "Phone",
    undefined,
    routes,
  );

  expect(routeApi.selectPairing).toHaveBeenCalledWith(
    canonicalUrl,
    routes,
    undefined,
    undefined,
    undefined,
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe(`${alternateUrl}/api/mobile/session`);
  expect(result.profile.baseUrl).toBe(canonicalUrl);
  expect(result.profile.connectionRoutes).toEqual(routes);
  expect(peerApi.release).not.toHaveBeenCalled();
});

it("routes a pairing session over the short-lived peer scope and releases it afterward", async () => {
  authorizationApi.canCoordinate = true;
  const peerUrl = `kcoder-p2p://${"a".repeat(48)}`;
  const peerRequestUrl = `${peerUrl}/api/mobile/session`;
  routeApi.selectPairing.mockResolvedValue(peerUrl);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(isPeerTransportUrl(peerUrl)).toBe(true);
  expect(isPeerTransportUrl(peerRequestUrl)).toBe(false);
  peerApi.fetch.mockResolvedValue(new Response(JSON.stringify({
    accessToken: "paired-access",
    expiresAt: Date.now() + 60_000,
    rpcToken: "paired-rpc",
    connectionRoutes: routes,
  }), { status: 200, headers: { "content-type": "application/json" } }));

  const result = await exchangeMobileSessionWithBootstrap(
    canonicalUrl,
    "pairing-token",
    "Phone",
    undefined,
    routes,
  );

  expect(fetch).not.toHaveBeenCalled();
  expect(peerApi.fetch).toHaveBeenCalledOnce();
  expect(peerApi.fetch.mock.calls[0]?.[0]).toBe(peerRequestUrl);
  expect(JSON.parse(String(peerApi.fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    token: "pairing-token",
    durableDeviceAuthorization: true,
  });
  expect(result.profile.baseUrl).toBe(canonicalUrl);
  expect(result.profile.baseUrl).not.toContain("kcoder-p2p");
  expect(peerApi.release).toHaveBeenCalledWith(expect.objectContaining({
    id: expect.stringMatching(/^pairing-/),
    accessToken: "pairing-token",
  }));
});

it("uses the verified public route for temporary pairing when device authorization cannot be coordinated", async () => {
  authorizationApi.canCoordinate = false;
  routeApi.selectPairing.mockResolvedValue(canonicalUrl);
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    accessToken: "temporary-access",
    expiresAt: Date.now() + 60_000,
    rpcToken: "temporary-rpc",
    connectionRoutes: routes,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);

  const result = await exchangeMobileSessionWithBootstrap(
    canonicalUrl,
    "pairing-token",
    "Phone",
    undefined,
    routes,
  );

  expect(routeApi.selectPairing).toHaveBeenCalledWith(canonicalUrl, routes, undefined, undefined, undefined);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe(`${canonicalUrl}/api/mobile/session`);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    token: "pairing-token",
    durableDeviceAuthorization: false,
  });
  expect(peerApi.fetch).not.toHaveBeenCalled();
  expect(peerApi.release).not.toHaveBeenCalled();
  expect(result.profile.accessToken).toBe("temporary-access");
});

it("keeps an established peer usable for reads while the public route is offline", async () => {
  const peerUrl = "kcoder-p2p://ttl-surviving-session";
  routeApi.resolve.mockResolvedValue(peerUrl);
  peerApi.fetch.mockResolvedValue(new Response(JSON.stringify({ servers: [{ id: "peer-server" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const publicFetch = vi.fn(async () => { throw new TypeError("public route is offline"); });
  vi.stubGlobal("fetch", publicFetch);

  await expect(gatewayRequest(makeProfile({ accessToken: "rotated-access-token" }), "/api/servers"))
    .resolves.toEqual({ servers: [{ id: "peer-server" }] });

  expect(peerApi.fetch).toHaveBeenCalledOnce();
  expect(peerApi.fetch.mock.calls[0]?.[0]).toBe(`${peerUrl}/api/servers`);
  expect(publicFetch).not.toHaveBeenCalled();
});

it("retries a peer GET through a newly resolved public route after invalidating the peer", async () => {
  const peerUrl = "kcoder-p2p://read-session";
  routeApi.resolve.mockResolvedValueOnce(peerUrl).mockResolvedValueOnce(publicUrl);
  peerApi.fetch.mockRejectedValueOnce(new TypeError("peer transport closed"));
  const fetch = vi.fn(async () => new Response(JSON.stringify({ servers: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);

  await expect(gatewayRequest(makeProfile(), "/api/servers")).resolves.toEqual({ servers: [] });

  expect(peerApi.fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
  expect(routeApi.invalidate).toHaveBeenCalledWith(expect.anything(), peerUrl);
  expect(routeApi.resolve).toHaveBeenCalledTimes(2);
});

it("never replays an unknown peer write on the public route", async () => {
  const peerUrl = "kcoder-p2p://write-session";
  routeApi.resolve.mockResolvedValue(peerUrl);
  peerApi.fetch.mockRejectedValueOnce(new TypeError("peer transport closed after dispatch"));
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  await expect(gatewayRequest(makeProfile(), "/api/servers/test", {
    method: "POST",
    body: JSON.stringify({ id: "draft" }),
  })).rejects.toThrow("peer transport closed after dispatch");

  expect(peerApi.fetch).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(routeApi.resolve).toHaveBeenCalledOnce();
});

it("rejects a session response that silently changes the QR route identity", async () => {
  routeApi.selectPairing.mockResolvedValue(alternateUrl);
  const changedRoutes = { ...routes, gatewayId: "c".repeat(64), publicKey: "d".repeat(64) };
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    accessToken: "paired-access",
    expiresAt: Date.now() + 60_000,
    connectionRoutes: changedRoutes,
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);

  await expect(exchangeMobileSessionWithBootstrap(
    canonicalUrl,
    "pairing-token",
    undefined,
    undefined,
    routes,
  )).rejects.toThrow("连接身份与配对二维码不一致");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
    [`${alternateUrl}/api/mobile/session`, "POST"],
    [`${alternateUrl}/api/mobile/session`, "DELETE"],
  ]);
});

it("reselects and retries a failed GET once, while preserving the selected URL", async () => {
  routeApi.resolve
    .mockResolvedValueOnce(alternateUrl)
    .mockResolvedValueOnce(publicUrl);
  const fetch = vi.fn()
    .mockRejectedValueOnce(new TypeError("network unavailable"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const profile = makeProfile();

  await expect(gatewayRequest(profile, "/api/servers")).resolves.toEqual({ servers: [] });
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    `${alternateUrl}/api/servers`,
    `${publicUrl}/api/servers`,
  ]);
  expect(routeApi.invalidate).toHaveBeenCalledOnce();
  expect(routeApi.invalidate).toHaveBeenCalledWith(profile, alternateUrl);
  expect(routeApi.resolve).toHaveBeenCalledTimes(2);
  expect(routeApi.resolve.mock.calls[1]?.[1]).toEqual({ signal: undefined });
});

it("never replays a failed write on another route", async () => {
  routeApi.resolve.mockResolvedValue(alternateUrl);
  const fetch = vi.fn(async () => { throw new TypeError("network unavailable"); });
  vi.stubGlobal("fetch", fetch);

  await expect(gatewayRequest(makeProfile(), "/api/servers/test", {
    method: "POST",
    body: JSON.stringify({ id: "draft" }),
  })).rejects.toThrow("network unavailable");
  expect(fetch).toHaveBeenCalledOnce();
  expect(routeApi.invalidate).toHaveBeenCalledOnce();
});

it("sends exactly one stable refresh POST to the resolved route", async () => {
  routeApi.resolve.mockResolvedValue(alternateUrl);
  const profile = makeProfile({
    authMode: "device",
    deviceId: "device-route-test",
    authorizationGeneration: "family-route-test",
    refreshToken: "a".repeat(64),
  });
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    accessToken: "new-access",
    rpcToken: "new-rpc",
    expiresAt: Date.now() + 60_000,
    refreshToken: "b".repeat(64),
    refreshExpiresAt: Date.now() + 80_000_000,
    deviceId: profile.deviceId,
    authorizationGeneration: profile.authorizationGeneration,
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);

  await refreshMobileSession(profile, "stable-rotation-route-001");

  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe(`${alternateUrl}/api/mobile/session/refresh`);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
    refreshToken: profile.refreshToken,
    rotationId: "stable-rotation-route-001",
    deviceId: profile.deviceId,
  });
});

it("uses an established peer for body-authenticated refresh without adding Bearer or replaying", async () => {
  const peerUrl = "kcoder-p2p://refresh-session";
  routeApi.resolve.mockResolvedValue(peerUrl);
  const profile = makeProfile({
    authMode: "device",
    deviceId: "device-route-test",
    authorizationGeneration: "family-route-test",
    refreshToken: "a".repeat(64),
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  peerApi.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
    accessToken: "new-access",
    rpcToken: "new-rpc",
    expiresAt: Date.now() + 60_000,
    refreshToken: "b".repeat(64),
    refreshExpiresAt: Date.now() + 80_000_000,
    deviceId: profile.deviceId,
    authorizationGeneration: profile.authorizationGeneration,
  }), { status: 200 }));

  await expect(refreshMobileSession(profile, "peer-refresh-rotation-001"))
    .resolves.toMatchObject({ accessToken: "new-access" });

  expect(fetch).not.toHaveBeenCalled();
  expect(peerApi.fetch).toHaveBeenCalledOnce();
  expect(peerApi.fetch.mock.calls[0]?.[0]).toBe(`${peerUrl}/api/mobile/session/refresh`);
  expect(new Headers(peerApi.fetch.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  expect(JSON.parse(String(peerApi.fetch.mock.calls[0]?.[1]?.body))).toEqual({
    refreshToken: profile.refreshToken,
    rotationId: "peer-refresh-rotation-001",
    deviceId: profile.deviceId,
  });
});

it("does not replay a refresh through Relay after a peer transport error", async () => {
  const peerUrl = "kcoder-p2p://refresh-unknown-result";
  routeApi.resolve.mockResolvedValue(peerUrl);
  const profile = makeProfile({
    authMode: "device",
    deviceId: "device-route-test",
    authorizationGeneration: "family-route-test",
    refreshToken: "a".repeat(64),
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  peerApi.fetch.mockRejectedValueOnce(new TypeError("peer response was lost"));

  await expect(refreshMobileSession(profile, "peer-refresh-unknown-001"))
    .rejects.toThrow("peer response was lost");

  expect(peerApi.fetch).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(routeApi.invalidate).toHaveBeenCalledWith(profile, peerUrl);
});

it("allows 13-second route selection, then enforces the independent five-second refresh timeout", async () => {
  vi.useFakeTimers();
  routeApi.resolve.mockImplementationOnce(async profile => {
    await new Promise(resolve => setTimeout(resolve, 13_000));
    return profile.baseUrl;
  });
  const profile = makeProfile({
    authMode: "device",
    deviceId: "device-route-test",
    authorizationGeneration: "family-route-test",
    refreshToken: "a".repeat(64),
  });
  let dispatchSignal: AbortSignal | null | undefined;
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    dispatchSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      dispatchSignal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("refresh dispatch timed out"), { name: "AbortError" }));
      }, { once: true });
    });
  });
  vi.stubGlobal("fetch", fetch);

  const pending = refreshMobileSession(profile, "route-longer-than-http-timeout");
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(13_000);

  expect(routeApi.resolve).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
  expect(dispatchSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(dispatchSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(dispatchSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the route deadline before the independent revoke dispatch deadline", async () => {
  vi.useFakeTimers();
  routeApi.resolve.mockImplementationOnce(async profile => {
    await new Promise(resolve => setTimeout(resolve, 13_000));
    return profile.baseUrl;
  });
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);

  const pending = revokeMobileSession(makeProfile());
  await vi.advanceTimersByTimeAsync(13_000);
  await expect(pending).resolves.toBeUndefined();

  expect(routeApi.resolve).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  expect(peerApi.release).toHaveBeenCalledOnce();
});

it("keeps caller cancellation active while refresh route selection is pending", async () => {
  let routeSignal: AbortSignal | undefined;
  routeApi.resolve.mockImplementationOnce((_profile, options) => new Promise<string>((_resolve, reject) => {
    routeSignal = options?.signal;
    routeSignal?.addEventListener("abort", () => reject(new Error("route cancelled")), { once: true });
  }));
  const controller = new AbortController();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  const pending = refreshMobileSession(makeProfile(), "cancelled-route-selection", controller.signal);
  await vi.waitFor(() => expect(routeSignal).toBeDefined());
  controller.abort();

  await expect(pending).rejects.toThrow("route cancelled");
  expect(routeSignal?.aborted).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it("does not replay a cancelled session POST", async () => {
  routeApi.selectPairing.mockResolvedValue(alternateUrl);
  const controller = new AbortController();
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    controller.abort();
    throw new TypeError("cancelled");
  });
  vi.stubGlobal("fetch", fetch);

  await expect(exchangeMobileSessionWithBootstrap(
    canonicalUrl,
    "pairing-token",
    undefined,
    controller.signal,
    routes,
  )).rejects.toThrow("Gateway 连接已取消");
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
});


it("checks request ownership again before a GET falls back to another route", async () => {
  routeApi.resolve.mockResolvedValueOnce(alternateUrl).mockResolvedValueOnce(publicUrl);
  let ownerCurrent = true;
  const fetcher = vi.fn(async () => {
    ownerCurrent = false;
    throw new TypeError("network unavailable");
  });
  vi.stubGlobal("fetch", fetcher);
  const beforeDispatch = vi.fn(() => {
    if (!ownerCurrent) throw new Error("source_transfer_authority_changed");
  });
  await expect(gatewayRequest(makeProfile(), "/api/servers", {}, {
    responseBytes: 1024, beforeDispatch,
  })).rejects.toThrow("source_transfer_authority_changed");
  expect(beforeDispatch).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(routeApi.invalidate).toHaveBeenCalledOnce();
});

it("does not classify an ownership denial as a route failure", async () => {
  routeApi.resolve.mockResolvedValue(alternateUrl);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(gatewayRequest(makeProfile(), "/api/servers", {}, {
    responseBytes: 1024,
    beforeDispatch() { throw new Error("source_transfer_authority_changed"); },
  })).rejects.toThrow("source_transfer_authority_changed");
  expect(fetcher).not.toHaveBeenCalled();
  expect(routeApi.invalidate).not.toHaveBeenCalled();
  expect(routeApi.resolve).toHaveBeenCalledOnce();
});
