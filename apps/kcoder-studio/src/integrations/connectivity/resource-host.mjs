// Native launch configuration only. RPC/target.env cannot create the WeakSet brand.
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { digestResources, ordinaryDirectory, readResource, resourceRelative, sha256, validSha } from '../office/resource-verifier.mjs';
import { acquireSourceComponent, releaseSourceComponent } from './source-resource-cache.mjs';

export const nativeConnectivityEnvironmentKey = 'KCODER_NATIVE_CONNECTIVITY_BINDING_V1';
const manifestName = 'channel-resource-manifest.json';
const launches = new WeakSet(), ownedSources = new WeakMap();
const fail = code => Object.assign(new Error(code), { code });
/**
 * Cheap pinned-identity check: the root is an ordinary directory and the sealed
 * manifest bytes match the pin. It reads no component files or runtime bytes and
 * is never authority to load code; the app-server verifies every byte at load.
 */
export async function inspectNativeConnectivityBundle(componentRoot, expectedManifestSha256) {
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
  return {root,manifest,manifestSha256:expectedManifestSha256,expected};
}
/** Complete byte verification for build/release evidence and load boundaries. */
export async function verifyNativeConnectivityBundle(componentRoot, expectedManifestSha256, {signal}={}) {
  const {root,manifest,manifestSha256,expected} = await inspectNativeConnectivityBundle(componentRoot,expectedManifestSha256);
  const planned = [];
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
      planned.push({path,full,maximumBytes:expectedFile.bytes});
    }
  }
  await visit(root);
  if (planned.length !== expected.size) throw fail('CHANNEL_RESOURCE_IDENTITY_CHANGED');
  const digests = await digestResources(planned,{signal});
  planned.forEach(({path},index) => {
    const expectedFile = expected.get(path), actual = digests[index];
    if (actual.bytes !== expectedFile.bytes || actual.sha256 !== expectedFile.sha256) throw fail('CHANNEL_RESOURCE_IDENTITY_CHANGED');
  });
  return {root,manifest,manifestSha256};
}
/**
 * Electron and Gateway only check the pin and describe the runtime. The Native
 * app-server hashes the complete tree and runtime image once at its load boundary
 * and pins that image for later launches; this value grants no load authority.
 */
export async function prepareNativeConnectivityLaunch({componentRoot,expectedManifestSha256}) {
  const inspected = await inspectNativeConnectivityBundle(componentRoot,expectedManifestSha256);
  // On macOS Electron's fuse lives in its framework, not the executable stub.
  // Use the sealed standalone Node carried by that package through the same launch protocol.
  const bundledNode = inspected.manifest.files.some(file => file.path === 'runtime/node');
  return bindNativeConnectivityRuntime(inspected.root, inspected.manifestSha256, bundledNode);
}

