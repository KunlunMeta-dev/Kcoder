// Only the actually loaded Windows addon can produce this process-local lease.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { nativeOfficeSpawnEnvironment } from './office/resource-host.mjs';
import { nativeConnectivitySpawnEnvironment } from './connectivity/resource-host.mjs';

const leases = new WeakMap();
const parentKey = 'KCODER_PRIVATE_RETENTION_PARENT_V1';
export const nativeComponentImageEnvironmentKey = 'KCODER_NATIVE_COMPONENT_IMAGE_BINDING_V1';
const fail = () => Object.assign(new Error('NATIVE_COMPONENT_IMAGE_UNAVAILABLE'), {code:'NATIVE_COMPONENT_IMAGE_UNAVAILABLE'});
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function consumeNativeComponentImageStartup(environment = process.env) {
  const raw = environment[nativeComponentImageEnvironmentKey];
  for (const key of Object.keys(environment)) if (key.toUpperCase() === nativeComponentImageEnvironmentKey) delete environment[key];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > 65536 || !/^[a-zA-Z0-9_-]+$/.test(raw)) throw fail();
  const pin = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  validatePin(pin);
  return Object.freeze(pin);
}

function validatePin(pin) {
  if (!pin || pin.schemaVersion !== 1 || pin.abiVersion !== 1 || typeof pin.addonPath !== 'string' || !isAbsolute(pin.addonPath)
      || !validSha(pin.addonSha256) || !validSha(pin.programSha256)
      || Object.keys(pin).some(key => !['schemaVersion','abiVersion','addonPath','addonSha256','programSha256'].includes(key))) throw fail();
}

export async function captureTrustedWindowsComponentImage(program, pin) {
  if (process.platform !== 'win32') return null;
  if (typeof program !== 'string' || !isAbsolute(program)) throw fail();
  validatePin(pin);
  const addonPath = await realpath(pin.addonPath);
  const info = await lstat(addonPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) throw fail();
  const bytes = await readFile(addonPath);
  if (createHash('sha256').update(bytes).digest('hex') !== pin.addonSha256) throw fail();
  // dlopen always loads a native image; no .js extension fallback is possible.
  // The native capture independently verifies the actual mapped addon file,
  // its image identity/hash, and the original target under held kernel locks.
  const loaded = {exports:{}};
  process.dlopen(loaded, addonPath);
  const native = loaded.exports;
  if (native.abiVersion !== 1 || !['captureImage','sameImage','closeImage'].every(key => typeof native[key] === 'function')) throw fail();
  const opaque = native.captureImage(addonPath, pin.addonSha256, program, pin.programSha256);
  return wrapImage(native, opaque, { ...pin, addonPath }, program, true);
}

function wrapImage(native, opaque, pin, program, component, parent) {
  let closed = false;
  const image = Object.freeze({
    ...(component ? { matches(target) {
      if (closed || target?.runtime !== 'kcoder' || target.transport !== 'local' || target.security
          || typeof target.command !== 'string' || !isAbsolute(target.command)) return false;
      try { return native.sameImage(opaque, target.command) === true; } catch { return false; }
    } } : {}),
    verifyCurrent() {
      if (closed) throw fail();
      parent?.verifyCurrent();
      if (native.sameImage(opaque, program) !== true) throw fail();
    },
    close() {
      if (closed) return;
      closed = true;
      native.closeImage(opaque);
    },
  });
  leases.set(image, {native, opaque, pin, program, component, isClosed:() => closed});
  return image;
}

function gatewayImage(image) {
  const lease = leases.get(image);
  if (!lease?.component || lease.isClosed()) throw fail();
  image.verifyCurrent();
  return lease;
}

export function windowsSystemSshPath(existingGatewayImage) {
  const lease = gatewayImage(existingGatewayImage);
  if (process.platform !== 'win32' || typeof lease.native.systemSshPath !== 'function') throw fail();
  const path = lease.native.systemSshPath();
  if (typeof path !== 'string' || !isAbsolute(path)) throw fail();
  return path;
}

