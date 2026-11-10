import { describe, expect, it, vi } from "vitest";
import type { HistoryRefreshSnapshot } from "./history-refresh";
import { HistoryRefreshBatchController, type HistoryRefreshBatchChild } from "./history-refresh-batch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function childHarness(onChange: (snapshot: HistoryRefreshSnapshot) => void, handlers: {
  start?: () => Promise<void>;
  resume?: () => Promise<void>;
  cancel?: () => Promise<void>;
} = {}) {
  let snapshot: HistoryRefreshSnapshot = { phase: "idle" };
  const set = (value: HistoryRefreshSnapshot) => { snapshot = value; onChange(value); };
  const child: HistoryRefreshBatchChild = {
    get snapshot() { return snapshot; },
    async start() { await handlers.start?.(); },
    async resume() { await handlers.resume?.(); },
    async cancel() { await handlers.cancel?.(); },
  };
  return { child, set };
}

describe("HistoryRefreshBatchController", () => {
  it("deduplicates a fixed path snapshot and serializes each scope before reporting ready once", async () => {
    const created: string[] = [];
    const readySnapshots: string[][] = [];
    let live = 0;
    let peak = 0;
    const batch = new HistoryRefreshBatchController(
      ["/one/", "/one", "/two"],
      (workspace, onChange) => {
        created.push(workspace);
        const harness = childHarness(onChange, { start: async () => {
          live += 1; peak = Math.max(peak, live);
          await Promise.resolve();
          harness.set({ phase: "ready", progress: { status: "ready", examinedEntries: 2, indexedSessions: 1, issueCount: 0 } });
          live -= 1;
        } });
        return harness.child;
      },
      snapshot => { if (snapshot.phase === "ready") readySnapshots.push(snapshot.completedWorkspaces); },
    );

    await batch.start(true);

    expect(batch.workspaces).toEqual(["/one/", "/two"]);
    expect(created).toEqual(["/one/", "/two"]);
    expect(peak).toBe(1);
    expect(batch.snapshot).toMatchObject({ phase: "ready", completedWorkspaces: ["/one/", "/two"], totalWorkspaces: 2 });
    expect(readySnapshots).toEqual([["/one/", "/two"]]);
  });

  it("resumes the paused child and does not rerun its first request or any ready scope", async () => {
    const attempts: Record<string, { start: number; resume: number }> = {};
    const batch = new HistoryRefreshBatchController(["/one", "/two"], (workspace, onChange) => {
      attempts[workspace] = { start: 0, resume: 0 };
      const harness = childHarness(onChange, {
        start: async () => {
          attempts[workspace]!.start += 1;
          harness.set(workspace === "/one"
            ? { phase: "paused", progress: { status: "building", nextCursor: "same-cursor", examinedEntries: 4, indexedSessions: 2, issueCount: 0 } }
            : { phase: "ready", progress: { status: "ready", examinedEntries: 1, indexedSessions: 1, issueCount: 0 } });
        },
        resume: async () => {
          attempts[workspace]!.resume += 1;
          harness.set({ phase: "ready", progress: { status: "ready", examinedEntries: 5, indexedSessions: 2, issueCount: 0 } });
        },
      });
      return harness.child;
    }, () => {});

    await batch.start(true);
    expect(batch.snapshot.phase).toBe("paused");
    expect(batch.snapshot.completedWorkspaces).toEqual([]);
    await batch.resume();

    expect(attempts).toEqual({
      "/one": { start: 1, resume: 1 },
      "/two": { start: 1, resume: 0 },
    });
    expect(batch.snapshot).toMatchObject({ phase: "ready", completedWorkspaces: ["/one", "/two"] });
  });

  it("awaits the owned active cancellation receipt and never starts a later workspace", async () => {
    const receipt = deferred<void>();
    const started = deferred<void>();
    const created: string[] = [];
    let childHarnessValue: ReturnType<typeof childHarness> | undefined;
    let cancelCalls = 0;
    const batch = new HistoryRefreshBatchController(["/one", "/two"], (workspace, onChange) => {
      created.push(workspace);
      const harness = childHarness(onChange, {
        start: async () => { started.resolve(); await receipt.promise; },
        cancel: async () => { cancelCalls += 1; await receipt.promise; },
      });
      childHarnessValue = harness;
      return harness.child;
    }, () => {});

    const running = batch.start(true);
    await started.promise;
    let cancelled = false;
    const canceling = batch.cancel().then(() => { cancelled = true; });
    await Promise.resolve();
    expect(cancelled).toBe(false);
    expect(cancelCalls).toBe(1);

    childHarnessValue!.set({ phase: "ready", progress: { status: "ready", examinedEntries: 1, indexedSessions: 1, issueCount: 0 } });
    receipt.resolve();
    await Promise.all([running, canceling]);

    expect(created).toEqual(["/one"]);
    expect(batch.snapshot.phase).toBe("cancelled");
    expect(batch.snapshot.completedWorkspaces).toEqual([]);
    expect(cancelled).toBe(true);
  });

  it.each(["incomplete", "error"] as const)("stops on %s for the exact scope without reporting aggregate success", async phase => {
    const created: string[] = [];
    const batch = new HistoryRefreshBatchController(["/one", "/two"], (workspace, onChange) => {
      created.push(workspace);
      const harness = childHarness(onChange, { start: async () => harness.set({
        phase,
        ...(phase === "error" ? { error: "refresh failed" } : { progress: { status: "incomplete", examinedEntries: 2, indexedSessions: 1, issueCount: 1 } }),
      }) });
      return harness.child;
    }, () => {});

    await batch.start(true);

    expect(created).toEqual(["/one"]);
    expect(batch.snapshot.phase).toBe(phase);
    expect(batch.snapshot.completedWorkspaces).toEqual([]);
    expect(batch.snapshot.currentWorkspace).toBe("/one");
    expect(batch.snapshot.errorWorkspace).toBe("/one");
  });

  it("turns child creation failures into a scoped error state", async () => {
    const changes = vi.fn();
    const batch = new HistoryRefreshBatchController(["/unavailable"], () => { throw new Error("connection unavailable"); }, changes);
    await batch.start(true);
    expect(batch.snapshot).toMatchObject({
      phase: "error",
      currentWorkspace: "/unavailable",
      errorWorkspace: "/unavailable",
      error: "connection unavailable",
    });
    expect(changes).toHaveBeenCalled();
  });
});
