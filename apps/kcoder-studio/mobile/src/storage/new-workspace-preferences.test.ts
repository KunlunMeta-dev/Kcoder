import { describe, expect, it } from "vitest";
import {
  newWorkspacePreferenceKey,
  normalizeNewWorkspacePreference,
  reasoningEffortLabel,
} from "./new-workspace-preferences";

describe("new workspace preferences", () => {
  it("规范化目录和隔离方式", () => {
    expect(normalizeNewWorkspacePreference({ cwd: " /repo ", isolation: "worktree" })).toEqual({ cwd: "/repo", isolation: "worktree" });
    expect(normalizeNewWorkspacePreference({ cwd: "/repo", isolation: "unknown" })).toEqual({ cwd: "/repo", isolation: "local" });
    expect(normalizeNewWorkspacePreference({ cwd: " " })).toBeNull();
  });

  it("隔离不同 profile 和 server 的偏好", () => {
    expect(newWorkspacePreferenceKey("host:4174", "ssh/a")).toBe(
      "kcoder-studio:mobile-new-workspace:v1:host%3A4174:ssh%2Fa",
    );
  });

  it("保留 Paseo/Codex 风格的完整推理档位", () => {
    expect(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(reasoningEffortLabel)).toEqual(
      ["关闭", "最低", "低", "中", "高", "极高", "最大", "超高"],
    );
    expect(reasoningEffortLabel("custom")).toBe("custom");
  });
});
