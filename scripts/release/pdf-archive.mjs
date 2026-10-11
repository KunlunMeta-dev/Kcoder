import { inflateRawSync, gunzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateChromeZip } from './chrome-archive.mjs';

const LIMIT = 64 * 1024 * 1024;
function safeName(name, root) {
  const parts = name.replace(/\/$/, '').split('/');
  if (parts[0] !== root || /[\\:\x00-\x1f\x7f]/.test(name) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe PDF archive path');
  return parts.join('/');
}
function validateEntries(entries) {
  const seen = new Map();
  let size = 0;
  for (const entry of entries) {
    const key = entry.name.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate PDF archive path');
    seen.set(key, entry);
    size += entry.data?.length ?? 0;
    if (size > LIMIT || entries.length > 4096) throw new Error('PDF archive expansion limit');
  }
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = seen.get(parts.slice(0, i).join('/').toLowerCase());
      if (parent && !parent.directory) throw new Error('PDF archive file used as a directory');
    }
  }
  return entries;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function readPdfZip(bytes, root = 'xpdf-tools-win-4.06') {
  if (bytes.length > LIMIT) throw new Error('PDF ZIP size limit');
  validateChromeZip(bytes, { directory: root, executable: 'bin64/pdftotext.exe' });
  let end = bytes.length - 22;
  while (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) end--;
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];
  let expanded = 0;
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const length = bytes.readUInt32LE(offset + 24), compressed = bytes.readUInt32LE(offset + 20);
    expanded += length;
    if (expanded > LIMIT) throw new Error('PDF ZIP expansion limit');
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + compressed);
    const data = bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(length, 1) }) : raw;
    if (data.length !== length || crc32(data) !== bytes.readUInt32LE(offset + 16)) throw new Error('PDF ZIP checksum mismatch');
    entries.push({ name: safeName(name, root), directory: name.endsWith('/'), data });
    offset += 46 + nameLength + extra + comment;
  }
  return validateEntries(entries);
}
function field(bytes, start, length) {
  const value = bytes.subarray(start, start + length);
  const nul = value.indexOf(0);
  const text = value.subarray(0, nul < 0 ? value.length : nul).toString('utf8');
  if (!Buffer.from(text).equals(value.subarray(0, nul < 0 ? value.length : nul))) throw new Error('Invalid PDF TAR name encoding');
  return text;
}
function octal(bytes, start, length) {
  const text = field(bytes, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('Unsupported PDF TAR numeric field');
  return Number.parseInt(text, 8);
}
export function readPdfTarGz(compressed, root) {
  if (compressed.length > LIMIT) throw new Error('PDF TAR size limit');
  const bytes = gunzipSync(compressed, { maxOutputLength: LIMIT });
  const entries = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!bytes.subarray(offset).every(byte => byte === 0)) throw new Error('Unexpected trailing PDF TAR data');
      return validateEntries(entries);
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (octal(header, 148, 8) !== checksum) throw new Error('PDF TAR checksum mismatch');
    const type = String.fromCharCode(header[156]);
    if (!['0', '\0', '5'].includes(type)) throw new Error('PDF TAR links or extensions are forbidden');
    const prefix = field(header, 345, 155), raw = field(header, 0, 100);
    const name = safeName(prefix ? `${prefix}/${raw}` : raw, root);
    const size = octal(header, 124, 12), start = offset + 512;
    if (size > LIMIT || start + size > bytes.length || (type === '5' && size !== 0)) throw new Error('Invalid PDF TAR size');
    entries.push({ name, directory: type === '5', data: bytes.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('Truncated PDF TAR');
}
export async function extractPdfEntries(entries, destination) {
  // Validation completes before any writes. Only fresh private staging is used.
  for (const entry of entries) {
    const path = join(destination, ...entry.name.split('/'));
    if (entry.directory) await mkdir(path, { recursive: true, mode: 0o700 });
    else { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, entry.data, { flag: 'wx', mode: 0o644 }); }
  }
}
