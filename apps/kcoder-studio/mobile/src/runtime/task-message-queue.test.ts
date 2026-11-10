import { describe, expect, it, vi } from "vitest";
import { TaskMessageQueue, taskMessageQueue } from "./task-message-queue";

const message = (id: string) => ({ id, content: id, attachments: [], createdAt: 1 });

describe("TaskMessageQueue", () => {
  it("按入队顺序取出，并允许失败后放回队首", () => {
    const queue = new TaskMessageQueue();
    const listener = vi.fn();
    queue.subscribe(listener);
    queue.enqueue(message("a"));
    queue.enqueue(message("b"));
    expect(queue.takeFirst()?.id).toBe("a");
    queue.prepend(message("a"));
    expect(queue.getSnapshot().map((item) => item.id)).toEqual(["a", "b"]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("同一任务 owner 在面板重挂载后复用队列", () => {
    const owner = {};
    expect(taskMessageQueue(owner)).toBe(taskMessageQueue(owner));
    expect(taskMessageQueue(owner)).not.toBe(taskMessageQueue({}));
  });

  it("能从持久化状态恢复队列副本", () => {
    const queue = new TaskMessageQueue();
    const restored = [message("persisted")];
    queue.replace(restored);
    restored[0].content = "mutated";
    expect(queue.first()?.content).toBe("persisted");
  });

  it("首次派发前持久化并冻结权限，失败重试不会因选择变化而改写稳定ID", async () => {
    const queue = new TaskMessageQueue();
    queue.enqueue(message("queued-stable") as ReturnType<typeof message> & { attachments: [] });
    const persisted: unknown[] = [];
    const first = await queue.freezePermissionMode("queued-stable", "ask", async (items) => {
      persisted.push(items);
    });
    const retry = await queue.freezePermissionMode("queued-stable", "yolo", async (items) => {
      persisted.push(items);
    });

    expect(first).toBe("ask");
    expect(retry).toBe("ask");
    expect(queue.first()).toMatchObject({ id: "queued-stable", permissionMode: "ask" });
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject([{ id: "queued-stable", permissionMode: "ask" }]);
  });

  it("持久化失败时保留已捕获权限，并阻止本次 dispatch", async () => {
    const queue = new TaskMessageQueue();
    queue.enqueue(message("queued-stable") as ReturnType<typeof message> & { attachments: [] });

    await expect(
      queue.freezePermissionMode("queued-stable", "bypass", async () => {
        throw new Error("storage unavailable");
      }),
    ).rejects.toThrow("storage unavailable");
    expect(queue.first()).toMatchObject({ id: "queued-stable", permissionMode: "bypass" });
  });

  it("达到持久化上限后明确拒绝而不是让重启静默丢消息", () => {
    const queue = new TaskMessageQueue();
    for (let index = 0; index < 20; index += 1) queue.enqueue(message(String(index)));
    expect(() => queue.enqueue(message("overflow"))).toThrow("最多排队 20 条");
  });
});
