import { afterEach, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";

const nativeStorage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItemOverride: undefined as ((key: string) => Promise<string | null>) | undefined,
  setItemOverride: undefined as ((key: string, value: string) => Promise<void>) | undefined,
}));
const nativeSecureStorage = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn((key: string) => nativeStorage.getItemOverride
    ? nativeStorage.getItemOverride(key)
    : Promise.resolve(nativeStorage.values.get(key) ?? null)),
  setItem: vi.fn((key: string, value: string) => nativeStorage.setItemOverride
    ? nativeStorage.setItemOverride(key, value)
    : Promise.resolve().then(() => { nativeStorage.values.set(key, value); })),
  removeItem: vi.fn(async (key: string) => { nativeStorage.values.delete(key); }),
} }));
vi.mock("./secure", () => ({
  getSecureValue: async (key: string) => nativeSecureStorage.values.get(key) ?? null,
  setSecureValue: async (key: string, value: string) => { nativeSecureStorage.values.set(key, value); },
  deleteSecureValue: async (key: string) => { nativeSecureStorage.values.delete(key); },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

const profile: GatewayProfile = {
  id: "native-workspace-operation-lock-review",
  label: "native lock review fixture",
  baseUrl: "http://127.0.0.1:4173",
  accessToken: "review-only",
  expiresAt: 0,
  rpcToken: "review-only",
  authorizationGeneration: "native-review-generation",
  authMode: "legacy",
};
const server: KCoderServer = {
  id: "review-local",
  label: "review local",
  description: "native AsyncStorage race fixture",
  runtime: "kcoder",
  transport: "local",
  workspacePath: "/workspace/review",
  command: "kcoder",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  nativeStorage.values.clear();
  nativeStorage.getItemOverride = undefined;
  nativeStorage.setItemOverride = undefined;
  nativeSecureStorage.values.clear();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function seedNativeProfileMetadata(): Promise<void> {
  const profileStore = await import("./profile-store");
  await profileStore.persistProfiles([profile], profile.id);
  const raw = nativeSecureStorage.values.get(profileStore.PROFILE_INDEX_KEY);
  const index = JSON.parse(raw ?? "null") as { profiles?: Array<Record<string, unknown>> } | null;
  expect(index?.profiles).toHaveLength(1);
  expect(index?.profiles?.[0]).toMatchObject({
    id: profile.id,
    baseUrl: profile.baseUrl,
    authorizationGeneration: profile.authorizationGeneration,
  });
}

it("serializes native ACK1, ACK2, and a new intent for the same durable record", async () => {
  const path = "/workspace/review";
  const oldIntent = JSON.stringify([path, "main"]);
  const oldRecord = {
    id: "native-review-old-receipt",
    intent: oldIntent,
    dispatched: true,
    completedAt: Date.now() - 60_000,
    result: "/workspace/review-main",
  };
  const operations = await import("./pending-workspace-operation");
  const { pendingThreadCreationKey } = await import("./pending-thread-creation");
  await seedNativeProfileMetadata();
  const key = operations.pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([
    "worktree", pendingThreadCreationKey(profile, server, path),
  ]));
  nativeStorage.values.set(key, JSON.stringify(oldRecord));
  const oldReceipt = await operations.loadConfirmedWorkspaceOperationReceipt(
    profile, server, { receiptId: oldRecord.id, kind: "worktree", sourcePath: path }, oldRecord.result,
  );
  expect(oldReceipt).not.toBeNull();
  if (!oldReceipt) throw new Error("fixture receipt was not loadable");

  const firstReadStarted = deferred<void>();
  const firstReadRelease = deferred<void>();
  const staleAckReadRelease = deferred<void>();
  let firstReadReleased = false;
  let readCount = 0;
  let staleAckReadStartedBeforeRelease = false;
  nativeStorage.getItemOverride = async requestedKey => {
    if (requestedKey !== key) return nativeStorage.values.get(requestedKey) ?? null;
    const snapshotAtRead = nativeStorage.values.get(requestedKey) ?? null;
    readCount += 1;
    if (readCount === 1) {
      firstReadStarted.resolve(undefined);
      await firstReadRelease.promise;
      return snapshotAtRead;
    }
    if (readCount === 2 && !firstReadReleased) {
      staleAckReadStartedBeforeRelease = true;
      await staleAckReadRelease.promise;
      return snapshotAtRead;
    }
    return snapshotAtRead;
  };

  const newIntent = JSON.stringify([path, "feature"]);
  const mutate = vi.fn(async () => "/workspace/review-feature");
  const readback = vi.fn(async () => null);
  const startNewIntent = () => operations.recoverableWorkspaceOperationWithReceipt({
    profile, server, path, kind: "worktree", intent: newIntent, newIntent: true, mutate, readback,
  });

  let ackOne: ReturnType<typeof operations.acknowledgeConfirmedWorkspaceOperation> | undefined;
  let ackTwo: ReturnType<typeof operations.acknowledgeConfirmedWorkspaceOperation> | undefined;
  let firstIntent: Promise<Awaited<ReturnType<typeof startNewIntent>>> | undefined;
  let retryIntent: Promise<Awaited<ReturnType<typeof startNewIntent>>> | undefined;
  let newReceipt: Awaited<ReturnType<typeof startNewIntent>> | undefined;
  let oldHandleAfterReplacement:
    Awaited<ReturnType<typeof operations.acknowledgeConfirmedWorkspaceOperation>> | undefined;
  let onlyAckOneReadWhileHeld = false;
  let firstIntentSucceeded = false;

  try {
    ackOne = operations.acknowledgeConfirmedWorkspaceOperation(oldReceipt);
    await firstReadStarted.promise;
    ackTwo = operations.acknowledgeConfirmedWorkspaceOperation(oldReceipt);
    firstIntent = startNewIntent();
    const firstIntentObserved = firstIntent.then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    );
    onlyAckOneReadWhileHeld = readCount === 1 && !staleAckReadStartedBeforeRelease && mutate.mock.calls.length === 0;

    firstReadReleased = true;
    firstReadRelease.resolve(undefined);
    expect(await ackOne).toBe("consumed");

    const firstIntentResult = await firstIntentObserved;
    firstIntentSucceeded = firstIntentResult.ok;
    if (firstIntentResult.ok) {
      newReceipt = firstIntentResult.value;
    } else {
      // On the unsafe implementation, the premature request rejects against the
      // unconsumed record. Retry after ACK1 so the late ACK2 can exercise overwrite.
      retryIntent = startNewIntent();
      newReceipt = await retryIntent;
    }

    staleAckReadRelease.resolve(undefined);
    await ackTwo;
    oldHandleAfterReplacement = await operations.acknowledgeConfirmedWorkspaceOperation(oldReceipt);
  } finally {
    firstReadReleased = true;
    firstReadRelease.resolve(undefined);
    staleAckReadRelease.resolve(undefined);
    const pending: Promise<unknown>[] = [];
    if (ackOne) pending.push(ackOne);
    if (ackTwo) pending.push(ackTwo);
    if (firstIntent) pending.push(firstIntent);
    if (retryIntent) pending.push(retryIntent);
    await Promise.allSettled(pending);
  }

  const finalRecord = JSON.parse(nativeStorage.values.get(key) ?? "null") as Record<string, unknown> | null;
  expect(onlyAckOneReadWhileHeld).toBe(true);
  expect(firstIntentSucceeded).toBe(true);
  expect(newReceipt?.receipt.id).not.toBe(oldRecord.id);
  expect(mutate).toHaveBeenCalledOnce();
  expect(readback).not.toHaveBeenCalled();
  expect(finalRecord).toMatchObject({
    id: newReceipt?.receipt.id,
    intent: newIntent,
    result: "/workspace/review-feature",
  });
  expect(finalRecord?.consumed).not.toBe(true);
  expect(oldHandleAfterReplacement).toBe("superseded");
});

it("releases the native same-key queue after both bookkeeping writes fail", async () => {
  const path = "/workspace/review";
  const intent = JSON.stringify([path, "main"]);
  const oldRecord = {
    id: "native-review-failed-ack-receipt",
    intent,
    dispatched: true,
    completedAt: Date.now() - 60_000,
    result: "/workspace/review-main",
  };
  const operations = await import("./pending-workspace-operation");
  const { pendingThreadCreationKey } = await import("./pending-thread-creation");
  await seedNativeProfileMetadata();
  const key = operations.pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([
    "worktree", pendingThreadCreationKey(profile, server, path),
  ]));
  nativeStorage.values.set(key, JSON.stringify(oldRecord));
  const receipt = await operations.loadConfirmedWorkspaceOperationReceipt(
    profile, server, { receiptId: oldRecord.id, kind: "worktree", sourcePath: path }, oldRecord.result,
  );
  expect(receipt).not.toBeNull();
  if (!receipt) throw new Error("fixture receipt was not loadable");

  let failWrites = true;
  let failedWriteCount = 0;
  nativeStorage.setItemOverride = async (requestedKey, value) => {
    if (failWrites && requestedKey === key) {
      failedWriteCount += 1;
      throw new Error("controlled AsyncStorage write failure");
    }
    nativeStorage.values.set(requestedKey, value);
  };
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

  expect(await operations.acknowledgeConfirmedWorkspaceOperation(receipt)).toBe("pending");
  expect(failedWriteCount).toBe(2);
  failWrites = false;
  const recovered = await operations.loadConfirmedWorkspaceOperationReceipt(
    profile, server, { receiptId: oldRecord.id, kind: "worktree", sourcePath: path }, oldRecord.result,
  );

  expect(recovered).toMatchObject({ id: oldRecord.id, consumed: false });
  expect(JSON.parse(nativeStorage.values.get(key)!)).toEqual(oldRecord);
  expect(warning).toHaveBeenCalledOnce();
});
