import { constants } from 'node:fs';
import { copyFile, lstat, link, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicPath, npmManifest, npmPackageFiles, runNpm } from './artifact-manifest.mjs';
import { stageStorageNativeAddon, storageNativeBuildInputs } from '../../apps/kcoder-studio/desktop/storage-native-resources.mjs';
import { stageConnectivityResources } from '../../apps/kcoder-channel-host/packaging/stage-resources.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const packageRoot = resolve(repositoryRoot, 'apps/kcoder-studio');
const outputRoot = resolve(repositoryRoot, 'target/packages/kcoder-studio-gateway');
const addonName = 'kcoder-native-storage.node';

function isWithin(root, path) {
  const local = relative(root, path);
  return local === '' || local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function packageFiles(root) {
  const files = npmPackageFiles(root);
  if (!files.includes('package.json')) throw new Error('Gateway npm source inventory is invalid');
  return files;
}

function hostTarget() {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 3 : process.arch === 'x64' ? 1 : null;
  if (!arch || !['linux', 'darwin', 'win32'].includes(platform)) {
    throw new Error(`Unsupported Gateway npm native target: ${platform}/${process.arch}`);
  }
  return { electronPlatformName: platform, arch };
}

async function copyPackageFile(sourceRoot, stageRoot, path) {
  assertPublicPath(path);
  const source = resolve(sourceRoot, path);
  const destination = resolve(stageRoot, path);
  if (!isWithin(sourceRoot, source) || !isWithin(stageRoot, destination)) throw new Error('Gateway npm path escaped package root');
  let current = source;
  while (current !== sourceRoot) {
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`Gateway npm source is a symbolic link: ${path}`);
    current = dirname(current);
  }
  const entry = await lstat(source);
  if (!entry.isFile()) throw new Error(`Gateway npm source is not a file: ${path}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

function validateNpmFiles(files) {
  const unique = new Set();
  for (const path of files) {
    if (typeof path !== 'string' || unique.has(path)) throw new Error('Gateway npm source inventory contains duplicate paths');
    assertPublicPath(path);
    unique.add(path);
  }
  if (!unique.has('package.json')) throw new Error('Gateway npm package.json is missing');
  return [...unique].sort();
}

async function isRegularFile(path) {
  try {
    const entry = await lstat(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoSourceRuntime(sourceRoot) {
  for (const path of ['bin/kcoder-native-storage.node', 'gateway-resources/kcoder-channel-host']) {
    try {
      await lstat(resolve(sourceRoot, path));
      throw new Error('Gateway npm source contains staged runtime resources; refusing checkout or architecture reuse');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

/** Copy npm's exact public allowlist, then add package-local runtime resources. */
export async function stageGatewayNpmPackage({
  sourceRoot = packageRoot,
  repository = repositoryRoot,
  stageRoot,
  destination,
  env = process.env,
  listFiles = packageFiles,
  stageAddon = stageStorageNativeAddon,
  stageChannel = stageConnectivityResources,
  createManifest,
  pack = (root, output) => runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', output], root),
} = {}) {
  sourceRoot = resolve(sourceRoot);
  repository = resolve(repository);
  if (typeof stageRoot !== 'string' || typeof destination !== 'string' || !isAbsolute(stageRoot) || !isAbsolute(destination)) {
    throw new Error('Gateway npm staging needs absolute owned paths');
  }
  stageRoot = resolve(stageRoot);
  destination = resolve(destination);
  if (isWithin(sourceRoot, stageRoot) || isWithin(sourceRoot, destination) ||
      isWithin(stageRoot, destination) || isWithin(destination, stageRoot)) {
    throw new Error('Gateway npm output paths overlap the source or package stage');
  }
  await mkdir(stageRoot, { recursive: false });
  await mkdir(destination, { recursive: true });
  await assertNoSourceRuntime(sourceRoot);
  const files = validateNpmFiles(await listFiles(sourceRoot));
  for (const path of files) await copyPackageFile(sourceRoot, stageRoot, path);
  const manifest = JSON.parse(await readFile(join(stageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@kcoder/studio' || !manifest.files?.includes('bin') || !manifest.files?.includes('gateway-resources')) {
    throw new Error('Gateway npm package manifest omits package-local runtime resources');
  }

  const context = hostTarget();
  const buildInputs = storageNativeBuildInputs(context, { repositoryRoot: repository, env, destinationRoot: stageRoot });
  const addon = await stageAddon(context, { repositoryRoot: repository, env, destinationRoot: stageRoot });
  if (addon?.source !== buildInputs.source || addon?.destination !== buildInputs.destination ||
      buildInputs.destination !== join(stageRoot, 'bin', addonName) || !await isRegularFile(buildInputs.destination)) {
    throw new Error('Gateway npm storage addon does not match the selected source target and package path');
  }

  const channelRoot = join(stageRoot, 'gateway-resources', 'kcoder-channel-host');
  const stagedChannel = await stageChannel({ destination: channelRoot, replace: false });
  if (stagedChannel?.componentRoot !== channelRoot ||
      !await isRegularFile(join(channelRoot, 'channel-resource-manifest.json')) ||
      !await isRegularFile(join(channelRoot, 'src/applications/store-bootstrap.mjs')) ||
      !await isRegularFile(join(channelRoot, 'src/channels/store-relocation.mjs'))) {
    throw new Error('Gateway npm channel-host resource stage is incomplete');
  }

  await (createManifest ?? (root => npmManifest(root, 'studio-web', buildInputs.target)))(stageRoot);
  const packageOutputRoot = await mkdtemp(join(destination, '.pending-'));
  try {
    const packed = JSON.parse(await pack(stageRoot, packageOutputRoot));
    const filename = packed?.[0]?.filename;
    if (typeof filename !== 'string' || !filename.endsWith('.tgz') || basename(filename) !== filename) {
      throw new Error('Gateway npm pack did not return a package filename');
    }
    const packagedFile = resolve(packageOutputRoot, filename);
    if (!await isRegularFile(packagedFile)) throw new Error('Gateway npm pack did not create its declared package file');
    const targetFilename = `${filename.slice(0, -'.tgz'.length)}-${buildInputs.target}.tgz`;
    const packageFile = resolve(destination, targetFilename);
    if (!isWithin(destination, packageFile)) throw new Error('Gateway npm output path escaped its destination');
    try { await link(packagedFile, packageFile); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Gateway npm artifact already exists; refusing replacement');
      throw error;
    }
    return Object.freeze({
      stageRoot,
      packageFile,
      platform: buildInputs.target,
      addonPath: buildInputs.destination,
      channelHostRoot: channelRoot,
    });
  } finally {
    await rm(packageOutputRoot, { recursive: true, force: true });
  }
}

async function main() {
  await mkdir(dirname(outputRoot), { recursive: true });
  const ownerRoot = await mkdtemp(resolve(dirname(outputRoot), '.kcoder-studio-gateway-npm-'));
  const stageRoot = resolve(ownerRoot, 'package');
  try {
    const result = await stageGatewayNpmPackage({ stageRoot, destination: outputRoot });
    process.stdout.write(`${result.packageFile}\n`);
  } finally {
    await rm(ownerRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
