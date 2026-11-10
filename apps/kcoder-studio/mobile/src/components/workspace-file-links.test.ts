import { describe, expect, it } from "vitest";
import { isWorkspaceFileConflictError, workspaceFileLocationFromLink, workspaceFilePathFromInlineCode, workspaceFilePathFromLink, workspaceImageMimeType } from "./workspace-file-links";

describe("workspaceFilePathFromLink", () => {
  it("解析相对、file 和 vscode 文件链接", () => {
    expect(workspaceFilePathFromLink("src/app.tsx#L12", "/repo")).toBe("/repo/src/app.tsx");
    expect(workspaceFilePathFromLink("file:///repo/你好%20world.ts:8:2", "/repo")).toBe("/repo/你好 world.ts");
    expect(workspaceFilePathFromLink("vscode://file/repo/src/a.ts", "/repo")).toBe("/repo/src/a.ts");
    expect(workspaceFilePathFromLink("tmp/example.txt", "/")).toBe("/tmp/example.txt");
  });

  it("拒绝外部协议、工作区根目录和越界路径", () => {
    expect(workspaceFilePathFromLink("https://example.com/a.ts", "/repo")).toBeNull();
    expect(workspaceFilePathFromLink("../../etc/passwd", "/repo")).toBeNull();
    expect(workspaceFilePathFromLink("file:///other/a.ts", "/repo")).toBeNull();
    expect(workspaceFilePathFromLink(".", "/repo")).toBeNull();
    expect(workspaceFilePathFromLink("#section", "/repo")).toBeNull();
    expect(workspaceFilePathFromLink("javascript:alert(1)", "/repo")).toBeNull();
  });

  it("只把像文件路径的行内代码识别为工作区文件", () => {
    expect(workspaceFilePathFromInlineCode("README.md", "/repo")).toBe("/repo/README.md");
    expect(workspaceFilePathFromInlineCode("src/app.tsx:12:4", "/repo")).toBe("/repo/src/app.tsx");
    expect(workspaceFilePathFromInlineCode("src\\app.tsx:12:4", "C:\\repo")).toBe("C:\\repo\\src\\app.tsx");
    expect(workspaceFilePathFromInlineCode("npm test", "/repo")).toBeNull();
    expect(workspaceFilePathFromInlineCode("--help", "/repo")).toBeNull();
  });

  it("保留 Markdown 文件链接中的行列位置", () => {
    expect(workspaceFileLocationFromLink("src/app.tsx#L12-L14", "/repo")).toEqual({ path: "/repo/src/app.tsx", line: 12, column: undefined });
    expect(workspaceFileLocationFromLink("README.md:8:3", "/repo")).toEqual({ path: "/repo/README.md", line: 8, column: 3 });
  });

  it("解析 Windows drive 与 UNC 工作区中的相对、绝对和 file URL 链接", () => {
    expect(workspaceFileLocationFromLink("src\\App.tsx:12:4", "C:\\Work")).toEqual({
      path: "C:\\Work\\src\\App.tsx",
      line: 12,
      column: 4,
    });
    expect(workspaceFileLocationFromLink("C:\\Work\\src\\App.tsx#L7", "C:\\Work")).toEqual({
      path: "C:\\Work\\src\\App.tsx",
      line: 7,
      column: undefined,
    });
    expect(workspaceFileLocationFromLink("file:///C:/Work/src/App%20File.tsx:9", "C:\\Work")).toEqual({
      path: "C:\\Work\\src\\App File.tsx",
      line: 9,
      column: undefined,
    });
    expect(workspaceFileLocationFromLink("file://server/share/Work/src/App.tsx#L5", "\\\\server\\share\\Work")).toEqual({
      path: "\\\\server\\share\\Work\\src\\App.tsx",
      line: 5,
      column: undefined,
    });
    expect(workspaceFileLocationFromLink("src\\App.tsx:12", "C:/Work")).toMatchObject({
      path: "C:/Work/src/App.tsx",
      line: 12,
    });
  });

  it("拒绝 Windows drive 越界、路径分隔符歧义、scheme 和控制字符", () => {
    expect(workspaceFilePathFromLink("D:\\Other\\secret.txt", "C:\\Work")).toBeNull();
    expect(workspaceFilePathFromLink("..\\..\\outside.txt", "C:\\Work")).toBeNull();
    expect(workspaceFilePathFromLink("file:///C:/Other/secret.txt", "C:\\Work")).toBeNull();
    expect(workspaceFilePathFromLink("javascript:alert(1)", "C:\\Work")).toBeNull();
    expect(workspaceFilePathFromLink("src\\bad%00name.ts", "C:\\Work")).toBeNull();
  });
});

describe("isWorkspaceFileConflictError", () => {
  it("recognizes server revision conflicts without treating ordinary failures as conflicts", () => {
    expect(isWorkspaceFileConflictError(new Error("workspace file has changed on disk"))).toBe(true);
    expect(isWorkspaceFileConflictError("revision mismatch")).toBe(true);
    expect(isWorkspaceFileConflictError("permission denied")).toBe(false);
  });
});

describe("workspaceImageMimeType", () => {
  it("recognizes previewable raster image extensions case-insensitively", () => {
    expect(workspaceImageMimeType("screenshot.PNG")).toBe("image/png");
    expect(workspaceImageMimeType("photo.jpeg")).toBe("image/jpeg");
    expect(workspaceImageMimeType("animation.gif")).toBe("image/gif");
    expect(workspaceImageMimeType("icon.svg")).toBeNull();
  });
});
