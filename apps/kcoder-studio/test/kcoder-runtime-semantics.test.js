import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const compatibilityFiles = new Set([
  resolve(repoRoot, "apps/kcoder-studio/renderer/src/kcoder/legacyRuntimeAbi.ts"),
  resolve(repoRoot, "apps/kcoder-studio/renderer/src/kcoder/legacyRuntimeAbi.test.ts"),
]);
const scannedRoots = [
  resolve(repoRoot, "apps/kcoder-studio/src"),
  resolve(repoRoot, "apps/kcoder-studio/e2e"),
  resolve(repoRoot, "apps/kcoder-studio/renderer/src/kcoder"),
  resolve(repoRoot, "crates/kcoder_cli/src/app_server.rs"),
  resolve(repoRoot, "crates/kcoder_cli/tests/app_server_stdio.rs"),
  resolve(repoRoot, "apps/kcoder-studio/dev-server.mjs"),
];
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx", ".rs"]);
const forbiddenPatterns = [
  /runtime\.codex\./,
  /runtime\s*:\s*["']codex["']/,
];

async function sourceFiles(path) {
  if (sourceExtensions.has(extname(path))) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(entry => {
      const entryPath = resolve(path, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return sourceExtensions.has(extname(entry.name)) ? [entryPath] : [];
    })
  );
  return nested.flat();
}

test("KCoder 产品代码不会重新引入 Codex app-server 业务语义", async () => {
  const files = (await Promise.all(scannedRoots.map(sourceFiles)))
    .flat()
    .filter(path => !compatibilityFiles.has(path));
  const violations = [];
  for (const path of files) {
    const source = await readFile(path, "utf8");
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(source)) violations.push(`${path.slice(repoRoot.length + 1)}: ${pattern}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    "旧 Wework Codex ABI 只能出现在 legacyRuntimeAbi 兼容模块中",
  );
});
