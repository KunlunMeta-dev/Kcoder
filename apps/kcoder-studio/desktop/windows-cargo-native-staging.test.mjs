import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageWindowsSignedNativeInputs } from './build-windows.mjs';

function pe(library) {
  const bytes = Buffer.alloc(4096);
  bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(library ? 0x2000 : 0, 150);
  return bytes;
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-cargo-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binaryDir = join(root, 'cargo'), stageDir = join(root, 'stage');
  await mkdir(binaryDir); await mkdir(stageDir);
  for (const name of ['kcoder.exe', 'kcoder-process-supervisor.exe']) await writeFile(join(stageDir, name), pe(false));
  return { root, binaryDir, stageDir, context: { packager: { config: {} } } };
}

test('a hard-linked Cargo DLL is sealed from an owned single-link copy', async t => {
  const f = await setup(t), library = join(f.binaryDir, 'kcoder_native_image.dll');
  const bytes = pe(true); await writeFile(library, bytes); await link(library, join(f.binaryDir, 'cargo-deps.dll'));
  assert.equal((await lstat(library)).nlink, 2);
  const pin = await stageWindowsSignedNativeInputs(f.context, f, { enabled: false, allowUnsigned: true });
  assert.equal(pin.addonSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(join(f.stageDir, 'kcoder-native-image.node')), bytes);
  assert.equal((await lstat(library)).nlink, 2);
  assert.deepEqual(f.context.packager.config.extraMetadata.nativeWindowsComponentImage, pin);
  assert.ok(!(await readdir(f.stageDir)).some(name => name.startsWith('.cargo-native-input-')));
});

test('a linked source path and an invalid DLL cannot replace an existing sealed addon', { skip: process.platform === 'win32' }, async t => {
  const f = await setup(t), library = join(f.binaryDir, 'kcoder_native_image.dll');
  const previous = Buffer.from('previous sealed addon');
  await writeFile(join(f.stageDir, 'kcoder-native-image.node'), previous);
  await writeFile(join(f.binaryDir, 'other.dll'), pe(true)); await symlink(join(f.binaryDir, 'other.dll'), library);
  await assert.rejects(stageWindowsSignedNativeInputs(f.context, f, { enabled: false, allowUnsigned: true }));
  await rm(library); await writeFile(library, Buffer.from('not a PE image'));
  await assert.rejects(stageWindowsSignedNativeInputs(f.context, f, { enabled: false, allowUnsigned: true }), /RESOURCE_INVALID/);
  assert.deepEqual(await readFile(join(f.stageDir, 'kcoder-native-image.node')), previous);
  assert.ok(!(await readdir(f.stageDir)).some(name => name.startsWith('.cargo-native-input-')));
});
