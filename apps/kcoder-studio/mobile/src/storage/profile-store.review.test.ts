// Independent unit check of refresh-secret persistence and restart hydration.
import { afterEach, expect, it, vi } from "vitest";

const secureValues = vi.hoisted(() => new Map<string, string>());
vi.mock("./secure", () => ({
  getSecureValue: vi.fn(async (key: string) => secureValues.get(key) ?? null),
  setSecureValue: vi.fn(async (key: string, value: string) => { secureValues.set(key, value); }),
  deleteSecureValue: vi.fn(async (key: string) => { secureValues.delete(key); }),
}));
import type { GatewayProfile } from "@/gateway/types";
import { PROFILE_INDEX_KEY, loadProfiles, persistProfiles } from "./profile-store";
import { DeviceAuthorizationManager } from "@/state/device-authorization";
import { ProfileCoordinator } from "@/state/profile-coordinator";

const profile: GatewayProfile = {
  id: "persist-review", label: "Review", baseUrl: "https://gateway.example/g/a",
  accessToken: "private-access", rpcToken: "private-rpc", expiresAt: 500,
  authMode: "device", deviceId: "device-review", authorizationGeneration: "family-review",
  refreshToken: "private-refresh", refreshExpiresAt: 9_000, pendingRotationId: "rotation-review-0001",
};
afterEach(() => secureValues.clear());

it("stores the staged rotation in the private profile secret and reloads it for process recovery", async () => {
  await persistProfiles([profile], profile.id);

  const index = JSON.parse(secureValues.get(PROFILE_INDEX_KEY)!) as { profiles: Record<string, unknown>[]; activeId: string };
  const entry = index.profiles[0];
  expect(entry).not.toHaveProperty("accessToken");
  expect(entry).not.toHaveProperty("refreshToken");
  expect(entry).not.toHaveProperty("pendingRotationId");
  const secretKey = String(entry.secretKey);
  const secret = JSON.parse(secureValues.get(secretKey)!) as Record<string, unknown>;
  expect(secret).toMatchObject({
    profileId: profile.id, baseUrl: profile.baseUrl, deviceId: profile.deviceId,
    authorizationGeneration: profile.authorizationGeneration,
    accessToken: profile.accessToken, rpcToken: profile.rpcToken,
    refreshToken: profile.refreshToken, pendingRotationId: profile.pendingRotationId,
  });

  const restored = await loadProfiles();
  expect(restored.activeId).toBe(profile.id);
  expect(restored.profiles[0]).toMatchObject({
    accessToken: profile.accessToken, refreshToken: profile.refreshToken,
    pendingRotationId: profile.pendingRotationId,
    authorizationGeneration: profile.authorizationGeneration,
  });
});

it("recovers an interrupted refresh from the saved rotation after reloading through the profile store", async () => {
  const initial: GatewayProfile = {
    ...profile,
    expiresAt: Date.now() - 1,
    refreshExpiresAt: Date.now() + 50_000,
    pendingRotationId: undefined,
  };
  await persistProfiles([initial], initial.id);
  const beforeRestart = await loadProfiles();
  const firstCoordinator = new ProfileCoordinator();
  firstCoordinator.hydrate(beforeRestart);
  const firstManager = new DeviceAuthorizationManager(
    id => firstCoordinator.getSnapshot().profiles.find(item => item.id === id),
    (expected, next) => firstCoordinator.updateCredentials(expected, next, persistProfiles),
    vi.fn(),
    async () => { throw new Error("response lost after server rotation"); },
    () => "review-restart-rotation-0001",
  );

  await expect(firstManager.authorize(beforeRestart.profiles[0])).rejects.toThrow("response lost after server rotation");
  const interrupted = await loadProfiles();
  expect(interrupted.profiles[0].pendingRotationId).toBe("review-restart-rotation-0001");

  const secondCoordinator = new ProfileCoordinator();
  secondCoordinator.hydrate(interrupted);
  const renew = vi.fn(async (expected: GatewayProfile, rotationId: string) => {
    expect(rotationId).toBe("review-restart-rotation-0001");
    expect(expected.refreshToken).toBe(profile.refreshToken);
    return {
      ...expected,
      accessToken: "recovered-access",
      rpcToken: "recovered-rpc",
      refreshToken: "recovered-refresh",
      refreshExpiresAt: Date.now() + 50_000,
      pendingRotationId: undefined,
      expiresAt: Date.now() + 10_000,
    };
  });
  const secondManager = new DeviceAuthorizationManager(
    id => secondCoordinator.getSnapshot().profiles.find(item => item.id === id),
    (expected, next) => secondCoordinator.updateCredentials(expected, next, persistProfiles),
    vi.fn(), renew, () => "must-not-mint-another-id-0001",
  );

  await secondManager.authorize(interrupted.profiles[0]);

  expect(renew).toHaveBeenCalledOnce();
  const recovered = await loadProfiles();
  expect(recovered.profiles[0]).toMatchObject({
    accessToken: "recovered-access",
    rpcToken: "recovered-rpc",
    refreshToken: "recovered-refresh",
    pendingRotationId: undefined,
  });
});
