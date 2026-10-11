// Independent authorization lifecycle review: synthetic profiles and persistence callback.
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayProfile } from "@/gateway/types";
import { GatewaySessionExpiredError } from "@/gateway/http";
import { withLocalIdentityLock } from "@/storage/context-lock";
import { DeviceAuthorizationManager } from "./device-authorization";
import { ProfileCoordinator } from "./profile-coordinator";

const future = () => Date.now() + 10 * 60_000;
function deviceProfile(): GatewayProfile {
  return {
    id: "review-profile", label: "Review", baseUrl: "https://gateway.example",
    accessToken: "old-access", rpcToken: "rpc", expiresAt: Date.now() + 10,
    authMode: "device", deviceId: "review-device", authorizationGeneration: "review-generation",
    refreshToken: "old-refresh", refreshExpiresAt: future(), accessTtlMs: 30_000,
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("durably stages one rotation before sending it, then commits credentials before publication", async () => {
  let current = deviceProfile();
  const order: string[] = [];
  const commit = vi.fn(async (expected: GatewayProfile, next: GatewayProfile) => {
    expect(current.accessToken).toBe(expected.accessToken);
    current = { ...next };
    order.push(next.pendingRotationId ? "staged" : "committed");
    return current;
  });
  const renew = vi.fn(async (expected: GatewayProfile, rotationId: string) => {
    order.push("request");
    expect(expected.pendingRotationId).toBe(rotationId);
    return { ...expected, accessToken: "new-access", refreshToken: "new-refresh", pendingRotationId: undefined, expiresAt: future() };
  });
  const changed = vi.fn();
  const manager = new DeviceAuthorizationManager(id => id === current.id ? current : undefined, commit, changed, renew, () => "review-rotation-0001");
  const sameProfileObject = current;

  await Promise.all([manager.authorize(current, true), manager.authorize(current, true)]);

  expect(order).toEqual(["staged", "request", "committed"]);
  expect(renew).toHaveBeenCalledOnce();
  expect(current).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", pendingRotationId: undefined });
  expect(sameProfileObject.accessToken).toBe("new-access");
  expect(changed).toHaveBeenCalledOnce();
});

it("resumes the persisted rotation ID after an interrupted response instead of staging a second ID", async () => {
  const current = { ...deviceProfile(), pendingRotationId: "review-rotation-0002" };
  const commit = vi.fn(async (_expected: GatewayProfile, next: GatewayProfile) => next);
  const renew = vi.fn(async (expected: GatewayProfile, rotationId: string) => {
    expect(expected.pendingRotationId).toBe("review-rotation-0002");
    expect(rotationId).toBe("review-rotation-0002");
    return { ...expected, accessToken: "recovered-access", refreshToken: "recovered-refresh", pendingRotationId: undefined, expiresAt: future() };
  });
  const manager = new DeviceAuthorizationManager(() => current, commit, vi.fn(), renew, () => "must-not-be-used-0001");

  await manager.authorize(current);

  expect(commit).toHaveBeenCalledOnce();
  expect(renew).toHaveBeenCalledOnce();
});

it("publishes the same refreshed secrets into two distinct same-family caller profiles", async () => {
  let current = deviceProfile();
  const first = { ...current };
  const second = { ...current };
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const commit = vi.fn(async (_expected: GatewayProfile, next: GatewayProfile) => {
    current = { ...next };
    return current;
  });
  const renew = vi.fn(async (expected: GatewayProfile) => {
    await waiting;
    return { ...expected, accessToken: "shared-new-access", refreshToken: "shared-new-refresh", pendingRotationId: undefined, expiresAt: future() };
  });
  const manager = new DeviceAuthorizationManager(() => current, commit, vi.fn(), renew, () => "review-rotation-0004");

  const firstWaiter = manager.authorize(first, true);
  const secondWaiter = manager.authorize(second, true);
  expect(secondWaiter).toBe(firstWaiter);
  release();
  await Promise.all([firstWaiter, secondWaiter]);

  for (const caller of [first, second]) expect(caller).toMatchObject({
    accessToken: "shared-new-access", refreshToken: "shared-new-refresh", pendingRotationId: undefined,
    baseUrl: current.baseUrl, authorizationGeneration: current.authorizationGeneration,
  });
  expect(renew).toHaveBeenCalledOnce();
});

it("rejects a same-profile caller whose Gateway route was replaced during a pending rotation", async () => {
  let current = deviceProfile();
  const original = { ...current };
  const replaced = { ...current, baseUrl: "https://other-gateway.example/g/tenant-b", refreshToken: "other-route-secret" };
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const renew = vi.fn(async (expected: GatewayProfile) => {
    await waiting;
    return { ...expected, accessToken: "new-access", refreshToken: "new-refresh", pendingRotationId: undefined, expiresAt: future() };
  });
  const manager = new DeviceAuthorizationManager(() => current, async (_expected, next) => { current = { ...next }; return current; }, vi.fn(), renew, () => "review-rotation-0005");
  const originalWaiter = manager.authorize(original, true);

  await expect(manager.authorize(replaced, true)).rejects.toThrow("会话已失效");
  expect(renew).toHaveBeenCalledOnce();
  expect(replaced.refreshToken).toBe("other-route-secret");
  release();
  await originalWaiter;
  expect(replaced).toMatchObject({
    baseUrl: "https://other-gateway.example/g/tenant-b", refreshToken: "other-route-secret",
    accessToken: "old-access",
  });
  expect(renew).toHaveBeenCalledOnce();
});

it("does not publish old-route refresh secrets if the stored profile is replaced while the request is in flight", async () => {
  const original = deviceProfile();
  const coordinator = new ProfileCoordinator();
  coordinator.hydrate({ profiles: [original], activeId: original.id });
  let release!: () => void;
  let requested!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  const persist = vi.fn(async () => {});
  const renew = vi.fn(async (expected: GatewayProfile) => {
    requested();
    await waiting;
    return { ...expected, accessToken: "old-route-new-access", refreshToken: "old-route-new-refresh", pendingRotationId: undefined, expiresAt: future() };
  });
  const manager = new DeviceAuthorizationManager(
    id => coordinator.getSnapshot().profiles.find(profile => profile.id === id),
    (expected, next) => coordinator.updateCredentials(expected, next, persist),
    vi.fn(), renew, () => "review-rotation-0006",
  );
  const originalCaller = { ...original };
  const operation = manager.authorize(originalCaller, true);
  await started;

  const replacement: GatewayProfile = {
    ...original,
    baseUrl: "https://other-gateway.example/g/tenant-b",
    authorizationGeneration: "replacement-generation",
    accessToken: "replacement-access",
    refreshToken: "replacement-refresh",
    pendingRotationId: undefined,
  };
  coordinator.hydrate({ profiles: [replacement], activeId: replacement.id });
  release();

  await expect(operation).rejects.toThrow("会话已失效");
  expect(renew).toHaveBeenCalledOnce();
  expect(renew.mock.calls[0][0]).toMatchObject({ baseUrl: original.baseUrl, refreshToken: original.refreshToken });
  expect(coordinator.getSnapshot().profiles[0]).toMatchObject({
    baseUrl: replacement.baseUrl,
    authorizationGeneration: replacement.authorizationGeneration,
    accessToken: replacement.accessToken,
    refreshToken: replacement.refreshToken,
    pendingRotationId: undefined,
  });
  expect(originalCaller).toMatchObject({ baseUrl: original.baseUrl, accessToken: original.accessToken, refreshToken: original.refreshToken });
});

it("reproduces independent managers conflicting when no cross-context lock exists", async () => {
  const initial = deviceProfile();
  const firstProfile = { ...initial };
  const secondProfile = { ...initial };
  const firstCoordinator = new ProfileCoordinator();
  const secondCoordinator = new ProfileCoordinator();
  firstCoordinator.hydrate({ profiles: [firstProfile], activeId: initial.id });
  secondCoordinator.hydrate({ profiles: [secondProfile], activeId: initial.id });
  let releaseBoth!: () => void;
  let notifyBoth!: () => void;
  const bothRequests = new Promise<void>(resolve => { releaseBoth = resolve; });
  const bothStarted = new Promise<void>(resolve => { notifyBoth = resolve; });
  let calls = 0;
  let serverRefreshToken = initial.refreshToken!;
  let acceptedRotation: string | null = null;
  const renew = vi.fn(async (expected: GatewayProfile, rotationId: string) => {
    calls += 1;
    if (calls === 2) notifyBoth();
    await bothRequests;
    if (expected.refreshToken !== serverRefreshToken) throw new GatewaySessionExpiredError();
    if (acceptedRotation && acceptedRotation !== rotationId) throw new GatewaySessionExpiredError();
    acceptedRotation = rotationId;
    const nextRefreshToken = "server-rotated-refresh";
    serverRefreshToken = nextRefreshToken;
    return { ...expected, accessToken: "server-rotated-access", refreshToken: nextRefreshToken, pendingRotationId: undefined, expiresAt: future() };
  });
  const makeManager = (coordinator: ProfileCoordinator, rotationId: string) => new DeviceAuthorizationManager(
    id => coordinator.getSnapshot().profiles.find(item => item.id === id),
    (expected, next) => coordinator.updateCredentials(expected, next, async () => {}),
    vi.fn(), renew, () => rotationId,
  );
  const firstManager = makeManager(firstCoordinator, "review-tab-rotation-0001");
  const secondManager = makeManager(secondCoordinator, "review-tab-rotation-0002");

  const first = firstManager.authorize(firstProfile, true);
  const second = secondManager.authorize(secondProfile, true);
  await bothStarted;
  releaseBoth();
  const outcomes = await Promise.allSettled([first, second]);

  expect(renew).toHaveBeenCalledTimes(2);
  expect(new Set(renew.mock.calls.map(call => call[1]))).toEqual(new Set([
    "review-tab-rotation-0001", "review-tab-rotation-0002",
  ]));
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
  const loser = outcomes[0].status === "rejected" ? firstProfile : secondProfile;
  expect(loser.refreshToken).toBe(initial.refreshToken);
  expect(loser.pendingRotationId).toMatch(/^review-tab-rotation-/);
});

it("shares one rotation across two web-tab managers after the second waits on Web Locks", async () => {
  const lockTails = new Map<string, Promise<void>>();
  const requestLock = vi.fn(async <T>(_name: string, _options: { mode: "exclusive" }, operation: () => Promise<T>): Promise<T> => {
    const name = _name;
    const previous = lockTails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const queued = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => queued);
    lockTails.set(name, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (lockTails.get(name) === tail) lockTails.delete(name); }
  });
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { locks: { request: requestLock } });

  const initial = deviceProfile();
  const firstCaller = { ...initial };
  const secondCaller = { ...initial };
  let persisted: GatewayProfile[] = [{ ...initial }];
  let activeId: string | null = initial.id;
  const persistenceLog: string[] = [];
  const makeCoordinator = () => new ProfileCoordinator({
    reload: async () => ({ profiles: persisted.map(item => ({ ...item })), activeId }),
    serialize: operation => withLocalIdentityLock("gateway-profile-index", operation, false),
  });
  const firstCoordinator = makeCoordinator();
  const secondCoordinator = makeCoordinator();
  firstCoordinator.hydrate({ profiles: [{ ...initial }], activeId });
  secondCoordinator.hydrate({ profiles: [{ ...initial }], activeId });
  const persist = vi.fn(async (profiles: GatewayProfile[], nextActiveId: string | null) => {
    persisted = profiles.map(item => ({ ...item }));
    activeId = nextActiveId;
    persistenceLog.push(persisted[0]?.pendingRotationId ?? `committed:${persisted[0]?.refreshToken}`);
  });
  let releaseRefresh!: () => void;
  let notifyRefresh!: () => void;
  const refreshBarrier = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const refreshStarted = new Promise<void>(resolve => { notifyRefresh = resolve; });
  let serverRefreshToken = initial.refreshToken!;
  let serverRotation = 0;
  const renew = vi.fn(async (expected: GatewayProfile, rotationId: string) => {
    notifyRefresh();
    await refreshBarrier;
    if (expected.refreshToken !== serverRefreshToken) throw new GatewaySessionExpiredError();
    serverRotation += 1;
    serverRefreshToken = `shared-web-rotation-${serverRotation}-refresh`;
    return { ...expected, accessToken: `shared-web-rotation-${serverRotation}-access`, refreshToken: serverRefreshToken, pendingRotationId: undefined, expiresAt: future() };
  });
  const managerFor = (coordinator: ProfileCoordinator, rotationId: string) => new DeviceAuthorizationManager(
    id => coordinator.getSnapshot().profiles.find(item => item.id === id),
    (expected, next) => coordinator.updateCredentials(expected, next, persist),
    vi.fn(), renew, () => rotationId,
    async () => { await coordinator.synchronize(); },
  );
  const first = managerFor(firstCoordinator, "review-web-tab-rotation-0001").authorize(firstCaller, true);
  await refreshStarted;
  const second = managerFor(secondCoordinator, "review-web-tab-rotation-0002").authorize(secondCaller, true);
  releaseRefresh();
  await Promise.all([first, second]);

  expect(requestLock).toHaveBeenCalledWith(expect.stringContaining("device-authorization:"), { mode: "exclusive" }, expect.any(Function));
  expect(renew).toHaveBeenCalledOnce();
  expect(persisted[0]).toMatchObject({ accessToken: "shared-web-rotation-1-access", refreshToken: "shared-web-rotation-1-refresh", pendingRotationId: undefined });
  for (const caller of [firstCaller, secondCaller]) expect(caller).toMatchObject({
    accessToken: "shared-web-rotation-1-access", refreshToken: "shared-web-rotation-1-refresh", pendingRotationId: undefined,
  });
});

it("does not publish a token rotation when the durable CAS reports a replaced profile", async () => {
  const current = deviceProfile();
  const changed = vi.fn();
  const commit = vi.fn(async () => null);
  const renew = vi.fn();
  const manager = new DeviceAuthorizationManager(() => current, commit, changed, renew as never, () => "review-rotation-0003");

  await expect(manager.authorize(current, true)).rejects.toThrow("会话已失效");

  expect(renew).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});
