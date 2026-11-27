// Pinned static FreeType/libpng/zlib for the Xpdf pdftopng page renderer.
// Every archive is SHA-256 verified before extraction; builds stay inside the
// caller's owned work directory and install only into its private prefix.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { extractPdfEntries, readPdfTarGz } from './pdf-archive.mjs';

const run = promisify(execFile);
const LIMIT = 64 * 1024 * 1024;
// Official release archives. Mirrors may redirect, so integrity comes from the
// pinned SHA-256 (cross-checked against a second official mirror when pinned).
export const PDF_RENDER_ASSETS = Object.freeze(Object.fromEntries(Object.entries({
  zlib: ['zlib-1.3.2.tar.gz', 'bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16', 'https://zlib.net/fossils/zlib-1.3.2.tar.gz', 'Zlib', ['LICENSE']],
  libpng: ['libpng-1.6.59.tar.gz', '86a3e4b501f7f50e392c4e456ea158893e9a595b1c63eb88c7bb9f6cf8772dad', 'https://download.sourceforge.net/libpng/libpng-1.6.59.tar.gz', 'libpng-2.0', ['LICENSE']],
  freetype: ['freetype-2.14.3.tar.gz', 'e61b31ab26358b946e767ed7eb7f4bb2e507da1cfefeb7a8861ace7fd5c899a1', 'https://download.savannah.gnu.org/releases/freetype/freetype-2.14.3.tar.gz', 'FTL OR GPL-2.0-or-later', ['LICENSE.TXT', 'docs/FTL.TXT', 'docs/GPLv2.TXT']],
}).map(([key, [name, sha256, url, license, notices]]) => [key, Object.freeze({ name, sha256, url, root: name.replace(/\.tar\.gz$/, ''), license, notices: Object.freeze(notices) })])));
export const PDF_RENDER_KEYS = Object.freeze(['zlib', 'libpng', 'freetype']);
const LIBRARIES = Object.freeze({
  zlib: ['libz.a', 'libzs.a', 'zs.lib', 'z.lib', 'zlibstatic.lib'],
  libpng: ['libpng16.a', 'libpng16_static.lib', 'png16.lib'],
  freetype: ['libfreetype.a', 'freetype.lib'],
});

