// Independent HTTP contract review for durable device-token rotation.
import { afterEach, expect, it, vi } from "vitest";
import { GatewaySessionExpiredError, installGatewayAuthorizationDenialRecorder, refreshMobileSession } from "./http";
import type { GatewayAuthorizationDenialWitness, GatewayProfile } from "./types";
import { ProfileCoordinator } from "@/state/profile-coordinator";

const profile: GatewayProfile = {
  id: "refresh-review", label: "Review", baseUrl: "https://gateway.example/g/tenant-a",
  accessToken: "old-access", rpcToken: "old-rpc", expiresAt: Date.now() + 1_000,
  authMode: "device", deviceId: "device-review-12345678", authorizationGeneration: "family-review",
  refreshToken: "a".repeat(64), refreshExpiresAt: Date.now() + 86_400_000,
};
let removeDenialRecorder: (() => void) | undefined;
afterEach(() => { removeDenialRecorder?.(); removeDenialRecorder = undefined; vi.unstubAllGlobals(); });

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

it("persists only a terminal refresh 401, not a rotation conflict 409", async () => {
  const current = { ...profile };
  const coordinator = new ProfileCoordinator();
  coordinator.hydrate({ profiles: [current], activeId: current.id });
  const record = vi.fn((witness: GatewayAuthorizationDenialWitness) => coordinator.recordAuthorizationDenial(witness, async () => {}));
  removeDenialRecorder = installGatewayAuthorizationDenialRecorder(record, witness => coordinator.isCurrentAuthorizationDenial(witness));
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("{}", { status: 409 }))
    .mockResolvedValueOnce(new Response("{}", { status: 401 }));
  vi.stubGlobal("fetch", fetch);

  await expect(refreshMobileSession(current, "same-device-rotation-0003")).rejects.toBeInstanceOf(GatewaySessionExpiredError);
  expect(record).not.toHaveBeenCalled();
  await expect(refreshMobileSession(current, "same-device-rotation-0003")).rejects.toBeInstanceOf(GatewaySessionExpiredError);
  expect(record).toHaveBeenCalledOnce();
  expect(coordinator.isAuthorizationDenied(current)).toBe(true);
});
