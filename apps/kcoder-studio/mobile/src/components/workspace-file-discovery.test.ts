import { describe, expect, it, vi } from "vitest";
import type { TaskRuntime } from "@/runtime/task-runtime";
import {
  parseWorkspacePathSearchResult,
  rememberWorkspaceFile,
  rememberWorkspaceFileAfterPersistence,
  searchWorkspacePaths,
  workspaceRecentFilesForRoot,
  WorkspaceSearchQueryTooLongError,
  workspaceSearchQueryByteLength,
} from "./workspace-file-discovery";

describe("workspace file discovery", () => {
  it("uses the current workspace root and maps the existing path-name RPC", async () => {
    const request = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
      files: [
        { path: "src/main.ts", fileName: "main.ts", matchType: "file", score: 900 },
        { path: "src/mobile", fileName: "mobile", matchType: "directory", score: 800 },
      ],
    }));
    const task = { request } as unknown as TaskRuntime;

    await expect(searchWorkspacePaths(task, "/workspace", "  main  ")).resolves.toEqual([
      { path: "/workspace/src/main.ts", name: "main.ts", is_directory: false },
      { path: "/workspace/src/mobile", name: "mobile", is_directory: true },
    ]);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("runtime.workspace.search", {
      root: "/workspace",
      query: "main",
    });
  });

  it("drops malformed and escaping server paths before they become openable entries", () => {
    expect(
      parseWorkspacePathSearchResult("/workspace", {
        files: [
          { path: "src/main.rs", matchType: "file" },
          { path: "../outside.txt", matchType: "file" },
          { path: "/etc/passwd", matchType: "file" },
          { path: "src\\secret.txt", matchType: "file" },
          { path: "src//secret.txt", matchType: "file" },
          { path: "src/.", matchType: "directory" },
          { path: "src/other", matchType: "content" },
          null,
        ],
      }),
    ).toEqual([
      { path: "/workspace/src/main.rs", name: "main.rs", is_directory: false },
    ]);
  });

  it("maps slash-separated search results under Windows drive and UNC roots", () => {
    expect(parseWorkspacePathSearchResult("C:\\workspace", {
      files: [
        { path: "src/main.rs", matchType: "file" },
        { path: "../outside.txt", matchType: "file" },
        { path: "src\\ambiguous.rs", matchType: "file" },
      ],
    })).toEqual([
      { path: "C:\\workspace\\src\\main.rs", name: "main.rs", is_directory: false },
    ]);
    expect(parseWorkspacePathSearchResult("\\\\server\\share\\workspace", {
      files: [{ path: "docs/guide.md", matchType: "file" }],
    })).toEqual([
      { path: "\\\\server\\share\\workspace\\docs\\guide.md", name: "guide.md", is_directory: false },
    ]);
  });

  it("keeps recent files inside the current workspace and restores newest unique paths", () => {
    expect(
      workspaceRecentFilesForRoot("/workspace", [
        "/workspace/src/a.ts",
        "/workspace-copy/private.txt",
        "/other/private.txt",
        "/workspace/../outside.txt",
        "/workspace/src/folder/",
        "/workspace",
        "/workspace/src/a.ts",
      ]),
    ).toEqual(["/workspace/src/a.ts"]);
    expect(
      rememberWorkspaceFile("/workspace", ["/workspace/src/a.ts"], "/workspace/src/b.ts"),
    ).toEqual(["/workspace/src/b.ts", "/workspace/src/a.ts"]);
    expect(
      workspaceRecentFilesForRoot("/workspace-copy", ["/workspace/src/a.ts"]),
    ).toEqual([]);
    expect(workspaceRecentFilesForRoot("C:\\workspace", [
      "C:\\workspace\\src\\a.ts",
      "C:\\workspace-old\\private.txt",
      "C:\\workspace\\..\\outside.txt",
    ])).toEqual(["C:\\workspace\\src\\a.ts"]);
  });

  it("does not commit a recent-file update when persistence fails", async () => {
    const existing = ["/workspace/src/previous.ts"];
    const persist = vi.fn(async (_path: string) => {
      throw new Error("storage unavailable");
    });

    await expect(
      rememberWorkspaceFileAfterPersistence(
        "/workspace",
        "/workspace/src/current.ts",
        persist,
      ),
    ).rejects.toThrow("storage unavailable");
    expect(persist).toHaveBeenCalledWith("/workspace/src/current.ts");
    expect(existing).toEqual(["/workspace/src/previous.ts"]);
  });

  it("uses the persisted merged recent list instead of a panel snapshot", async () => {
    const stalePanelSnapshot = ["/workspace/src/old.ts"];
    const persist = vi.fn(async (path: string) => [path, "/workspace/src/newer-panel.ts"]);
    await expect(
      rememberWorkspaceFileAfterPersistence("/workspace", "/workspace/src/current.ts", persist),
    ).resolves.toEqual([
      "/workspace/src/current.ts",
      "/workspace/src/newer-panel.ts",
    ]);
    expect(persist).toHaveBeenCalledWith("/workspace/src/current.ts");
    expect(stalePanelSnapshot).toEqual(["/workspace/src/old.ts"]);
  });

  it("bounds recent history and rejects queries beyond the server byte limit locally", async () => {
    const history = Array.from({ length: 25 }, (_, index) => `/workspace/src/${index}.ts`);
    const recent = rememberWorkspaceFile("/workspace", history, "/workspace/src/new.ts");
    expect(recent).toHaveLength(20);
    expect(recent[0]).toBe("/workspace/src/new.ts");
    expect(recent).not.toContain("/workspace/src/19.ts");

    const request = vi.fn();
    const task = { request } as unknown as TaskRuntime;
    const tooLongQuery = "🧭".repeat(65);
    expect(workspaceSearchQueryByteLength(tooLongQuery)).toBe(260);
    await expect(searchWorkspacePaths(task, "/workspace", tooLongQuery)).rejects.toBeInstanceOf(
      WorkspaceSearchQueryTooLongError,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
