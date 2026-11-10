import { afterEach, expect, it, vi } from "vitest";
import type { GatewayRpcClient } from "@/gateway/rpc";
import { profile, server } from "./fixture.test-support";
import { probeThreadPresence, THREAD_PRESENCE_PHASE_DEADLINE_MS } from "./thread-presence";
import { captureSessionTranscriptScope } from "@/storage/session-transcript-scope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function client() {
  return {
    supportsExperimental: vi.fn(() => true),
    matchesRetainedAttachmentOwner: vi.fn(() => true),
    request: vi.fn(async () => ({ status: "unknown", threadId: "thread-1", reason: "busy" })),
  } as unknown as GatewayRpcClient;
}

afterEach(() => vi.useRealTimers());

it.each(["capture", "versioned-read"] as const)("the total advisory deadline fences a held cache %s before it can send RPC", async stage => {
  vi.useFakeTimers();
  const held = deferred<unknown>();
  const rpc = client();
  const scope = captureSessionTranscriptScope(profile, server, "/workspace", "thread-1");
  const cache = {
    capture: vi.fn(() => stage === "capture" ? held.promise : Promise.resolve({ scope, isCurrent: () => true })),
    loadVersioned: vi.fn(() => stage === "versioned-read" ? held.promise : Promise.resolve({
      value: { record: { scope } }, version: { epoch: "e".repeat(64), dataRevision: 1 },
    })),
  };
  let current = true;
  const pending = probeThreadPresence({ client: rpc, profile, server, cwd: "/workspace", threadId: "thread-1",
    ownerToken: {}, isCurrentOwner: () => current }, cache as never);

  try {
    await vi.advanceTimersByTimeAsync(THREAD_PRESENCE_PHASE_DEADLINE_MS);
    expect(await pending).toBeNull();
    held.resolve(stage === "capture" ? { scope, isCurrent: () => true } : {
      value: { record: { scope } }, version: { epoch: "e".repeat(64), dataRevision: 1 },
    });
    await tick();
    expect(cache.loadVersioned).toHaveBeenCalledTimes(stage === "capture" ? 0 : 1);
    expect(rpc.request).not.toHaveBeenCalled();
  } finally {
    current = false;
    held.resolve({});
    await vi.advanceTimersByTimeAsync(THREAD_PRESENCE_PHASE_DEADLINE_MS);
    await pending.catch(() => {});
  }
});

it("returns a typed absence only with the exact thread echo and the pre-probe cache version", async () => {
  const rpc = client();
  rpc.request = vi.fn(async () => ({ status: "absent", threadId: "thread-1", reason: "boundDeletedPrimarySource" })) as never;
  const scope = captureSessionTranscriptScope(profile, server, "/workspace", "thread-1");
  const version = { epoch: "f".repeat(64), dataRevision: 9 };
  const cache = { capture: vi.fn(async () => ({ scope, isCurrent: () => true })),
    loadVersioned: vi.fn(async () => ({ value: { record: { scope } }, version })) };
  const result = await probeThreadPresence({ client: rpc, profile, server, cwd: "/workspace", threadId: "thread-1",
    ownerToken: {}, isCurrentOwner: () => true }, cache as never);
  expect(result).toEqual({ result: { status: "absent", threadId: "thread-1", reason: "boundDeletedPrimarySource" }, scope, version });
  expect(cache.loadVersioned).toHaveBeenCalledTimes(1);
});

it.each(["lease-capture-failure", "missing-cache-record", "versioned-read-failure"] as const)(
  "retains the probe route scope but no deletion version after %s", async stage => {
    const rpc = client();
    rpc.request = vi.fn(async () => ({ status: "absent", threadId: "thread-1", reason: "boundDeletedPrimarySource" })) as never;
    const scope = captureSessionTranscriptScope(profile, server, "/workspace", "thread-1");
    const cache = {
      capture: vi.fn(async () => {
        if (stage === "lease-capture-failure") throw new Error("cache unavailable");
        return { scope, isCurrent: () => true };
      }),
      loadVersioned: vi.fn(async () => {
        if (stage === "versioned-read-failure") throw new Error("cache unavailable");
        return null;
      }),
    };
    const result = await probeThreadPresence({ client: rpc, profile, server, cwd: "/workspace", threadId: "thread-1",
      ownerToken: {}, isCurrentOwner: () => true }, cache as never);
    expect(result).toEqual({ result: { status: "absent", threadId: "thread-1", reason: "boundDeletedPrimarySource" }, scope, version: null });
    expect(cache.loadVersioned).toHaveBeenCalledTimes(stage === "lease-capture-failure" ? 0 : 1);
  },
);

it("drops the captured route scope when its owner expires while cache reading fails", async () => {
  const rpc = client();
  const readStarted = deferred<null>();
  let current = true;
  const scope = captureSessionTranscriptScope(profile, server, "/workspace", "thread-1");
  const cache = {
    capture: vi.fn(async () => ({ scope, isCurrent: () => current })),
    loadVersioned: vi.fn(async () => { await readStarted.promise; throw new Error("cache unavailable"); }),
  };
  const pending = probeThreadPresence({ client: rpc, profile, server, cwd: "/workspace", threadId: "thread-1",
    ownerToken: {}, isCurrentOwner: () => current }, cache as never);
  await tick();
  current = false;
  readStarted.resolve(null);
  expect(await pending).toBeNull();
  expect(rpc.request).not.toHaveBeenCalled();
});

it("rejects an observation echoed for a different thread after the owner check", async () => {
  const rpc = client();
  rpc.request = vi.fn(async () => ({ status: "absent", threadId: "other-thread", reason: "boundDeletedPrimarySource" })) as never;
  const cache = { capture: vi.fn(async () => { throw new Error("no cache witness"); }), loadVersioned: vi.fn() };
  const result = await probeThreadPresence({ client: rpc, profile, server, cwd: "/workspace", threadId: "thread-1",
    ownerToken: {}, isCurrentOwner: () => true }, cache as never);
  expect(result).toBeNull();
  expect(rpc.request).toHaveBeenCalledTimes(1);
});

it("does not dispatch when the retained client no longer owns the exact workspace", async () => {
  const rpc = client();
  rpc.matchesRetainedAttachmentOwner = vi.fn(() => false) as never;
  const result = await probeThreadPresence({ client: rpc, profile, server, cwd: "/workspace", threadId: "thread-1",
    ownerToken: {}, isCurrentOwner: () => true }, { capture: vi.fn(), loadVersioned: vi.fn() } as never);
  expect(result).toBeNull();
  expect(rpc.request).not.toHaveBeenCalled();
});
