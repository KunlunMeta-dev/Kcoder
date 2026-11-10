import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APPLICATION_CATALOG, CHANNEL_CATALOG } from '../src/catalog.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
async function sha(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
/** Third-party test trees are development assets, never runtime resources. */
export function isProductionDependencyEntry(name, isDirectory = false) {
  if (isDirectory && ['test', 'tests', '__tests__', '__fixtures__', 'coverage', '.nyc_output'].includes(name.toLowerCase())) return false;
  return !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(name);
}
/** Normalize only the new owned copy; checkout modes never become runtime authority. */
export async function copyPrivateResource(source, destination) {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
}
export async function stageNativeConnectivityBundle({ output, nodeProgram, bundleNode = false }) {
  if (!isAbsolute(output) || !isAbsolute(nodeProgram)) throw Error('Explicit absolute native resource/runtime paths required');
  const node = await realpath(nodeProgram);
  const nodeInfo = await lstat(node);
  if (!nodeInfo.isFile() || nodeInfo.nlink !== 1) throw Error('Native Node runtime must be an ordinary single-link file');
  // Creation is exclusive. This never repairs, publishes over, or reuses a tree.
  await mkdir(output, { mode: 0o700 });
  const directories = new Set([output]);
  const files = [];
  let totalBytes = 0;
  async function put(source, destination) {
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Only ordinary resource files can be staged');
    const path = relative(output, destination).split(sep).join('/');
    if (path.startsWith('../') || path.includes(':') || path.includes('\\')) throw Error('Resource path escaped staging');
    totalBytes += info.size;
    if (files.length >= 20000 || totalBytes > 512 * 1024 * 1024) throw Error('Native channel resource budget exceeded');
    const directory = dirname(destination);
    if (!directories.has(directory)) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      directories.add(directory);
    }
    await copyPrivateResource(source, destination);
    const sha256 = await sha(destination);
    files.push({ path, bytes: info.size, sha256 });
    return sha256;
  }
  async function tree(source, destination, depth = 0, dependency = false) {
    if (depth > 40) throw Error('Native resource depth exceeded');
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.bin' || (dependency && !isProductionDependencyEntry(entry.name, entry.isDirectory()))) continue;
      const from = join(source, entry.name), to = join(destination, entry.name);
      if (entry.isSymbolicLink()) throw Error('Resource symlink is not allowed');
      if (entry.isDirectory()) await tree(from, to, depth + 1, dependency);
      else await put(from, to);
    }
  }
  await put(join(packageRoot, 'package.json'), join(output, 'package.json'));
  const lockSha256 = await put(join(packageRoot, 'package-lock.json'), join(output, 'package-lock.json'));
  await tree(join(packageRoot, 'src'), join(output, 'src'));
  await tree(join(packageRoot, 'node_modules'), join(output, 'node_modules'), 0, true);
  await put(join(repoRoot, 'LICENSE'), join(output, 'licenses/LICENSE.txt'));
  if (bundleNode) {
    // Bundle the native build toolchain, not a second runtime downloader or Electron's launcher stub.
    if (process.versions.electron || node !== await realpath(process.execPath) || Number(process.versions.node.split('.')[0]) < 22)
      throw Error('Bundled channel runtime requires the current standalone Node 22+');
    await put(node, join(output, 'runtime/node'));
    await chmod(join(output, 'runtime/node'), 0o755);
    await put(join(dirname(dirname(node)), 'LICENSE'), join(output, 'licenses/node-LICENSE.txt'));
  }
  const info = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'));
  if (info.name !== '@kunlunmeta/kcoder-channel-host' || info.version !== '0.1.0') throw Error('Unknown channel component identity');
  const manifest = {
    schemaVersion: 1, name: info.name, version: info.version, nodeMinimumMajor: 22,
    entry: 'src/applications/stdio.mjs', lockSha256,
    files: files.sort((a, b) => a.path.localeCompare(b.path)), totalBytes,
    catalog: { applications: APPLICATION_CATALOG, channels: CHANNEL_CATALOG },
  };
  const manifestPath = join(output, 'channel-resource-manifest.json');
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
  await writeFile(manifestPath, bytes, { flag: 'wx', mode: 0o600 });
  return { schemaVersion: 1, componentRoot: output, manifestSha256: createHash('sha256').update(bytes).digest('hex'), nodeProgram: node };
}

export async function stageNativeConnectivityResources(options) {
  const bundle = await stageNativeConnectivityBundle(options);
  return { ...bundle, nodeSha256: await sha(bundle.nodeProgram) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, nodeProgram] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(await stageNativeConnectivityResources({ output, nodeProgram })) + '\n');
}
