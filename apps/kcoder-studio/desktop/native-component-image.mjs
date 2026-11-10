// Build pins describe resources; only the Native addon creates an image lease.
import { copyFile, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';

const addonBinary = 'kcoder-native-image.node';
const key = 'KCODER_NATIVE_COMPONENT_IMAGE_BINDING_V1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => new Error('NATIVE_COMPONENT_IMAGE_RESOURCE_INVALID');

async function image(path, library) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024 * 1024) throw fail();
  const bytes = await readFile(path);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw fail();
  const offset = bytes.readUInt32LE(60);
  if (offset < 64 || offset > 1024 * 1024 || offset + 24 > bytes.length
      || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0'
      || bytes.readUInt16LE(offset + 4) !== 0x8664
      || Boolean(bytes.readUInt16LE(offset + 22) & 0x2000) !== library) throw fail();
  return digest(bytes);
}

export async function stageNativeWindowsComponentImage({library, destination}) {
  if (!isAbsolute(library) || !isAbsolute(destination)) throw fail();
  // destination is the existing owned Windows input bin directory. Its actual
  // CLI has already been built/staged by the ordinary packaging transaction.
  const path = join(destination, addonBinary);
  await copyFile(library, path);
  return Object.freeze({schemaVersion:1, abiVersion:1, addonBinary,
    addonSha256:await image(path, true), programSha256:await image(join(destination, 'kcoder.exe'), false)});
}

export async function packagedNativeWindowsComponentEnvironment({resourcesPath, appMetadata, remoteThin = false, platform = process.platform}) {
  if (platform !== 'win32' || remoteThin || appMetadata?.nativeWindowsComponentImage === undefined) return Object.freeze({});
  const pin = appMetadata.nativeWindowsComponentImage;
  if (!pin || pin.schemaVersion !== 1 || pin.abiVersion !== 1 || pin.addonBinary !== addonBinary
      || !validSha(pin.addonSha256) || !validSha(pin.programSha256)
      || Object.keys(pin).some(name => !['schemaVersion','abiVersion','addonBinary','addonSha256','programSha256'].includes(name))) throw fail();
  const addonPath = join(resourcesPath, 'bin', addonBinary);
  if (await image(addonPath, true) !== pin.addonSha256
      || await image(join(resourcesPath, 'bin', 'kcoder.exe'), false) !== pin.programSha256) throw fail();
  const value = {schemaVersion:1, abiVersion:1, addonPath, addonSha256:pin.addonSha256, programSha256:pin.programSha256};
  return Object.freeze({[key]:Buffer.from(JSON.stringify(value)).toString('base64url')});
}
