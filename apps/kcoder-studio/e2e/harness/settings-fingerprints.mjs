import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const RENDERER_BUILD_DIRECTORIES = ["src", "packages", "branding", "third_party", "public"];
const RENDERER_BUILD_FILES = [
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "postcss.config.js",
  "tailwind.config.js",
  "components.json",
];
const RENDERER_SOURCE_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);

/**
 * Fingerprint all ordinary files under a frozen export root.
 * Symlinks are rejected so the digest cannot silently include files outside
 * the path a caller intended to pin.
 */
export async function fingerprintRegularTree(root) {
  const canonicalRoot = await assertCanonicalDirectory(root);
  const entries = await inventoryDirectory(canonicalRoot, canonicalRoot);
  return { entries, digest: digestEntries(entries) };
}

/** Fingerprint one regular source file beneath a canonical root. */
export async function fingerprintRegularFile(root, file) {
  const canonicalRoot = await assertCanonicalDirectory(root);
  const path = resolve(canonicalRoot, file);
  await assertContainedPath(canonicalRoot, path, file);
  const info = await lstat(path);
  assert.ok(!info.isSymbolicLink(), `fingerprint entry cannot be a symlink: ${path}`);
  assert.ok(info.isFile(), `fingerprint entry must be a regular file: ${path}`);
  const entries = [await inventoryFile(canonicalRoot, path)];
  return { entries, digest: digestEntries(entries) };
}

/**
 * Fingerprint shared assets separately and expose the bundled Noto Sans SC
 * source files as an independent summary. This does not imply that a product
 * manifest binds these assets as build inputs.
 */
export async function fingerprintSharedAssets(root) {
  const tree = await fingerprintRegularTree(root);
  const notoSansScEntries = tree.entries.filter(entry =>
    entry.path.startsWith("fonts/noto-sans-sc/"));
  return {
    ...tree,
    notoSansSc: {
      entries: notoSansScEntries,
      digest: digestEntries(notoSansScEntries),
    },
  };
}

/**
 * Fingerprint the source and configuration consumed by the desktop Vite build.
 * `root` is apps/kcoder-studio/renderer; generated dist, dependencies and
 * native host files are intentionally outside this Web build input set.
 */
export async function fingerprintRendererSource(root) {
  const canonicalRoot = await assertCanonicalDirectory(root);
  const entries = [];
  for (const directory of RENDERER_BUILD_DIRECTORIES) {
    const path = resolve(canonicalRoot, directory);
    await assertContainedPath(canonicalRoot, path, directory);
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), `Renderer build input cannot be a symlink: ${path}`);
    assert.ok(info.isDirectory(), `Renderer build input directory is missing: ${path}`);
    entries.push(...await inventoryDirectory(canonicalRoot, path, { excludedDirectories: RENDERER_SOURCE_EXCLUDED_DIRECTORIES }));
  }
  for (const file of RENDERER_BUILD_FILES) {
    const path = resolve(canonicalRoot, file);
    await assertContainedPath(canonicalRoot, path, file);
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), `Renderer build input cannot be a symlink: ${path}`);
    assert.ok(info.isFile(), `Renderer build input file is missing: ${path}`);
    entries.push(await inventoryFile(canonicalRoot, path));
  }
  entries.sort((left, right) => comparePath(left.path, right.path));
  return { entries, digest: digestEntries(entries) };
}

async function assertCanonicalDirectory(root) {
  const absolute = resolve(root);
  const info = await lstat(absolute);
  assert.ok(!info.isSymbolicLink(), `fingerprint root cannot be a symlink: ${absolute}`);
  assert.ok(info.isDirectory(), `fingerprint root must be a directory: ${absolute}`);
  assert.equal(await realpath(absolute), absolute, `fingerprint root must be canonical: ${absolute}`);
  return absolute;
}

async function assertContainedPath(root, path, label) {
  const rel = relative(root, path);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`), `${label} must stay beneath ${root}`);
}

async function inventoryDirectory(root, directory, options = {}) {
  const entries = [];
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => comparePath(left.name, right.name));
  for (const child of children) {
    const path = resolve(directory, child.name);
    const info = await lstat(path);
    if (options.excludedDirectories?.has(child.name) && (child.isDirectory() || info.isSymbolicLink())) continue;
    assert.ok(!info.isSymbolicLink(), `fingerprint entry cannot be a symlink: ${path}`);
    if (child.isDirectory()) entries.push(...await inventoryDirectory(root, path, options));
    else {
      assert.ok(child.isFile() && info.isFile(), `fingerprint entry must be a regular file: ${path}`);
      entries.push(await inventoryFile(root, path));
    }
  }
  return entries;
}

async function inventoryFile(root, path) {
  const bytes = await readFile(path);
  return {
    path: relative(root, path).split(sep).join("/"),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function digestEntries(entries) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
