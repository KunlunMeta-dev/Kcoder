import { describe, expect, it } from "vitest";
import { diffFilePaths, diffForFile, diffPathExistsAfter, parseGitStatus } from "./git-diff-utils";

describe("Git changes parsing", () => {
  it("保留 porcelain -z 中的中文、空格与 rename 目标路径", () => {
    expect(parseGitStatus(" M 你好 world.txt\0R  新名字.ts\0旧名字.ts\0?? a -> b.txt\0")).toEqual([
      { code: " M", path: "你好 world.txt", staged: false, working: true },
      { code: "R ", path: "新名字.ts", staged: true, working: false },
      { code: "??", path: "a -> b.txt", staged: false, working: true },
    ]);
  });

  it("按 ---/+++ 路径定位含空格、中文及新文件的 diff", () => {
    const diff = [
      "diff --git a/你好 world.txt b/你好 world.txt",
      "--- a/你好 world.txt",
      "+++ b/你好 world.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/new file.ts b/new file.ts",
      "--- /dev/null",
      "+++ b/new file.ts",
      "@@ -0,0 +1 @@",
      "+export {};",
    ].join("\n");
    expect(diffFilePaths(diff)).toEqual(["你好 world.txt", "new file.ts"]);
    expect(diffForFile(diff, "new file.ts")).toContain("+export {};");
    expect(diffForFile(diff, "你好 world.txt")).not.toContain("new file.ts");
  });

  it("解码 Git C-style quoted UTF-8 路径", () => {
    const diff = "diff --git a/x b/x\n--- \"a/\\344\\275\\240\\345\\245\\275.ts\"\n+++ \"b/\\344\\275\\240\\345\\245\\275.ts\"\n@@ -1 +1 @@\n-a\n+b";
    expect(diffFilePaths(diff)).toEqual(["你好.ts"]);
  });

  it("区分可在 Files 打开的当前文件与已删除文件", () => {
    const diff = [
      "diff --git a/removed.ts b/removed.ts",
      "--- a/removed.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/current.ts b/current.ts",
      "--- a/current.ts",
      "+++ b/current.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(diffPathExistsAfter(diff, "removed.ts")).toBe(false);
    expect(diffPathExistsAfter(diff, "current.ts")).toBe(true);
  });
});
