import { gatewaySessionExpired } from "@/gateway/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskRuntimeTestHelpers } from "./task-runtime";
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});
describe("移动端文件变更规范化", () => {
  it("保留 app-server 文件对象中的路径并兼容旧字符串", () => {
    expect(
      taskRuntimeTestHelpers.fileChangesFromValue({
        artifact_id: "artifact-1",
        workspace_path: "/workspace",
        file_count: 3,
        files: [
          {
            path: "src/main.ts",
            change_type: "modified",
            additions: 2,
            deletions: 1,
          },
          "README.md",
          { change_type: "deleted" },
        ],
        status: "active",
        revertible: true,
      })?.files,
    ).toEqual(["src/main.ts", "README.md"]);
  });
});
