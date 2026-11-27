// Pinned official lark-cli (https://github.com/larksuite/cli, MIT) for full
// Studio desktop packages. Build time only: release archives are verified
// against SHA-256 values recorded here and cross-checked with the release's
// own checksums.txt. Nothing downloaded is executed, and the npm package's
// installer (postinstall) is never used.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { assertMacExecutable } from './mac-executable.mjs';

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const LARK_CLI_VERSION = '1.0.100';
export const LARK_CLI_TAG = `v${LARK_CLI_VERSION}`;
/** Commit of the upstream tag; the bundled lark-* skills come from the same commit. */
export const LARK_CLI_COMMIT = 'ac22a60a23d66c37d43a7ec6d9e99b99a4320356';
const RELEASE_URL = `https://github.com/larksuite/cli/releases/download/${LARK_CLI_TAG}`;
const asset = (name, sha256, extra = {}) => Object.freeze({ name, sha256, url: `${RELEASE_URL}/${name}`, ...extra });

/** Release assets for the Studio desktop platforms that bundle lark-cli. */
export const LARK_CLI_RELEASE = Object.freeze({
  version: LARK_CLI_VERSION,
  tag: LARK_CLI_TAG,
  commit: LARK_CLI_COMMIT,
  checksums: asset('checksums.txt', '90ff2de16a179de0127de6e2da090586b141220185aee6bc2067606800a9d9e8'),
  assets: Object.freeze({
    'linux-x64': asset('lark-cli-1.0.100-linux-amd64.tar.gz', 'cd7363f731c9e5dd2becd909837922cffea8aad229d581a84eb13c6aa0ce6808', { format: 'tar.gz', executable: 'lark-cli', binary: 'elf-x64' }),
    'win-x64': asset('lark-cli-1.0.100-windows-amd64.zip', '93118ca1992b4e5f1a40c14301f6fbde703d5e9160a9113099e409b4bd1c1d8d', { format: 'zip', executable: 'lark-cli.exe', binary: 'pe-x64' }),
    'mac-x64': asset('lark-cli-1.0.100-darwin-amd64.tar.gz', '7f5d442e5da3ae62b03a5b552880b651637b16b2eed91b588afaca6d72a6643a', { format: 'tar.gz', executable: 'lark-cli', binary: 'macho-x64' }),
    'mac-arm64': asset('lark-cli-1.0.100-darwin-arm64.tar.gz', 'd068a27f608335016a8a7fb1b3cd1fccfb96bda92075a027e2bf1c4c23134e30', { format: 'tar.gz', executable: 'lark-cli', binary: 'macho-arm64' }),
  }),
});

const MARKER = '.kcoder-lark-cli.json';
const MARKER_SCHEMA = 'kcoder.lark-cli-resource.v1';
const ARCHIVE_LIMIT = 64 * 1024 * 1024;
const EXPANDED_LIMIT = 160 * 1024 * 1024;
const CHECKSUMS_LIMIT = 64 * 1024;
const DOCUMENTS = Object.freeze(['LICENSE', 'README.md', 'CHANGELOG.md']);

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function regularFile(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('lark-cli resource must be a regular file');
  if (info.size > limit) throw new Error('lark-cli resource exceeds its size limit');
  return info;
}

async function rejectSymlinkAncestors(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if ((await exists(current))?.isSymbolicLink()) throw new Error('lark-cli paths must not traverse symbolic links');
    if (dirname(current) === current) return;
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyHash(path, expected, limit) {
  await regularFile(path, limit);
  if (await sha256File(path) !== expected) throw new Error('lark-cli resource SHA-256 mismatch; existing resources were not changed');
}

/** Upstream checksums.txt must list every pinned asset with the recorded digest. */
export function verifyLarkCliChecksums(text, release = LARK_CLI_RELEASE) {
  const listed = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || listed.has(match[2])) throw new Error('lark-cli checksums.txt is malformed');
    listed.set(match[2], match[1]);
  }
  for (const entry of Object.values(release.assets)) {
    if (listed.get(entry.name) !== entry.sha256) throw new Error(`lark-cli checksums.txt does not confirm the pinned ${entry.name}`);
  }
  return listed;
}

function allowedEntry(name, executable) {
  return name === executable || DOCUMENTS.includes(name);
}

