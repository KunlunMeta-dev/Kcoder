// Native launch configuration only. RPC/target.env cannot create the WeakSet brand.
import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { digestResource, ordinaryDirectory, readResource, resourceRelative, sha256, validSha } from '../office/resource-verifier.mjs';

export const nativeConnectivityEnvironmentKey = 'KCODER_NATIVE_CONNECTIVITY_BINDING_V1';
const manifestName = 'channel-resource-manifest.json';
const launches = new WeakSet(), ownedSources = new WeakMap();
const fail = code => Object.assign(new Error(code), { code });
export async function verifyNativeConnectivityBundle(componentRoot, expectedManifestSha256) {
  if (!validSha(expectedManifestSha256)) throw fail('CHANNEL_RESOURCE_IDENTITY_REQUIRED');
  const root = await ordinaryDirectory(componentRoot);
  const bytes = await readResource(join(root, manifestName));
  if (sha256(bytes) !== expectedManifestSha256) throw fail('CHANNEL_RESOURCE_IDENTITY_CHANGED');
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || manifest.name !== '@kunlunmeta/kcoder-channel-host' || manifest.version !== '0.1.0'
      || manifest.nodeMinimumMajor !== 22 || manifest.entry !== 'src/applications/stdio.mjs' || !validSha(manifest.lockSha256)
      || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20000
      || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes > 512 * 1024 * 1024)
    throw fail('CHANNEL_RESOURCE_MANIFEST_INVALID');
  const expected = new Map(); let total = 0;
  for (const file of manifest.files) {
    resourceRelative(file.path);
    if (!validSha(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || expected.has(file.path)) throw fail('CHANNEL_RESOURCE_MANIFEST_INVALID');
    expected.set(file.path, file); total += file.bytes;
  }
  if (total !== manifest.totalBytes || !['package.json','package-lock.json','src/applications/stdio.mjs','licenses/LICENSE.txt'].every(path => expected.has(path)))
    throw fail('CHANNEL_RESOURCE_MANIFEST_INVALID');
  if (expected.get('package-lock.json').sha256 !== manifest.lockSha256) throw fail('CHANNEL_RESOURCE_IDENTITY_CHANGED');
  const found = new Set();
  async function visit(directory, prefix = '', depth = 0) {
    if (depth > 40) throw fail('CHANNEL_RESOURCE_LIMIT');
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name; resourceRelative(path);
      if (path === manifestName) continue;
      const full = join(directory,name), info = await lstat(full);
      if (info.isSymbolicLink()) throw fail('CHANNEL_RESOURCE_UNSAFE');
      if (info.isDirectory()) { await visit(full,path,depth+1); continue; }
      const expectedFile = expected.get(path);
      if (!info.isFile() || !expectedFile) throw fail('CHANNEL_RESOURCE_IDENTITY_CHANGED');
      const actual = await digestResource(full,{maxBytes:expectedFile.bytes});
      if (actual.bytes !== expectedFile.bytes || actual.sha256 !== expectedFile.sha256) throw fail('CHANNEL_RESOURCE_IDENTITY_CHANGED');
      found.add(path);
    }
  }
  await visit(root);
  if (found.size !== expected.size) throw fail('CHANNEL_RESOURCE_IDENTITY_CHANGED');
  return {root,manifest,manifestSha256:expectedManifestSha256};
}
export async function prepareNativeConnectivityLaunch({componentRoot,expectedManifestSha256}) {
  const verified = await verifyNativeConnectivityBundle(componentRoot,expectedManifestSha256);
  // On macOS Electron's fuse lives in its framework, not the executable stub.
  // Use the sealed standalone Node carried by that package through the same launch protocol.
  const bundledNode = verified.manifest.files.some(file => file.path === 'runtime/node');
  return bindNativeConnectivityRuntime(verified.root, verified.manifestSha256, bundledNode);
}

