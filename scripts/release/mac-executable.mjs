import { open } from 'node:fs/promises';

export async function assertMacX64Executable(path) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.readUInt32LE(0) !== 0xfeedfacf
      || header.readUInt32LE(4) !== 0x01000007 || header.readUInt32LE(12) !== 2) {
      throw new Error(`Not an x86_64 Mach-O executable: ${path}`);
    }
  } finally { await file.close(); }
}

export function validateMacSystemLibraries(output) {
  const libraries = output.split(/\r?\n/).slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
  if (!libraries.length || libraries.some(path => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'))) {
    throw new Error('macOS PDF reader contains an unbundled non-system dynamic library');
  }
  return libraries;
}

export async function macExecutableMetadata(path) {
  await assertMacX64Executable(path);
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(32); await file.read(header, 0, header.length, 0);
    const count = header.readUInt32LE(16), size = header.readUInt32LE(20);
    if (count > 4096 || size > 1024 * 1024 || size + 32 > (await file.stat()).size) throw new Error('Invalid Mach-O load commands');
    const commands = Buffer.alloc(size);
    if ((await file.read(commands, 0, size, 32)).bytesRead !== size) throw new Error('Truncated Mach-O load commands');
    let offset = 0, signed = false, minimumSystemVersion = null;
    const version = packed => `${packed >>> 16}.${packed >>> 8 & 255}.${packed & 255}`;
    for (let i = 0; i < count; i++) {
      if (offset + 8 > size) throw new Error('Invalid Mach-O load command');
      const command = commands.readUInt32LE(offset), bytes = commands.readUInt32LE(offset + 4);
      if (bytes < 8 || offset + bytes > size) throw new Error('Invalid Mach-O load command size');
      if (command === 0x1d) signed = true;
      if (command === 0x32 && bytes >= 24) minimumSystemVersion = version(commands.readUInt32LE(offset + 12));
      if (command === 0x24 && bytes >= 16) minimumSystemVersion = version(commands.readUInt32LE(offset + 8));
      offset += bytes;
    }
    if (offset !== size) throw new Error('Mach-O load command size mismatch');
    return { architecture: 'x86_64', signed, minimumSystemVersion };
  } finally { await file.close(); }
}
