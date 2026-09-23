import { describe, expect, it } from "vitest";
import { TerminalCommandQueue, type TerminalWriter } from "./terminal-command-queue";

class DelayedWriter implements TerminalWriter {
  value = "";
  operations: string[] = [];

  reset(): void {
    this.operations.push("reset");
    this.value = "";
  }

  write(data: string, callback: () => void): void {
    this.operations.push(`start:${data}`);
    setTimeout(() => {
      this.value += data;
      this.operations.push(`finish:${data}`);
      callback();
    }, data === "old" ? 8 : 0);
  }
}

describe("TerminalCommandQueue", () => {
  it("在旧写入完成后原子替换，并让后续输出接在新快照之后", async () => {
    const writer = new DelayedWriter();
    const queue = new TerminalCommandQueue();
    const snapshots: number[] = [];
    queue.enqueue(writer, { type: "write", data: "old", sequence: 1 }, (sequence) => snapshots.push(sequence));
    queue.enqueue(writer, { type: "replace", data: "snapshot", sequence: 2 }, (sequence) => snapshots.push(sequence));
    queue.enqueue(writer, { type: "write", data: "+new", sequence: 3 }, (sequence) => snapshots.push(sequence));

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(writer.value).toBe("snapshot+new");
    expect(writer.operations).toEqual([
      "start:old", "finish:old", "reset", "start:snapshot", "finish:snapshot", "start:+new", "finish:+new",
    ]);
    expect(snapshots).toEqual([1, 2, 3]);
  });
});
