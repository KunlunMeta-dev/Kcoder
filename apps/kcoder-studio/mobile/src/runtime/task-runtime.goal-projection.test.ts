import { describe, expect, it, vi } from "vitest";
import { TaskRuntime, type ThreadGoal } from "./task-runtime";
import { publishGoal } from "./task-runtime/goalProjection";
import { MobileRpcError } from "@/gateway/rpc";

const goal: ThreadGoal = { threadId: "goal-thread", goalId: "goal-1", revision: 1,
  objective: "Finish the work", mode: "standard", verificationKind: "artifact", status: "active",
  tokenBudget: 1000, tokensUsed: 240, timeUsedSeconds: 15, turnCount: 1, createdAt: 1, updatedAt: 2 };
function fixture() {
  const task = TaskRuntime.demo(goal.threadId);
  const request = vi.fn();
  const client = { request, subscribe: vi.fn(() => vi.fn()), supportsExperimental: () => true, close: vi.fn() };
  task.attachClient(client as never);
  return { task, request };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe("target Goal projection", () => {
  it("does not let an older explicit GET clear a later unknown write", async () => {
    const { task, request } = fixture(); publishGoal(task, goal);
    const read = deferred<{ threadId: string; goal: ThreadGoal }>();
    request.mockImplementation(method => method === "thread/goal/get" ? read.promise : Promise.reject(new MobileRpcError("write timed out")));
    const pendingRead = task.getGoal(true);
    await expect(task.updateGoalStatus("paused", goal)).rejects.toThrow();
    read.resolve({ threadId: goal.threadId, goal }); await pendingRead;
    expect(task.getSnapshot().goalMutationUnknown).toBe(true);
    await expect(task.clearGoal(goal)).rejects.toThrow();
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/goal/get", "thread/goal/set"]);
    task.close();
  });
  it("locks a rejected edit until successful observation when its read-back fails", async () => {
    const { task, request } = fixture(); publishGoal(task, goal);
    request.mockRejectedValueOnce(new MobileRpcError("stale goal precondition", -1, "remote"));
    request.mockRejectedValueOnce(new MobileRpcError("read timed out"));
    await expect(task.editGoal("Keep this text", undefined, goal)).rejects.toThrow();
    expect(task.getSnapshot().goalEditReadRequired).toBe(true);
    expect(task.getSnapshot().goalMutationUnknown).not.toBe(true);
    await expect(task.editGoal("Keep this text", undefined, goal)).rejects.toThrow();
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/goal/set", "thread/goal/get"]);
    request.mockResolvedValueOnce({ threadId: goal.threadId, goal });
    await task.getGoal(true);
    expect(task.getSnapshot().goalEditReadRequired).toBe(false);
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/goal/set", "thread/goal/get", "thread/goal/get"]);
    task.close();
  });
  it.each(["complete", "cancelled", "usageLimited", "budgetLimited"] as const)("rejects %s edits before dispatch", async status => {
    const { task, request } = fixture(); publishGoal(task, { ...goal, status });
    await expect(task.editGoal("Unsaved text", undefined, goal)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled(); task.close();
  });
  it("observes a remote terminal rejection once without replaying the edit", async () => {
    const { task, request } = fixture(); publishGoal(task, goal);
    request.mockRejectedValueOnce(new MobileRpcError("terminal goal cannot be edited", -1, "remote"));
    request.mockResolvedValueOnce({ threadId: goal.threadId, goal: { ...goal, status: "complete", revision: 2 } });
    await expect(task.editGoal("Unsaved text", undefined, goal)).rejects.toThrow();
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/goal/set", "thread/goal/get"]);
    expect(task.getSnapshot().goal).toMatchObject({ status: "complete", objective: goal.objective });
    task.close();
  });
  it("locks an unknown write until explicit read-only reconciliation, without replay", async () => {
    const { task, request } = fixture(); publishGoal(task, goal);
    request.mockRejectedValueOnce(new MobileRpcError("timeout"));
    await expect(task.updateGoalStatus("paused", goal)).rejects.toThrow("timeout");
    expect(task.getSnapshot().goalMutationUnknown).toBe(true);
    await expect(task.clearGoal(goal)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValue({ threadId: goal.threadId, goal });
    await task.getGoal(); expect(task.getSnapshot().goalMutationUnknown).toBe(true);
    await task.getGoal(true); expect(task.getSnapshot().goalMutationUnknown).toBe(false);
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/goal/set", "thread/goal/get", "thread/goal/get"]);
    task.close();
  });
  it("does not restore a Goal cleared while get was pending", async () => {
    const { task, request } = fixture();
    publishGoal(task, goal);
    const read = deferred<{ threadId: string; goal: ThreadGoal }>(); request.mockReturnValue(read.promise);
    const pending = task.getGoal();
    task.handleRpc({ method: "thread/goal/updated", params: { threadId: goal.threadId, goal: null } });
    read.resolve({ threadId: goal.threadId, goal }); await pending;
    expect(task.getSnapshot().goal).toBeNull();
    task.close();
  });
  it("aborts a fallback status mutation when a newer notification overtakes its read", async () => {
    const { task, request } = fixture();
    const read = deferred<{ threadId: string; goal: ThreadGoal }>(); request.mockReturnValue(read.promise);
    const pending = task.updateGoalStatus("paused");
    publishGoal(task, { ...goal, revision: 2, status: "complete" });
    read.resolve({ threadId: goal.threadId, goal });
    await expect(pending).rejects.toThrow("Goal changed");
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/goal/get"]);
    task.close();
  });
  it("aborts a fallback edit across a reconnect before any write", async () => {
    const { task, request } = fixture();
    const read = deferred<{ threadId: string; goal: ThreadGoal }>(); request.mockReturnValue(read.promise);
    const pending = task.editGoal("New objective");
    const newerRequest = vi.fn();
    task.attachClient({ request: newerRequest, subscribe: () => () => {}, close() {} } as never);
    read.resolve({ threadId: goal.threadId, goal });
    await expect(pending).rejects.toThrow("connection changed");
    expect(newerRequest).not.toHaveBeenCalled();
    task.close();
  });
  it("keeps a newer updated notification when the earlier write ACK arrives", async () => {
    const { task, request } = fixture(); publishGoal(task, goal);
    const ack = deferred<{ goal: ThreadGoal }>(); request.mockReturnValue(ack.promise);
    const pending = task.updateGoalStatus("paused", goal);
    publishGoal(task, { ...goal, revision: 3, status: "complete" });
    ack.resolve({ goal: { ...goal, revision: 2, status: "paused" } }); await pending;
    expect(task.getSnapshot().goal?.status).toBe("complete");
    expect(request).toHaveBeenCalledWith("thread/goal/set", expect.objectContaining({ expectedGoalId: goal.goalId, expectedRevision: 1, status: "paused" }), undefined);
    task.close();
  });
  it("projects status, edit and clear ACKs and keeps Goal pause separate from turn stop", async () => {
    const { task, request } = fixture(); publishGoal(task, goal); task.patch({ running: true, activeTurnId: "turn" });
    request.mockResolvedValueOnce({ goal: { ...goal, revision: 2, status: "paused" } });
    await task.updateGoalStatus("paused", goal);
    expect(task.getSnapshot()).toMatchObject({ running: true, activeTurnId: "turn", goal: { status: "paused" } });
    request.mockResolvedValueOnce({ goal: { ...goal, revision: 3, status: "paused", objective: "Edited" } });
    await task.editGoal("Edited", undefined, task.getSnapshot().goal!);
    expect(task.getSnapshot().goal?.objective).toBe("Edited");
    request.mockResolvedValueOnce({ cleared: true }); await task.clearGoal(task.getSnapshot().goal!);
    expect(task.getSnapshot().goal).toBeNull();
    expect(request.mock.calls.some(call => call[0] === "turn/interrupt")).toBe(false);
    task.close();
  });
  it("rejects a read for a foreign inner thread and ignores foreign notifications", async () => {
    const { task, request } = fixture();
    request.mockResolvedValue({ threadId: goal.threadId, goal: { ...goal, threadId: "peer" } });
    await expect(task.getGoal()).rejects.toThrow("another thread");
    task.handleRpc({ method: "thread/goal/updated", params: { threadId: "peer", goal } });
    expect(task.getSnapshot().goal).toBeUndefined(); task.close();
  });
});
