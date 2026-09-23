import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateChromeZip } from './chrome-archive.mjs';

const run = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, '../..');
export const CHROME_VERSION = '152.0.7977.82';
const hashes = {
  linux64: '0704631fb3e4f741092e08f55272f90abc3e307f991f05f332924364415b02e0',
  win64: '460016c1ddba882bf253445175ab240dd947fa349bd720daeb0e311c17e74540',
};
const marker = '.kcoder-chrome.json';

export function chromeRelease(platform) {
  if (!Object.hasOwn(hashes, platform)) throw new Error(`Unsupported Chrome platform: ${platform}`);
  return {
    platform, version: CHROME_VERSION, sha256: hashes[platform], directory: `chrome-${platform}`,
    executable: platform === 'win64' ? 'chrome.exe' : 'chrome',
    metadataUrl: `https://googlechromelabs.github.io/chrome-for-testing/${CHROME_VERSION}.json`,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${platform}/chrome-${platform}.zip`,
  };
}

export function validateChromeMetadata(metadata, release) {
  if (metadata?.version !== release.version || !metadata?.downloads?.chrome?.some(item => item.platform === release.platform && item.url === release.url)) {
    throw new Error('Chrome metadata did not identify the pinned official download');
  }
}

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Chrome resource must be a regular file');
  return info;
}

async function verifyArchive(path, release) {
  const info = await regularFile(path);
  if (info.size > 512 * 1024 * 1024) throw new Error('Chrome archive exceeds its size limit');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== release.sha256) throw new Error('Chrome archive SHA-256 mismatch; existing installation was not changed');
}

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function rejectSymlinkAncestors(path) {
  for (let current = resolve(path);; current = dirname(current)) {
    const info = await exists(current);
    if (info?.isSymbolicLink()) throw new Error('Chrome resource paths must not traverse symbolic links');
    if (dirname(current) === current) break;
  }
}

async function downloadOfficialFile(url, file, limit) {
  // --disable prevents curlrc/netrc-style user configuration from injecting credentials.
  // Explicit standard proxy environment variables remain usable; redirects are never followed.
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--disable', '--fail', '--silent', '--show-error', '--proto', '=https', '--max-redirs', '0',
      '--connect-timeout', '30', '--max-time', '600', '--max-filesize', String(limit),
      '--output', file, '--write-out', '%{http_code}', url,
    ], { timeout: 610000, maxBuffer: 1024 * 1024 });
    if (stdout !== '200' || (await regularFile(file)).size > limit) throw new Error('Invalid download response');
  } catch {
    throw new Error('Chrome download failed; provide a verified --archive for offline preparation');
  }
}

async function extractArchive(archive, destination) {
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(scriptDirectory, 'extract-chrome.ps1'), '-Archive', archive, '-Destination', destination],
    { timeout: 120000, maxBuffer: 1024 * 1024 });
  } else {
    await run('unzip', ['-q', archive, '-d', destination], { timeout: 120000, maxBuffer: 1024 * 1024 });
  }
}

async function verifyExtracted(destination, release, entries) {
  const expected = new Map(entries.map(entry => [entry.name.replace(/\/$/, ''), entry]));
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), info = await lstat(path);
      const relativePath = relative(destination, path).split(sep).join('/');
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Chrome extraction produced an unsafe file');
      if (info.isDirectory()) {
        if (!entries.some(entry => entry.name.startsWith(`${relativePath}/`))) throw new Error('Chrome extraction produced an unexpected directory');
        await chmod(path, 0o755);
        await visit(path);
      } else {
        const entry = expected.get(relativePath);
        if (!entry || entry.directory) throw new Error('Chrome extraction produced an unexpected file');
        // Strip setuid/setgid and group/world writes, including chrome_sandbox privilege bits.
        await chmod(path, entry.executable || relativePath === `${release.directory}/${release.executable}` ? 0o755 : 0o644);
        expected.delete(relativePath);
      }
    }
  }
  await visit(destination);
  if ([...expected.values()].some(entry => !entry.directory)) throw new Error('Chrome extraction omitted required files');
  await regularFile(join(destination, release.directory, release.executable));
  await chmod(destination, 0o755);
}

export async function prepareChrome({ platform = process.platform === 'win32' ? 'win64' : 'linux64',
  destination, cache = join(repository, 'target/cache/chrome-for-testing'), archive,
  release = chromeRelease(platform), download = downloadOfficialFile, extract = extractArchive,
  renamePath = rename } = {}) {
  if (!destination) throw new Error('A dedicated chrome destination is required');
  const output = resolve(destination), cacheRoot = resolve(cache);
  if (basename(output) !== 'chrome' || dirname(output) === parse(output).root ||
      output === cacheRoot || output.startsWith(cacheRoot + sep) || cacheRoot.startsWith(output + sep)) {
    throw new Error('Chrome requires a dedicated non-overlapping chrome destination');
  }
  const pinned = chromeRelease(release.platform);
  if (release.version !== pinned.version || release.url !== pinned.url || release.metadataUrl !== pinned.metadataUrl ||
      release.directory !== pinned.directory || release.executable !== pinned.executable || !/^[a-f0-9]{64}$/.test(release.sha256)) {
    throw new Error('Chrome release must use the pinned official artifact');
  }
  await rejectSymlinkAncestors(output);
  await rejectSymlinkAncestors(cacheRoot);
  const current = await exists(output);
  if (current) {
    let prior;
    try { await regularFile(join(output, marker)); prior = JSON.parse(await readFile(join(output, marker), 'utf8')); } catch { /* Reject unowned directories below. */ }
    if (!current.isDirectory() || prior?.platform !== release.platform || !/^[a-f0-9]{64}$/.test(prior.sha256 ?? '')) {
      throw new Error('Refusing to replace a directory not managed by the Chrome preparer');
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  const lock = join(dirname(output), '.kcoder-chrome.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new Error('Chrome preparation is already in progress'); throw error; }
  let staging, retainRecovery = false;
  try {
    staging = await mkdtemp(join(dirname(output), '.chrome-stage-'));
    const cached = join(cacheRoot, `chrome-${release.version}-${release.platform}-${release.sha256.slice(0, 12)}.zip`);
    if (archive || !(await exists(cached))) {
      const candidate = join(staging, 'download.zip');
      if (archive) {
        await verifyArchive(resolve(archive), release);
        await copyFile(resolve(archive), candidate);
      } else {
        const metadataPath = join(staging, 'metadata.json');
        await download(release.metadataUrl, metadataPath, 1024 * 1024);
        if ((await regularFile(metadataPath)).size > 1024 * 1024) throw new Error('Chrome metadata exceeds its size limit');
        validateChromeMetadata(JSON.parse(await readFile(metadataPath, 'utf8')), release);
        await download(release.url, candidate, 512 * 1024 * 1024);
      }
      await verifyArchive(candidate, release);
      // Copy to a same-filesystem cache staging area before its atomic rename.
      const cacheStage = await mkdtemp(join(cacheRoot, '.chrome-cache-'));
      try {
        await copyFile(candidate, join(cacheStage, 'archive.zip'));
        await verifyArchive(join(cacheStage, 'archive.zip'), release);
        await rename(join(cacheStage, 'archive.zip'), cached);
      } finally { await rm(cacheStage, { recursive: true, force: true }); }
    }
    // Extract a private verified copy so concurrent cache maintenance cannot change the input.
    await verifyArchive(cached, release);
    const verified = join(staging, 'verified.zip');
    await copyFile(cached, verified);
    await verifyArchive(verified, release);
    const entries = validateChromeZip(await readFile(verified), release);
    const fresh = join(staging, 'chrome');
    await mkdir(fresh, { mode: 0o700 });
    await extract(verified, fresh);
    await verifyExtracted(fresh, release, entries);
    await writeFile(join(fresh, marker), JSON.stringify({ version: release.version, platform: release.platform, sha256: release.sha256, source: release.url }, null, 2) + '\n', { mode: 0o644 });
    const backup = join(staging, 'previous');
    let backedUp = false;
    if (await exists(output)) { await renamePath(output, backup); backedUp = true; }
    try { await renamePath(fresh, output); }
    catch (error) {
      if (backedUp) {
        try { await renamePath(backup, output); }
        catch { retainRecovery = true; throw new Error(`Chrome update failed; previous resources retained at ${backup}`); }
      }
      throw error;
    }
    return { directory: output, executable: join(output, release.directory, release.executable), version: release.version, sha256: release.sha256 };
  } finally {
    if (staging && !retainRecovery) await rm(staging, { recursive: true, force: true });
    await rmdir(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  try {
    for (let i = 2; i < process.argv.length; i += 2) {
      const name = { '--platform': 'platform', '--dest': 'destination', '--cache': 'cache', '--archive': 'archive' }[process.argv[i]];
      if (!name || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error('Usage: prepare-chrome.mjs --platform linux64|win64 --dest PATH [--cache PATH] [--archive ZIP]');
      options[name] = process.argv[i + 1];
    }
    console.log(JSON.stringify(await prepareChrome(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
