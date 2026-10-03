import { describe, expect, it, vi } from "vitest";
import { HistoryRefreshController, parseHistoryRefresh } from "./history-refresh";

const progress = (status = "building", nextCursor: string | undefined = status === "building" ? "cursor" : undefined) => ({ status, nextCursor, examinedEntries: 2, indexedSessions: 1, issueCount: 0 });
function fixture(responses: unknown[], options = {}) {
  const client = { supportsExperimental: vi.fn(() => true), request: vi.fn(async (_method: string, _params: Record<string, unknown>, _timeout?: number) => responses.shift()), close: vi.fn() };
  const connect = vi.fn(async () => client);
  const controller = new HistoryRefreshController(connect, () => {}, options);
  return { controller, connect, client };
}

// These fixtures exercise protocol ownership and cleanup, not model behavior.
describe("history refresh ownership", () => {
  it("rejects coerced status", () => {
    expect(() => parseHistoryRefresh({ ...progress("ready"), status: ["ready"] })).toThrow();
  });
  it("rejects repeated cursors after a pause", async () => {
    const { controller, client } = fixture([progress(), progress()], { maxSteps: 1 });
    await controller.start(true);
    await controller.resume();
    expect(controller.snapshot.phase).toBe("error");
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledOnce();
  });
  it("requires explicit confirmation and fails closed on old capability", async () => {
    const { controller, connect, client } = fixture([]);
    await expect(controller.start(false)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    client.supportsExperimental.mockReturnValue(false);
    await controller.start(true);
    expect(controller.snapshot.phase).toBe("error");
    expect(client.request).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });
  it("keeps one connection through paused continuation and closes at ready", async () => {
    const { controller, connect, client } = fixture([progress(), progress("ready", undefined)], { maxSteps: 1 });
    await controller.start(true);
    expect(controller.snapshot.phase).toBe("paused");
    expect(client.close).not.toHaveBeenCalled();
    await controller.resume();
    expect(controller.snapshot.phase).toBe("ready");
    expect(connect).toHaveBeenCalledOnce();
    expect(client.request.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["thread/history/refresh", { acknowledgeExternalWriters: true }],
      ["thread/history/refresh", { cursor: "cursor" }],
    ]);
    expect(client.close).toHaveBeenCalledOnce();
  });
  it("cancels the newly returned in-flight cursor before closing", async () => {
    const { controller, client } = fixture([]);
    let resolve!: (value: unknown) => void;
    client.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    client.request.mockResolvedValue(progress("cancelled", undefined));
    const running = controller.start(true);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    const cancelling = controller.cancel();
    resolve(progress("building", "late-cursor"));
    await Promise.all([running, cancelling]);
    expect(client.request).toHaveBeenLastCalledWith("thread/history/refresh", { cursor: "late-cursor", cancel: true }, 5000);
    expect(controller.snapshot.phase).toBe("cancelled");
    expect(client.close).toHaveBeenCalledOnce();
  });
  it("pauses at elapsed budget and cancels paused work", async () => {
    let now = 0;
    const { controller, client } = fixture([progress(), progress("cancelled", undefined)], { now: () => now });
    client.request.mockImplementationOnce(async () => { now = 120000; return progress(); });
    await controller.start(true);
    expect(controller.snapshot.phase).toBe("paused");
    await controller.cancel();
    expect(client.close).toHaveBeenCalledOnce();
  });
  it("enforces the default 200-step limit without creating another owner", async () => {
    const { controller, connect, client } = fixture(Array.from({ length: 200 }, (_, index) => progress("building", `cursor-${index}`)));
    await controller.start(true);
    expect(controller.snapshot.phase).toBe("paused");
    expect(client.request).toHaveBeenCalledTimes(200);
    expect(connect).toHaveBeenCalledOnce();
    await controller.cancel();
    expect(client.close).toHaveBeenCalledOnce();
  });
  it("rejects duplicate starts while a step is in flight", async () => {
    const { controller, client } = fixture([]);
    let resolve!: (value: unknown) => void;
    client.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const running = controller.start(true);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    await expect(controller.start(true)).rejects.toThrow();
    await expect(controller.resume()).rejects.toThrow();
    resolve(progress("ready"));
    await running;
    expect(client.request).toHaveBeenCalledOnce();
  });
  it("closes on a lost response and does not silently reconnect", async () => {
    const { controller, client, connect } = fixture([]);
    client.request.mockRejectedValue(new Error("connection lost"));
    await controller.start(true);
    expect(controller.snapshot.phase).toBe("error");
    await expect(controller.resume()).rejects.toThrow();
    expect(client.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });
  it("closes even when explicit cursor cancellation is rejected", async () => {
    const { controller, client } = fixture([progress()], { maxSteps: 1 });
    await controller.start(true);
    client.request.mockRejectedValue(new Error("cancel failed"));
    await controller.cancel();
    expect(client.close).toHaveBeenCalledOnce();
  });
  it.each([progress("incomplete", undefined), progress("cancelled", undefined), { status: "ready", issueCount: 3 }])("closes terminal or malformed responses", async (response) => {
    const { controller, client } = fixture([response]);
    await controller.start(true);
    expect(client.close).toHaveBeenCalledOnce();
    expect(controller.snapshot.phase).not.toBe("ready");
  });
  it("closes a connection arriving after disposal without starting a build", async () => {
    const { client } = fixture([]);
    let resolve!: (value: typeof client) => void;
    const controller = new HistoryRefreshController(() => new Promise((done) => { resolve = done; }), () => {});
    const running = controller.start(true);
    const cancelling = controller.cancel();
    resolve(client);
    await Promise.all([running, cancelling]);
    expect(client.request).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });
  it.each([progress("building", ""), progress("ready", "illegal"), { ...progress(), examinedEntries: -1 }])("rejects invalid wire progress", (value) => {
    expect(() => parseHistoryRefresh(value)).toThrow();
  });
});
