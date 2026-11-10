// Native resource verification only. No renderer/RPC path is accepted here.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, parse, relative, resolve, sep, dirname } from 'node:path';

export const officeResourceManifestName = 'office-resource-manifest.json';
export const officeResourceEntry = 'components/src/cli.mjs';
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 20000;
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
export const resourceError = code => Object.assign(new Error(code), { code });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function resourceRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || isAbsolute(value)
      || value.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f]/.test(part))) throw resourceError('OFFICE_RESOURCE_INVALID');
  return value;
}
export async function ordinaryDirectory(path) {
  if (!isAbsolute(path)) throw resourceError('OFFICE_RESOURCE_INVALID');
  const full = resolve(path); const root = parse(full).root;
  let current = root;
  for (const part of relative(root, full).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw resourceError('OFFICE_RESOURCE_UNSAFE');
  }
  return full;
}
export async function readResource(path, limit = 4 * 1024 * 1024) {
  await ordinaryDirectory(dirname(path));
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) throw resourceError('OFFICE_RESOURCE_UNSAFE');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat({ bigint: true });
    if (!sameResourceFile(before, actual)) throw resourceError('OFFICE_RESOURCE_CHANGED');
    const bytes = await handle.readFile();
    if (BigInt(bytes.length) !== actual.size || !sameResourceFile(actual, await handle.stat({ bigint: true }))) throw resourceError('OFFICE_RESOURCE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}
// Windows path stats may omit the volume ID; held descriptor stats retain it.
export const sameResourceFile = (left, right) => right.isFile() && right.nlink === 1n
  && (left.dev === right.dev || (process.platform === 'win32' && left.dev === 0n))
  && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
export async function digestResource(path, { maxBytes = MAX_BYTES, signal, inspectFuses = false } = {}) {
  await ordinaryDirectory(dirname(path));
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw resourceError('OFFICE_RESOURCE_UNSAFE');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat({ bigint: true });
    if (!sameResourceFile(before, actual)) throw resourceError('OFFICE_RESOURCE_CHANGED');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(256 * 1024); let total = 0; let tail = Buffer.alloc(0); const wires = [];
    const ceiling = Math.min(Number(actual.size), maxBytes);
    while (true) {
      if (signal?.aborted) throw resourceError('OFFICE_CANCELLED');
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, ceiling - total + 1), null); if (!bytesRead) break;
      total += bytesRead;
      if (total > Number(actual.size) || total > maxBytes) throw resourceError('OFFICE_RESOURCE_CHANGED');
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
      if (inspectFuses) {
        const scan = Buffer.concat([tail, chunk]); let index = 0;
        while ((index = scan.indexOf(FUSE_SENTINEL, index)) !== -1) {
          const position = index + FUSE_SENTINEL.length;
          if (position + 2 < scan.length) {
            const location = total - bytesRead - tail.length + index;
            if (!wires.some(wire => wire.location === location)) wires.push({ location, version: scan[position], length: scan[position + 1], runAsNode: scan[position + 2] });
            if (wires.length > 8) throw resourceError('OFFICE_RUNTIME_MODE_UNAVAILABLE');
          }
          index += FUSE_SENTINEL.length;
        }
        tail = Buffer.from(scan.subarray(Math.max(0, scan.length - FUSE_SENTINEL.length - 260)));
      }
    }
    if (total !== Number(actual.size) || !sameResourceFile(actual, await handle.stat({ bigint: true }))) throw resourceError('OFFICE_RESOURCE_CHANGED');
    // Electron fuse v1 format constants match the repository's @electron/fuses 1.8.0.
    const enabled = wires.length > 0 && wires.every(wire => wire.version === 1 && wire.length >= 1 && wire.runAsNode === 49);
    return { sha256: hash.digest('hex'), bytes: total, electronFusePresent: wires.length > 0, electronRunAsNodeEnabled: enabled };
  } finally { await handle.close(); }
}
export async function resourceInventory(root, { signal } = {}) {
  root = await ordinaryDirectory(root); const planned = []; let plannedBytes = 0;
  async function visit(directory, prefix, depth) {
    if (depth > 40) throw resourceError('OFFICE_RESOURCE_LIMIT');
    for (const name of (await readdir(directory)).sort()) {
      if (signal?.aborted) throw resourceError('OFFICE_CANCELLED');
      const path = prefix ? `${prefix}/${name}` : name; resourceRelative(path);
      if (path === officeResourceManifestName) continue;
      const full = resolve(directory, name); const info = await lstat(full);
      if (info.isSymbolicLink()) throw resourceError('OFFICE_RESOURCE_UNSAFE');
      if (info.isDirectory()) { await visit(full, path, depth + 1); continue; }
      if (!info.isFile() || planned.length >= MAX_FILES || !Number.isSafeInteger(info.size)
          || info.size < 0 || info.size > MAX_BYTES - plannedBytes) throw resourceError('OFFICE_RESOURCE_LIMIT');
      plannedBytes += info.size;
      planned.push({ path, full, maximumBytes: info.size });
    }
  }
  // Admit the entire count/byte budget before starting any content reads.
  await visit(root, '', 0);
  const files = new Array(planned.length); let cursor = 0, failure, failed = false;
  const fail = error => { if (!failed) { failed = true; failure = error; } };
  async function worker() {
    while (!failed && cursor < planned.length) {
      if (signal?.aborted) { fail(resourceError('OFFICE_CANCELLED')); break; }
      const index = cursor++, entry = planned[index];
      try {
        // Each read keeps the original ancestry, single-link descriptor, full
        // SHA and before/after identity checks; no observation is reused.
        const observed = await digestResource(entry.full, { maxBytes: entry.maximumBytes, signal });
        if (signal?.aborted) throw resourceError('OFFICE_CANCELLED');
        files[index] = { path: entry.path, bytes: observed.bytes, sha256: observed.sha256,
          legal: /\/(?:licen[cs]e|notice|copying)(?:\.|$)/i.test('/' + entry.path) };
      } catch (error) { fail(error); }
    }
  }
  // Join every started read before returning either an error or a complete,
  // deterministically ordered inventory. At most eight content FDs are held.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(8, planned.length) }, () => worker()));
  for (const result of workers) if (result.status === 'rejected') fail(result.reason);
  if (failed) throw failure;
  return { files, totalBytes: files.reduce((total, entry) => total + entry.bytes, 0) };
}
export async function verifyOfficeResourceBundle(root, expectedSha256, { signal } = {}) {
  if (!validSha(expectedSha256)) throw resourceError('OFFICE_RESOURCE_IDENTITY_MISMATCH');
  root = await ordinaryDirectory(root);
  const bytes = await readResource(resolve(root, officeResourceManifestName));
  if (sha256(bytes) !== expectedSha256) throw resourceError('OFFICE_RESOURCE_IDENTITY_MISMATCH');
  let manifest; try { manifest = JSON.parse(bytes); } catch { throw resourceError('OFFICE_RESOURCE_INVALID'); }
  if (manifest?.schemaVersion !== 1 || manifest.componentName !== '@kcoder/office-components' || manifest.nodeMinimumMajor !== 22
      || manifest.packageRoot !== 'components' || manifest.entry !== officeResourceEntry || !validSha(manifest.lockSha256)
      || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES
      || !Array.isArray(manifest.dependencies) || manifest.dependencies.length > 2000) throw resourceError('OFFICE_RESOURCE_INVALID');
  const names = new Set(); for (const entry of manifest.files) {
    resourceRelative(entry.path);
    if (names.has(entry.path) || !validSha(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw resourceError('OFFICE_RESOURCE_INVALID');
    names.add(entry.path);
  }
  const actual = await resourceInventory(root, { signal });
  if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files) || actual.totalBytes !== manifest.totalBytes) throw resourceError('OFFICE_RESOURCE_IDENTITY_MISMATCH');
  if ([officeResourceEntry,'components/package.json','components/package-lock.json','licenses/kcoder-office/LICENSE.txt','licenses/saxes/LICENSE.txt','licenses/electron-fuses/LICENSE.txt','licenses/PROVENANCE.md'].some(path=>!names.has(path)) || !manifest.files.some(file => file.legal)) throw resourceError('OFFICE_RESOURCE_INVALID');
  const lockBytes = await readResource(resolve(root, 'components/package-lock.json'));
  if (sha256(lockBytes) !== manifest.lockSha256) throw resourceError('OFFICE_RESOURCE_IDENTITY_MISMATCH');
  const locked = JSON.parse(lockBytes).packages;
  if (!locked || Object.keys(locked).filter(Boolean).length !== manifest.dependencies.length || new Set(manifest.dependencies.map(dependency => dependency.path)).size !== manifest.dependencies.length) throw resourceError('OFFICE_DEPENDENCY_UNAVAILABLE');
  for (const [name, version] of Object.entries({docx:'9.5.1',exceljs:'4.4.0',pptxgenjs:'4.0.1',fflate:'0.8.3',saxes:'6.0.0'})) {
    if (locked['node_modules/'+name]?.version !== version) throw resourceError('OFFICE_DEPENDENCY_UNAVAILABLE');
  }
  const pkg = JSON.parse(await readResource(resolve(root, 'components/package.json')));
  if (pkg.name !== manifest.componentName || pkg.version !== manifest.componentVersion) throw resourceError('OFFICE_RESOURCE_IDENTITY_MISMATCH');
  for (const dependency of manifest.dependencies) {
    resourceRelative(dependency.path);
    if (!dependency.path.startsWith('node_modules/') || typeof dependency.version !== 'string') throw resourceError('OFFICE_RESOURCE_INVALID');
    if (locked[dependency.path]?.version !== dependency.version || (locked[dependency.path]?.integrity ?? null) !== dependency.integrity) throw resourceError('OFFICE_DEPENDENCY_UNAVAILABLE');
    const installed = JSON.parse(await readResource(resolve(root, 'components', dependency.path, 'package.json')));
    if (installed.version !== dependency.version) throw resourceError('OFFICE_DEPENDENCY_UNAVAILABLE');
  }
  return Object.freeze({ root, manifest, manifestSha256: expectedSha256, componentRoot: resolve(root, 'components') });
}
