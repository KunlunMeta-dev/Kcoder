import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileRpcError } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient } from "./task-runtime/fixture.test-support";

function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
});

describe("TaskRuntime metadata and model review", () => {
  it("serializes optimistic renames and rolls a rejected later rename back to the confirmed predecessor", async () => {
    const first = deferred();
    const second = deferred();
    const client = new FakeClient([]);
    let metadataCalls = 0;
    client.request = vi.fn(async (method: string) => {
      if (method !== "thread/metadata/update") return {};
      metadataCalls += 1;
      return metadataCalls === 1 ? first.promise : second.promise;
    }) as never;

    const runtime = TaskRuntime.demo("metadata-review-thread");
    runtime.attachClient(client as never);
    const renameA = runtime.rename("A");
    const resultA = expect(renameA).resolves.toBeUndefined();
    const renameB = runtime.rename("B");
    expect(runtime.getSnapshot().title).toBe("B");
    await vi.waitFor(() => expect(metadataCalls).toBe(1));

    first.resolve({});
    await resultA;
    await vi.waitFor(() => expect(metadataCalls).toBe(2));
    second.reject(new MobileRpcError("explicit metadata rejection", 409, "remote"));
    await expect(renameB).rejects.toThrow("explicit metadata rejection");

    expect(runtime.getSnapshot().title).toBe("A");
    expect(runtime.getSnapshot().metadataPending).toEqual([]);
    expect(runtime.getSnapshot().metadataUnknown ?? []).not.toContain("title");
    runtime.close();
  });

  it("uses authoritative thread/read data after an ambiguous model update, not the pending selection", async () => {
    const client = new FakeClient([]);
    const ambiguous = new MobileRpcError("model ACK lost", -1, "transport", "unknown");
    client.request = vi.fn(async (method: string) => {
      if (method === "thread/metadata/update") throw ambiguous;
      if (method === "thread/read")
        return {
          thread: {
            id: "metadata-review-thread",
            model: "confirmed-model",
            modelProvider: "confirmed-provider",
          },
        };
      return {};
    }) as never;

    const runtime = TaskRuntime.demo("metadata-review-thread");
    runtime.attachClient(client as never);
    const previousModel = runtime.getSnapshot().model;
    await expect(runtime.setTurnPreferences("pending-model")).rejects.toThrow("model ACK lost");

    expect(client.request).toHaveBeenCalledWith(
      "thread/read",
      expect.objectContaining({ threadId: "metadata-review-thread" }),
      undefined,
    );
    expect(runtime.getSnapshot().pendingTurnPreferences).toBeUndefined();
    expect(runtime.getSnapshot().model).toBe("confirmed-provider::confirmed-model");
    expect(runtime.getSnapshot().model).not.toBe("pending-model");
    expect(runtime.getSnapshot().model).not.toBe(previousModel);
    expect(runtime.getSnapshot().configurationReady).toBe(true);
    runtime.close();
  });
});
