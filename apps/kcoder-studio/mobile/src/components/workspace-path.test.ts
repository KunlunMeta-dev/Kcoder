import { describe, expect, it } from "vitest";
import { isWorkspacePath, joinWorkspacePath, safeWorkspacePathRelative, workspacePathName, workspacePathParent, workspaceRelativePath } from "./workspace-path";

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

  it.each([
    { root: "C:\\workspace", child: "C:\\workspace\\src\\main.ts", joined: "C:\\workspace\\src\\main.ts" },
    { root: "C:/workspace", child: "C:/workspace/src/main.ts", joined: "C:/workspace/src/main.ts" },
    { root: "\\\\server\\share\\workspace", child: "\\\\server\\share\\workspace\\src\\main.ts", joined: "\\\\server\\share\\workspace\\src\\main.ts" },
  ])("supports a Windows drive or UNC root without accepting sibling paths", ({ root, child, joined }) => {
    expect(isWorkspacePath(root, child)).toBe(true);
    expect(workspaceRelativePath(root, child)).toBe("src/main.ts");
    expect(joinWorkspacePath(root, "src/main.ts")).toBe(joined);
    expect(workspacePathParent(root, child)).toBe(joinWorkspacePath(root, "src"));
    expect(workspacePathName(child)).toBe("main.ts");
    expect(isWorkspacePath(root, `${root}-old\\private.txt`)).toBe(false);
  });

  it("joins children under a Windows drive root", () => {
    expect(isWorkspacePath("C:\\", "C:\\src\\main.ts")).toBe(true);
    expect(workspaceRelativePath("C:\\", "C:\\src\\main.ts")).toBe("src/main.ts");
    expect(joinWorkspacePath("C:\\", "src/main.ts")).toBe("C:\\src\\main.ts");
  });

  it("compares Windows roots without case while keeping segment containment", () => {
    expect(isWorkspacePath("C:\\Work", "c:\\work\\Src\\main.ts")).toBe(true);
    expect(workspaceRelativePath("C:\\Work", "c:\\work\\Src\\main.ts")).toBe("Src/main.ts");
    expect(workspacePathParent("C:\\Work", "c:\\work\\Src\\main.ts")).toBe("C:\\Work\\Src");
    expect(isWorkspacePath("C:\\Work", "c:\\worker\\private.ts")).toBe(false);
    expect(isWorkspacePath("\\\\Server\\Share\\Work", "\\\\server\\share\\work\\src\\main.ts")).toBe(true);
  });

  it("allows a workspace root directory while rejecting traversal and control segments", () => {
    expect(isWorkspacePath("/workspace", "/workspace")).toBe(true);
    expect(isWorkspacePath("/workspace", "/workspace/src")).toBe(true);
    expect(isWorkspacePath("/workspace", "/workspace/src/")).toBe(true);
    expect(isWorkspacePath("/workspace", "/workspace/../outside")).toBe(false);
    expect(isWorkspacePath("/workspace", "/workspace/../")).toBe(false);
    expect(isWorkspacePath("/workspace", "/workspace/./src")).toBe(false);
    expect(isWorkspacePath("/workspace", "/workspace/src/bad\u0001name")).toBe(false);
    expect(workspaceRelativePath("/workspace", "/workspace/../outside")).toBe("");
    expect(safeWorkspacePathRelative("/workspace", "/workspace")).toBeNull();
    expect(safeWorkspacePathRelative("/workspace", "/workspace", true)).toBe("");

    expect(isWorkspacePath("C:\\workspace", "C:\\workspace")).toBe(true);
    expect(isWorkspacePath("C:\\workspace", "C:\\workspace\\src\\")).toBe(true);
    expect(isWorkspacePath("C:\\workspace", "C:\\workspace\\..\\outside")).toBe(false);
    expect(isWorkspacePath("C:\\workspace", "C:\\workspace\\src\\bad\u0001name")).toBe(false);
    expect(workspaceRelativePath("C:\\workspace", "C:\\workspace\\..\\outside")).toBe("");
  });
});
