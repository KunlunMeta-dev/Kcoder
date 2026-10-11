import { expect, it } from "vitest";
import type { GatewayProfile } from "@/gateway/types";
import { ProfileCoordinator, ProfileOperationGate, profileAuthorizationScopeKey } from "./profile-coordinator";

const profile = (overrides: Partial<GatewayProfile> = {}): GatewayProfile => ({
  id: "gateway-stable",
  label: "Gateway",
  baseUrl: "https://gateway.example/g/primary",
  accessToken: "access-old",
  refreshToken: "refresh-old",
  refreshExpiresAt: 9_000,
  expiresAt: 100,
  rpcToken: "rpc",
  authorizationGeneration: "authorization-1",
  authMode: "device",
  deviceId: "device-1",
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it("authorization scope separates route, authorization generation, and device, while ignoring routine credential rotation", () => {
  const original = profile();
  const scope = profileAuthorizationScopeKey(original);
  const rotated = profile({
    accessToken: "access-new",
    refreshToken: "refresh-new",
    expiresAt: 8_000,
    refreshExpiresAt: 20_000,
    pendingRotationId: undefined,
  });
  expect(profileAuthorizationScopeKey(rotated)).toBe(scope);
  expect(profileAuthorizationScopeKey(profile({ baseUrl: "https://other.example/g/primary" }))).not.toBe(scope);
  expect(profileAuthorizationScopeKey(profile({ authorizationGeneration: "authorization-2" }))).not.toBe(scope);
  expect(profileAuthorizationScopeKey(profile({ deviceId: "device-2" }))).not.toBe(scope);
  expect(profileAuthorizationScopeKey(profile({ id: "other-profile" }))).not.toBe(scope);
});

it("a new same-profile authorization can refresh before an old generation settles; rotations still join their generation", async () => {
  const gate = new ProfileOperationGate();
  const oldProfile = profile();
  const oldWork = deferred<void>();
  const oldRefresh = gate.run(profileAuthorizationScopeKey(oldProfile), () => oldWork.promise);

  const rotatedProfile = profile({ accessToken: "access-rotated", refreshToken: "refresh-rotated", expiresAt: 7_000 });
  const sameGenerationRefresh = gate.run(profileAuthorizationScopeKey(rotatedProfile), async () => {});
  expect(sameGenerationRefresh).toBe(oldRefresh);

  const nextGeneration = profile({ authorizationGeneration: "authorization-2", deviceId: "device-2" });
  let freshCalls = 0;
  const freshRefresh = gate.run(profileAuthorizationScopeKey(nextGeneration), async () => { freshCalls += 1; });
  const freshOutcome = await Promise.race([
    freshRefresh.then(() => "resolved" as const),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
  ]);
  oldWork.resolve();
  await Promise.all([oldRefresh, freshRefresh]);

  expect(freshOutcome).toBe("resolved");
  expect(freshRefresh).not.toBe(oldRefresh);
  expect(freshCalls).toBe(1);
});

it("a deferred old-scope failure cannot publish into the newly active authorization", async () => {
  const gate = new ProfileOperationGate();
  const coordinator = new ProfileCoordinator();
  const oldProfile = profile();
  coordinator.hydrate({ profiles: [oldProfile], activeId: oldProfile.id });
  const oldScope = profileAuthorizationScopeKey(oldProfile);
  const oldWork = deferred<void>();
  let visibleError: string | null = null;

  const publishFailureIfCurrent = (scope: string, error: Error) => {
    const current = coordinator.getSnapshot().profiles.find((item) => item.id === oldProfile.id);
    if (current && coordinator.isActive(oldProfile.id) && profileAuthorizationScopeKey(current) === scope) {
      visibleError = error.message;
    }
  };
  const oldRequest = gate.run(oldScope, async () => {
    await oldWork.promise;
    throw new Error("old authorization failed");
  }).catch((error: Error) => publishFailureIfCurrent(oldScope, error));

  const newProfile = profile({ authorizationGeneration: "authorization-2", deviceId: "device-2" });
  coordinator.hydrate({ profiles: [newProfile], activeId: newProfile.id });
  let newRefreshFinished = false;
  const newRequest = gate.run(profileAuthorizationScopeKey(newProfile), async () => { newRefreshFinished = true; });
  const newOutcome = await Promise.race([
    newRequest.then(() => "resolved" as const),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
  ]);
  oldWork.resolve();
  await Promise.all([oldRequest, newRequest]);

  expect(newOutcome).toBe("resolved");
  expect(newRefreshFinished).toBe(true);
  await oldRequest;
  expect(visibleError).toBeNull();

  publishFailureIfCurrent(profileAuthorizationScopeKey(newProfile), new Error("current authorization failed"));
  expect(visibleError).toBe("current authorization failed");
});
