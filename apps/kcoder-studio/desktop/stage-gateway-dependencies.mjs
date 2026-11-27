import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const excludedDirectoryNames = new Set(['node_modules', 'build', 'test', 'tests', '__tests__', '__fixtures__', '.git']);

function contains(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}
function packageName(name) {
  if (typeof name !== 'string' || name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) {
    throw new Error('Gateway dependency name is invalid');
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
function rejectSourceOverlap(source, output) {
  if (contains(source, output) || contains(output, source)) throw new Error('Gateway dependency staging overlaps a source tree');
}
async function verifyOrdinaryTree(root) {
  const info = await lstat(root);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('Gateway staging contains an unsafe link or special file');
  if (info.isDirectory()) for (const name of await readdir(root)) await verifyOrdinaryTree(join(root, name));
}

export function normalizeElectronArch(arch, fallback = process.arch) {
  if (arch === undefined || arch === null) return fallback;
  if (typeof arch === 'string') return arch;
  return ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' })[arch] ?? `unsupported-${arch}`;
}

async function resolvePackage(name, fromRoot) {
  packageName(name);
  const require = createRequire(join(fromRoot, 'package.json'));
  let packageFile;
  try {
    packageFile = await realpath(require.resolve(`${name}/package.json`));
  } catch (packageResolutionError) {
    // Some packages hide package.json behind exports.
    let entryFile;
    try {
      entryFile = await realpath(require.resolve(name));
    } catch (entryResolutionError) {
      if (entryResolutionError.code === 'MODULE_NOT_FOUND') throw entryResolutionError;
      throw packageResolutionError;
    }
    let current = dirname(entryFile);
    while (current !== dirname(current)) {
      const candidate = join(current, 'package.json');
      try {
        const metadata = JSON.parse(await readFile(candidate, 'utf8'));
        if (metadata.name === name) {
          packageFile = candidate;
          break;
        }
      } catch { /* Keep walking toward the package root. */ }
      current = dirname(current);
    }
    if (!packageFile) throw packageResolutionError;
  }
  const source = dirname(packageFile);
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  if (metadata.name !== name) throw new Error('Gateway dependency source name does not match');
  return { source, metadata };
}

/** Stage the standalone Gateway production dependencies. */
export async function stageGatewayDependencies({
  sourceRoot = studioRoot,
  destination,
} = {}) {
  sourceRoot = await realpath(resolve(sourceRoot));
  const requestedOutput = resolve(destination ?? resolve(sourceRoot, '../../target/packages/kcoder-studio/gateway-dependencies/node_modules'));
  if (basename(requestedOutput) !== 'node_modules') {
    throw new Error('Gateway dependencies require a dedicated node_modules staging directory');
  }
  const output = await canonicalOutput(requestedOutput);
  if (contains(sourceRoot, output)) throw new Error('Gateway dependencies require a dedicated staging directory outside the source tree');
  for (let ancestor = sourceRoot; ; ancestor = dirname(ancestor)) {
    if (output === join(ancestor, 'node_modules')) throw new Error('Gateway dependencies cannot replace live source node_modules');
    if (ancestor === dirname(ancestor)) break;
  }
  try {
    const info = await lstat(output);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Gateway dependency staging destination must be an ordinary directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.gateway-dependencies-'));
  const fresh = join(staging, 'node_modules');
  const visited = new Map();
  async function copyDependency(name, fromRoot, { parentOutput = dirname(fresh) } = {}) {
    const resolvedPackage = await resolvePackage(name, fromRoot);
    const { source, metadata } = resolvedPackage;
    rejectSourceOverlap(source, output);
    if (parentOutput !== dirname(fresh) && !contains(fresh, parentOutput)) throw new Error('Gateway dependency parent escaped staging');
    // Match Node's nearest-package lookup. Conflicting transitive versions stay
    // under their own parent instead of overwriting another package's dependency.
    let outputPackage = join(fresh, name);
    for (let parent = parentOutput; ; parent = dirname(parent)) {
      const candidate = relative(fresh, join(parent, 'node_modules', name)).split(sep).join('/');
      if (visited.has(candidate)) {
        const entry = visited.get(candidate);
        if (entry.source === source) {
          return true;
        }
        outputPackage = join(parentOutput, 'node_modules', name);
        break;
      }
      if (parent === dirname(fresh)) break;
      if (parent === dirname(parent) || !contains(dirname(fresh), parent)) throw new Error('Gateway dependency lookup escaped staging');
    }
    if (!contains(fresh, outputPackage)) throw new Error('Gateway dependency path escaped staging');
    const key = relative(fresh, outputPackage).split(sep).join('/');
    if (visited.has(key)) throw new Error(`Gateway dependency version conflict: ${name}`);
    const entry = { source, version: metadata.version, output: outputPackage };
    visited.set(key, entry);
    await mkdir(dirname(outputPackage), { recursive: true });
    await cp(source, outputPackage, {
      recursive: true,
      filter: async path => {
        const relativePath = relative(source, path).split(sep).filter(Boolean).join('/');
        const parts = relativePath.split('/').filter(Boolean);
        if (parts.some(part => excludedDirectoryNames.has(part)) || path.endsWith('.node') || /\.test\.[cm]?[jt]sx?$/.test(path)) return false;
        const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Gateway dependency source contains an unsafe link or special file');
        return true;
      },
    });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      await copyDependency(dependency, source, { parentOutput: outputPackage });
    }
    return true;
  }

  let previous = false;
  let restoreFailed = false;
  let primaryError, published = false;
  try {
    await mkdir(fresh, { recursive: true });
    for (const dependency of ['ssh2', 'jsonc-parser', 'ws', 'compression']) await copyDependency(dependency, sourceRoot);
    await verifyOrdinaryTree(fresh);
    try { await rename(output, join(staging, 'previous')); previous = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(fresh, output); published = true; }
    catch (error) {
      if (previous) {
        try { await rename(join(staging, 'previous'), output); }
        catch (restoreError) {
          restoreFailed = true;
          throw Object.assign(new Error(`Gateway dependency staging failed; previous files preserved in ${staging}`, { cause: error }), { restoreError });
        }
      }
      throw error;
    }
    return { output, packages: Object.fromEntries([...visited].map(([name, entry]) => [name, entry.version])) };
  } catch (error) { primaryError = error; throw error;
  } finally {
    // This unique temporary directory contains only packaging artifacts. Never
    // remove its backup if restoring the previous stage failed.
    if (!restoreFailed) try { await rm(staging, { recursive: true, force: true }); }
    catch (cleanupError) {
      if (primaryError) {
        Object.defineProperty(primaryError, 'cleanupError', { value: cleanupError });
        primaryError.cleanupUnconfirmed = true;
      } else throw Object.assign(new Error('Gateway dependency staging cleanup is unconfirmed', { cause: cleanupError }),
        { code: 'GATEWAY_DEPENDENCIES_CLEANUP_UNCONFIRMED', published, cleanupUnconfirmed: true, staging });
    }
  }
}

export default async function beforePack() {
  return stageGatewayDependencies();
}
