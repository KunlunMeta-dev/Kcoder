import { describe, expect, it, vi } from "vitest";
import { mapThreadListDependencies } from "./threadDirectory";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function signalWithin(signal: Promise<unknown>, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void signal.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function tracked<T>(counter: { active: number; peak: number }, operation: () => Promise<T>): Promise<T> {
  counter.active += 1;
  counter.peak = Math.max(counter.peak, counter.active);
  try {
    return await operation();
  } finally {
    counter.active -= 1;
  }
}

describe("mapThreadListDependencies review contract", () => {
  it("starts a ready target's page read before a held discovery and preserves bounded, fair, ordered fan-out", async () => {
    // These callbacks model work boundaries only. They are not Gateway/WebSocket
    // requests and provide no RTT or end-to-end UI timing evidence.
    const targets = ["A", "B", "C", "D", "E", "F"];
    const releaseB = deferred<void>();
    const releaseAReads = deferred<void>();
    const aReadStarted = deferred<void>();
    const counter = { active: 0, peak: 0 };
    const events: string[] = [];
    const discoverCalls: string[] = [];
    const readCalls: string[] = [];
    const discoveredBatch: string[][] = [];
    let bReleased = false;

    const operation = mapThreadListDependencies(
      targets,
      async (target) => tracked(counter, async () => {
        events.push(`discover:${target}`);
        discoverCalls.push(target);
        if (target === "B") await releaseB.promise;
        return target;
      }),
      (target) => [`${target}:default`, `${target}:extra`],
      async (scope) => tracked(counter, async () => {
        events.push(`read:${scope}`);
        readCalls.push(scope);
        if (scope.startsWith("A:")) {
          aReadStarted.resolve(undefined);
          await releaseAReads.promise;
        }
        return `${scope}:result`;
      }),
      { onDiscovered: (discoveries) => discoveredBatch.push([...discoveries]) },
    );
    const outcome = operation.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    try {
      expect(await signalWithin(aReadStarted.promise)).toBe(true);
      expect(bReleased).toBe(false);
      expect(events.indexOf("read:A:default")).toBeLessThan(events.indexOf("discover:E"));
      expect(counter.peak).toBeLessThanOrEqual(4);
    } finally {
      bReleased = true;
      releaseB.resolve(undefined);
      releaseAReads.resolve(undefined);
    }

    const completed = await outcome;
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw completed.error;
    expect(completed.value.discoveries).toEqual(targets);
    expect(completed.value.results).toEqual(
      targets.flatMap((target) => [
        `${target}:default:result`,
        `${target}:extra:result`,
      ]),
    );
    expect(discoverCalls).toEqual(targets);
    expect(readCalls).toHaveLength(targets.length * 2);
    expect(new Set(readCalls).size).toBe(targets.length * 2);
    expect(discoveredBatch).toEqual([targets]);
    expect(counter.peak).toBeLessThanOrEqual(4);
    expect(counter.active).toBe(0);
  });

  it("runs one target's default and extra roots without making discovery await its child reads", async () => {
    const events: string[] = [];
    const result = await mapThreadListDependencies(
      ["only"],
      async (target) => {
        events.push(`discover:${target}`);
        return { target };
      },
      ({ target }) => [`${target}:default`, `${target}:extra-a`, `${target}:extra-b`],
      async (scope) => {
        events.push(`read:${scope}`);
        return scope;
      },
      { onDiscovered: (discoveries) => events.push(`published:${discoveries.length}`) },
    );

    expect(events).toEqual([
      "discover:only",
      "published:1",
      "read:only:default",
      "read:only:extra-a",
      "read:only:extra-b",
    ]);
    expect(result.discoveries).toEqual([{ target: "only" }]);
    expect(result.results).toEqual([
      "only:default",
      "only:extra-a",
      "only:extra-b",
    ]);
  });

  it("stops queued callbacks after invalidation and waits for held active reads to drain", async () => {
    const targets = ["A", "B", "C", "D", "E", "F"];
    const releaseReads = deferred<void>();
    const fourReadsStarted = deferred<void>();
    const counter = { active: 0, peak: 0 };
    const discoverCalls: string[] = [];
    const readCalls: string[] = [];
    let activeReads = 0;
    let current = true;
    let settled = false;
    let discoveredCalls = 0;
    let discoverCallsAtCancel = 0;
    let readCallsAtCancel = 0;

    const operation = mapThreadListDependencies(
      targets,
      async (target) => tracked(counter, async () => {
        discoverCalls.push(target);
        return target;
      }),
      (target) => [`${target}:default`, `${target}:extra`],
      async (scope) => tracked(counter, async () => {
        activeReads += 1;
        readCalls.push(scope);
        if (activeReads === 4) fourReadsStarted.resolve(undefined);
        try {
          await releaseReads.promise;
          return scope;
        } finally {
          activeReads -= 1;
        }
      }),
      { isCurrent: () => current, onDiscovered: () => { discoveredCalls += 1; } },
    );
    const outcome = operation.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { settled = true; });

    try {
      expect(await signalWithin(fourReadsStarted.promise)).toBe(true);
      expect(activeReads).toBe(4);
      expect(readCalls.length).toBeLessThan(targets.length * 2);
      current = false;
      discoverCallsAtCancel = discoverCalls.length;
      readCallsAtCancel = readCalls.length;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(activeReads).toBe(4);
      expect(discoverCalls).toHaveLength(discoverCallsAtCancel);
      expect(readCalls).toHaveLength(readCallsAtCancel);
    } finally {
      current = false;
      releaseReads.resolve(undefined);
    }

    const completed = await outcome;
    expect(completed.ok).toBe(false);
    if (completed.ok) throw new Error("invalidated scheduling unexpectedly completed");
    expect(String(completed.error)).toContain("会话列表读取已取消");
    expect(settled).toBe(true);
    expect(activeReads).toBe(0);
    expect(counter.active).toBe(0);
    expect(counter.peak).toBeLessThanOrEqual(4);
    expect(readCalls).toHaveLength(readCallsAtCancel);
    expect(discoverCalls).toHaveLength(discoverCallsAtCancel);
    expect(discoverCalls.length).toBeLessThanOrEqual(targets.length);
    expect(discoveredCalls).toBeLessThanOrEqual(1);
  });

  it("propagates discovery failure", async () => {
    const failure = new Error("discovery failed");
    const discover = async () => { throw failure; };
    await expect(mapThreadListDependencies(
      ["A"],
      discover,
      () => [],
      async () => "unreachable",
    )).rejects.toBe(failure);
  });

  it("propagates scope-expansion failure", async () => {
    const failure = new Error("scope expansion failed");
    await expect(mapThreadListDependencies(
      ["A"],
      async (target) => target,
      () => { throw failure; },
      async () => "unreachable",
    )).rejects.toBe(failure);
  });

  it("propagates onDiscovered failure without starting dependent reads", async () => {
    const failure = new Error("directory publication failed");
    const read = vi.fn(async () => "unreachable");
    await expect(mapThreadListDependencies(
      ["A"],
      async (target) => target,
      (target) => [target],
      read,
      { onDiscovered: () => { throw failure; } },
    )).rejects.toBe(failure);
    expect(read).not.toHaveBeenCalled();
  });

  it("propagates read failure after its other active reader drains", async () => {
    const failure = new Error("page read failed");
    const failingReaderStarted = deferred<void>();
    const releaseFailure = deferred<void>();
    const heldReaderStarted = deferred<void>();
    const releaseHeldReader = deferred<void>();
    let settled = false;
    const operation = mapThreadListDependencies(
      ["A"],
      async (target) => target,
      (target) => [`${target}:fails`, `${target}:held`],
      async (scope) => {
        if (scope.endsWith(":fails")) {
          failingReaderStarted.resolve(undefined);
          await releaseFailure.promise;
          throw failure;
        }
        heldReaderStarted.resolve(undefined);
        await releaseHeldReader.promise;
        return scope;
      },
    );
    const outcome = operation.catch((error: unknown) => {
      settled = true;
      return error;
    });

    try {
      expect(await signalWithin(Promise.all([
        failingReaderStarted.promise,
        heldReaderStarted.promise,
      ]))).toBe(true);
      releaseFailure.resolve(undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
    } finally {
      releaseFailure.resolve(undefined);
      releaseHeldReader.resolve(undefined);
    }

    await expect(outcome).resolves.toBe(failure);
    expect(settled).toBe(true);
  });

  it("returns an empty result and publishes an empty discovery exactly once for zero targets", async () => {
    const discover = vi.fn(async () => "unexpected");
    const scopesFor = vi.fn(() => ["unexpected"]);
    const read = vi.fn(async () => "unexpected");
    const onDiscovered = vi.fn((discoveries: readonly string[]) => {
      expect(discoveries).toEqual([]);
    });
    const result = await mapThreadListDependencies(
      [],
      discover,
      scopesFor,
      read,
      { onDiscovered },
    );

    expect(result).toEqual({ discoveries: [], results: [] });
    expect(onDiscovered).toHaveBeenCalledTimes(1);
    expect(discover).not.toHaveBeenCalled();
    expect(scopesFor).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