async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT) throw new Error('PDF renderer dependency must be a bounded regular file');
  return info;
}
export async function verifyRenderHash(path, expected) {
  await regular(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error(`PDF renderer dependency SHA-256 mismatch: ${basename(path)}; existing resources were not changed`);
}
/** Download argv: HTTPS only, including redirects; no shell. */
export function renderDownloadArgs(url, output) {
  if (!url.startsWith('https://')) throw new Error('PDF renderer dependency URLs must use HTTPS');
  return ['--disable', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '5',
    '--connect-timeout', '30', '--max-time', '300', '--max-filesize', String(LIMIT), '--output', output, url];
}
async function download(url, output) {
  try { await run(process.platform === 'win32' ? 'curl.exe' : 'curl', renderDownloadArgs(url, output), { timeout: 310000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error('Official PDF renderer dependency download failed; use the pinned offline archive options'); }
}
/**
 * Resolve each pinned archive into the owned stage: explicit path, then the
 * archive directory, then the verified cache, then an HTTPS download.
 */
export async function fetchPdfRenderAssets({ stage, cacheRoot, archiveDirectory, archives = {}, offline = false, assets = PDF_RENDER_ASSETS, fetch = download }) {
  const verified = {};
  for (const [key, asset] of Object.entries(assets)) {
    const local = join(stage, asset.name), cached = join(cacheRoot, `${asset.name}.${asset.sha256}`);
    const offered = archiveDirectory ? join(resolve(archiveDirectory), asset.name) : null;
    if (archives[key]) { await regular(resolve(archives[key])); await copyFile(resolve(archives[key]), local); }
    else if (offered && await exists(offered)) { await regular(offered); await copyFile(offered, local); }
    else if (await exists(cached)) { await regular(cached); await copyFile(cached, local); }
    else { if (offline) throw new Error(`Pinned ${key} renderer archive is absent from the offline cache`); await fetch(asset.url, local); }
    await verifyRenderHash(local, asset.sha256); verified[key] = local;
    if (!(await exists(cached))) {
      const temporary = await mkdtemp(join(cacheRoot, '.pdf-render-cache-'));
      try { const candidate = join(temporary, 'archive'); await copyFile(local, candidate); await verifyRenderHash(candidate, asset.sha256); await rename(candidate, cached); }
      finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }
  return verified;
}
/** CMake configure arguments for each dependency, in build order. */
export function renderDependencyPlan({ sources, builds, prefix, toolchain = [] }) {
  const common = ['-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_INSTALL_PREFIX=${prefix}`, '-DCMAKE_INSTALL_LIBDIR=lib', '-DBUILD_SHARED_LIBS=OFF',
    '-DCMAKE_POSITION_INDEPENDENT_CODE=ON', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', ...toolchain];
  const specific = {
    zlib: () => ['-DZLIB_BUILD_TESTING=OFF', '-DZLIB_BUILD_SHARED=OFF', '-DZLIB_BUILD_STATIC=ON'],
    libpng: libraries => ['-DPNG_SHARED=OFF', '-DPNG_STATIC=ON', '-DPNG_TESTS=OFF', '-DPNG_TOOLS=OFF', '-DPNG_FRAMEWORK=OFF',
      `-DZLIB_ROOT=${prefix}`, `-DZLIB_INCLUDE_DIR=${join(prefix, 'include')}`, `-DZLIB_LIBRARY=${libraries.zlib}`, `-DZLIB_LIBRARY_RELEASE=${libraries.zlib}`],
    freetype: () => ['-DFT_DISABLE_ZLIB=TRUE', '-DFT_DISABLE_BZIP2=TRUE', '-DFT_DISABLE_PNG=TRUE', '-DFT_DISABLE_HARFBUZZ=TRUE', '-DFT_DISABLE_BROTLI=TRUE'],
  };
  return PDF_RENDER_KEYS.map(key => ({ key, configure: libraries => ['-S', join(sources, PDF_RENDER_ASSETS[key].root), '-B', join(builds, key), ...common, ...specific[key](libraries)] }));
}
export async function resolveRenderLibrary(prefix, key) {
  for (const name of LIBRARIES[key]) {
    const path = join(prefix, 'lib', name), info = await exists(path);
    if (info?.isFile() && !info.isSymbolicLink()) return path;
  }
  throw new Error(`Static ${key} library is missing after its install step`);
}
/**
 * Build the three static libraries with the caller's toolchain. `invoke`
 * runs one argv command and writes its log; it must throw on failure.
 */
export async function buildPdfRenderDependencies({ archives, work, cmake, toolchain = [], invoke }) {
  const sources = join(work, 'render-sources'), builds = join(work, 'render-deps'), prefix = join(work, 'render-prefix');
  for (const directory of [sources, builds, prefix]) await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const key of PDF_RENDER_KEYS) {
    const asset = PDF_RENDER_ASSETS[key];
    await verifyRenderHash(archives[key], asset.sha256);
    await extractPdfEntries(readPdfTarGz(await readFile(archives[key]), asset.root), sources);
  }
  const libraries = {};
  for (const { key, configure } of renderDependencyPlan({ sources, builds, prefix, toolchain })) {
    await invoke(cmake, configure(libraries), `pdf-render-${key}-configure.log`);
    await invoke(cmake, ['--build', join(builds, key), '--config', 'Release', '--parallel', '8'], `pdf-render-${key}-build.log`);
    await invoke(cmake, ['--install', join(builds, key), '--config', 'Release'], `pdf-render-${key}-install.log`);
    libraries[key] = await resolveRenderLibrary(prefix, key);
  }
  return { prefix, libraries };
}
/** Xpdf configure arguments that enable Splash, FreeType and PNG for pdftopng. */
export function xpdfRenderArgs({ prefix, libraries }) {
  const include = join(prefix, 'include'), freetype = join(include, 'freetype2');
  return [`-DFREETYPE_INCLUDE_DIR_ft2build=${freetype}`, `-DFREETYPE_INCLUDE_DIR_freetype=${freetype}`, `-DFREETYPE_INCLUDE_DIR_freetype_freetype=${freetype}`, `-DFREETYPE_LIBRARY=${libraries.freetype}`,
    `-DPNG_PNG_INCLUDE_DIR=${include}`, `-DPNG_LIBRARY=${libraries.libpng}`, `-DPNG_LIBRARY_RELEASE=${libraries.libpng}`,
    `-DZLIB_INCLUDE_DIR=${include}`, `-DZLIB_LIBRARY=${libraries.zlib}`, `-DZLIB_LIBRARY_RELEASE=${libraries.zlib}`,
    '-DCMAKE_DISABLE_FIND_PACKAGE_Qt6Widgets=ON', '-DCMAKE_DISABLE_FIND_PACKAGE_Qt5Widgets=ON', '-DPAPER_LIBRARY=', '-DLCMS_LIBRARY='];
}
/** Stable fingerprint form of renderer options: private build paths removed. */
export function normalizedRenderOptions(options, work) {
  return options.map(option => option.split(work).join('<work>'));
}
export function renderDependencyInputs() {
  return Object.fromEntries(PDF_RENDER_KEYS.map(key => [key, { name: PDF_RENDER_ASSETS[key].name, sha256: PDF_RENDER_ASSETS[key].sha256, license: PDF_RENDER_ASSETS[key].license }]));
}
/** Copy each verified source archive and its upstream license notices. */
export async function includeRenderDependencyMaterials({ archives, sourceDirectory, licenseDirectory }) {
  for (const key of PDF_RENDER_KEYS) {
    const asset = PDF_RENDER_ASSETS[key];
    await verifyRenderHash(archives[key], asset.sha256);
    await copyFile(archives[key], join(sourceDirectory, asset.name));
    const entries = readPdfTarGz(await readFile(archives[key]), asset.root);
    const target = join(licenseDirectory, asset.root); await mkdir(target, { recursive: true });
    for (const notice of asset.notices) {
      const entry = entries.find(item => item.name === `${asset.root}/${notice}` && !item.directory);
      if (!entry || !entry.data.length) throw new Error(`PDF renderer dependency notice is missing: ${asset.root}/${notice}`);
      await writeFile(join(target, basename(notice)), entry.data, { flag: 'wx' });
    }
  }
}
export function renderDependencyNotice() {
  return PDF_RENDER_KEYS.map(key => { const asset = PDF_RENDER_ASSETS[key]; return `${asset.root} (${asset.license}): ${asset.url}\nSHA256 ${asset.sha256}`; }).join('\n');
}
