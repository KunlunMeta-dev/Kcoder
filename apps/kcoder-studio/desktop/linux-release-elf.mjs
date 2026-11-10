import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';

/** Inspect bounded ELF metadata from the same opened packaged executable. */
export async function inspectLinuxReleaseElf(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    assert.ok(Number.isSafeInteger(size) && size >= 64, 'invalid ELF file size');
    const read = async (offset, length) => {
      assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(length)
        && offset >= 0 && length >= 0 && length <= 1024 * 1024
        && offset <= size && length <= size - offset, 'ELF metadata outside file bounds');
      const bytes = Buffer.alloc(length);
      let received = 0;
      while (received < length) {
        const result = await file.read(bytes, received, length - received, offset + received);
        assert.ok(result.bytesRead > 0, 'truncated ELF metadata');
        received += result.bytesRead;
      }
      return bytes;
    };
    const header = await read(0, 64);
    assert.equal(header.subarray(0, 4).toString('hex'), '7f454c46', 'sidecar must be ELF');
    assert.equal(header[4], 2, 'sidecar must be ELF64');
    assert.equal(header[5], 1, 'sidecar must use the Linux x64 little-endian encoding');
    assert.equal(header[6], 1, 'invalid ELF version');
    const type = header.readUInt16LE(16);
    assert.ok(type === 2 || type === 3, 'ELF must be executable or position-independent executable');
    assert.equal(header.readUInt16LE(18), 62, 'sidecar must target x86_64');
    assert.equal(header.readUInt32LE(20), 1, 'invalid ELF header version');
    assert.equal(header.readUInt16LE(52), 64, 'invalid ELF64 header size');
    const integer = value => {
      assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER), 'ELF offset exceeds safe integer range');
      return Number(value);
    };
    const entry = header.readBigUInt64LE(24);
    assert.ok(entry > 0n, 'ELF executable entry is missing');
    const programCount = header.readUInt16LE(56), sectionCount = header.readUInt16LE(60);
    assert.ok(programCount > 0 && programCount <= 4096, 'invalid ELF program count');
    assert.ok(sectionCount > 0 && sectionCount <= 4096, 'invalid ELF section count');
    assert.equal(header.readUInt16LE(54), 56, 'invalid ELF64 program header size');
    assert.equal(header.readUInt16LE(58), 64, 'invalid ELF64 section header size');
    const programs = await read(integer(header.readBigUInt64LE(32)), programCount * 56);
    let executableEntry = false;
    for (let index = 0; index < programCount; index++) {
      const row = programs.subarray(index * 56, (index + 1) * 56);
      if (row.readUInt32LE(0) !== 1) continue;
      const offset = integer(row.readBigUInt64LE(8)), length = integer(row.readBigUInt64LE(32));
      assert.ok(offset <= size && length <= size - offset, 'ELF load segment outside file');
      const start = row.readBigUInt64LE(16), memory = row.readBigUInt64LE(40);
      assert.ok(BigInt(length) <= memory, 'invalid ELF load segment size');
      if ((row.readUInt32LE(4) & 1) && entry >= start && entry - start < memory) executableEntry = true;
    }
    assert.ok(executableEntry, 'ELF entry must belong to an executable load segment');
    const sections = await read(integer(header.readBigUInt64LE(40)), sectionCount * 64);
    const namesIndex = header.readUInt16LE(62);
    assert.ok(namesIndex > 0 && namesIndex < sectionCount, 'invalid ELF section name table');
    const nameRow = sections.subarray(namesIndex * 64, (namesIndex + 1) * 64);
    assert.equal(nameRow.readUInt32LE(4), 3, 'ELF section names must use a string table');
    const names = await read(integer(nameRow.readBigUInt64LE(24)), integer(nameRow.readBigUInt64LE(32)));
    for (let index = 0; index < sectionCount; index++) {
      const row = sections.subarray(index * 64, (index + 1) * 64);
      const nameOffset = row.readUInt32LE(0), kind = row.readUInt32LE(4);
      assert.ok(nameOffset < names.length, 'ELF section name outside string table');
      const end = names.indexOf(0, nameOffset);
      assert.ok(end >= nameOffset, 'unterminated ELF section name');
      const name = names.toString('utf8', nameOffset, end);
      assert.ok(kind !== 2 && name !== '.symtab' && !/^\.(?:z?debug|gnu_debug|gdb_index)/.test(name),
        `release ELF contains debug or full symbol section: ${name}`);
      if (kind !== 8) {
        const offset = integer(row.readBigUInt64LE(24)), length = integer(row.readBigUInt64LE(32));
        assert.ok(offset <= size && length <= size - offset, 'ELF section outside file');
      }
    }
    return { bytes: size, format: 'ELF64', machine: 'x86_64', type, sectionCount, stripped: true };
  } finally {
    await file.close();
  }
}