function recordEntry(entries, name, data, executable) {
  if (!allowedEntry(name, executable)) throw new Error(`Unexpected lark-cli archive entry: ${JSON.stringify(name)}`);
  if (entries.has(name)) throw new Error('Duplicate lark-cli archive entry');
  entries.set(name, data);
}

function tarField(header, start, length) {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function tarNumber(header, start, length) {
  const text = tarField(header, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('Unsupported lark-cli TAR numeric field');
  return Number.parseInt(text, 8);
}

/** Flat release tarball: regular files only, no links, paths or extensions. */
export function readLarkCliTarGz(compressed, executable) {
  if (compressed.length > ARCHIVE_LIMIT) throw new Error('lark-cli archive exceeds its size limit');
  const bytes = gunzipSync(compressed, { maxOutputLength: EXPANDED_LIMIT });
  const entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!bytes.subarray(offset).every(byte => byte === 0)) throw new Error('Unexpected trailing lark-cli TAR data');
      return entries;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (tarNumber(header, 148, 8) !== checksum) throw new Error('lark-cli TAR checksum mismatch');
    const type = String.fromCharCode(header[156]);
    if (type !== '0' && type !== '\0') throw new Error('lark-cli TAR links, directories or extensions are forbidden');
    if (tarField(header, 345, 155) !== '') throw new Error('lark-cli TAR paths are forbidden');
    const size = tarNumber(header, 124, 12);
    const start = offset + 512;
    if (start + size > bytes.length) throw new Error('Truncated lark-cli TAR');
    recordEntry(entries, tarField(header, 0, 100), bytes.subarray(start, start + size), executable);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('Truncated lark-cli TAR');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Flat release ZIP: stored or deflated files, no encryption, ZIP64 or paths. */
export function readLarkCliZip(bytes, executable) {
  if (bytes.length > ARCHIVE_LIMIT) throw new Error('lark-cli archive exceeds its size limit');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error('lark-cli ZIP has no end record');
  const count = bytes.readUInt16LE(end + 10);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count || count > 16) throw new Error('Unsupported lark-cli ZIP layout');
  const entries = new Map();
  let expanded = 0;
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid lark-cli ZIP directory');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), length = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    if (flags & 0x41 || ![0, 8].includes(method) || [compressed, length, local].includes(0xffffffff)) throw new Error('Unsupported lark-cli ZIP entry');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    expanded += length;
    if (expanded > EXPANDED_LIMIT) throw new Error('lark-cli ZIP expansion limit');
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid lark-cli ZIP entry header');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > bytes.length) throw new Error('Truncated lark-cli ZIP entry');
    const raw = bytes.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(length, 1) }) : raw;
    if (data.length !== length || crc32(data) !== crc) throw new Error('lark-cli ZIP checksum mismatch');
    recordEntry(entries, name, data, executable);
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}

/** The binary must match the packaged platform before it enters resources. */
export async function verifyLarkCliBinary(path, kind) {
  if (kind === 'macho-x64' || kind === 'macho-arm64') return assertMacExecutable(path, kind.slice(6));
  const file = await open(path, 'r');
  let header;
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
  if (kind === 'elf-x64') {
    if (header.length < 64 || header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 2 || header[5] !== 1
      || header.readUInt16LE(18) !== 0x3e || ![2, 3].includes(header.readUInt16LE(16))) throw new Error('lark-cli must be a Linux x86-64 ELF executable');
    return;
  }
  if (kind === 'pe-x64') {
    if (header.length < 64 || header.toString('ascii', 0, 2) !== 'MZ') throw new Error('lark-cli.exe has no DOS header');
    const pe = header.readUInt32LE(0x3c);
    if (pe + 26 > header.length || header.readUInt32LE(pe) !== 0x4550 || header.readUInt16LE(pe + 4) !== 0x8664
      || header.readUInt16LE(pe + 24) !== 0x20b) throw new Error('lark-cli.exe must be a Windows x64 PE32+ executable');
    return;
  }
  throw new Error('Unknown lark-cli binary kind');
}

async function readMarker(directory) {
  try {
    await regularFile(join(directory, MARKER), 16384);
    return JSON.parse(await readFile(join(directory, MARKER), 'utf8'));
  } catch { return null; }
}

