import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayProfile } from "@/gateway/types";
import { DeviceAuthorizationManager } from "./device-authorization";
import { ProfileCoordinator } from "./profile-coordinator";
const makeProfile = (): GatewayProfile => ({ id: "device", label: "device", baseUrl: "https://gateway.example/g/device", accessToken: "access-0", rpcToken: "rpc", expiresAt: 2000, authMode: "device", deviceId: "device-id", refreshToken: "a".repeat(64), refreshExpiresAt: 20000, authorizationGeneration: "family-1", accessTtlMs: 1000 });
afterEach(() => vi.useRealTimers());
describe("durable device authorization", () => {
 it("single flight persists rotation before wire and publishes only after secret commit", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1800); const profile = makeProfile(); const coordinator = new ProfileCoordinator(); coordinator.hydrate({ profiles: [profile], activeId: profile.id });
  const writes: GatewayProfile[][] = []; let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const persist = vi.fn(async (profiles: GatewayProfile[]) => { writes.push(profiles.map(value => ({ ...value }))); if (writes.length === 2) await waiting; });
  const renew = vi.fn(async (value: GatewayProfile, id: string) => { expect(writes[0][0].pendingRotationId).toBe(id); return { ...value, pendingRotationId: undefined, accessToken: "access-1", refreshToken: "b".repeat(64), expiresAt: 2800 }; });
  const changed = vi.fn(); const manager = new DeviceAuthorizationManager(id => coordinator.getSnapshot().profiles.find(value => value.id === id), (before, after) => coordinator.updateCredentials(before, after, persist), changed, renew, () => "synthetic-rotation-01");
  const first = manager.authorize(profile); expect(manager.authorize(profile)).toBe(first);
  await vi.waitFor(() => expect(writes).toHaveLength(2)); expect(profile.accessToken).toBe("access-0"); expect(changed).not.toHaveBeenCalled();
  release(); await first; expect(renew).toHaveBeenCalledOnce(); expect(profile.accessToken).toBe("access-1"); expect(profile.authorizationGeneration).toBe("family-1"); expect(changed).toHaveBeenCalledOnce();
 });
 it("lost response retains same durable ID, then a sleeping restart commits recovery before obtaining fresh access", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1800); let profile = makeProfile(); const durable: GatewayProfile[] = []; const commit = async (expected: GatewayProfile, next: GatewayProfile) => { expect(expected.refreshToken).toBe(profile.refreshToken); durable.push({ ...next }); profile = { ...next }; return profile; };
  const failed = new DeviceAuthorizationManager(() => profile, commit, () => {}, async () => { throw new Error("lost response"); }, () => "synthetic-rotation-01");
  await expect(failed.authorize(profile)).rejects.toThrow("lost response"); expect(profile.pendingRotationId).toBe("synthetic-rotation-01");
  vi.setSystemTime(5000); const renew = vi.fn(async (value: GatewayProfile, id: string) => {
    if (id === "synthetic-rotation-01") return { ...value, refreshToken: "b".repeat(64), accessToken: "expired-recovered", expiresAt: 2800, pendingRotationId: undefined };
    expect(durable.at(-2)?.refreshToken).toBe("b".repeat(64)); expect(durable.at(-2)?.pendingRotationId).toBeUndefined();
    return { ...value, refreshToken: "c".repeat(64), accessToken: "fresh", expiresAt: 6000, pendingRotationId: undefined };
  });
  const resumed = new DeviceAuthorizationManager(() => profile, commit, () => {}, renew, () => "synthetic-rotation-02");
  await resumed.authorize(profile); expect(renew.mock.calls.map(call => call[1])).toEqual(["synthetic-rotation-01", "synthetic-rotation-02"]); expect(profile.accessToken).toBe("fresh"); expect(profile.pendingRotationId).toBeUndefined();
 });
 it("a failed initial durable rotation write performs no refresh request", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1800); const profile = makeProfile(); const renew = vi.fn();
  const manager = new DeviceAuthorizationManager(() => profile, async () => { throw new Error("secure storage failed"); }, () => {}, renew);
  await expect(manager.authorize(profile)).rejects.toThrow("secure storage failed"); expect(renew).not.toHaveBeenCalled(); expect(profile.pendingRotationId).toBeUndefined();
 });
 it("two callers with separate profile objects receive the same committed credentials", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1800); let profile = makeProfile(); const first = { ...profile }; const second = { ...profile };
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const manager = new DeviceAuthorizationManager(() => profile, async (_before, after) => { profile = { ...after }; return profile; }, () => {}, async value => { await waiting; return { ...value, accessToken: "fresh", refreshToken: "b".repeat(64), expiresAt: 2800, pendingRotationId: undefined }; });
  const a = manager.authorize(first); const b = manager.authorize(second); expect(a).toBe(b); release(); await Promise.all([a,b]);
  expect(first.accessToken).toBe("fresh"); expect(second.accessToken).toBe("fresh");
 });
 it("transient failures retain the rotation and bound background retries", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1800); let profile = makeProfile(); const renew = vi.fn(async () => { throw new Error("offline"); });
  const manager = new DeviceAuthorizationManager(() => profile, async (_before, after) => { profile = { ...after }; return profile; }, () => {}, renew);
  await expect(manager.authorize(profile)).rejects.toThrow("offline"); const rotation = profile.pendingRotationId;
  expect(manager.nextAttemptAt(profile)).toBe(2800);
  for (let i=0;i<10;i++) await expect(manager.authorize(profile)).rejects.toThrow("offline"); expect(renew).toHaveBeenCalledOnce();
  vi.setSystemTime(2800); await expect(manager.authorize(profile)).rejects.toThrow("offline"); expect(renew).toHaveBeenCalledTimes(2); expect(profile.pendingRotationId).toBe(rotation); expect(manager.nextAttemptAt(profile)).toBe(4800);
 });

});
