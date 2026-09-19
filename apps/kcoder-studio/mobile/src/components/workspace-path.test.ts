import { describe, expect, it } from "vitest";
import { isWorkspacePath, joinWorkspacePath, workspaceRelativePath } from "./workspace-path";

describe("workspace paths", () => {
  it("handles the filesystem root without producing double slashes", () => {
    expect(isWorkspacePath("/", "/apps/mobile")).toBe(true);
    expect(joinWorkspacePath("/", "apps/mobile")).toBe("/apps/mobile");
    expect(joinWorkspacePath("/", "/apps/mobile")).toBe("/apps/mobile");
    expect(workspaceRelativePath("/", "/apps/mobile")).toBe("apps/mobile");
  });

  it("keeps a regular workspace bounded by path segments", () => {
    expect(isWorkspacePath("/srv/project", "/srv/project/src")).toBe(true);
    expect(isWorkspacePath("/srv/project", "/srv/project-copy")).toBe(false);
    expect(joinWorkspacePath("/srv/project", "src/main.ts")).toBe("/srv/project/src/main.ts");
    expect(workspaceRelativePath("/srv/project", "/srv/project/src/main.ts")).toBe("src/main.ts");
  });
});
