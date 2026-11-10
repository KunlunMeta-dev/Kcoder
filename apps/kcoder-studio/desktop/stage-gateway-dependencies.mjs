import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const excludedDirectoryNames = new Set(['node_modules', 'build', 'test', 'tests', '__tests__', '__fixtures__', '.git']);

function normalizePlatform(platform) {
  if (platform === 'mac') return 'darwin';
  if (platform === 'win') return 'win32';
  return platform;
}

export function normalizeElectronArch(arch, fallback = process.arch) {
  if (arch === undefined || arch === null) return fallback;
  if (typeof arch === 'string') return arch;
  return ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' })[arch] ?? `unsupported-${arch}`;
}

async function resolvePackage(name, fromRoot) {
  const require = createRequire(join(fromRoot, 'package.json'));
  let packageFile;
  try {
    packageFile = await realpath(require.resolve(`${name}/package.json`));
  } catch (packageResolutionError) {
    // Some packages (including node-datachannel) hide package.json behind exports.
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
  return { source, metadata };
}

async function findNodeDatachannelAddon(packageRoot) {
  const addon = join(packageRoot, 'build', 'Release', 'node_datachannel.node');
  try {
    const info = await lstat(addon);
    return info.isFile() && !info.isSymbolicLink() ? addon : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Stage the standalone Gateway's production dependencies. The N-API addon is
 * included only when the packaged target matches the machine that produced it.
 */
export async function stageGatewayDependencies({
  sourceRoot = studioRoot,
  destination,
  targetPlatform = process.platform,
  targetArch = process.arch,
} = {}) {
  const output = resolve(destination ?? resolve(sourceRoot, '../../target/packages/kcoder-studio/gateway-dependencies/node_modules'));
  if (basename(output) !== 'node_modules' || dirname(output) === dirname(sourceRoot)) {
    throw new Error('Gateway dependencies require a dedicated node_modules staging directory');
  }
  const normalizedTargetPlatform = normalizePlatform(targetPlatform);
  const normalizedTargetArch = normalizeElectronArch(targetArch);
  const matchesBuildHost = normalizedTargetPlatform === process.platform && normalizedTargetArch === process.arch;
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.gateway-dependencies-'));
  const fresh = join(staging, 'node_modules');
  await mkdir(fresh, { recursive: true });
  const visited = new Map();
  const nativeStatus = {
    status: 'omitted',
    targetPlatform: normalizedTargetPlatform,
    targetArch: normalizedTargetArch,
    reason: matchesBuildHost ? 'native-addon-missing' : 'target-does-not-match-build-host',
  };

  async function copyDependency(name, fromRoot, { includeNodeDatachannelAddon = false, parentOutput = dirname(fresh) } = {}) {
    const resolvedPackage = await resolvePackage(name, fromRoot);
    const { source, metadata } = resolvedPackage;
    // Match Node's nearest-package lookup. Conflicting transitive versions stay
    // under their own parent instead of overwriting another package's dependency.
    let outputPackage = join(fresh, name);
    for (let parent = parentOutput; ; parent = dirname(parent)) {
      const candidate = relative(fresh, join(parent, 'node_modules', name)).split(sep).join('/');
      if (visited.has(candidate)) {
        if (visited.get(candidate) === metadata.version) return true;
        outputPackage = join(parentOutput, 'node_modules', name);
        break;
      }
      if (parent === dirname(fresh)) break;
    }
    const key = relative(fresh, outputPackage).split(sep).join('/');
    if (visited.has(key)) throw new Error(`Gateway dependency version conflict: ${name}`);
    visited.set(key, metadata.version);
    await mkdir(dirname(outputPackage), { recursive: true });
    await cp(source, outputPackage, {
      recursive: true,
      filter: path => {
        const relativePath = relative(source, path).split(sep).filter(Boolean).join('/');
        if (name === 'node-datachannel' && includeNodeDatachannelAddon &&
          ['build', 'build/Release', 'build/Release/node_datachannel.node'].includes(relativePath)) return true;
        const parts = relativePath.split('/').filter(Boolean);
        return !parts.some(part => excludedDirectoryNames.has(part)) && !path.endsWith('.node') && !/\.test\.[cm]?[jt]sx?$/.test(path);
      },
    });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      await copyDependency(dependency, source, { parentOutput: outputPackage });
    }
    return true;
  }

  let previous = false;
  let restoreFailed = false;
  try {
    for (const dependency of ['ssh2', 'jsonc-parser', 'ws', 'compression']) await copyDependency(dependency, sourceRoot);
    if (matchesBuildHost) {
      let source;
      try {
        ({ source } = await resolvePackage('node-datachannel', sourceRoot));
      } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        nativeStatus.reason = 'optional-package-not-installed';
      }
      if (source) {
        const addon = await findNodeDatachannelAddon(source);
        if (addon) {
          await copyDependency('node-datachannel', sourceRoot, { includeNodeDatachannelAddon: true });
          nativeStatus.status = 'included';
          nativeStatus.reason = null;
        }
      }
    }
    try { await rename(output, join(staging, 'previous')); previous = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(fresh, output); }
    catch (error) {
      if (previous) {
        try { await rename(join(staging, 'previous'), output); }
        catch { restoreFailed = true; throw new Error(`Gateway dependency staging failed; previous files preserved in ${staging}`); }
      }
      throw error;
    }
    return { output, packages: Object.fromEntries(visited), p2pNative: nativeStatus };
  } finally {
    // This unique temporary directory contains only packaging artifacts. Never
    // remove its backup if restoring the previous stage failed.
    if (!restoreFailed) await rm(staging, { recursive: true, force: true });
  }
}

function reportP2PStatus(result) {
  if (result?.p2pNative?.status === 'omitted') {
    console.warn(`Gateway P2P native transport omitted for ${result.p2pNative.targetPlatform}/${result.p2pNative.targetArch} (${result.p2pNative.reason}); Relay fallback remains available.`);
  }
}

export default async function beforePack(context) {
  const result = await stageGatewayDependencies({
    targetPlatform: context?.electronPlatformName ?? process.platform,
    targetArch: normalizeElectronArch(context?.arch, 'unknown'),
  });
  reportP2PStatus(result);
  return result;
}
