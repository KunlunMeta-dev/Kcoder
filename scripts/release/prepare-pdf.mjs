import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractPdfEntries, readPdfTarGz, readPdfZip } from './pdf-archive.mjs';
import { buildPdf, includePdfBuildMaterials, XPDF_VARIANT } from './build-pdf.mjs';

const run = promisify(execFile), repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PDF_VERSION = '4.06';
export const PDF_EXE_SHA256 = '11fdcebb19c91c7733d6067105a5b1c08f0dc4110de20dc11a66e7936b65d968';
export const PDF_ASSETS = Object.freeze(Object.fromEntries(Object.entries({
  tools: ['xpdf-tools-win-4.06.zip', '2b6ca45da794e7854a6468fd6c8063fde62701f001ce03fa4f603eab7e15a0b6'],
  source: ['xpdf-4.06.tar.gz', '1c38f527c46caee0f712386d42a885b96a31ed9ce11904e872559859894d137e'],
  simplified: ['xpdf-chinese-simplified.tar.gz', 'f946b8d1659812d7ed25d235ae9d693b37cd6927f34d72f32284d286ce2813b4'],
  traditional: ['xpdf-chinese-traditional.tar.gz', 'c7b9a71a21bb81cb24078fa67be9ac645501413cd8d20aa589f28160cdf40af2'],
}).map(([key, [name, sha256]]) => [key, Object.freeze({ name, sha256, url: `https://dl.xpdfreader.com/${name}` })])));
const MARKER = '.kcoder-pdf.json', STAGE_MARKER = '.kcoder-pdf-stage.json';
const LIMIT = 64 * 1024 * 1024;
const config = `# Xpdf 4.06: resolve these relative paths from the managed pdf directory.\ntextEncoding UTF-8\ncidToUnicode Adobe-GB1 data/chinese-simplified/Adobe-GB1.cidToUnicode\nunicodeMap ISO-2022-CN data/chinese-simplified/ISO-2022-CN.unicodeMap\nunicodeMap EUC-CN data/chinese-simplified/EUC-CN.unicodeMap\nunicodeMap GBK data/chinese-simplified/GBK.unicodeMap\ncMapDir Adobe-GB1 data/chinese-simplified/CMap\ntoUnicodeDir data/chinese-simplified/CMap\ncidToUnicode Adobe-CNS1 data/chinese-traditional/Adobe-CNS1.cidToUnicode\nunicodeMap Big5 data/chinese-traditional/Big5.unicodeMap\nunicodeMap Big5ascii data/chinese-traditional/Big5ascii.unicodeMap\ncMapDir Adobe-CNS1 data/chinese-traditional/CMap\ntoUnicodeDir data/chinese-traditional/CMap\n`;
async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function regular(path) { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('PDF resource must be a regular file'); if (info.size > LIMIT) throw new Error('PDF resource exceeds limit'); return info; }
async function noLinks(path) {
  for (let current = resolve(path);; current = dirname(current)) {
    if ((await exists(current))?.isSymbolicLink()) throw new Error('PDF paths must not traverse symlinks');
    if (dirname(current) === current) return;
  }
}
export async function verifyPdfHash(path, expected) {
  await regular(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('PDF resource SHA-256 mismatch; existing resources were not changed');
}
async function owned(path) {
  const info = await exists(path);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing to replace an unowned PDF destination');
  let marker;
  try { await regular(join(path, MARKER)); marker = JSON.parse(await readFile(join(path, MARKER), 'utf8')); } catch { throw new Error('Refusing to replace an unowned PDF destination'); }
  if (marker.schema !== 'kcoder.pdf-resource.v1' || marker.vendor !== 'xpdf' || marker.platform !== 'win64' || !/^[0-9a-f]{64}$/.test(marker.executableSha256 ?? '')) throw new Error('Refusing to replace an unowned PDF destination');
  return info;
}
async function download(url, output) {
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--disable', '--fail', '--silent', '--show-error', '--proto', '=https', '--max-redirs', '0',
      '--connect-timeout', '30', '--max-time', '180', '--max-filesize', String(LIMIT),
      '--output', output, '--write-out', '%{http_code}', url,
    ], { timeout: 190000, maxBuffer: 1024 * 1024 });
    if (stdout !== '200') throw new Error('Unexpected download status');
  } catch { throw new Error('Official Xpdf download failed; use the pinned offline archive options'); }
}
async function writeDurableJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}
async function readSmallJson(path) {
  const info = await regular(path);
  if (info.size > 16384) throw new Error('PDF recovery record exceeds limit');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function recover(output, journal, renamePath = rename) {
  if (!(await exists(journal))) return;
  const record = await readSmallJson(journal);
  if (record.version !== 1 || record.output !== output || !/^\.pdf-stage-[A-Za-z0-9]+$/.test(record.stage ?? '')) throw new Error('Invalid PDF recovery destination');
  const stage = join(dirname(output), record.stage);
  await noLinks(stage);
  if (!(await exists(stage))) {
    if (!await owned(output)) throw new Error('PDF recovery data is missing');
    await rm(journal); return;
  }
  const owner = await readSmallJson(join(stage, STAGE_MARKER));
  if (owner.output !== output || owner.nonce !== record.nonce) throw new Error('Unowned PDF recovery staging directory');
  const backup = join(stage, 'previous');
  if (!await exists(output)) {
    if (!await owned(backup)) throw new Error('PDF recovery has no previous resources');
    await renamePath(backup, output);
  } else { await owned(output); }
  await rm(stage, { recursive: true });
  await rm(journal);
}
export function verifyWin64PdfExecutable(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('PDF executable has no DOS header');
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 26 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b) throw new Error('PDF executable must be Windows x64 PE32+');
}
async function permissions(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await permissions(path);
    else { await regular(path); await chmod(path, entry.name === 'pdftotext.exe' ? 0o755 : 0o644); }
  }
}
async function build(archives, stage, cacheRoot) {
  const unpack = join(stage, 'unpack'); await mkdir(unpack, { mode: 0o700 });
  await extractPdfEntries(readPdfZip(await readFile(archives.tools)), unpack);
  for (const key of ['simplified', 'traditional']) await extractPdfEntries(readPdfTarGz(await readFile(archives[key]), `xpdf-chinese-${key}`), unpack);
  const fresh = join(stage, 'fresh'), tools = join(unpack, 'xpdf-tools-win-4.06');
  await mkdir(fresh, { mode: 0o700 });
  // The official tools archive supplies documentation; verify its executable
  // as provenance only. The runtime is rebuilt from the matching patched source.
  await verifyPdfHash(join(tools, 'bin64/pdftotext.exe'), PDF_EXE_SHA256);
  const built = await buildPdf({ sourceArchive: archives.source, workDirectory: stage, cache: cacheRoot });
  await copyFile(built.executable, join(fresh, 'pdftotext.exe'));
  await verifyPdfHash(join(fresh, 'pdftotext.exe'), built.metadata.executableSha256);
  verifyWin64PdfExecutable(await readFile(join(fresh, 'pdftotext.exe')));
  for (const entry of await readdir(tools, { withFileTypes: true })) {
    if (entry.isFile()) await copyFile(join(tools, entry.name), join(fresh, entry.name));
  }
  await cp(join(tools, 'doc'), join(fresh, 'doc'), { recursive: true, errorOnExist: true, force: false });
  for (const key of ['simplified', 'traditional']) await cp(join(unpack, `xpdf-chinese-${key}`), join(fresh, 'data', `chinese-${key}`), { recursive: true, errorOnExist: true, force: false });
  await mkdir(join(fresh, 'source')); await copyFile(archives.source, join(fresh, 'source', PDF_ASSETS.source.name));
  await includePdfBuildMaterials(join(fresh, 'source'), built.metadata);
  await writeFile(join(fresh, 'xpdfrc'), config);
  for (const path of ['README', 'COPYING', 'COPYING3', 'doc/pdftotext.txt', 'data/chinese-simplified/README', 'data/chinese-simplified/CMap/LICENSE.md', 'data/chinese-traditional/README', 'data/chinese-traditional/CMap/LICENSE.md']) await regular(join(fresh, path));
  for (const line of config.split('\n').filter(line => /^(cidToUnicode|unicodeMap|cMapDir|toUnicodeDir) /.test(line))) {
    const path = join(fresh, line.split(' ').at(-1));
    const info = await lstat(path); if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Missing Xpdf configuration resource');
  }
  const marker = { schema: 'kcoder.pdf-resource.v1', vendor: 'xpdf', version: PDF_VERSION, variant: XPDF_VARIANT, platform: 'win64', executableSha256: built.metadata.executableSha256, buildFingerprint: built.metadata.fingerprint, archives: PDF_ASSETS, configuration: { file: 'xpdfrc', cwd: 'pdf', paths: 'relative-to-process-cwd' }, upstreamLicense: 'GPL-2.0-only OR GPL-3.0-only', modifiedComponentLicense: 'GPL-3.0-only', buildRecipeLicense: 'MIT', source: `source/${PDF_ASSETS.source.name}` };
  await writeFile(join(fresh, MARKER), JSON.stringify(marker, null, 2) + '\n');
  await writeFile(join(fresh, 'KCODER-PDF-NOTICE.txt'), `Xpdf command-line tool ${XPDF_VARIANT}, modified by KCoder on 2026-09-24; not the unmodified official binary and not Poppler.\nThis modified Xpdf component is distributed under GPL-3.0-only; upstream permits GPL v2 or v3. This does not change the license of KCoder.\nRetain README, doc/, COPYING and COPYING3. Original source is included at ${marker.source}; source/xpdf-windows-paths.patch, build-pdf.mjs, BUILD-INFO.json and KCODER-MODIFICATIONS.txt describe and reproduce the actual modified component.\nChinese data: retain each README and CMap/LICENSE.md.\nInvoke with cwd set to this pdf directory and -cfg xpdfrc -enc UTF-8.\nPinned official archives and hashes:\n${Object.values(PDF_ASSETS).map(asset => `${asset.url}\nSHA256 ${asset.sha256}`).join('\n')}\n`);
  await permissions(fresh);
  return { fresh, executableSha256: built.metadata.executableSha256, buildFingerprint: built.metadata.fingerprint, cacheHit: built.cacheHit };
}
export async function preparePdf({ destination, cache = join(repository, 'target/cache/xpdf'), archives = {}, archiveDirectory, offline = false, renamePath = rename } = {}) {
  if (!destination) throw new Error('A dedicated pdf destination is required');
  if (archiveDirectory) {
    await noLinks(resolve(archiveDirectory));
    archives = { ...Object.fromEntries(Object.entries(PDF_ASSETS).map(([key, asset]) => [key, join(resolve(archiveDirectory), asset.name)])), ...archives };
  }
  if (Object.keys(archives).some(key => !Object.hasOwn(PDF_ASSETS, key))) throw new Error('Unknown PDF archive option');
  const output = resolve(destination), cacheRoot = resolve(cache), parent = dirname(output);
  if (basename(output) !== 'pdf' || parent === parse(output).root || output === cacheRoot || output.startsWith(cacheRoot + sep) || cacheRoot.startsWith(output + sep)) throw new Error('PDF requires a dedicated non-overlapping destination ending in pdf');
  await noLinks(output); await noLinks(cacheRoot); await mkdir(parent, { recursive: true });
  const lock = join(parent, '.kcoder-pdf.lock'), journal = join(parent, '.kcoder-pdf-recovery.json');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new Error('PDF preparation is locked; do not remove a live preparation lock'); throw error; }
  let stage, retain = false;
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, destination: output }), { mode: 0o600, flag: 'wx' });
    await recover(output, journal, renamePath);
    const initial = await owned(output);
    await mkdir(cacheRoot, { recursive: true });
    stage = await mkdtemp(join(parent, '.pdf-stage-')); await chmod(stage, 0o700);
    const nonce = randomUUID(); await writeDurableJson(join(stage, STAGE_MARKER), { output, nonce });
    const verified = {};
    for (const [key, asset] of Object.entries(PDF_ASSETS)) {
      const local = join(stage, asset.name), cached = join(cacheRoot, `${asset.name}.${asset.sha256}`);
      if (archives[key]) { await regular(resolve(archives[key])); await copyFile(resolve(archives[key]), local); }
      else if (await exists(cached)) { await regular(cached); await copyFile(cached, local); }
      else { if (offline) throw new Error(`Pinned ${key} archive is absent from the offline cache`); await download(asset.url, local); }
      await verifyPdfHash(local, asset.sha256); verified[key] = local;
      if (!(await exists(cached))) {
        const temporary = await mkdtemp(join(cacheRoot, '.pdf-cache-'));
        try { const candidate = join(temporary, 'archive'); await copyFile(local, candidate); await verifyPdfHash(candidate, asset.sha256); await rename(candidate, cached); }
        finally { await rm(temporary, { recursive: true, force: true }); }
      }
    }
    const assembled = await build(verified, stage, cacheRoot);
    const fresh = assembled.fresh;
    const current = await owned(output);
    if (Boolean(initial) !== Boolean(current) || (initial && (initial.dev !== current.dev || initial.ino !== current.ino))) throw new Error('PDF destination changed during preparation');
    await writeDurableJson(journal, { version: 1, output, stage: basename(stage), nonce });
    try {
      if (current) await renamePath(output, join(stage, 'previous'));
      await renamePath(fresh, output);
    }
    catch (error) {
      if (current) {
        try { await recover(output, journal, renamePath); stage = undefined; }
        catch { retain = true; throw new Error(`PDF replacement failed and needs recovery; previous resources retained in ${basename(stage)}`); }
      } else { await rm(journal); }
      throw error;
    }
    await rm(stage, { recursive: true }); stage = undefined; await rm(journal);
    return { directory: output, executable: join(output, 'pdftotext.exe'), config: join(output, 'xpdfrc'), cwd: output, vendor: 'xpdf', version: PDF_VERSION, variant: XPDF_VARIANT, platform: 'win64', executableSha256: assembled.executableSha256, buildFingerprint: assembled.buildFingerprint, buildCacheHit: assembled.cacheHit, source: join(output, 'source', PDF_ASSETS.source.name) };
  } finally {
    if (stage && !retain) await rm(stage, { recursive: true, force: true });
    await rm(join(lock, 'owner.json'), { force: true }); await rmdir(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { archives: {} };
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const flag = process.argv[i];
      if (flag === '--offline') { options.offline = true; continue; }
      const key = { '--dest': 'destination', '--cache': 'cache', '--archive-dir': 'archiveDirectory', '--tools-archive': 'tools', '--source-archive': 'source', '--simplified-archive': 'simplified', '--traditional-archive': 'traditional' }[flag];
      const value = process.argv[++i];
      if (!key || !value || value.startsWith('--')) throw new Error('Usage: prepare-pdf.mjs --dest PATH/pdf [--cache PATH] [--archive-dir DIR] [--offline] [--tools-archive ZIP --source-archive TAR.GZ --simplified-archive TAR.GZ --traditional-archive TAR.GZ]');
      if (Object.hasOwn(PDF_ASSETS, key)) options.archives[key] = value; else options[key] = value;
    }
    console.log(JSON.stringify(await preparePdf(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
