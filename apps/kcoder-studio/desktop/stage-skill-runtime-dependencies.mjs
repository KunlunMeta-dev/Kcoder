// Stage the pinned skill runtime packages (apps/kcoder-studio/skill-runtime)
// into an ordinary, self-contained node_modules tree for extraResources.
// The source must already be installed from its own lockfile with
// `pnpm --dir apps/kcoder-studio/skill-runtime install --frozen-lockfile --ignore-scripts`.
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_RUNTIME_LAUNCHERS } from '../src/skill-node-runtime.mjs';

const studioRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SKILL_RUNTIME_PACKAGE_NAME = '@kcoder/studio-skill-runtime';
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_FILES = 60_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_DEPTH = 64;
const DEVELOPMENT_ONLY_FILE = /\.d\.[cm]?ts$|\.(?:[cm]?js|css)\.map$/;

function contains(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function validatePackageName(name) {
  if (typeof name !== 'string' || name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) {
    throw new Error('Skill runtime dependency name is invalid');
  }
}

async function canonicalOutput(output) {
  const missing = [];
  let parent = dirname(output);
  for (;;) {
    try { return join(await realpath(parent), ...missing.reverse(), basename(output)); }
    catch (error) {
      if (error.code !== 'ENOENT' || parent === dirname(parent)) throw error;
      missing.push(basename(parent)); parent = dirname(parent);
    }
  }
}

/** Read the pinned direct dependencies; ranges are rejected. */
export async function readSkillRuntimePins(sourceRoot) {
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (manifest.name !== SKILL_RUNTIME_PACKAGE_NAME || manifest.private !== true) throw new Error('Unknown skill runtime package identity');
  const pins = manifest.dependencies ?? {};
  if (!Object.keys(pins).length) throw new Error('Skill runtime declares no dependencies');
  for (const [name, version] of Object.entries(pins)) {
    validatePackageName(name);
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) throw new Error(`Skill runtime dependency ${name} must use an exact version`);
  }
  for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies', 'scripts']) {
    if (manifest[field] !== undefined) throw new Error(`Skill runtime package must not declare ${field}`);
  }
  return pins;
}

