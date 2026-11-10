import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as nodeFileSystem from 'node:fs';
import { readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ordinaryDirectory, readResource, sameResourceFile } from './integrations/office/resource-verifier.mjs';

export const studioAssetManifestName = 'studio-public-assets.json';
const assetName = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new Error('STUDIO_COMPILED_ASSET_INTEGRITY_UNAVAILABLE');
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const maximumFile = 32 * 1024 * 1024;

/** Build metadata only. No personal settings, dynamic documents or HTML are eligible. */
export async function stageStudioPublicAssets({ webRoot }) {
  await ordinaryDirectory(webRoot);
  const files = [];let totalBytes = 0;
  for (const name of (await readdir(resolve(webRoot, 'assets'))).sort()) {
    const path = `assets/${name}`;
    if (!assetName.test(path)) continue;
    const bytes = await readResource(resolve(webRoot, path), maximumFile);
    totalBytes += bytes.length;
    if (files.length >= 2048 || totalBytes > 128 * 1024 * 1024) throw invalid();
    files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  if (!files.length) throw invalid();
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files, totalBytes }) + '\n');
  const temporary = resolve(webRoot, `.${studioAssetManifestName}.${randomUUID()}`);
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
  await rename(temporary, resolve(webRoot, studioAssetManifestName));
  return { schemaVersion: 1, resourceDirectory: 'renderer-dist', manifest: studioAssetManifestName, manifestSha256: digest(bytes) };
}

/** Read only package.json from the actual sibling ASAR, with bounded header/offsets. */
export async function readStudioPackageMetadata(archive) {
  // Electron patches fs to expose ASAR as a virtual directory. Read the real
  // bounded archive FD, never a virtual stat or a global process.noAsar toggle.
  const disk = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFileSystem;
  await ordinaryDirectory(dirname(archive));
  const before = disk.lstatSync(archive, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 16n * 1024n * 1024n) throw invalid();
  const fd = disk.openSync(archive, disk.constants.O_RDONLY | (disk.constants.O_NOFOLLOW ?? 0));
  let metadata;
  try {
    const actual = disk.fstatSync(fd, { bigint: true });
    if (!sameResourceFile(before, actual)) throw invalid();
    // Read bounded ranges from the same held archive. Parsing one package entry
    // must not synchronously read every unrelated ASAR payload on the HTTP loop.
    const readRange = (position, length) => {
      if (!Number.isSafeInteger(position) || position < 0 || position + length > Number(actual.size)) throw invalid();
      const bytes = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const count = disk.readSync(fd, bytes, offset, length - offset, position + offset);
        if (!count) throw invalid();
        offset += count;
      }
      return bytes;
    };
    const prefix = readRange(0, 16);
    if (prefix.readUInt32LE(0) !== 4) throw invalid();
    const headerBytes = prefix.readUInt32LE(4), jsonBytes = prefix.readUInt32LE(12);
    if (headerBytes < 8 || headerBytes > 1024 * 1024 || jsonBytes > headerBytes - 8) throw invalid();
    const entry = JSON.parse(readRange(16, jsonBytes).toString('utf8')).files?.['package.json'];
    if (!entry || entry.link || entry.unpacked || !/^\d{1,12}$/.test(entry.offset) || !Number.isSafeInteger(entry.size) || entry.size > 65536 || entry.size < 2) throw invalid();
    const start = 8 + headerBytes + Number(entry.offset);
    metadata = JSON.parse(readRange(start, entry.size).toString('utf8'));
    if (!sameResourceFile(actual, disk.fstatSync(fd, { bigint: true }))) throw invalid();
  } finally { disk.closeSync(fd); }
  return metadata;
}

async function inventory(webRoot, pin) {
  if (!pin || pin.schemaVersion !== 1 || pin.resourceDirectory !== 'renderer-dist' || pin.manifest !== studioAssetManifestName || !validSha(pin.manifestSha256)
      || Object.keys(pin).some(key => !['schemaVersion','resourceDirectory','manifest','manifestSha256'].includes(key))) throw invalid();
  const bytes = await readResource(resolve(webRoot, studioAssetManifestName));
  if (digest(bytes) !== pin.manifestSha256) throw invalid();
  const data = JSON.parse(bytes.toString('utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.files) || !data.files.length || data.files.length > 2048) throw invalid();
  const files = new Map();let total = 0;
  for (const file of data.files) {
    if (!assetName.test(file.path) || files.has(file.path) || !validSha(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > maximumFile) throw invalid();
    files.set(file.path, file);total += file.bytes;
  }
  if (total !== data.totalBytes || total > 128 * 1024 * 1024) throw invalid();
  return files;
}
export async function verifyStudioPublicAssets(webRoot, pin) {
  const files = await inventory(webRoot, pin);
  for (const [path, file] of files) {
    const bytes = await readResource(resolve(webRoot, path), maximumFile);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw invalid();
  }
  return files.size;
}

/** Only packaged, ASAR-pinned immutable code can avoid private session-store reads. */
export function createStudioPublicAssets({ webRoot, resourcesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..') }) {
  let captured;
  const verifiedBytes = new Map();
  // Retain the verified response bytes, not a cached permission to read mutable
  // disk bytes. The captured release pin and its 128 MiB inventory bound this
  // process-owned generation; a replacement release needs a new route instance.
  const resource = (path, file) => {
    let pending = verifiedBytes.get(path);
    if (!pending) {
      pending = readResource(resolve(webRoot, path), file.bytes).then(bytes => {
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw invalid();
        return bytes;
      }).catch(error => {
        if (verifiedBytes.get(path) === pending) verifiedBytes.delete(path);
        throw error;
      });
      verifiedBytes.set(path, pending);
    }
    return pending;
  };
  const load = () => captured ??= (async () => {
    if (resolve(webRoot) !== resolve(resourcesRoot, 'renderer-dist')) return null;
    let metadata;
    try { metadata = await readStudioPackageMetadata(resolve(resourcesRoot, 'app.asar')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return metadata.nativeStudioPublicAssets ? inventory(webRoot, metadata.nativeStudioPublicAssets) : null;
  })();
  return async (request, response, pathname) => {
    const path = pathname.slice(1);
    if (!['GET','HEAD'].includes(request.method) || !assetName.test(path)) return false;
    try {
      const files = await load(), file = files?.get(path);
      if (!file) return false;
      const bytes = await resource(path, file);
      const etag = `"sha256-${file.sha256}"`, fresh = request.headers['if-none-match'] === etag;
      response.writeHead(fresh ? 304 : 200, { 'content-type': path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'content-length': bytes.length, 'cache-control': 'public, max-age=31536000, immutable', etag,
        'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
      response.end(fresh || request.method === 'HEAD' ? undefined : bytes);
      return true;
    } catch {
      response.writeHead(503, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      response.end('Compiled asset unavailable');return true;
    }
  };
}