/** Only a directory carrying our marker may be replaced. */
async function ownedDestination(output) {
  const info = await exists(output);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing to replace an unowned lark-cli destination');
  const marker = await readMarker(output);
  if (marker?.schema !== MARKER_SCHEMA || marker.vendor !== 'larksuite/cli' || !/^[0-9a-f]{64}$/.test(marker.executableSha256 ?? '')) {
    throw new Error('Refusing to replace an unowned lark-cli destination');
  }
  return { info, marker };
}

async function current(output, platform, entry, release) {
  const owned = await ownedDestination(output);
  if (!owned) return null;
  const { marker } = owned;
  if (marker.version !== release.version || marker.commit !== release.commit || marker.platform !== platform
    || marker.archive?.sha256 !== entry.sha256 || marker.executable !== entry.executable) return owned;
  try {
    await verifyHash(join(output, entry.executable), marker.executableSha256, EXPANDED_LIMIT);
    await regularFile(join(output, 'LICENSE'), 64 * 1024);
    return { ...owned, reusable: true };
  } catch { return owned; }
}

function downloadArgs(url, output) {
  // --disable ignores curlrc; redirects (GitHub release storage) must stay on HTTPS.
  return ['--disable', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '5',
    '--connect-timeout', '30', '--max-time', '600', '--max-filesize', String(ARCHIVE_LIMIT), '--output', output, url];
}

