import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertMacX64Executable, macBuildInputs, macPackConfig } from './build-macos.mjs';

test('macOS packaging selects a native Intel Rust target and a dedicated sidecar stage', () => {
  const inputs = macBuildInputs({ CARGO_TARGET_DIR: '/owned/cargo-cache' }, 'darwin', 'x64');
  assert.equal(inputs.target, 'x86_64-apple-darwin');
  assert.equal(inputs.binaryDir, '/owned/cargo-cache/x86_64-apple-darwin/release');
  assert.match(inputs.stageDir, /macos-input[/\\]bin$/);
  assert.throws(() => macBuildInputs({}, 'linux', 'x64'), /native x64 macOS/);
  assert.throws(() => macBuildInputs({}, 'darwin', 'arm64'), /native x64 macOS/);
  assert.throws(() => macBuildInputs({ KCODER_MACOS_TARGET: 'aarch64-apple-darwin' }, 'darwin', 'x64'), /Intel/);
});

test('macOS packages the sidecar and declares Intel DMG without requesting signing credentials', async () => {
  let stages = 0; let audits = 0;
  const config = macPackConfig(async () => { stages++; }, async () => { audits++; });
  assert.equal(config.mac.identity, null);
  assert.equal(config.npmRebuild, false);
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['x64'] }]);
  assert.deepEqual(config.mac.extraResources.map(item => item.to), ['bin/kcoder', 'bin/chrome', 'bin/pdf']);
  assert.match(config.mac.extraResources[0].from, /macos-input[/\\]bin[/\\]kcoder$/);
  await config.beforePack({ electronPlatformName: 'darwin' });
  await config.afterPack({ electronPlatformName: 'darwin' });
  assert.equal(stages, 1); assert.equal(audits, 1);
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
});
