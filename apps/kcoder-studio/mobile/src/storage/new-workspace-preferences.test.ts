import { initLocale } from "@/i18n";
import { describe, expect, it } from "vitest";
import {
  newWorkspacePreferenceKey,
  normalizeNewWorkspacePreference,
  reasoningEffortLabel,
} from "./new-workspace-preferences";

describe("new workspace preferences", () => {
  it("规范化目录和隔离方式", () => {
    expect(
      normalizeNewWorkspacePreference({
        cwd: " /repo ",
        isolation: "worktree",
      }),
    ).toEqual({ cwd: "/repo", isolation: "worktree" });
    expect(
      normalizeNewWorkspacePreference({ cwd: "/repo", isolation: "unknown" }),
    ).toEqual({ cwd: "/repo", isolation: "local" });
    expect(normalizeNewWorkspacePreference({ cwd: " " })).toBeNull();
  });

  it("隔离不同 profile 和 server 的偏好", () => {
    expect(newWorkspacePreferenceKey("host:4174", "ssh/a", "scope/a")).toBe(
      "kcoder-studio:mobile-new-workspace:v1:host%3A4174:ssh%2Fa:scope:v2:scope%2Fa",
    );
  });

  it.each([
    [
      "en",
      [
        "Off",
        "Minimal",
        "Low",
        "Medium",
        "High",
        "Extra high",
        "Maximum",
        "Ultra",
      ],
    ],
    ["zh-CN", ["关闭", "最低", "低", "中", "高", "极高", "最大", "超高"]],
  ] as const)("保留 %s 的完整推理档位", (locale, labels) => {
    initLocale(locale);
    expect(
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
        reasoningEffortLabel,
      ),
    ).toEqual(labels);
    expect(reasoningEffortLabel("custom")).toBe("custom");
  });
});