/** The installed tree must be pnpm's record of the committed lockfile. */
async function verifyInstalledLockfile(sourceRoot) {
  const lockfile = await readFile(join(sourceRoot, 'pnpm-lock.yaml'));
  let installed;
  try { installed = await readFile(join(sourceRoot, 'node_modules', '.pnpm', 'lock.yaml')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Skill runtime packages are not installed; run pnpm --dir apps/kcoder-studio/skill-runtime install --frozen-lockfile --ignore-scripts');
  }
  if (!lockfile.equals(installed)) {
    throw new Error('Installed skill runtime packages do not match pnpm-lock.yaml; run pnpm --dir apps/kcoder-studio/skill-runtime install --frozen-lockfile --ignore-scripts');
  }
}

/** Node's node_modules lookup list. It also applies to names that match a builtin (e.g. `buffer`). */
export function nodeModulePaths(fromDirectory) {
  const paths = [];
  for (let directory = resolve(fromDirectory); ; directory = dirname(directory)) {
    if (basename(directory) !== 'node_modules') paths.push(join(directory, 'node_modules'));
    if (directory === dirname(directory)) return paths;
  }
}

/**
 * Locate a package directory exactly like Node's node_modules lookup and keep
 * it inside the installed skill tree (never Studio's own node_modules).
 */
async function locatePackage(name, fromDirectory, installedRoot) {
  validatePackageName(name);
  for (const directory of nodeModulePaths(fromDirectory)) {
    const candidate = join(directory, ...name.split('/'));
    let packageFile;
    try { packageFile = await realpath(join(candidate, 'package.json')); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    const source = dirname(packageFile);
    if (!contains(installedRoot, source)) return null;
    const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
    if (metadata.name !== name) throw new Error(`Skill runtime dependency ${name} resolves to a different package`);
    return { source, metadata };
  }
  return null;
}

/**
 * Publish a self-contained skill package tree. Each pinned package keeps its
 * transitive dependencies below its own node_modules, so the top level (used
 * as NODE_PATH) exposes only the pinned packages. Native `.node` addons are
 * omitted: nothing is built and the tree must stay pure JavaScript. Type
 * declarations and source maps are omitted as development-only files.
 */
export async function stageSkillRuntimeDependencies({ sourceRoot = join(studioRoot, 'skill-runtime'), destination } = {}) {
  sourceRoot = await realpath(resolve(sourceRoot));
  const pins = await readSkillRuntimePins(sourceRoot);
  await verifyInstalledLockfile(sourceRoot);
  const installedRoot = await realpath(join(sourceRoot, 'node_modules'));
  const requestedOutput = resolve(destination ?? resolve(studioRoot, '../../target/packages/kcoder-studio/skill-runtime/node_modules'));
  if (basename(requestedOutput) !== 'node_modules') throw new Error('Skill runtime requires a dedicated node_modules staging directory');
  const output = await canonicalOutput(requestedOutput);
  if (contains(sourceRoot, output) || contains(studioRoot, output) || contains(output, sourceRoot)) {
    throw new Error('Skill runtime staging must be outside the source tree');
  }
  try {
    const info = await lstat(output);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Skill runtime staging destination must be an ordinary directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.skill-runtime-'));
  const fresh = join(staging, 'node_modules');
  const visited = new Map();
  const budget = { files: 0, bytes: 0, nativeAddonsOmitted: 0, developmentFilesOmitted: 0 };

  async function copyTree(from, to, depth) {
    if (depth > MAX_DEPTH) throw new Error('Skill runtime package depth exceeded');
    await mkdir(to, { recursive: true });
    for (const entry of (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      // pnpm writes only .bin shims below a package's own node_modules.
      if (depth === 0 && entry.name === 'node_modules') continue;
      const info = await lstat(source);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Skill runtime package contains an unsafe link or special file');
      if (info.isDirectory()) { await copyTree(source, target, depth + 1); continue; }
      if (entry.name.endsWith('.node')) { budget.nativeAddonsOmitted += 1; continue; }
      // Type declarations and source maps are never loaded at runtime (~40% of the tree).
      if (DEVELOPMENT_ONLY_FILE.test(entry.name)) { budget.developmentFilesOmitted += 1; continue; }
      budget.files += 1;
      budget.bytes += info.size;
      if (budget.files > MAX_FILES || budget.bytes > MAX_BYTES) throw new Error('Skill runtime staging budget exceeded');
      await copyFile(source, target, constants.COPYFILE_EXCL);
    }
  }

  async function place(name, source, metadata, outputPackage) {
    if (!contains(fresh, outputPackage)) throw new Error('Skill runtime package path escaped staging');
    const key = relative(fresh, outputPackage).split(sep).join('/');
    if (visited.has(key)) throw new Error(`Skill runtime dependency placement conflict: ${name}`);
    if (metadata.bundledDependencies || metadata.bundleDependencies) throw new Error(`Skill runtime dependency ${name} bundles dependencies`);
    visited.set(key, { source, version: metadata.version });
    await copyTree(source, outputPackage, 0);
  }

  // Node resolves a dependency from the nearest node_modules. Reuse an
  // identical copy visible from `parentOutput`; place new ones at the top of
  // this pinned package's subtree, nesting only on version conflicts.
  async function includeDependencies(source, metadata, parentOutput, subtreeRoot) {
    const groups = [
      [metadata.dependencies, true],
      [metadata.optionalDependencies, false],
      [metadata.peerDependencies, false],
    ];
    for (const [group, required] of groups) {
      for (const name of Object.keys(group ?? {})) {
        const located = await locatePackage(name, source, installedRoot);
        if (!located) {
          if (required) throw new Error(`Skill runtime dependency ${name} is not installed`);
          continue;
        }
        let outputPackage = join(subtreeRoot, 'node_modules', name);
        let reused = false;
        for (let parent = parentOutput; ; parent = dirname(parent)) {
          const candidate = relative(fresh, join(parent, 'node_modules', name)).split(sep).join('/');
          const existing = visited.get(candidate);
          if (existing) {
            if (existing.source === located.source) reused = true;
            else outputPackage = join(parentOutput, 'node_modules', name);
            break;
          }
          if (parent === subtreeRoot) break;
          if (!contains(subtreeRoot, parent)) throw new Error('Skill runtime dependency lookup escaped staging');
        }
        if (reused) continue;
        await place(name, located.source, located.metadata, outputPackage);
        await includeDependencies(located.source, located.metadata, outputPackage, subtreeRoot);
      }
    }
  }

  let previous = false;
  let restoreFailed = false;
  let primaryError;
  let published = false;
  try {
    await mkdir(fresh, { recursive: true });
    for (const [name, version] of Object.entries(pins)) {
      const located = await locatePackage(name, sourceRoot, installedRoot);
      if (!located) throw new Error(`Skill runtime dependency ${name} is not installed`);
      if (located.metadata.version !== version) throw new Error(`Skill runtime dependency ${name} is ${located.metadata.version}, expected ${version}`);
      const outputPackage = join(fresh, name);
      await place(name, located.source, located.metadata, outputPackage);
      await includeDependencies(located.source, located.metadata, outputPackage, outputPackage);
    }
    for (const launcher of SKILL_RUNTIME_LAUNCHERS) {
      if (!Object.hasOwn(pins, launcher.packageName)) continue;
      const info = await lstat(join(fresh, ...launcher.script.split('/')));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Skill runtime launcher script for ${launcher.name} is missing`);
    }
    try { await rename(output, join(staging, 'previous')); previous = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(fresh, output); published = true; }
    catch (error) {
      if (previous) {
        try { await rename(join(staging, 'previous'), output); }
        catch (restoreError) {
          restoreFailed = true;
          throw Object.assign(new Error(`Skill runtime staging failed; previous files preserved in ${staging}`, { cause: error }), { restoreError });
        }
      }
      throw error;
    }
    return {
      output,
      packages: Object.fromEntries(Object.keys(pins).map(name => [name, visited.get(name).version])),
      packageCount: visited.size,
      fileCount: budget.files,
      totalBytes: budget.bytes,
      nativeAddonsOmitted: budget.nativeAddonsOmitted,
      developmentFilesOmitted: budget.developmentFilesOmitted,
    };
  } catch (error) { primaryError = error; throw error;
  } finally {
    // The unique temporary directory holds only generated packaging files.
    if (!restoreFailed) {
      try { await rm(staging, { recursive: true, force: true }); }
      catch (cleanupError) {
        if (primaryError) Object.defineProperty(primaryError, 'cleanupError', { value: cleanupError });
        else throw Object.assign(new Error('Skill runtime staging cleanup is unconfirmed', { cause: cleanupError }), { published, staging });
      }
    }
  }
}
