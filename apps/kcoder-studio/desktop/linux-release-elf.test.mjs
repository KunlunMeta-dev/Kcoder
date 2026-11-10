import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectLinuxReleaseElf } from './linux-release-elf.mjs';

function fixture(extra) {
  const bytes = Buffer.alloc(640);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(0x400000n, 24); bytes.writeBigUInt64LE(64n, 32);
  bytes.writeBigUInt64LE(128n, 40); bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
  bytes.writeUInt16LE(64, 58); bytes.writeUInt16LE(extra ? 4 : 3, 60); bytes.writeUInt16LE(2, 62);
  bytes.writeUInt32LE(1, 64); bytes.writeUInt32LE(5, 68);
  bytes.writeBigUInt64LE(0x400000n, 80); bytes.writeBigUInt64LE(640n, 96);
  bytes.writeBigUInt64LE(640n, 104);
  const names = Buffer.from(`\0.text\0.shstrtab\0${extra ?? ''}\0`);
  names.copy(bytes, 400);
  const section = (index, name, kind, offset, length) => {
    const row = 128 + index * 64;
    bytes.writeUInt32LE(name, row); bytes.writeUInt32LE(kind, row + 4);
    bytes.writeBigUInt64LE(BigInt(offset), row + 24); bytes.writeBigUInt64LE(BigInt(length), row + 32);
  };
  section(1, 1, 1, 600, 16); section(2, 7, 3, 400, names.length);
  if (extra) section(3, 17, extra === '.symtab' ? 2 : 1, 616, 4);
  return bytes;
}
async function owned(t, bytes) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-release-elf-test-'));
  t.after(() => rm(root, { recursive: true }));
  const path = join(root, 'sidecar'); await writeFile(path, bytes, { mode: 0o700 }); return path;
}
test('stripped Linux ELF64 executable passes direct structural inspection', async t => {
  const report = await inspectLinuxReleaseElf(await owned(t, fixture()));
  assert.equal(report.bytes, 640); assert.equal(report.stripped, true); assert.equal(report.sectionCount, 3);
});
test('non-ELF and out-of-bounds ELF metadata are rejected', async t => {
  await assert.rejects(inspectLinuxReleaseElf(await owned(t, Buffer.alloc(640))), /must be ELF/);
  const invalid = fixture(); invalid.writeBigUInt64LE(630n, 40);
  await assert.rejects(inspectLinuxReleaseElf(await owned(t, invalid)), /outside file bounds/);
});
test('debug and full symbol sections fail the release guard', async t => {
  for (const name of ['.debug_info', '.zdebug_info', '.symtab']) {
    await assert.rejects(inspectLinuxReleaseElf(await owned(t, fixture(name))), /debug or full symbol/);
  }
});
