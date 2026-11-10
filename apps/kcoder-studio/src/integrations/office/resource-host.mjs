// Called by the native Electron/Gateway launcher, never an HTTP or renderer API.
import { digestResource, resourceError, verifyOfficeResourceBundle } from './resource-verifier.mjs';
const nativeLaunches = new WeakSet();
export const nativeOfficeEnvironmentKey = 'KCODER_NATIVE_OFFICE_BINDING_V1';
export async function prepareNativeOfficeLaunch({ componentRoot, expectedManifestSha256, expectedMode } = {}) {
  const verified = await verifyOfficeResourceBundle(componentRoot, expectedManifestSha256);
  const mode = process.versions.electron ? 'electron_as_node' : 'standalone_node';
  if (expectedMode !== undefined && expectedMode !== mode) throw resourceError('OFFICE_RUNTIME_MODE_UNAVAILABLE');
  if (Number(process.versions.node.split('.')[0]) < verified.manifest.nodeMinimumMajor) throw resourceError('OFFICE_NODE_UNAVAILABLE');
  const runtime = await digestResource(process.execPath, { maxBytes: 1024 * 1024 * 1024, inspectFuses: true });
  if (mode === 'electron_as_node' ? !runtime.electronRunAsNodeEnabled : runtime.electronFusePresent) throw resourceError('OFFICE_RUNTIME_MODE_UNAVAILABLE');
  const launch = Object.freeze({ schemaVersion: 1, componentRoot: verified.root, manifestSha256: verified.manifestSha256,
    runtime: Object.freeze({ program: process.execPath, sha256: runtime.sha256, mode, nodeVersion: process.versions.node, electronVersion: process.versions.electron ?? null }) });
  nativeLaunches.add(launch); return launch;
}
/** Configuration for an already authenticated native spawn, not a permission token. */
export function nativeOfficeSpawnEnvironment(launch) {
  if (!nativeLaunches.has(launch)) throw resourceError('OFFICE_NATIVE_LAUNCH_REQUIRED');
  return Object.freeze({ [nativeOfficeEnvironmentKey]: Buffer.from(JSON.stringify(launch)).toString('base64url') });
}
/** Exact host values for Root's native factory; JSON cannot create this brand. */
export function nativeOfficeLaunchValues(launch) {
  if (!nativeLaunches.has(launch)) throw resourceError('OFFICE_NATIVE_LAUNCH_REQUIRED');
  return launch;
}

/** Root calls once at native Gateway startup, not from target/env or business RPC. */
export async function captureNativeOfficeStartupConfiguration(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw resourceError('OFFICE_STARTUP_INVALID');
  let value;
  try { value=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')); } catch { throw resourceError('OFFICE_STARTUP_INVALID'); }
  if (!value || value.schemaVersion!==1 || !value.runtime || Object.keys(value).some(key=>!['schemaVersion','componentRoot','manifestSha256','runtime'].includes(key))
      || Object.keys(value.runtime).some(key=>!['program','sha256','mode','nodeVersion','electronVersion'].includes(key))) throw resourceError('OFFICE_STARTUP_INVALID');
  const launch=await prepareNativeOfficeLaunch({componentRoot:value.componentRoot,expectedManifestSha256:value.manifestSha256,expectedMode:value.runtime.mode});
  for(const key of ['program','sha256','mode','nodeVersion','electronVersion']) if(launch.runtime[key]!==value.runtime[key]) throw resourceError('OFFICE_RUNTIME_MODE_UNAVAILABLE');
  return launch;
}

/** Packaged full desktop producer; expected SHA is the app.asar build receipt. */
export async function preparePackagedOfficeGatewayEnvironment({ resourcesPath, appMetadata, remoteThin = false } = {}) {
  if (remoteThin) return Object.freeze({});
  const pin=appMetadata?.nativeOfficeResources;
  if (pin === undefined) return Object.freeze({});
  if (!pin || pin.schemaVersion!==1 || pin.resourceDirectory!=='office' || pin.nodeMinimumMajor!==22
      || typeof pin.manifestSha256!=='string' || !/^[a-f0-9]{64}$/.test(pin.manifestSha256)
      || Object.keys(pin).some(key=>!['schemaVersion','resourceDirectory','manifestSha256','nodeMinimumMajor'].includes(key))
      || typeof resourcesPath!=='string') throw resourceError('OFFICE_PACKAGED_PIN_INVALID');
  if (!process.versions.electron) throw resourceError('OFFICE_RUNTIME_MODE_UNAVAILABLE');
  const {resolve,isAbsolute}=await import('node:path');
  if(!isAbsolute(resourcesPath))throw resourceError('OFFICE_PACKAGED_PIN_INVALID');
  const launch=await prepareNativeOfficeLaunch({componentRoot:resolve(resourcesPath,'office'),expectedManifestSha256:pin.manifestSha256,expectedMode:'electron_as_node'});
  return nativeOfficeSpawnEnvironment(launch);
}