async function download(url, output) {
  try { await run(process.platform === 'win32' ? 'curl.exe' : 'curl', downloadArgs(url, output), { timeout: 610000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error('Official lark-cli download failed; use the pinned offline archive options'); }
}

/** Explicit file, offline archive directory, verified cache, then HTTPS download. */
async function acquire(entry, { explicit, archiveDirectory, cacheRoot, stage, offline, limit }) {
  const local = join(stage, entry.name);
  const cached = join(cacheRoot, `${entry.name}.${entry.sha256}`);
  const offlineCopy = archiveDirectory ? join(archiveDirectory, entry.name) : null;
  if (explicit) { await regularFile(resolve(explicit), limit); await copyFile(resolve(explicit), local); }
  else if (offlineCopy && await exists(offlineCopy)) { await regularFile(offlineCopy, limit); await copyFile(offlineCopy, local); }
  else if (await exists(cached)) { await regularFile(cached, limit); await copyFile(cached, local); }
  else {
    if (offline) throw new Error(`Pinned ${entry.name} is absent from the offline archive directory and cache`);
    await download(entry.url, local);
  }
  await verifyHash(local, entry.sha256, limit);
  if (!await exists(cached)) {
    const temporary = await mkdtemp(join(cacheRoot, '.lark-cli-cache-'));
    try {
      const candidate = join(temporary, 'archive');
      await copyFile(local, candidate);
      await verifyHash(candidate, entry.sha256, limit);
      await rename(candidate, cached);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  return local;
}

export async function prepareLarkCli({
  platform, destination, cache = join(repository, 'target/cache/lark-cli'), archive, checksums, archiveDirectory,
  offline = false, release = LARK_CLI_RELEASE,
} = {}) {
  const entry = release.assets[platform];
  if (!entry) throw new Error(`Unsupported bundled lark-cli platform: ${platform}`);
  if (!destination) throw new Error('A dedicated lark-cli destination is required');
  const output = resolve(destination), cacheRoot = resolve(cache), parent = dirname(output);
  if (basename(output) !== 'lark-cli' || parent === parse(output).root || output === cacheRoot
    || output.startsWith(cacheRoot + sep) || cacheRoot.startsWith(output + sep)) {
    throw new Error('lark-cli requires a dedicated non-overlapping destination ending in lark-cli');
  }
  const offlineRoot = archiveDirectory ? resolve(archiveDirectory) : undefined;
  await rejectSymlinkAncestors(output); await rejectSymlinkAncestors(cacheRoot);
  if (offlineRoot) await rejectSymlinkAncestors(offlineRoot);
  await mkdir(parent, { recursive: true });
  const lock = join(parent, '.kcoder-lark-cli.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('lark-cli preparation is locked; do not remove a live preparation lock'); throw error; }
  let stage;
  let retain = false;
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, destination: output }), { mode: 0o600, flag: 'wx' });
    const initial = await current(output, platform, entry, release);
    const result = extra => ({
      directory: output, executable: join(output, entry.executable), platform, version: release.version, commit: release.commit,
      archive: entry.name, archiveSha256: entry.sha256, ...extra,
    });
    // Warm path: the owned copy already holds the verified pinned binary.
    if (initial?.reusable) return result({ executableSha256: initial.marker.executableSha256, executableBytes: initial.marker.executableBytes, reused: true });

    await mkdir(cacheRoot, { recursive: true });
    stage = await mkdtemp(join(parent, '.lark-cli-stage-'));
    await chmod(stage, 0o700);
    const downloads = join(stage, 'download');
    await mkdir(downloads, { mode: 0o700 });
    const checksumsFile = await acquire(release.checksums, { explicit: checksums, archiveDirectory: offlineRoot, cacheRoot, stage: downloads, offline, limit: CHECKSUMS_LIMIT });
    verifyLarkCliChecksums(await readFile(checksumsFile, 'utf8'), release);
    const archiveFile = await acquire(entry, { explicit: archive, archiveDirectory: offlineRoot, cacheRoot, stage: downloads, offline, limit: ARCHIVE_LIMIT });
    const bytes = await readFile(archiveFile);
    const entries = entry.format === 'zip' ? readLarkCliZip(bytes, entry.executable) : readLarkCliTarGz(bytes, entry.executable);
    for (const required of [entry.executable, 'LICENSE']) if (!entries.has(required)) throw new Error(`lark-cli archive lacks ${required}`);

    const fresh = join(stage, 'fresh');
    await mkdir(fresh, { mode: 0o700 });
    const executable = join(fresh, entry.executable);
    await writeFile(executable, entries.get(entry.executable), { flag: 'wx', mode: 0o755 });
    await chmod(executable, 0o755);
    await verifyLarkCliBinary(executable, entry.binary);
    await writeFile(join(fresh, 'LICENSE'), entries.get('LICENSE'), { flag: 'wx', mode: 0o644 });
    const executableSha256 = await sha256File(executable);
    const executableBytes = entries.get(entry.executable).length;
    const marker = {
      schema: MARKER_SCHEMA, vendor: 'larksuite/cli', project: 'https://github.com/larksuite/cli', license: 'MIT',
      version: release.version, tag: release.tag, commit: release.commit, platform,
      archive: { name: entry.name, url: entry.url, sha256: entry.sha256 },
      checksums: { name: release.checksums.name, url: release.checksums.url, sha256: release.checksums.sha256 },
      executable: entry.executable, executableSha256, executableBytes,
    };
    await writeFile(join(fresh, MARKER), JSON.stringify(marker, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    await chmod(fresh, 0o755);

    const now = await ownedDestination(output);
    if (Boolean(initial) !== Boolean(now) || (initial && (initial.info.dev !== now.info.dev || initial.info.ino !== now.info.ino))) {
      throw new Error('lark-cli destination changed during preparation');
    }
    const previous = join(stage, 'previous');
    if (now) await rename(output, previous);
    try { await rename(fresh, output); }
    catch (error) {
      if (now) {
        try { await rename(previous, output); }
        catch { retain = true; throw new Error(`lark-cli replacement failed; previous resources retained in ${stage}`, { cause: error }); }
      }
      throw error;
    }
    return result({ executableSha256, executableBytes, reused: false });
  } finally {
    if (stage && !retain) await rm(stage, { recursive: true, force: true });
    await rm(join(lock, 'owner.json'), { force: true });
    await rmdir(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const usage = 'Usage: prepare-lark-cli.mjs --platform linux-x64|win-x64|mac-x64|mac-arm64 --dest PATH/lark-cli [--cache DIR] [--archive-dir DIR] [--archive FILE] [--checksums FILE] [--offline]';
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const flag = process.argv[i];
      if (flag === '--offline') { options.offline = true; continue; }
      const key = { '--platform': 'platform', '--dest': 'destination', '--cache': 'cache', '--archive-dir': 'archiveDirectory', '--archive': 'archive', '--checksums': 'checksums' }[flag];
      const value = process.argv[++i];
      if (!key || !value || value.startsWith('--')) throw new Error(usage);
      options[key] = value;
    }
    console.log(JSON.stringify(await prepareLarkCli(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
