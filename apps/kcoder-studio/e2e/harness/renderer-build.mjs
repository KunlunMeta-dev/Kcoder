import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { appRoot } from "./run-context.mjs";

const rendererRoot = resolve(appRoot, "renderer");

export async function assertRendererBuildFresh({ sourceRoot = rendererRoot, buildRoot = process.env.KCODER_E2E_RENDERER_ROOT || resolve(sourceRoot, "dist") } = {}) {
  const distMtime = await newestMtime(resolve(buildRoot));
  const inputDirectories = ["src", "packages", "branding", "third_party"];
  const inputFiles = [
    "index.html", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "vite.config.ts", "postcss.config.js", "tailwind.config.js",
    "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json",
  ];
  const requiredMtime = Math.max(
    ...await Promise.all(inputDirectories.map(name => newestMtime(resolve(sourceRoot, name)))),
    await newestMtime(resolve(sourceRoot, "public"), new Set(["wasm", "vendor", "flyfish-viewer-assets.json"])),
    ...await Promise.all(inputFiles.map(name => fileMtime(resolve(sourceRoot, name)))),
  );
  if (distMtime < requiredMtime) {
    throw new Error(
      "KCoder Studio renderer 构建产物早于源码；请先运行 `pnpm --dir apps/kcoder-studio/renderer build`，避免 E2E 使用旧 dist 产生假通过或假失败。",
    );
  }
  return { distMtime, sourceMtime: requiredMtime };
}

async function newestMtime(directory, excludedNames = new Set()) {
  let newest = 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (excludedNames.has(entry.name)) continue;
    if (!entry.isDirectory() && /\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const path = resolve(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? await newestMtime(path, excludedNames) : await fileMtime(path));
  }
  return newest;
}

async function fileMtime(path) {
  return stat(path).then(value => value.mtimeMs).catch(() => 0);
}
