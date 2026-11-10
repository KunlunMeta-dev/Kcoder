import { describe, expect, it, vi } from "vitest";
import type { GatewayProfile } from "@/gateway/types";
import { ProfileCoordinator } from "./profile-coordinator";
import { DeviceAuthorizationManager } from "./device-authorization";

const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const profile = (): GatewayProfile => ({ id: "owned-profile", label: "Synthetic", baseUrl: "http://owned.invalid", accessToken: "synthetic-access", rpcToken: "cookie-auth", expiresAt: Date.now() + 10, authMode: "device", deviceId: "owned-device", refreshToken: "synthetic-refresh", refreshExpiresAt: Date.now() + 1_000_000, authorizationGeneration: "owned-generation" });
function coordinators() {
  let durable = { profiles: [profile()], activeId: "owned-profile" };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>) => { const result = tail.then(() => operation()); tail = result.catch(() => {}); return result; };
  const storage = { reload: async () => structuredClone(durable), serialize };
  const persist = async (profiles: GatewayProfile[], activeId: string | null) => { durable = structuredClone({ profiles, activeId: activeId! }); };
  const a = new ProfileCoordinator(storage), b = new ProfileCoordinator(storage);
  a.hydrate(structuredClone(durable)); b.hydrate(structuredClone(durable));
  return { a, b, persist, read: () => structuredClone(durable) };
}
describe("short profile metadata transactions without a network lock", () => {
  it("two realms stage one canonical request and reconcile the same completed rotation", async () => {
    const { a, b, persist, read } = coordinators(), waiting = deferred();
    const requests: string[] = [];
    const renew = vi.fn(async (expected: GatewayProfile, requestId: string) => { requests.push(requestId); await waiting.promise; return { ...expected, pendingRotationId: undefined, accessToken: "synthetic-next", refreshToken: "synthetic-next-refresh", expiresAt: Date.now() + 100_000 }; });
    const make = (owner: ProfileCoordinator, id: string) => new DeviceAuthorizationManager(key => owner.getSnapshot().profiles.find(row => row.id === key), (old, next, intent) => owner.updateCredentials(old, next, persist, intent), () => {}, renew, () => id, () => owner.synchronize().then(() => {}));
    const first = make(a, "first-intent").authorize({ ...a.getSnapshot().profiles[0] }, true);
    const second = make(b, "second-intent").authorize({ ...b.getSnapshot().profiles[0] }, true);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(new Set(requests).size).toBe(1); expect(read().profiles[0].pendingRotationId).toBe(requests[0]);
    waiting.release(); await Promise.all([first, second]);
    expect(read().profiles[0]).toMatchObject({ accessToken: "synthetic-next", pendingRotationId: undefined });
  });
  it("removal completes while a refresh response is pending and the old response cannot resurrect it", async () => {
    const { a, b, persist, read } = coordinators(), waiting = deferred();
    const renew = vi.fn(async (expected: GatewayProfile) => { await waiting.promise; return { ...expected, pendingRotationId: undefined, accessToken: "late-synthetic", expiresAt: Date.now() + 100_000 }; });
    const manager = new DeviceAuthorizationManager(key => a.getSnapshot().profiles.find(row => row.id === key), (old, next, intent) => a.updateCredentials(old, next, persist, intent), () => {}, renew, () => "owned-rotation", () => a.synchronize().then(() => {}));
    const response = manager.authorize(a.getSnapshot().profiles[0], true);
    const observed = response.then(() => null, error => error);
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
    await b.synchronize(); await b.remove(b.beginRemoval("owned-profile"), persist);
    expect(read().profiles).toEqual([]);
    waiting.release(); expect(await observed).toBeInstanceOf(Error);
    expect(read().profiles).toEqual([]);
  });
});
