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
const legalName = /^(?:licen[cs]e|notice|copying|authors|patents)(?:[.\-_]|$)/i;
const developmentFile = /\.(?:[cm]?ts|tsx|md|markdown)$|\.(?:[cm]?[jt]sx?|css)\.map$/i;
const developmentDotfile = /^\.(?:eslintrc|eslintignore|nycrc|editorconfig|jshintrc|jscsrc|travis\.yml|npmignore|prettierrc|prettierignore|babelrc|gitattributes|gitignore|airtap\.yml|zuul\.yml|taprc|mocharc)(?:\..*)?$/i;
/**
 * Third-party tests, type declarations, TypeScript sources, source maps and
 * Markdown documentation are development assets, never runtime resources.
 * License, notice and copying files are always kept.
 */
export function isProductionDependencyEntry(name, isDirectory = false) {
  if (isDirectory) return !['test', 'tests', '__tests__', '__fixtures__', 'coverage', '.nyc_output', '.github'].includes(name.toLowerCase());
  if (legalName.test(name)) return true;
  return !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(name) && !developmentFile.test(name) && !developmentDotfile.test(name);
}
// Node resolves this package through `main` (lib/); `module` (es/) and the
// declaration tree are never loaded by the host or the Gateway channel runtime.
const unusedDependencyDirectories = new Set([
  'node_modules/@larksuiteoapi/node-sdk/es', 'node_modules/@larksuiteoapi/node-sdk/types',
]);
const dingtalkRoot = 'node_modules/@alicloud/dingtalk';
/** Deep `@alicloud/dingtalk/dist/<module>/client.js` imports actually present in src/. */
export async function importedDingtalkModules(sourceRoot = join(packageRoot, 'src')) {
  const modules = new Set();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (/\.[cm]?js$/.test(entry.name))
        for (const match of (await readFile(full, 'utf8')).matchAll(/@alicloud\/dingtalk\/dist\/([a-z0-9_]+)\/client\.js/g)) modules.add(match[1]);
    }
  }
  await visit(sourceRoot);
  return modules;
}
/**
 * Path policy for staged dependencies. `path` is relative to the package root
 * with `/` separators. Type-only `@types` packages, unused builds and every
 * DingTalk API module the host never imports are excluded. A package without
 * any license-named file keeps its README, which then carries its notice.
 */
