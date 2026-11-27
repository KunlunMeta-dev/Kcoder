import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macTarget } from '../../../scripts/release/mac-target.mjs';
import { normalizeElectronArch } from './stage-gateway-dependencies.mjs';

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const addonName = 'kcoder-native-storage.node';
const maxAddonBytes = 64 * 1024 * 1024;

function windowsTarget(env, hostPlatform) {
  const target = env.KCODER_WINDOWS_TARGET || (hostPlatform === 'win32'
    ? 'x86_64-pc-windows-msvc' : 'x86_64-pc-windows-gnu');
  if (!['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu'].includes(target)) {
    throw new Error('Windows storage addon requires an x86_64 Windows Rust target');
  }
  return target;
}

export function storageNativeBuildInputs(context, {
  repositoryRoot = repository, env = process.env, hostPlatform = process.platform, destinationRoot,
} = {}) {
  const platform = context?.electronPlatformName;
  const arch = normalizeElectronArch(context?.arch, 'unknown');
  let target, library, stage;
  if (platform === 'linux' && arch === 'x64') {
    target = 'x86_64-unknown-linux-gnu';
    library = 'libkcoder_native_storage.so';
    stage = 'linux-input';
  } else if (platform === 'darwin') {
    const mac = macTarget(arch);
    target = mac.target;
    library = 'libkcoder_native_storage.dylib';
    stage = mac.stage;
  } else if (platform === 'win32' && arch === 'x64') {
    target = windowsTarget(env, hostPlatform);
    library = 'kcoder_native_storage.dll';
    stage = 'windows-input';
  } else {
    throw new Error(`Unsupported storage addon target: ${platform ?? 'unknown'}/${arch}`);
  }

  const root = resolve(repositoryRoot);
  const targetRoot = resolve(root, env.KCODER_TARGET_DIR || env.CARGO_TARGET_DIR || 'target');
  const manifestPath = resolve(root, 'Cargo.toml');
  const cargoTargetDir = platform === 'linux'
    ? resolve(targetRoot, 'release') : resolve(targetRoot, target, 'release');
  const stageDirectory = destinationRoot ? resolve(destinationRoot, 'bin')
    : resolve(root, 'target/packages/kcoder-studio', stage, 'bin');
  return Object.freeze({
    repository: root,
    manifestPath,
    target,
    platform,
    arch,
    targetRoot,
    cargoTargetDir,
    library,
    source: resolve(cargoTargetDir, library),
    stageDirectory,
    destination: resolve(stageDirectory, addonName),
    addonName,
  });
}

function storageNativeCargoArgs(inputs) {
  return ['build', '--release', '--locked', '--manifest-path', inputs.manifestPath,
    ...(inputs.platform === 'linux' ? [] : ['--target', inputs.target]),
    '-p', 'kcoder_native_storage', '--lib'];
}

function runCargo({ args, repository: cwd, env }) {
  const cargo = env.KCODER_CARGO_BIN || 'cargo';
  return new Promise((complete, reject) => {
    const child = spawn(cargo, args, { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('close', code => code === 0 ? complete() : reject(new Error(`Storage addon Cargo build failed (${code})`)));
  });
}

function hasExpectedArchitecture(bytes, platform, arch) {
  if (platform === 'win32') {
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') return false;
    const offset = bytes.readUInt32LE(60);
    return offset >= 64 && offset <= 1024 * 1024 && offset + 24 <= bytes.length
      && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0'
      && bytes.readUInt16LE(offset + 4) === 0x8664
      && Boolean(bytes.readUInt16LE(offset + 22) & 0x2000);
  }
  if (platform === 'linux') {
    if (bytes.length < 20 || bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 2 || ![1, 2].includes(bytes[5])) return false;
    const type = bytes[5] === 1 ? bytes.readUInt16LE(16) : bytes.readUInt16BE(16);
    const machine = bytes[5] === 1 ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
    return bytes[5] === 1 && type === 3 && machine === 0x3e;
  }
  if (platform === 'darwin') {
    if (bytes.length < 32) return false;
    let magic, cpu, filetype;
    if (bytes.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))) {
      magic = bytes.readUInt32LE(0); cpu = bytes.readUInt32LE(4); filetype = bytes.readUInt32LE(12);
    } else if (bytes.subarray(0, 4).equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf]))) {
      magic = bytes.readUInt32BE(0); cpu = bytes.readUInt32BE(4); filetype = bytes.readUInt32BE(12);
    } else return false;
    return magic === 0xfeedfacf && filetype === 6 && cpu === (arch === 'arm64' ? 0x0100000c : 0x01000007);
  }
  return false;
}

async function readNativeLibrary(path, platform, arch) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 64n || before.size > BigInt(maxAddonBytes)) {
      throw new Error('STORAGE_NATIVE_RESOURCE_INVALID');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || bytes.length !== Number(before.size)
      || !hasExpectedArchitecture(bytes, platform, arch)) {
      throw new Error('STORAGE_NATIVE_RESOURCE_INVALID');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function publishAddon(inputs, bytes) {
  await mkdir(inputs.stageDirectory, { recursive: true });
  const directory = await lstat(inputs.stageDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('STORAGE_NATIVE_RESOURCE_INVALID');
  try {
    const existing = await lstat(inputs.destination);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('STORAGE_NATIVE_RESOURCE_INVALID');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${inputs.destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, inputs.destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Build and stage the addon from this checkout for the exact Electron target. */
export async function stageStorageNativeAddon(context, {
  repositoryRoot = repository,
  env = process.env,
  hostPlatform = process.platform,
  destinationRoot,
  build = runCargo,
} = {}) {
  const inputs = storageNativeBuildInputs(context, { repositoryRoot, env, hostPlatform, destinationRoot });
  const cargoEnv = { ...env, CARGO_TARGET_DIR: inputs.targetRoot };
  await build({
    args: storageNativeCargoArgs(inputs),
    repository: inputs.repository,
    manifestPath: inputs.manifestPath,
    target: inputs.target,
    targetRoot: inputs.targetRoot,
    cargoTargetDir: inputs.cargoTargetDir,
    env: cargoEnv,
  });
  const bytes = await readNativeLibrary(inputs.source, inputs.platform, inputs.arch);
  await publishAddon(inputs, bytes);
  return Object.freeze({ target: inputs.target, source: inputs.source, destination: inputs.destination });
}