/** Explicit executable-load boundary. RPC, polling and warm verification never hash it again. */
export async function captureWindowsExecutableImage(existingGatewayImage, program) {
  const lease = gatewayImage(existingGatewayImage);
  if (process.platform !== 'win32' || program !== windowsSystemSshPath(existingGatewayImage)) throw fail();
  const info = await lstat(program);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink < 1 || info.size > 1024 * 1024 * 1024 ||
      typeof lease.native.captureSystemSshImage !== 'function') throw fail();
  const bytes = await readFile(program);
  existingGatewayImage.verifyCurrent();
  const pin = { ...lease.pin, programSha256: createHash('sha256').update(bytes).digest('hex') };
  const opaque = lease.native.captureSystemSshImage(lease.opaque, pin.programSha256);
  return wrapImage(lease.native, opaque, pin, program, false, existingGatewayImage);
}

/** Only a synchronous trusted spawn boundary may supply this PID. The Native
 * side retains the actual process object and never reopens it by number. */
export function captureWindowsChildProcess(image, pid) {
  const lease = leases.get(image);
  if (process.platform !== 'win32' || !lease || lease.component || lease.isClosed() ||
      !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff ||
      !['captureProcess', 'sameProcess', 'closeProcess'].every(key => typeof lease.native[key] === 'function')) throw fail();
  image.verifyCurrent();
  const opaque = lease.native.captureProcess(lease.opaque, pid);
  let closed = false;
  return Object.freeze({
    verifyCurrent() {
      if (closed) throw fail();
      image.verifyCurrent();
      if (lease.native.sameProcess(opaque) !== true) throw fail();
    },
    close() {
      if (closed) return;
      closed = true;
      lease.native.closeProcess(opaque);
    },
  });
}

export function nativeWindowsComponentEnvironment(image, target, office, connectivity) {
  const lease = leases.get(image);
  if (!lease?.component || lease.isClosed() || !image.matches(target)) throw fail();
  const result = {[parentKey]:'v1.' + Buffer.from(JSON.stringify({version:1,mode:'localOs'})).toString('base64url')};
  if (office) Object.assign(result, nativeOfficeSpawnEnvironment(office));
  if (connectivity) Object.assign(result, nativeConnectivitySpawnEnvironment(connectivity));
  return Object.freeze(result);
}

// The source Gateway anchors only its deployment-owned default program. Per-target
// commands and RPC payloads never choose this native module or its expected hash.
export async function sourceWindowsComponentImagePin(program) {
  if (process.platform !== 'win32') return null;
  const addonPath = join(dirname(program), 'kcoder_native_image.dll');
  const hash = async path => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 * 1024) throw fail();
    return createHash('sha256').update(await readFile(path)).digest('hex');
  };
  return Object.freeze({schemaVersion:1,abiVersion:1,addonPath,
    addonSha256:await hash(addonPath),programSha256:await hash(program)});
}

export function consumeGatewayNativeComponentImageStartup(environment = process.env) {
  const present = Object.keys(environment).some(name => name.toUpperCase() === nativeComponentImageEnvironmentKey);
  try {
    const pin = consumeNativeComponentImageStartup(environment);
    return Object.freeze({state:present ? pin ? 'captured' : 'invalid' : 'absent',pin});
  } catch { return Object.freeze({state:'invalid',pin:null}); }
}
export async function captureGatewayWindowsComponentImage(program, input) {
  if (process.platform !== 'win32' || input.state === 'invalid') return null;
  try {
    const pin = input.state === 'captured' ? input.pin : await sourceWindowsComponentImagePin(program);
    return await captureTrustedWindowsComponentImage(program, pin);
  } catch { console.warn('NATIVE_COMPONENT_IMAGE_UNAVAILABLE'); return null; }
}