export function isRuntimeDependencyPath(path, { isDirectory = false, keepReadme = false, dingtalkModules = new Set() } = {}) {
  const parts = path.split('/'), name = parts.at(-1);
  if (parts.some((part, index) => part === '@types' && parts[index - 1] === 'node_modules')) return false;
  if (unusedDependencyDirectories.has(path)) return false;
  if (path.startsWith(dingtalkRoot + '/')) {
    const inner = path.slice(dingtalkRoot.length + 1).split('/');
    if (inner.length === 1) return isDirectory ? inner[0] === 'dist' : inner[0] === 'package.json' || legalName.test(inner[0]);
    if (inner[0] !== 'dist' || !dingtalkModules.has(inner[1])) return false;
  }
  if (!isDirectory && keepReadme && /^readme(?:\.|$)/i.test(name)) return true;
  return isProductionDependencyEntry(name, isDirectory);
}
/** Copy a verified ordinary runtime resource without imposing file mode policy. */
export async function copyResource(source, destination) {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}
/** Join every started copy before returning control to the owner's cleanup. */
export async function copyResources(resources, output) {
  let next = 0, failure;
  const files = new Array(resources.length);
  await Promise.all(Array.from({ length: Math.min(4, resources.length) }, async () => {
    while (!failure && next < resources.length) {
      const index = next++, { source, path, bytes } = resources[index];
      try {
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes) throw Error('Resource source changed during staging');
        const destination = join(output, path);
        await mkdir(dirname(destination), { recursive: true });
        await copyResource(source, destination);
        files[index] = { path, bytes, sha256: await sha(destination) };
      } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return files;
}
export async function resolveBundledNodeLicense(node) {
  const candidates=[join(dirname(dirname(node)),'LICENSE'),join(dirname(node),'LICENSE'),join(dirname(node),'LICENSE.txt')];
  for(const path of [...new Set(candidates)]){
    try{const info=await lstat(path);if(info.isFile()&&!info.isSymbolicLink())return path;}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  throw Error('Bundled Node LICENSE is unavailable; use a standalone Node distribution with its complete LICENSE at '+candidates.join(' or '));
}
export async function stageNativeConnectivityBundle({ output, nodeProgram, bundleNode = false }) {
  if (!isAbsolute(output) || !isAbsolute(nodeProgram)) throw Error('Explicit absolute native resource/runtime paths required');
  const node = await realpath(nodeProgram);
  const nodeInfo = await lstat(node);
  if (!nodeInfo.isFile() || nodeInfo.nlink !== 1) throw Error('Native Node runtime must be an ordinary single-link file');
  let nodeLicense;
  if(bundleNode){
    const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
    if (process.versions.electron || node !== await realpath(process.execPath) ||
        nodeMajor < 22 || nodeMajor === 22 && nodeMinor < 13)
      throw Error('Bundled channel runtime requires standalone Node 22.13.0+');
    nodeLicense=await resolveBundledNodeLicense(node);
  }
  // Creation is exclusive. This never repairs, publishes over, or reuses a tree.
  await mkdir(output);
  const resources = [];
  let totalBytes = 0;
  async function includeFile(source, destination) {
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Only ordinary resource files can be staged');
    const path = relative(output, destination).split(sep).join('/');
    if (path.startsWith('../') || path.includes(':') || path.includes('\\')) throw Error('Resource path escaped staging');
    totalBytes += info.size;
    if (resources.length >= 20000 || totalBytes > 512 * 1024 * 1024) throw Error('Native channel resource budget exceeded');
    resources.push({ source, path, bytes: info.size });
  }
  const dingtalkModules = await importedDingtalkModules();
  async function tree(source, destination, depth = 0, dependency = false) {
    if (depth > 40) throw Error('Native resource depth exceeded');
    const entries = await readdir(source, { withFileTypes: true });
    // A dependency package root without a license-named file keeps its README notice.
    const keepReadme = dependency && entries.some(entry => entry.name === 'package.json')
      && !entries.some(entry => legalName.test(entry.name));
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const from = join(source, entry.name), to = join(destination, entry.name);
      const path = relative(packageRoot, from).split(sep).join('/');
      if (entry.name === '.bin' || (dependency && !isRuntimeDependencyPath(path,
        { isDirectory: entry.isDirectory(), keepReadme, dingtalkModules }))) continue;
      if (entry.isSymbolicLink()) throw Error('Resource symlink is not allowed');
      if (entry.isDirectory()) await tree(from, to, depth + 1, dependency);
      else await includeFile(from, to);
    }
  }
  await includeFile(join(packageRoot, 'package.json'), join(output, 'package.json'));
  await includeFile(join(packageRoot, 'package-lock.json'), join(output, 'package-lock.json'));
  await tree(join(packageRoot, 'src'), join(output, 'src'));
  await tree(join(packageRoot, 'node_modules'), join(output, 'node_modules'), 0, true);
  await includeFile(join(repoRoot, 'LICENSE'), join(output, 'licenses/LICENSE.txt'));
  if (bundleNode) {
    // Bundle the native build toolchain, not a second runtime downloader or Electron's launcher stub.
    await includeFile(node, join(output, 'runtime/node'));
    await includeFile(nodeLicense, join(output, 'licenses/node-LICENSE.txt'));
  }
  const files = await copyResources(resources, output);
  if (bundleNode) await chmod(join(output, 'runtime/node'), 0o755);
  const lockSha256 = files.find(file => file.path === 'package-lock.json').sha256;
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
  await writeFile(manifestPath, bytes, { flag: 'wx' });
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
