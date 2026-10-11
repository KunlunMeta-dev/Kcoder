// Independent HTTP contract review for durable device-token rotation.
import { afterEach, expect, it, vi } from "vitest";
import { GatewaySessionExpiredError, refreshMobileSession } from "./http";
import type { GatewayProfile } from "./types";

const profile: GatewayProfile = {
  id: "refresh-review", label: "Review", baseUrl: "https://gateway.example/g/tenant-a",
  accessToken: "old-access", rpcToken: "old-rpc", expiresAt: Date.now() + 1_000,
  authMode: "device", deviceId: "device-review-12345678", authorizationGeneration: "family-review",
  refreshToken: "a".repeat(64), refreshExpiresAt: Date.now() + 86_400_000,
};
afterEach(() => vi.unstubAllGlobals());

it("sends one stable rotation intent to the selected Gateway route and validates family identity", async () => {
  const response = {
    accessToken: "new-access", rpcToken: "new-rpc", expiresAt: Date.now() + 60_000,
    refreshToken: "b".repeat(64), refreshExpiresAt: Date.now() + 80_000_000,
    deviceId: profile.deviceId, authorizationGeneration: profile.authorizationGeneration,
    accessTtlMs: 60_000,
  };
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);

  const result = await refreshMobileSession(profile, "same-device-rotation-0001");

  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("https://gateway.example/g/tenant-a/api/mobile/session/refresh");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({
    refreshToken: profile.refreshToken,
    rotationId: "same-device-rotation-0001",
    deviceId: profile.deviceId,
  });
  expect(result).toMatchObject({
    accessToken: "new-access", refreshToken: "b".repeat(64),
    rpcToken: "new-rpc", authorizationGeneration: profile.authorizationGeneration,
    deviceId: profile.deviceId, pendingRotationId: undefined,
  });
});

it.each([401, 409])("treats refresh status %s as revoked/conflicting authorization without replay", async (status) => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status }));
  vi.stubGlobal("fetch", fetch);

  await expect(refreshMobileSession(profile, "same-device-rotation-0002")).rejects.toBeInstanceOf(GatewaySessionExpiredError);
  expect(fetch).toHaveBeenCalledOnce();
});
