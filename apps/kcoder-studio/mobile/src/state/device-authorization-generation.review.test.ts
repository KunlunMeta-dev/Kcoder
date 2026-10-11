// Minimal regression probe for same-profile re-pair while an old refresh is pending.
// Synthetic credentials only; this test does not contact a Gateway.
import { expect, it, vi } from "vitest";
import type { GatewayProfile } from "@/gateway/types";
import { DeviceAuthorizationManager } from "./device-authorization";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function makeProfile(generation: string, deviceId: string): GatewayProfile {
  return {
    id: "same-route-profile",
    label: "Synthetic Gateway",
    baseUrl: "https://gateway.example/g/synthetic",
    authMode: "device",
    deviceId,
    authorizationGeneration: generation,
    accessToken: `synthetic-access-${generation}`,
    refreshToken: `synthetic-refresh-${generation}`,
    rpcToken: "synthetic-rpc",
    expiresAt: Date.now() - 1,
    refreshExpiresAt: Date.now() + 60_000,
    accessTtlMs: 30_000,
  };
}

it("starts the replacement generation refresh while the old same-id refresh is pending", async () => {
  let current = makeProfile("old-generation", "old-device");
  const oldRefresh = deferred<GatewayProfile>();
  const freshRefresh = deferred<GatewayProfile>();
  let signalOldStarted!: () => void;
  const oldStarted = new Promise<void>(resolve => { signalOldStarted = resolve; });
  let signalFreshStarted!: () => void;
  const freshStarted = new Promise<void>(resolve => { signalFreshStarted = resolve; });
  const renew = vi.fn((expected: GatewayProfile) => {
    if (expected.authorizationGeneration === "old-generation") { signalOldStarted(); return oldRefresh.promise; }
    signalFreshStarted();
    return freshRefresh.promise;
  });
  const commit = vi.fn(async (_expected: GatewayProfile, next: GatewayProfile) => {
    if (current.authorizationGeneration !== _expected.authorizationGeneration) throw new Error("stale authorization scope");
    current = { ...next };
    return current;
  });
  const manager = new DeviceAuthorizationManager(
    id => id === current.id ? current : undefined,
    commit,
    vi.fn(),
    renew,
    () => "synthetic-rotation-id",
  );

  const oldOperation = manager.authorize(current, true);
  await oldStarted;
  const oldOutcome = oldOperation.then(() => ({ status: "fulfilled" as const }), error => ({ status: "rejected" as const, error }));
  current = makeProfile("new-generation", "new-device");
  const freshOperation = manager.authorize(current, true);
  const freshOutcome = freshOperation.then(() => ({ status: "fulfilled" as const }), error => ({ status: "rejected" as const, error }));
  const observed = await Promise.race([
    freshStarted.then(() => "fresh-refresh-started" as const),
    freshOutcome.then(() => "fresh-operation-settled" as const),
    new Promise<"still-pending">(resolve => setTimeout(() => resolve("still-pending"), 100)),
  ]);

  try {
    expect(observed).toBe("fresh-refresh-started");
    freshRefresh.resolve({ ...makeProfile("new-generation", "new-device"), accessToken: "synthetic-new-result", refreshToken: "synthetic-new-rotated", expiresAt: Date.now() + 60_000 });
    expect((await freshOutcome).status).toBe("fulfilled");
    expect(renew).toHaveBeenCalledTimes(2);
  } finally {
    // Keep the old operation pending until the new authorization has refreshed and committed.
    oldRefresh.resolve({ ...makeProfile("old-generation", "old-device"), accessToken: "synthetic-old-result", refreshToken: "synthetic-old-rotated", expiresAt: Date.now() + 60_000 });
    freshRefresh.resolve({ ...makeProfile("new-generation", "new-device"), accessToken: "synthetic-new-result", refreshToken: "synthetic-new-rotated", expiresAt: Date.now() + 60_000 });
    await Promise.allSettled([oldOutcome, freshOutcome]);
  }
});

it("does not let a late old-generation refresh failure create backoff for the replacement", async () => {
  let current = makeProfile("old-generation", "old-device");
  let rejectOld!: (error: Error) => void;
  const oldRefresh = new Promise<GatewayProfile>((_resolve, reject) => { rejectOld = reject; });
  let signalOldStarted!: () => void;
  const oldStarted = new Promise<void>(resolve => { signalOldStarted = resolve; });
  const manager = new DeviceAuthorizationManager(
    id => id === current.id ? current : undefined,
    async (_expected, next) => { current = { ...next }; return current; },
    vi.fn(),
    vi.fn(() => { signalOldStarted(); return oldRefresh; }),
    () => "synthetic-old-rotation-id",
  );
  const oldOperation = manager.authorize(current, true);
  await oldStarted;
  current = makeProfile("new-generation", "new-device");

  rejectOld(new Error("synthetic old-generation network failure"));
  await expect(oldOperation).rejects.toThrow("synthetic old-generation network failure");

  expect(manager.nextAttemptAt(current)).toBe(0);
});
