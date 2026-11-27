import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const studioPackage = '@kcoder/studio';
const channelHostPackage = '@kunlunmeta/kcoder-channel-host';
const addonName = 'kcoder-native-storage.node';
const fail = code => { throw Object.assign(new Error(code), { code }); };

function inside(root, path) {
  const local = relative(root, path);
  return local === '' || local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

async function ordinaryDirectory(path) {
  try {
    const entry = await lstat(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readPackage(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return null;
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function ordinaryFile(path) {
  try {
    const entry = await lstat(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function isSourceCheckout(applicationRoot) {
  const repositoryRoot = resolve(applicationRoot, '../..');
  const [workspace, native, channelHost] = await Promise.all([
    ordinaryFile(resolve(repositoryRoot, 'Cargo.toml')),
    ordinaryFile(resolve(repositoryRoot, 'crates/kcoder_native_storage/Cargo.toml')),
    readPackage(resolve(repositoryRoot, 'apps/kcoder-channel-host/package.json')),
  ]);
  return workspace && native && channelHost?.name === channelHostPackage
    ? repositoryRoot : null;
}

async function isChannelHostResource(root) {
  const [pkg, manifest, source] = await Promise.all([
    readPackage(resolve(root, 'package.json')),
    readPackage(resolve(root, 'channel-resource-manifest.json')),
    ordinaryDirectory(resolve(root, 'src')),
  ]);
  return source && pkg?.name === channelHostPackage && manifest?.schemaVersion === 1 &&
    manifest.name === channelHostPackage && typeof manifest.entry === 'string';
}

/** Resolve only the three supported runtime layouts from the entry's known app root. */
export async function resolveStorageRuntimeResources({ moduleUrl, applicationRoot, resourcesPath } = {}) {
  if (typeof moduleUrl !== 'string' || typeof applicationRoot !== 'string' || !isAbsolute(applicationRoot)) {
    fail('STORAGE_RUNTIME_LAYOUT_UNAVAILABLE');
  }
  const modulePath = fileURLToPath(moduleUrl);
  const appRoot = resolve(applicationRoot);
  if (!inside(appRoot, modulePath)) fail('STORAGE_RUNTIME_LAYOUT_UNAVAILABLE');

  const repositoryRoot = await isSourceCheckout(appRoot);
  if (repositoryRoot && appRoot === resolve(repositoryRoot, 'apps/kcoder-studio')) {
    const channelHostRoot = resolve(repositoryRoot, 'apps/kcoder-channel-host/src');
    if (!await ordinaryDirectory(channelHostRoot)) fail('STORAGE_CHANNEL_HOST_RESOURCE_UNAVAILABLE');
    return Object.freeze({
      layout: 'source',
      applicationRoot: appRoot,
      repositoryRoot,
      channelHostRoot,
    });
  }

  if (resourcesPath !== undefined) {
    const electronResources = resolve(resourcesPath);
    if (inside(electronResources, modulePath)) {
      const channelHostComponent = resolve(electronResources, 'kcoder-channel-host');
      if (!await isChannelHostResource(channelHostComponent)) fail('STORAGE_CHANNEL_HOST_RESOURCE_UNAVAILABLE');
      return Object.freeze({
        layout: 'electron',
        applicationRoot: appRoot,
        resourcesRoot: electronResources,
        channelHostRoot: resolve(channelHostComponent, 'src'),
        nativeAddonPath: resolve(electronResources, 'bin', addonName),
      });
    }
  }

  const packageInfo = await readPackage(resolve(appRoot, 'package.json'));
  if (packageInfo?.name === studioPackage) {
    const channelHostComponent = resolve(appRoot, 'gateway-resources/kcoder-channel-host');
    const channelHostRoot = resolve(channelHostComponent, 'src');
    if (!await isChannelHostResource(channelHostComponent)) fail('STORAGE_CHANNEL_HOST_RESOURCE_UNAVAILABLE');
    return Object.freeze({
      layout: 'npm',
      applicationRoot: appRoot,
      channelHostRoot,
      nativeAddonPath: resolve(appRoot, 'bin', addonName),
    });
  }

  const resourceRoot = dirname(appRoot);
  const expectedResources = resourcesPath === undefined ? resourceRoot : resolve(resourcesPath);
  const channelHostComponent = resolve(expectedResources, 'kcoder-channel-host');
  const channelHostRoot = resolve(channelHostComponent, 'src');
  if (basename(appRoot) !== 'gateway' || resolve(expectedResources, 'gateway') !== appRoot ||
      expectedResources !== resourceRoot || !await isChannelHostResource(channelHostComponent)) fail('STORAGE_RUNTIME_LAYOUT_UNAVAILABLE');
  return Object.freeze({
    layout: 'electron',
    applicationRoot: appRoot,
    resourcesRoot: expectedResources,
    channelHostRoot,
    nativeAddonPath: resolve(expectedResources, 'bin', addonName),
  });
}

export function storageChannelHostModuleUrl(channelHostRoot, relativePath) {
  if (typeof channelHostRoot !== 'string' || typeof relativePath !== 'string' || !relativePath ||
      relativePath.includes('\0') || isAbsolute(relativePath)) fail('STORAGE_CHANNEL_HOST_RESOURCE_UNAVAILABLE');
  const root = resolve(channelHostRoot);
  const path = resolve(root, relativePath);
  if (!inside(root, path)) fail('STORAGE_CHANNEL_HOST_RESOURCE_UNAVAILABLE');
  return pathToFileURL(path).href;
}
