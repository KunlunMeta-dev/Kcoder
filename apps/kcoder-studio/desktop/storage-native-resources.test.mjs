import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { storageNativeBuildInputs, stageStorageNativeAddon } from './storage-native-resources.mjs';

function elfX64() {
  const bytes = Buffer.alloc(128);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(0x3e, 18);
  return bytes;
}

function elfArm64() {
  const bytes = elfX64();
  bytes.writeUInt16LE(0xb7, 18);
  return bytes;
}

function peX64() {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ');
  bytes.writeUInt32LE(128, 60);
  bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(0x8664, 132);
  bytes.writeUInt16LE(0x2000, 150);
  return bytes;
}

function machoArm64() {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(6, 12);
  return bytes;
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-storage-addon-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('storage addon staging builds from the selected checkout and exact Linux target output', async t => {
  const root = await temporaryRoot(t);
  const other = await temporaryRoot(t);
  const context = { electronPlatformName: 'linux', arch: 1 };
  const inputs = storageNativeBuildInputs(context, { repositoryRoot: root, env: { CARGO_TARGET_DIR: 'target' } });
  const decoy = resolve(other, 'target', 'release', inputs.library);
  await mkdir(dirname(decoy), { recursive: true });
  await writeFile(decoy, elfX64());

  let buildInput;
  const result = await stageStorageNativeAddon(context, {
    repositoryRoot: root,
    env: { CARGO_TARGET_DIR: 'target' },
    build: async input => { buildInput = input; },
  }).catch(error => error);
  assert.match(String(result), /ENOENT|no such file/i, 'a library in a different checkout cannot satisfy this stage');
  assert.equal(buildInput.repository, root);
  assert.equal(buildInput.manifestPath, join(root, 'Cargo.toml'));
  assert.equal(buildInput.target, 'x86_64-unknown-linux-gnu');
  assert.deepEqual(buildInput.args, ['build', '--release', '--locked', '--manifest-path', join(root, 'Cargo.toml'),
    '-p', 'kcoder_native_storage', '--lib']);
  assert.equal(buildInput.env.CARGO_TARGET_DIR, join(root, 'target'));
  assert.equal(buildInput.cargoTargetDir, join(root, 'target', 'release'));

  await mkdir(dirname(inputs.source), { recursive: true });
  const bytes = elfX64();
  await writeFile(inputs.source, bytes);
  const staged = await stageStorageNativeAddon(context, {
    repositoryRoot: root,
    env: { CARGO_TARGET_DIR: 'target' },
    build: async input => {
      assert.equal(input.repository, root);
      assert.equal(input.source, undefined, 'the injected builder cannot substitute another checkout artifact path');
    },
  });
  assert.equal(staged.source, inputs.source);
  assert.equal(staged.destination, inputs.destination);
  assert.deepEqual(await readFile(inputs.destination), bytes);
});

test('storage addon target mapping keeps Windows GNU and macOS arm64 resources architecture-specific', async t => {
  const root = await temporaryRoot(t);
  const windows = storageNativeBuildInputs({ electronPlatformName: 'win32', arch: 1 }, {
    repositoryRoot: root, env: { KCODER_WINDOWS_TARGET: 'x86_64-pc-windows-gnu' }, hostPlatform: 'linux',
  });
  assert.equal(windows.target, 'x86_64-pc-windows-gnu');
  assert.match(windows.destination, /windows-input[/\\]bin[/\\]kcoder-native-storage\.node$/);
  const windowsStaged = await stageStorageNativeAddon({ electronPlatformName: 'win32', arch: 1 }, {
    repositoryRoot: root,
    env: { KCODER_WINDOWS_TARGET: 'x86_64-pc-windows-gnu' },
    hostPlatform: 'linux',
    build: async input => {
      assert.equal(input.target, windows.target);
      assert.deepEqual(input.args, ['build', '--release', '--locked', '--manifest-path', join(root, 'Cargo.toml'),
        '--target', 'x86_64-pc-windows-gnu', '-p', 'kcoder_native_storage', '--lib']);
      const source = join(input.cargoTargetDir, windows.library);
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, peX64());
    },
  });
  assert.equal(windowsStaged.target, 'x86_64-pc-windows-gnu');

  const mac = storageNativeBuildInputs({ electronPlatformName: 'darwin', arch: 3 }, { repositoryRoot: root });
  assert.equal(mac.target, 'aarch64-apple-darwin');
  assert.match(mac.destination, /macos-arm64-input[/\\]bin[/\\]kcoder-native-storage\.node$/);
  const macStaged = await stageStorageNativeAddon({ electronPlatformName: 'darwin', arch: 3 }, {
    repositoryRoot: root,
    build: async input => {
      assert.equal(input.target, 'aarch64-apple-darwin');
      assert.deepEqual(input.args, ['build', '--release', '--locked', '--manifest-path', join(root, 'Cargo.toml'),
        '--target', 'aarch64-apple-darwin', '-p', 'kcoder_native_storage', '--lib']);
      const source = join(input.cargoTargetDir, mac.library);
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, machoArm64());
    },
  });
  assert.equal(macStaged.source, mac.source);
  assert.equal(macStaged.destination, mac.destination);
});

test('npm addon stage follows the selected checkout target and package-local bin layout', async t => {
  const root = await temporaryRoot(t);
  const stage = join(root, 'target/packages/kcoder-studio-gateway-stage');
  const inputs = storageNativeBuildInputs({ electronPlatformName: 'linux', arch: 1 }, {
    repositoryRoot: root,
    env: { KCODER_TARGET_DIR: 'target/native-current', CARGO_TARGET_DIR: 'target/native-other' },
    destinationRoot: stage,
  });
  assert.equal(inputs.targetRoot, join(root, 'target/native-current'));
  assert.equal(inputs.cargoTargetDir, join(root, 'target/native-current/release'));
  assert.equal(inputs.destination, join(stage, 'bin/kcoder-native-storage.node'));
});

test('storage addon staging rejects bytes whose native architecture differs from the requested target', async t => {
  const root = await temporaryRoot(t);
  const context = { electronPlatformName: 'linux', arch: 1 };
  const inputs = storageNativeBuildInputs(context, { repositoryRoot: root });
  await mkdir(dirname(inputs.source), { recursive: true });
  await writeFile(inputs.source, elfArm64());
  await assert.rejects(stageStorageNativeAddon(context, {
    repositoryRoot: root,
    build: async () => {},
  }), /STORAGE_NATIVE_RESOURCE_INVALID/);
  await assert.rejects(readFile(inputs.destination), { code: 'ENOENT' });
});
