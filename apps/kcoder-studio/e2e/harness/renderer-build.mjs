import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { appRoot } from "./run-context.mjs";
import { RENDERER_BUILD_DIRECTORIES, RENDERER_BUILD_FILES } from "./settings-fingerprints.mjs";

const rendererRoot = resolve(appRoot, "renderer");

export async function assertRendererBuildFresh({ sourceRoot = rendererRoot, buildRoot = process.env.KCODER_E2E_RENDERER_ROOT || resolve(sourceRoot, "dist") } = {}) {
  for (const directory of [sourceRoot, resolve(sourceRoot, 'src'), buildRoot]) {
    if (!(await stat(directory)).isDirectory()) throw new Error('Renderer freshness requires existing source and build directories');
  }
  const distMtime = await newestMtime(resolve(buildRoot));
  const inputDirectories = RENDERER_BUILD_DIRECTORIES.filter(name => name !== "public");
  const sourceExclusions = new Set(["node_modules"]);
  const requiredMtime = Math.max(
    ...await Promise.all(inputDirectories.map(name => newestMtime(resolve(sourceRoot, name), sourceExclusions))),
    await newestMtime(resolve(sourceRoot, "public"), new Set(["wasm", "vendor", "flyfish-viewer-assets.json"])),
    ...await Promise.all(RENDERER_BUILD_FILES.map(name => fileMtime(resolve(sourceRoot, name)))),
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
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (excludedNames.has(entry.name)) continue;
    if (!entry.isDirectory() && /\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const path = resolve(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? await newestMtime(path, excludedNames) : await fileMtime(path));
  }
  return newest;
}

async function fileMtime(path) {
  return stat(path).then(value => value.mtimeMs).catch(error => {
    if (error.code === 'ENOENT') return 0;
    throw error;
  });
}
