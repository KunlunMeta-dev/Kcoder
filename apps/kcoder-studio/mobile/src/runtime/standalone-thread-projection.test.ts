import { afterEach, expect, it, vi } from "vitest";
import { MobileRpcError } from "@/gateway/rpc";
import { updateThreadMetadata, subscribeThreadMutations } from "./task-runtime/threadDirectory";
import { taskRuntimeTestHelpers } from "./task-runtime/connectionFactory";
import { profile, server } from "./task-runtime/fixture.test-support";
const previous = { id: "projection", status: "idle" as const, title: "original", cwd: "/workspace", createdAt: "1", updatedAt: "1" };
afterEach(() => taskRuntimeTestHelpers.resetConnector());
it("projects before connection admission and rolls definite rejection back", async () => {
 let release!: () => void; const admission = new Promise<void>(resolve => { release = resolve; });
 taskRuntimeTestHelpers.setConnector(vi.fn(async () => { await admission; return { close: vi.fn(), request: async () => { throw new MobileRpcError("denied", 403, "remote"); } }; }) as never);
 const changes = vi.fn(); const events: unknown[] = []; const unsubscribe = subscribeThreadMutations(event => events.push(event.mutation));
 const pending = updateThreadMetadata(profile, server, previous.id, { title: "pending" }, previous.cwd, previous, changes);
 const rejection = expect(pending).rejects.toThrow("denied");
 expect(changes).toHaveBeenCalledWith(expect.objectContaining({ title: "pending" })); expect(events[0]).toEqual({ kind: "rename", title: "pending" });
 release(); await rejection; expect(changes).toHaveBeenLastCalledWith(previous); unsubscribe();
});
it("lost ACK reads exact thread authority and retains unknown if read fails", async () => {
 const request = vi.fn(async (method: string) => {
   if (method === "thread/read") return { thread: { ...previous, title: "pending" } };
   throw new MobileRpcError("ACK lost");
 }); taskRuntimeTestHelpers.setConnector(vi.fn(async () => ({ close: vi.fn(), request })) as never);
 const changes = vi.fn(); await updateThreadMetadata(profile, server, previous.id, { title: "pending" }, previous.cwd, previous, changes);
 expect(request).toHaveBeenCalledWith("thread/read", { threadId: previous.id, limit: 1 });
 request.mockRejectedValue(new MobileRpcError("offline"));
 await expect(updateThreadMetadata(profile, server, previous.id, { title: "next" }, previous.cwd, { ...previous, title: "pending" }, changes)).rejects.toThrow("结果仍未知");
 expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ title: "next" }));
});
