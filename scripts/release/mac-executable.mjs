import { open } from 'node:fs/promises';
import { macTarget } from './mac-target.mjs';

export async function assertMacExecutable(path, arch = 'x64') {
  const target = macTarget(arch);
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.readUInt32LE(0) !== 0xfeedfacf
      || header.readUInt32LE(4) !== target.cpuType || header.readUInt32LE(12) !== 2) {
      throw new Error(`Not an ${target.architecture} Mach-O executable: ${path}`);
    }
  } finally { await file.close(); }
}

export const assertMacX64Executable = path => assertMacExecutable(path, 'x64');

async function codeSignatureKind(file, offset, size, fileSize) {
  if (size < 20 || size > 64 * 1024 * 1024 || offset + size > fileSize) throw new Error('Invalid Mach-O code signature');
  const blob = Buffer.alloc(size);
  if ((await file.read(blob, 0, size, offset)).bytesRead !== size || blob.readUInt32BE(0) !== 0xfade0cc0) throw new Error('Invalid Mach-O code signature');
  const length = blob.readUInt32BE(4), count = blob.readUInt32BE(8);
  if (length > size || count > 256 || 12 + count * 8 > length) throw new Error('Invalid Mach-O code signature index');
  for (let i = 0; i < count; i++) {
    if (blob.readUInt32BE(12 + i * 8) !== 0) continue;
    const directory = blob.readUInt32BE(16 + i * 8);
    if (directory < 12 + count * 8 || directory + 16 > length || blob.readUInt32BE(directory) !== 0xfade0c02
      || blob.readUInt32BE(directory + 4) < 16 || directory + blob.readUInt32BE(directory + 4) > length) throw new Error('Invalid Mach-O code directory');
    return blob.readUInt32BE(directory + 12) & 2 ? 'ad-hoc' : 'embedded';
  }
  throw new Error('Missing Mach-O code directory');
}

export function validateMacSystemLibraries(output) {
  const libraries = output.split(/\r?\n/).slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
  if (!libraries.length || libraries.some(path => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'))) {
    throw new Error('macOS PDF reader contains an unbundled non-system dynamic library');
  }
  return libraries;
}

export async function macExecutableMetadata(path, arch = 'x64') {
  await assertMacExecutable(path, arch);
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(32); await file.read(header, 0, header.length, 0);
    const count = header.readUInt32LE(16), size = header.readUInt32LE(20);
    if (count > 4096 || size > 1024 * 1024 || size + 32 > (await file.stat()).size) throw new Error('Invalid Mach-O load commands');
    const commands = Buffer.alloc(size);
    if ((await file.read(commands, 0, size, 32)).bytesRead !== size) throw new Error('Truncated Mach-O load commands');
    let offset = 0, signed = false, signatureKind = 'none', minimumSystemVersion = null;
    const version = packed => `${packed >>> 16}.${packed >>> 8 & 255}.${packed & 255}`;
    for (let i = 0; i < count; i++) {
      if (offset + 8 > size) throw new Error('Invalid Mach-O load command');
      const command = commands.readUInt32LE(offset), bytes = commands.readUInt32LE(offset + 4);
      if (bytes < 8 || offset + bytes > size) throw new Error('Invalid Mach-O load command size');
      if (command === 0x1d) {
        if (bytes < 16) throw new Error('Invalid Mach-O code signature command');
        signed = true;
        signatureKind = await codeSignatureKind(file, commands.readUInt32LE(offset + 8), commands.readUInt32LE(offset + 12), (await file.stat()).size);
      }
      if (command === 0x32 && bytes >= 24) minimumSystemVersion = version(commands.readUInt32LE(offset + 12));
      if (command === 0x24 && bytes >= 16) minimumSystemVersion = version(commands.readUInt32LE(offset + 8));
      offset += bytes;
    }
    if (offset !== size) throw new Error('Mach-O load command size mismatch');
    return { architecture: macTarget(arch).architecture, signed, signatureKind, minimumSystemVersion };
  } finally { await file.close(); }
}
