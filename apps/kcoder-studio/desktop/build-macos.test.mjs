import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertMacX64Executable, macBuildInputs, macPackConfig } from './build-macos.mjs';
import { assertMacExecutable, macExecutableMetadata } from '../../../scripts/release/mac-executable.mjs';

test('macOS packaging selects a native Intel Rust target and a dedicated sidecar stage', () => {
  const inputs = macBuildInputs({ CARGO_TARGET_DIR: '/owned/cargo-cache' }, 'darwin', 'x64');
  assert.equal(inputs.target, 'x86_64-apple-darwin');
  assert.equal(inputs.binaryDir, '/owned/cargo-cache/x86_64-apple-darwin/release');
  assert.match(inputs.stageDir, /macos-input[/\\]bin$/);
  assert.throws(() => macBuildInputs({}, 'linux', 'x64'), /native x64 macOS/);
  assert.throws(() => macBuildInputs({}, 'darwin', 'universal'), /Unsupported macOS architecture/);
  assert.throws(() => macBuildInputs({ KCODER_MACOS_TARGET: 'aarch64-apple-darwin' }, 'darwin', 'x64'), /x86_64-apple-darwin/);
});

test('Apple Silicon uses ARM64 throughout and cannot reuse an Intel sidecar stage', () => {
  const inputs = macBuildInputs({ CARGO_TARGET_DIR: '/owned/cargo-cache' }, 'darwin', 'arm64');
  assert.equal(inputs.target, 'aarch64-apple-darwin');
  assert.equal(inputs.binaryDir, '/owned/cargo-cache/aarch64-apple-darwin/release');
  assert.match(inputs.stageDir, /macos-arm64-input[/\\]bin$/);
  assert.throws(() => macBuildInputs({ KCODER_MACOS_TARGET: 'x86_64-apple-darwin' }, 'darwin', 'arm64'), /aarch64-apple-darwin/);
  const config = macPackConfig(undefined, undefined, { arch: 'arm64' });
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.ok(config.mac.extraResources.every(item => item.from.includes('macos-arm64-input')));
  assert.ok(config.mac.extraResources.some(item => item.to === 'lark-cli' && /macos-arm64-input[/\\]lark-cli$/.test(item.from)));
});

test('macOS audits signed nested code before sealing the manifest into the outer bundle', async () => {
  const order = [];
  const config = macPackConfig(async () => { order.push('stage'); }, async (_, options) => {
    assert.equal(options.codeSigning, 'ad-hoc'); order.push('audit');
  }, { arch: 'x64' }, async (_, options) => {
    assert.equal(options.codeSigning, 'ad-hoc'); order.push('seal-and-verify');
  });
  assert.equal(config.mac.identity, '-');
  assert.equal(config.mac.hardenedRuntime, false);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.strictVerify, true);
  assert.equal(config.afterPack, null);
  assert.ok(new RegExp(config.mac.signIgnore[0]).test('/owned/KCoder.app/Contents/Resources/bin/chrome/browser.app'));
  assert.ok(!new RegExp(config.mac.signIgnore[0]).test('/owned/KCoder.app/Contents/Frameworks/Electron Framework.framework'));
  assert.equal(config.npmRebuild, false);
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['x64'] }]);
  assert.deepEqual(config.mac.extraResources.map(item => item.to), ['bin/kcoder', 'bin/kcoder-native-storage.node', 'bin/chrome', 'bin/pdf', 'searxng', 'lark-cli', 'kcoder-channel-host', 'kcoder-channel-host/node_modules', 'computer-use']);
  assert.deepEqual(config.mac.extraResources.find(item => item.to === 'kcoder-channel-host/node_modules').filter, ['**/*', '**/.*']);
  assert.match(config.mac.extraResources[0].from, /macos-input[/\\]bin[/\\]kcoder$/);
  assert.match(config.mac.extraResources[1].from, /macos-input[/\\]bin[/\\]kcoder-native-storage\.node$/);
  await config.beforePack({ electronPlatformName: 'darwin' });
  await config.afterSign({ electronPlatformName: 'darwin' });
  assert.deepEqual(order, ['stage', 'audit', 'seal-and-verify']);
});

test('a failed macOS resource audit prevents final sealing and delivery', async () => {
  let sealed = false;
  const config = macPackConfig(undefined, async () => { throw new Error('resource pin mismatch'); },
    { arch: 'arm64' }, async () => { sealed = true; });
  await assert.rejects(config.afterSign({}), /resource pin mismatch/);
  assert.equal(sealed, false);
});

test('macOS sidecar verification rejects ELF, ARM and non-executable Mach-O images', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-macho-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'kcoder');
  await writeFile(path, Buffer.from('\x7fELF'));
  await assert.rejects(assertMacX64Executable(path), /x86_64 Mach-O executable/);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(0x0100000c, 4); header.writeUInt32LE(2, 12);
  await writeFile(path, header);
  await assert.rejects(assertMacX64Executable(path), /x86_64 Mach-O executable/);
  header.writeUInt32LE(0x01000007, 4); header.writeUInt32LE(6, 12);
  await writeFile(path, header);
  await assert.rejects(assertMacX64Executable(path), /x86_64 Mach-O executable/);
  header.writeUInt32LE(2, 12); await writeFile(path, header);
  await assertMacX64Executable(path);
  await assert.rejects(assertMacExecutable(path, 'arm64'), /arm64 Mach-O/);
  header.writeUInt32LE(0x0100000c, 4); await writeFile(path, header);
  await assertMacExecutable(path, 'arm64');
  assert.equal((await macExecutableMetadata(path, 'arm64')).architecture, 'arm64');
});
