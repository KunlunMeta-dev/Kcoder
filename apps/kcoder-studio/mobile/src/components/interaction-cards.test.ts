import { describe, expect, it } from "vitest";
import {
  actionDescription,
  approvalActionPresentation,
} from "./approval-action";

describe("审批操作说明", () => {
  it("工具审批同时展示工具名和完整参数", () => {
    expect(
      actionDescription({
        type: "tool",
        name: "Write",
        input: { path: "/workspace/a.ts", content: "hello" },
      }),
    ).toContain('"path": "/workspace/a.ts"');
    expect(
      actionDescription({
        type: "tool",
        name: "Write",
        input: { path: "/workspace/a.ts" },
      }),
    ).toMatch(/^Tool: Write\nInput: /);
  });

  it("限制不受信任参数的展示长度", () => {
    const description = actionDescription({
      type: "tool",
      name: "Large",
      input: { data: "x".repeat(8_000) },
    });
    expect(description).toContain("input truncated");
    expect(description.length).toBeLessThan(4_200);
    expect(
      approvalActionPresentation({
        type: "tool",
        name: "Large",
        input: { data: "x".repeat(8_000) },
      }).safeToApprove,
    ).toBe(false);
  });

  it("缺少工具参数时明确告知用户", () => {
    expect(actionDescription({ type: "tool", name: "Unknown" })).toContain(
      "missing input",
    );
    expect(
      approvalActionPresentation({ type: "tool", name: "Unknown" })
        .safeToApprove,
    ).toBe(false);
  });
});
