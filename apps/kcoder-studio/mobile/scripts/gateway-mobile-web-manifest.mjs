import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, resolve, relative, sep } from 'node:path';

export const MOBILE_WEB_BASE_TOKEN = '/__kcoder_mobile_mount_v1__';

const manifestName = 'kcoder-mobile-web.json';
const maximumFileBytes = 32 * 1024 * 1024;
const maximumTotalBytes = 256 * 1024 * 1024;
const maximumFiles = 10000;
const maximumResourcePathLength = 1024;
const maximumManifestBytes = 4 * 1024 * 1024;

export function serializeGatewayMobileWebManifest(manifest) {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > maximumManifestBytes) {
    throw new Error('Mobile Web manifest exceeds static handler limit');
  }
  return serialized;
}

/** Atomically publish the public manifest without following a pre-existing target. */
export async function writeGatewayMobileWebManifest(distRoot, manifest) {
  const root = await verifyDistRoot(distRoot);
  const destination = resolve(root, manifestName);
  assertContained(root, destination, 'Mobile Web manifest escaped its export directory');
  const serialized = serializeGatewayMobileWebManifest(manifest);
  await assertSafeManifestDestination(destination);

  const temporary = resolve(root, `.kcoder-mobile-web-manifest-${randomUUID()}.tmp`);
  let handle = null;
  let published = false;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o644);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    // Recheck immediately before rename. Rename replaces the directory entry and
    // never follows a symlink or mutates another hard link's inode.
    await assertSafeManifestDestination(destination);
    await rename(temporary, destination);
    published = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!published) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Build the exact deploy-mount manifest consumed by Studio's static handler. */
export async function buildGatewayMobileWebManifest(distRoot, { expectedFiles = null } = {}) {
  const root = await verifyDistRoot(distRoot);

  const files = [];
  let total = 0;
  async function collect(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix + entry.name;
      if (path.length > maximumResourcePathLength) throw new Error('Mobile Web resource path exceeds static handler limit');
      if (path === manifestName) {
        await assertSafeManifestDestination(resolve(directory, entry.name));
        continue;
      }
      if ((entry.name.startsWith('.') && path !== '_expo/.routes.json') || /[\\%?#\x00-\x1f\x7f]/.test(entry.name) || entry.isSymbolicLink()) {
        throw new Error('Unsupported Mobile Web resource');
      }
      const absolute = resolve(directory, entry.name);
      assertContained(root, absolute, 'Mobile Web resource escaped its export directory');
      if (entry.isDirectory()) {
        await collect(absolute, `${path}/`);
        continue;
      }
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maximumFileBytes || /\.(?:map|gz|br)$/i.test(path)) {
        throw new Error('Unsupported Mobile Web resource');
      }
      const bytes = await readFile(absolute);
      if (bytes.length !== info.size || bytes.length > maximumFileBytes) throw new Error('Mobile Web resource changed while reading');
      const text = /\.(?:js|css|json|html|svg|txt|xml|webmanifest)$/i.test(path);
      const decoded = bytes.toString('utf8');
      const replacements = text ? decoded.split(MOBILE_WEB_BASE_TOKEN).length - 1 : 0;
      if ((text && !Buffer.from(decoded).equals(bytes)) || (!text && bytes.includes(Buffer.from(MOBILE_WEB_BASE_TOKEN))) ||
          (path.endsWith('.html') && /\bintegrity\s*=/i.test(decoded))) {
        throw new Error('Unsupported Mobile Web token encoding or integrity attribute');
      }
      total += bytes.length;
      if (total > maximumTotalBytes || files.length >= maximumFiles) throw new Error('Mobile Web build exceeds resource limit');
      files.push({
        path,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        text,
        replacements,
      });
    }
  }

  await collect(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  assert.ok(files.some(file => file.path === 'index.html'), 'Export is missing index.html');
  assert.ok(files.some(file => file.replacements > 0), 'Export did not apply Mobile Web baseUrl');
  if (expectedFiles !== null) {
    assert.ok(Array.isArray(expectedFiles), 'expected Mobile Web bundle files must be an array');
    const actualFiles = files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    assert.deepEqual(actualFiles, expectedFiles, 'deploy manifest files differ from the pinned matched bundle');
  }
  const manifest = { version: 1, baseToken: MOBILE_WEB_BASE_TOKEN, files };
  serializeGatewayMobileWebManifest(manifest);
  return manifest;
}

async function verifyDistRoot(distRoot) {
  assert.ok(typeof distRoot === 'string' && isAbsolute(distRoot), 'Mobile Web export directory must be absolute');
  const root = resolve(distRoot);
  assert.equal(root, distRoot, 'Mobile Web export directory must be normalized');
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Mobile Web export directory must be a regular directory');
  assert.equal(await realpath(root), root, 'Mobile Web export directory must not traverse a symlink');
  return root;
}

async function assertSafeManifestDestination(destination) {
  let info;
  try {
    info = await lstat(destination);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error('Unsafe existing Mobile Web manifest destination');
  }
}

function assertContained(root, candidate, message) {
  const path = relative(root, candidate);
  assert.ok(path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`), message);
}