function bindNativeConnectivityRuntime(componentRoot, manifestSha256, bundledNode = false, nodeSha256) {
  const nodeProgram = bundledNode ? join(componentRoot, 'runtime/node') : process.execPath;
  const nodeMode = !bundledNode && process.versions.electron ? 'electron_as_node' : 'standalone_node';
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || nodeMajor === 22 && nodeMinor < 13) throw fail('CHANNEL_NODE_UNAVAILABLE');
  // Fuse mode and image bytes are checked by the app-server before any load.
  const launch = Object.freeze({schemaVersion:1,componentRoot,manifestSha256,
    nodeProgram,...(nodeSha256 === undefined ? {} : {nodeSha256}),nodeMode,nodeVersion:bundledNode?undefined:process.versions.node,electronVersion:nodeMode==='electron_as_node'?process.versions.electron:null});
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
  if (value.nodeSha256 !== undefined && !validSha(value.nodeSha256)) throw fail('CHANNEL_STARTUP_INVALID');
  const inspected = await inspectNativeConnectivityBundle(value.componentRoot,value.manifestSha256);
  const bundledNode = inspected.manifest.files.some(file => file.path === 'runtime/node');
  // A parent's runtime digest is carried for the app-server to compare, not recomputed here.
  const launch = bindNativeConnectivityRuntime(inspected.root, inspected.manifestSha256, bundledNode, value.nodeSha256);
  for (const key of ['nodeProgram','nodeMode','nodeVersion','electronVersion']) if (launch[key] !== value[key]) throw fail('CHANNEL_RUNTIME_IDENTITY_CHANGED');
  return launch;
}
/** Consume native launch input synchronously before any asynchronous verifier. */
export async function captureGatewayNativeConnectivityStartup(environment = process.env) {
  const raw = environment[nativeConnectivityEnvironmentKey];
  for (const key of Object.keys(environment)) if (key.toUpperCase() === nativeConnectivityEnvironmentKey) delete environment[key];
  try { return raw ? await captureNativeConnectivityStartupConfiguration(raw) : await prepareSourceConnectivityLaunch(); }
  catch { console.warn('APPLICATION_NATIVE_UNAVAILABLE'); return null; }
}
/**
 * Existing source Gateway reuses an immutable private copy of its own package,
 * keyed by the lockfiles, source files and staging policy. Only a missing or
 * damaged copy is staged again; the Native app-server verifies every byte before load.
 */
export async function prepareSourceConnectivityLaunch({parent}={}) {
  const sourceRoot = fileURLToPath(new URL('../../../../kcoder-channel-host/', import.meta.url));
  const script = join(sourceRoot,'scripts/stage-native-resources.mjs');
  try { if (!(await lstat(script)).isFile()) return null; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const {stageNativeConnectivityBundle} = await import(pathToFileURL(script).href);
  const handle = await acquireSourceComponent({sourceRoot,stageScript:script,parent,
    stage:output => stageNativeConnectivityBundle({output,nodeProgram:process.execPath})});
  try {
    const launch = bindNativeConnectivityRuntime(handle.componentRoot, handle.manifestSha256);
    ownedSources.set(launch,handle); return launch;
  } catch (error) { await releaseSourceComponent(handle); throw error; }
}
/** Release this Gateway's lease; a shared immutable copy stays for the next start. */
export async function releaseSourceConnectivityLaunch(launch) {
  const handle = ownedSources.get(launch);
  if (handle) { ownedSources.delete(launch); await releaseSourceComponent(handle); }
}
/** Wait for owned children, then always release this Gateway's lease. */
export async function settleSourceConnectivityLaunch(launch, ownedChildren, timeoutMs = 5000) {
  const deadline=Date.now()+timeoutMs;
  while(ownedChildren.size && Date.now()<deadline)await new Promise(accept=>setTimeout(accept,25));
  const settled=!ownedChildren.size;
  // Shutdown already sent SIGKILL. A shared copy is never removed here, and an
  // ephemeral copy belongs only to this exiting Gateway.
  await releaseSourceConnectivityLaunch(launch);return settled;
}
export async function preparePackagedConnectivityGatewayEnvironment({resourcesPath,appMetadata,remoteThin=false}={}) {
  if (remoteThin || appMetadata?.nativeConnectivityResources === undefined) return Object.freeze({});
  const pin = appMetadata.nativeConnectivityResources;
  if (!pin || pin.schemaVersion !== 1 || pin.resourceDirectory !== 'kcoder-channel-host' || pin.nodeMinimumMajor !== 22 || !validSha(pin.manifestSha256)
      || Object.keys(pin).some(key=>!['schemaVersion','resourceDirectory','manifestSha256','nodeMinimumMajor'].includes(key))) throw fail('CHANNEL_PACKAGED_PIN_INVALID');
  const launch = await prepareNativeConnectivityLaunch({componentRoot:resolve(resourcesPath,'kcoder-channel-host'),expectedManifestSha256:pin.manifestSha256});
  return nativeConnectivitySpawnEnvironment(launch);
}
