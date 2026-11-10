import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macExecutableMetadata, validateMacSystemLibraries } from './mac-executable.mjs';

test('ARM64 linker ad-hoc signatures stay distinct from publisher signatures and malformed blobs fail', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-mac-signature-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture');
  const bytes = Buffer.alloc(84);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(16, 20);
  bytes.writeUInt32LE(0x1d, 32); bytes.writeUInt32LE(16, 36); bytes.writeUInt32LE(48, 40); bytes.writeUInt32LE(36, 44);
  bytes.writeUInt32BE(0xfade0cc0, 48); bytes.writeUInt32BE(36, 52); bytes.writeUInt32BE(1, 56);
  bytes.writeUInt32BE(0, 60); bytes.writeUInt32BE(20, 64);
  bytes.writeUInt32BE(0xfade0c02, 68); bytes.writeUInt32BE(16, 72); bytes.writeUInt32BE(0x20002, 80);
  await writeFile(path, bytes);
  assert.equal((await macExecutableMetadata(path, 'arm64')).signatureKind, 'ad-hoc');
  bytes.writeUInt32BE(0, 80); await writeFile(path, bytes);
  assert.equal((await macExecutableMetadata(path, 'arm64')).signatureKind, 'embedded');
  bytes.writeUInt32BE(1000, 64); await writeFile(path, bytes);
  await assert.rejects(macExecutableMetadata(path, 'arm64'), /Invalid Mach-O code directory/);
});

test('native PDF runtime permits system libraries and refuses an unbundled development toolchain path', () => {
  assert.deepEqual(validateMacSystemLibraries('/owned/pdftotext:\n\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n'), ['/usr/lib/libc++.1.dylib', '/usr/lib/libSystem.B.dylib']);
  for (const dependency of ['/usr/local/lib/libjpeg.dylib', '@rpath/libexample.dylib', '/Users/Admin/private/libfoo.dylib']) {
    assert.throws(() => validateMacSystemLibraries(`/owned/pdftotext:\n\t${dependency} (compatibility version 1.0.0)\n`), /unbundled non-system/);
  }
});