async function bindNativeConnectivityRuntime(componentRoot, manifestSha256, bundledNode = false) {
  const nodeProgram = bundledNode ? join(componentRoot, 'runtime/node') : process.execPath;
  const nodeMode = !bundledNode && process.versions.electron ? 'electron_as_node' : 'standalone_node';
  if (Number(process.versions.node.split('.')[0]) < 22) throw fail('CHANNEL_NODE_UNAVAILABLE');
  const runtime = await digestResource(nodeProgram,{maxBytes:1024*1024*1024,inspectFuses:true});
  if (nodeMode === 'electron_as_node' ? !runtime.electronRunAsNodeEnabled : runtime.electronFusePresent) throw fail('CHANNEL_RUNTIME_MODE_UNAVAILABLE');
  const launch = Object.freeze({schemaVersion:1,componentRoot,manifestSha256,
    nodeProgram,nodeSha256:runtime.sha256,nodeMode,nodeVersion:bundledNode?undefined:process.versions.node,electronVersion:nodeMode==='electron_as_node'?process.versions.electron:null});
  launches.add(launch); return launch;
}
export function nativeConnectivitySpawnEnvironment(launch) {
  if (!launches.has(launch)) throw fail('CHANNEL_NATIVE_LAUNCH_REQUIRED');
  return Object.freeze({[nativeConnectivityEnvironmentKey]:Buffer.from(JSON.stringify(launch)).toString('base64url')});
}
export async function captureNativeConnectivityStartupConfiguration(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw fail('CHANNEL_STARTUP_INVALID');
  const value = JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
  if (!value || value.schemaVersion !== 1 || Object.keys(value).some(key=>!['schemaVersion','componentRoot','manifestSha256','nodeProgram','nodeSha256','nodeMode','nodeVersion','electronVersion'].includes(key))) throw fail('CHANNEL_STARTUP_INVALID');
  const launch = await prepareNativeConnectivityLaunch({componentRoot:value.componentRoot,expectedManifestSha256:value.manifestSha256});
  for (const key of ['nodeProgram','nodeSha256','nodeMode','nodeVersion','electronVersion']) if (launch[key] !== value[key]) throw fail('CHANNEL_RUNTIME_IDENTITY_CHANGED');
  return launch;
}
/** Consume native launch input synchronously before any asynchronous verifier. */
export async function captureGatewayNativeConnectivityStartup(environment = process.env) {
  const raw = environment[nativeConnectivityEnvironmentKey];
  for (const key of Object.keys(environment)) if (key.toUpperCase() === nativeConnectivityEnvironmentKey) delete environment[key];
  try { return raw ? await captureNativeConnectivityStartupConfiguration(raw) : await prepareSourceConnectivityLaunch(); }
  catch { console.warn('CHANNEL_NATIVE_UNAVAILABLE'); return null; }
}
/** Existing source Gateway builds an owned sealed copy from its own installed package. */
export async function prepareSourceConnectivityLaunch() {
  const sourceRoot = fileURLToPath(new URL('../../../../kcoder-channel-host/', import.meta.url));
  const script = join(sourceRoot,'scripts/stage-native-resources.mjs');
  try { if (!(await lstat(script)).isFile()) return null; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const owner = await realpath(await mkdtemp(join(tmpdir(),'kcoder-native-channel-resources-')));
  try {
    const {stageNativeConnectivityBundle} = await import(pathToFileURL(script).href);
    const bundle = await stageNativeConnectivityBundle({output:join(owner,'component'),nodeProgram:process.execPath});
    // Staging hashes each file in this newly created private tree. The Native
    // app-server verifies those hashes before loading it.
    const launch = await bindNativeConnectivityRuntime(bundle.componentRoot, bundle.manifestSha256);
    ownedSources.set(launch,owner); return launch;
  } catch (error) { await rm(owner,{recursive:true,force:true}); throw error; }
}
/** Call only after the original Gateway's owned app-server children have exited. */
export async function releaseSourceConnectivityLaunch(launch) {
  const owner = ownedSources.get(launch);
  if (owner) { ownedSources.delete(launch); await rm(owner,{recursive:true,force:true}); }
}
export async function settleSourceConnectivityLaunch(launch, ownedChildren, timeoutMs = 5000) {
  const deadline=Date.now()+timeoutMs;
  while(ownedChildren.size && Date.now()<deadline)await new Promise(accept=>setTimeout(accept,25));
  if(ownedChildren.size)return false;
  await releaseSourceConnectivityLaunch(launch);return true;
}
export async function preparePackagedConnectivityGatewayEnvironment({resourcesPath,appMetadata,remoteThin=false}={}) {
  if (remoteThin || appMetadata?.nativeConnectivityResources === undefined) return Object.freeze({});
  const pin = appMetadata.nativeConnectivityResources;
  if (!pin || pin.schemaVersion !== 1 || pin.resourceDirectory !== 'kcoder-channel-host' || pin.nodeMinimumMajor !== 22 || !validSha(pin.manifestSha256)
      || Object.keys(pin).some(key=>!['schemaVersion','resourceDirectory','manifestSha256','nodeMinimumMajor'].includes(key))) throw fail('CHANNEL_PACKAGED_PIN_INVALID');
  const launch = await prepareNativeConnectivityLaunch({componentRoot:resolve(resourcesPath,'kcoder-channel-host'),expectedManifestSha256:pin.manifestSha256});
  return nativeConnectivitySpawnEnvironment(launch);
}
