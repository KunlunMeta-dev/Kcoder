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

  it("达到持久化上限后明确拒绝而不是让重启静默丢消息", () => {
    const queue = new TaskMessageQueue();
    for (let index = 0; index < 20; index += 1) queue.enqueue(message(String(index)));
    expect(() => queue.enqueue(message("overflow"))).toThrow("最多排队 20 条");
  });
});
