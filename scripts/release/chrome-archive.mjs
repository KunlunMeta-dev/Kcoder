// Validate both ZIP name tables before invoking the host's extraction utility.
// Only regular files/directories under the expected platform root are accepted.
export function validateChromeZip(bytes, release) {
  const invalid = () => { throw new Error('Unsafe or unsupported Chrome archive'); };
  if (bytes.length < 22 || bytes.length > 512 * 1024 * 1024) invalid();
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) invalid();
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12);
  const directory = bytes.readUInt32LE(end + 16);
  if (!count || count > 10000 || count !== bytes.readUInt16LE(end + 8) || directory + size !== end) invalid();
  let offset = directory, expanded = 0;
  const names = new Set(), entries = [], regions = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) invalid();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), length = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const attributes = bytes.readUInt32LE(offset + 38), local = bytes.readUInt32LE(offset + 42);
    const finish = offset + 46 + nameLength + extraLength + commentLength;
    if (finish > end || flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff || length === 0xffffffff) invalid();
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength), name = rawName.toString('utf8');
    const parts = name.replace(/\/$/, '').split('/');
    if (!Buffer.from(name).equals(rawName) || /[\\:\x00-\x1f\x7f]/.test(name) || parts[0] !== release.directory ||
        parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) invalid();
    const key = parts.join('/').toLowerCase();
    if (names.has(key)) invalid();
    names.add(key);
    const mode = attributes >>> 16, type = mode & 0o170000;
    const isDirectory = name.endsWith('/');
    if (![0, 0o100000, 0o040000].includes(type) || (type === 0o040000 && !isDirectory) || (!isDirectory && parts.length < 2)) invalid();
    expanded += length;
    if (expanded > 1024 * 1024 * 1024) invalid();
    if (local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) invalid();
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > directory || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName)) invalid();
    // Unicode path extras can otherwise override names validated above in some extractors.
    for (const [start, length] of [[offset + 46 + nameLength, extraLength], [local + 30 + localNameLength, localExtraLength]]) {
      for (let extra = start; extra < start + length;) {
        if (extra + 4 > start + length) invalid();
        const tag = bytes.readUInt16LE(extra), payload = bytes.readUInt16LE(extra + 2);
        if (tag === 0x7075 || extra + 4 + payload > start + length) invalid();
        extra += 4 + payload;
      }
    }
    entries.push({ name, directory: isDirectory, executable: Boolean(mode & 0o111) });
    regions.push([local, dataStart + compressed]);
    offset = finish;
  }
  if (offset !== end || !names.has(`${release.directory}/${release.executable}`.toLowerCase())) invalid();
  regions.sort((a, b) => a[0] - b[0]);
  if (regions.some((region, index) => index > 0 && region[0] < regions[index - 1][1])) invalid();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = entries.find(candidate => candidate.name.replace(/\/$/, '').toLowerCase() === parts.slice(0, i + 1).join('/').toLowerCase());
      if (parent && !parent.directory) invalid();
    }
  }
  return entries;
}
