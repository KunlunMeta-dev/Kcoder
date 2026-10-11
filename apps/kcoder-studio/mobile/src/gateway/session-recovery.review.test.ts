// Regression contract: a Relay process restart forgets access-token registration,
// while the Gateway-owned device refresh grant remains valid.
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayProfile } from "./types";
import { gatewayRequest, gatewaySessionExpired, installGatewayAuthorizationResolver } from "./http";

const profile: GatewayProfile = {
  id: "review-profile", label: "Review", baseUrl: "https://gateway.example",
  accessToken: "relay-unknown-access", rpcToken: "rpc", expiresAt: Date.now() + 60_000,
  authMode: "device", deviceId: "review-device", authorizationGeneration: "review-generation",
  refreshToken: "durable-refresh-grant", refreshExpiresAt: Date.now() + 86_400_000,
};
let removeResolver: (() => void) | undefined;
afterEach(() => { removeResolver?.(); removeResolver = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("renews and retries a probe before labeling a Relay-unknown token expired", async () => {
  const resolver = vi.fn(async (_profile: GatewayProfile, force = false) => {
    if (force) _profile.accessToken = "relay-registered-access";
  });
  removeResolver = installGatewayAuthorizationResolver(resolver);
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    return new Response(null, { status: authorization === "Bearer relay-registered-access" ? 200 : 401 });
  });
  vi.stubGlobal("fetch", request);

  expect(await gatewaySessionExpired({ ...profile })).toBe(false);

  expect(resolver).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: profile.id }), false);
  expect(resolver).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: profile.id }), true);
  expect(request).toHaveBeenCalledTimes(2);
});

it("reuses a winner token if a deferred GET returns 401 for the older captured header", async () => {
  const current: GatewayProfile = { ...profile };
  let rejectFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>(resolve => { rejectFirst = resolve; });
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (request.mock.calls.length === 1) return firstResponse;
    const authorization = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ devices: [] }), {
      status: authorization === "Bearer storage-event-winner" ? 200 : 401,
    });
  });
  const resolver = vi.fn(async (candidate: GatewayProfile, force = false) => {
    if (force) {
      // A redundant force refresh would rotate again after another tab already
      // committed the winner while the original GET was in flight.
      candidate.accessToken = "unnecessary-second-rotation";
      candidate.refreshToken = "unnecessary-refresh-rotation";
    }
  });
  removeResolver = installGatewayAuthorizationResolver(resolver);
  vi.stubGlobal("fetch", request);

  const pending = gatewayRequest<{ devices: unknown[] }>(current, "/api/mobile/devices");
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer relay-unknown-access");

  Object.assign(current, {
    accessToken: "storage-event-winner",
    refreshToken: "storage-event-refresh-winner",
    expiresAt: Date.now() + 60_000,
  });
  rejectFirst(new Response(null, { status: 401 }));

  expect(await pending).toEqual({ devices: [] });
  expect(resolver).toHaveBeenCalledTimes(1);
  // The resolver records the mutable profile object by reference, so its
  // current token is the winner. The first call was the initial non-forced
  // readiness check; there must not be a second forced refresh after the old
  // header's 401 arrives.
  expect(resolver.mock.calls.map((call) => call[1])).toEqual([false]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer storage-event-winner");
  expect(current.refreshToken).toBe("storage-event-refresh-winner");
});

it.each([
  ["base URL", "baseUrl", "https://replacement.example"],
  ["authorization generation", "authorizationGeneration", "replacement-generation"],
] as const)("does not retry a deferred old 401 after the %s changes", async (_label, field, value) => {
  const current: GatewayProfile = { ...profile };
  let resolveFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  const request = vi.fn(async () => firstResponse);
  const resolver = vi.fn(async (_profile: GatewayProfile, _force = false) => {});
  removeResolver = installGatewayAuthorizationResolver(resolver);
  vi.stubGlobal("fetch", request);

  const pending = gatewayRequest(current, "/api/mobile/devices");
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  Object.assign(current, { [field]: value });
  resolveFirst(new Response(null, { status: 401 }));

  await expect(pending).rejects.toThrow("Gateway 授权范围已改变");
  expect(request).toHaveBeenCalledOnce();
  expect(resolver.mock.calls.map((call) => call[1])).toEqual([false]);
});

it("does not expose a deferred old 200 response after the profile route changes", async () => {
  const current: GatewayProfile = { ...profile };
  let resolveFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  const request = vi.fn(async () => firstResponse);
  const resolver = vi.fn(async (_profile: GatewayProfile, _force = false) => {});
  removeResolver = installGatewayAuthorizationResolver(resolver);
  vi.stubGlobal("fetch", request);

  const pending = gatewayRequest<{ devices: string[] }>(current, "/api/mobile/devices");
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  current.baseUrl = "https://replacement.example";
  resolveFirst(new Response(JSON.stringify({ devices: ["old-route-data"] }), { status: 200 }));

  await expect(pending).rejects.toThrow("Gateway 授权范围已改变");
  expect(request).toHaveBeenCalledOnce();
  expect(resolver.mock.calls.map((call) => call[1])).toEqual([false]);
});
