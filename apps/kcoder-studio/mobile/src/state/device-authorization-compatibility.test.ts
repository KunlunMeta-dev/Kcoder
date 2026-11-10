import { afterEach, expect, it, vi } from "vitest";
import type { GatewayProfile } from "@/gateway/types";
import { withLocalIdentityLock, withLocalMetadata } from "@/storage/context-lock";
import { ProfileCoordinator } from "./profile-coordinator";
import { DeviceAuthorizationManager } from "./device-authorization";

const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const initial = (): GatewayProfile => ({ id: "owned-profile", label: "Synthetic", baseUrl: "https://owned.invalid", authMode: "device", deviceId: "owned-device", authorizationGeneration: "owned-generation", accessToken: "synthetic-access", rpcToken: "cookie-auth", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 10, refreshExpiresAt: Date.now() + 1_000_000 });
const deviceKey = (profile: GatewayProfile) => `device-authorization:${JSON.stringify([profile.baseUrl, profile.deviceId, profile.authorizationGeneration])}`;
function fixture() {
  const active = new Set<string>(), tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal("document", {}); vi.stubGlobal("indexedDB", undefined);
  vi.stubGlobal("navigator", { locks: { async request<T>(name: string, _options: unknown, operation: () => Promise<T>): Promise<T> {
    const prior = tails.get(name) ?? Promise.resolve(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const tail = prior.catch(() => {}).then(() => held); tails.set(name, tail);
    await prior.catch(() => {}); active.add(name);
    try { return await operation(); } finally { active.delete(name); release(); if (tails.get(name) === tail) tails.delete(name); }
  } } });
  let durable = { profiles: [initial()], activeId: "owned-profile" as string | null };
  const persist = vi.fn(async (profiles: GatewayProfile[], activeId: string | null) => { expect(active.has("kcoder-mobile:gateway-profile-index")).toBe(true); durable = structuredClone({ profiles, activeId }); });
  const storage = { reload: async () => structuredClone(durable), serialize: <T>(operation: () => Promise<T>) => withLocalMetadata("gateway-profile-index", operation) };
  const a = new ProfileCoordinator(storage), b = new ProfileCoordinator(storage); a.hydrate(structuredClone(durable)); b.hydrate(structuredClone(durable));
  return { a, b, persist, active, read: () => structuredClone(durable), replace: (value: GatewayProfile) => { durable = { profiles: [value], activeId: value.id }; } };
}
afterEach(() => vi.unstubAllGlobals());
it("waits for the original device scope before synchronizing or claiming a rotation", async () => {
  const f = fixture(), entered = deferred(), network = deferred(), profile = { ...f.read().profiles[0] };
  const oldActor = withLocalIdentityLock(deviceKey(profile), async () => { entered.release(); await network.promise; await withLocalMetadata("gateway-profile-index", async () => { f.replace({ ...profile, accessToken: "legacy-fresh", refreshToken: "legacy-fresh-refresh", expiresAt: Date.now() + 100_000 }); }); });
  await entered.promise;
  const renew = vi.fn(), synchronize = vi.fn(() => f.a.synchronize().then(() => {}));
  const manager = new DeviceAuthorizationManager(id => f.a.getSnapshot().profiles.find(row => row.id === id), (old, next, intent) => f.a.updateCredentials(old, next, f.persist, intent), () => {}, renew, () => "must-not-claim-before-legacy-owner", synchronize);
  const pending = manager.authorize(profile, true);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(synchronize).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled(); expect(renew).not.toHaveBeenCalled(); expect(f.read().profiles[0].pendingRotationId).toBeUndefined();
  network.release(); await oldActor; await pending;
  expect(synchronize).toHaveBeenCalledOnce(); expect(renew).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled(); expect(profile.accessToken).toBe("legacy-fresh");
});
it("keeps a pending network response outside the profile-index authority so a peer can remove it", async () => {
  const f = fixture(), network = deferred(), profile = { ...f.read().profiles[0] };
  const renew = vi.fn(async (old: GatewayProfile) => {
    expect(f.active.has(`kcoder-mobile:${deviceKey(profile)}`)).toBe(true);
    expect(f.active.has("kcoder-mobile:gateway-profile-index")).toBe(false);
    await network.promise; return { ...old, accessToken: "late-fresh", refreshToken: "late-refresh", pendingRotationId: undefined, expiresAt: Date.now() + 100_000 };
  });
  const manager = new DeviceAuthorizationManager(id => f.a.getSnapshot().profiles.find(row => row.id === id), (old, next, intent) => f.a.updateCredentials(old, next, f.persist, intent), () => {}, renew, () => "owned-request", () => f.a.synchronize().then(() => {}));
  const pending = manager.authorize(profile, true); const outcome = pending.then(() => null, error => error);
  await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
  await f.b.synchronize(); expect((await f.b.remove(f.b.beginRemoval(profile.id), f.persist)).removed).toBe(true);
  expect(f.read().profiles).toEqual([]); expect(f.active.has(`kcoder-mobile:${deviceKey(profile)}`)).toBe(true);
  network.release(); expect(await outcome).toBeInstanceOf(Error); expect(f.read().profiles).toEqual([]);
});
