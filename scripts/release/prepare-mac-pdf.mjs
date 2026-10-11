// Native Intel macOS pdftotext, rebuilt from the already pinned Xpdf source.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PDF_ASSETS, PDF_CONFIGURATION, PDF_VERSION, verifyPdfHash } from './prepare-pdf.mjs';
import { compilerMetadata } from './build-pdf.mjs';
import { extractPdfEntries, readPdfTarGz } from './pdf-archive.mjs';
import { assertMacX64Executable, macExecutableMetadata, validateMacSystemLibraries } from './mac-executable.mjs';

const run = promisify(execFile), here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..'), marker = '.kcoder-pdf.json';
const keys = ['source', 'simplified', 'traditional'];
const recipes = ['prepare-mac-pdf.mjs', 'prepare-pdf.mjs', 'build-pdf.mjs', 'pdf-archive.mjs', 'chrome-archive.mjs', 'mac-chrome-links.mjs', 'mac-executable.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const variant = '4.06-kcoder-macos.1';
async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function noLinks(path) {
  for (let current = resolve(path);; current = dirname(current)) {
    if ((await exists(current))?.isSymbolicLink()) throw new Error('macOS PDF resource path traverses a symlink');
    if (current === dirname(current)) return;
  }
}
async function owned(path) {
  const info = await exists(path);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('macOS PDF destination must be a directory');
  const tag = JSON.parse(await readFile(join(path, marker), 'utf8'));
  if (tag.schema !== 'kcoder.pdf-resource.v1' || tag.platform !== 'mac-x64') throw new Error('Refusing to replace unowned macOS PDF resources');
  return info;
}
async function invoke(command, args, work, log, env) {
  try {
    const result = await run(command, args, { env, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
    await writeFile(join(work, log), result.stdout + result.stderr);
    return result.stdout;
  } catch (error) {
    await writeFile(join(work, log), String(error.stdout ?? '') + String(error.stderr ?? ''));
    throw new Error(`Native macOS PDF build failed; inspect ${join(work, log)}`);
  }
}
async function permissions(root) {
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await permissions(path);
    else if (entry.isFile()) await chmod(path, entry.name === 'pdftotext' ? 0o755 : 0o644);
    else throw new Error('macOS PDF resources contain a non-regular entry');
  }
}
export async function prepareMacPdf({ destination, cache = join(repository, 'target/cache/xpdf'), archiveDirectory,
  env = process.env, offline = false, renamePath = rename } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'x64') throw new Error('Native Intel macOS PDF build host required');
  if (!destination) throw new Error('Dedicated macOS PDF destination required');
  const output = resolve(destination), cacheRoot = resolve(cache), parent = dirname(output);
  if (basename(output) !== 'pdf' || parent === parse(output).root || output === cacheRoot || output.startsWith(cacheRoot + sep) || cacheRoot.startsWith(output + sep)) throw new Error('Dedicated non-overlapping pdf resource destination required');
  await noLinks(output); await noLinks(cacheRoot); if (archiveDirectory) await noLinks(archiveDirectory);
  await mkdir(parent, { recursive: true }); await mkdir(cacheRoot, { recursive: true });
  const initial = await owned(output), lock = join(parent, '.kcoder-mac-pdf.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new Error('Native macOS PDF preparation already locked'); throw error; }
  let stage, retain = false;
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, output }), { flag: 'wx', mode: 0o600 });
    stage = await mkdtemp(join(parent, '.mac-pdf-stage-'));
    const archives = {};
    for (const key of keys) {
      const asset = PDF_ASSETS[key], local = join(stage, asset.name), cached = join(cacheRoot, `${asset.name}.${asset.sha256}`);
      if (archiveDirectory) await copyFile(join(resolve(archiveDirectory), asset.name), local);
      else if (await exists(cached)) await copyFile(cached, local);
      else {
        if (offline) throw new Error(`Pinned ${key} archive unavailable offline`);
        await invoke('curl', ['--disable', '--fail', '--silent', '--show-error', '--proto', '=https', '--max-redirs', '0', '--connect-timeout', '30', '--max-time', '180', '--max-filesize', String(64 * 1024 * 1024), '--output', local, asset.url], stage, `download-${key}.log`, env);
      }
      await verifyPdfHash(local, asset.sha256); archives[key] = local;
      if (!(await exists(cached))) {
        const temporary = await mkdtemp(join(cacheRoot, '.mac-pdf-cache-'));
        try { await copyFile(local, join(temporary, 'archive')); await verifyPdfHash(join(temporary, 'archive'), asset.sha256); await rename(join(temporary, 'archive'), cached); }
        finally { await rm(temporary, { recursive: true, force: true }); }
      }
    }
    const unpack = join(stage, 'unpack'); await mkdir(unpack);
    await extractPdfEntries(readPdfTarGz(await readFile(archives.source), 'xpdf-4.06'), unpack);
    for (const key of ['simplified', 'traditional']) await extractPdfEntries(readPdfTarGz(await readFile(archives[key]), `xpdf-chinese-${key}`), unpack);
    const sourceRoot = join(unpack, 'xpdf-4.06'), build = join(stage, 'build'), cmake = env.KCODER_PDF_CMAKE || 'cmake';
    const sdk = (await invoke('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], stage, 'sdk-path.log', env)).trim();
    if (!sdk.startsWith('/') || /[\"\n\r]/.test(sdk) || !(await lstat(join(sdk, 'usr/include/c++/v1/atomic'))).isFile()) throw new Error('Apple SDK libc++ headers unavailable');
    const arguments_ = ['-S', sourceRoot, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_ARCHITECTURES=x86_64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=15.7',
      '-DCMAKE_C_COMPILER=/usr/bin/clang', '-DCMAKE_CXX_COMPILER=/usr/bin/clang++', `-DCMAKE_CXX_FLAGS=-isystem "${join(sdk, 'usr/include/c++/v1')}"`, '-DMULTITHREADED=OFF', '-DNO_FONTCONFIG=ON',
      '-DCMAKE_DISABLE_FIND_PACKAGE_Qt6Widgets=ON', '-DCMAKE_DISABLE_FIND_PACKAGE_Qt5Widgets=ON', '-DCMAKE_DISABLE_FIND_PACKAGE_PNG=ON', '-DCMAKE_DISABLE_FIND_PACKAGE_ZLIB=ON',
      '-DFREETYPE_INCLUDE_DIR_ft2build=', '-DFREETYPE_INCLUDE_DIR_freetype=', '-DFREETYPE_INCLUDE_DIR_freetype_freetype=', '-DFREETYPE_LIBRARY=', '-DPAPER_LIBRARY=', '-DLCMS_LIBRARY='];
    const sdkVersion = (await invoke('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], stage, 'sdk-version.log', env)).trim();
    const sdkSettingsSha256 = digest(await readFile(join(sdk, 'SDKSettings.json')));
    const cmakeVersion = (await invoke(cmake, ['--version'], stage, 'cmake-version.log', env)).split(/\r?\n/)[0];
    await invoke(cmake, arguments_, stage, 'configure.log', env);
    const compiler = await compilerMetadata(build);
    if (compiler.id !== 'AppleClang') throw new Error('Native macOS PDF build requires AppleClang');
    const recipeHashes = {};
    for (const name of recipes) recipeHashes[name] = digest(await readFile(join(here, name)));
    const inputs = { platform: 'mac-x64', variant, archives: Object.fromEntries(keys.map(key => [key, PDF_ASSETS[key].sha256])), cmakeVersion, compiler, sdkVersion, sdkSettingsSha256,
      recipes: recipeHashes, options: arguments_.slice(4) };
    const fingerprint = digest(Buffer.from(JSON.stringify(inputs))), cachedBuild = join(cacheRoot, `xpdf-mac-build-${fingerprint}`);
    let built, cacheHit = false;
    if (await exists(cachedBuild)) {
      await noLinks(cachedBuild); built = JSON.parse(await readFile(join(cachedBuild, 'build.json'), 'utf8'));
      if (built.fingerprint !== fingerprint || digest(Buffer.from(JSON.stringify(built.inputs))) !== fingerprint || digest(await readFile(join(cachedBuild, 'pdftotext'))) !== built.executableSha256) throw new Error('Native PDF build cache verification failed');
      cacheHit = true;
    } else {
      await invoke(cmake, ['--build', build, '--target', 'pdftotext', '--parallel', '8'], stage, 'build.log', env);
      const executable = join(build, 'xpdf/pdftotext'); await assertMacX64Executable(executable);
      const libraries = validateMacSystemLibraries(await invoke('/usr/bin/otool', ['-L', executable], stage, 'libraries.log', env));
      built = { executableMetadata: await macExecutableMetadata(executable), schema: 'kcoder.xpdf-mac-build.v1', fingerprint, inputs, executableSha256: digest(await readFile(executable)), libraries };
      const temporary = await mkdtemp(join(cacheRoot, '.mac-pdf-build-'));
      try { await copyFile(executable, join(temporary, 'pdftotext')); await writeFile(join(temporary, 'build.json'), JSON.stringify(built, null, 2) + '\n'); await rename(temporary, cachedBuild); }
      catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
    }
    const fresh = join(stage, 'fresh'); await mkdir(fresh);
    await copyFile(join(cachedBuild, 'pdftotext'), join(fresh, 'pdftotext')); await assertMacX64Executable(join(fresh, 'pdftotext'));
    for (const name of ['README', 'COPYING', 'COPYING3']) await copyFile(join(sourceRoot, name), join(fresh, name));
    await cp(join(sourceRoot, 'doc'), join(fresh, 'doc'), { recursive: true });
    for (const key of ['simplified', 'traditional']) await cp(join(unpack, `xpdf-chinese-${key}`), join(fresh, 'data', `chinese-${key}`), { recursive: true });
    const sources = join(fresh, 'source'); await mkdir(sources);
    await copyFile(archives.source, join(sources, PDF_ASSETS.source.name));
    for (const name of recipes) await copyFile(join(here, name), join(sources, name));
    await copyFile(join(here, 'xpdf-windows-paths.patch'), join(sources, 'xpdf-windows-paths.patch'));
    await copyFile(join(here, 'pdf-runtime-licenses/MIT.txt'), join(sources, 'BUILD-RECIPE-LICENSE.txt'));
    await writeFile(join(sources, 'BUILD-INFO.json'), JSON.stringify(built, null, 2) + '\n');
    await writeFile(join(fresh, 'xpdfrc'), PDF_CONFIGURATION);
    const tag = { schema: 'kcoder.pdf-resource.v1', vendor: 'xpdf', version: PDF_VERSION, variant, platform: 'mac-x64', executableSha256: built.executableSha256,
      buildFingerprint: fingerprint, executableMetadata: built.executableMetadata, upstreamLicense: 'GPL-2.0-only OR GPL-3.0-only', buildRecipeLicense: 'MIT', source: `source/${PDF_ASSETS.source.name}`, configuration: { file: 'xpdfrc', cwd: 'pdf', paths: 'relative-to-process-cwd' } };
    await writeFile(join(fresh, marker), JSON.stringify(tag, null, 2) + '\n');
    await writeFile(join(fresh, 'KCODER-PDF-NOTICE.txt'), `Xpdf ${PDF_VERSION}, native macOS Intel build by KCoder (${variant}). Only pdftotext is built; upstream source is unmodified.\nXpdf: GPL v2 or GPL v3, retain COPYING and COPYING3; this does not relicense KCoder. Build recipe: MIT.\nComplete original source: ${tag.source}. Build inputs, compiler hash, source hashes, system-only libraries and recipe hashes: source/BUILD-INFO.json.\nRebuild on native Intel macOS with Apple Command Line Tools and CMake: node source/prepare-mac-pdf.mjs --dest /absolute/output/pdf --cache /absolute/cache --archive-dir /directory/with/three/official/source-and-Chinese-data-archives.\nChinese character maps retain their original README and CMap/LICENSE.md. Invoke with this directory as cwd and -cfg xpdfrc -enc UTF-8. No OCR.\n${keys.map(key => `${PDF_ASSETS[key].url}\nSHA256 ${PDF_ASSETS[key].sha256}`).join('\n')}\n`);
    await permissions(fresh);
    const current = await owned(output);
    if (Boolean(initial) !== Boolean(current) || initial && (initial.dev !== current.dev || initial.ino !== current.ino)) throw new Error('macOS PDF destination changed during preparation');
    const backup = join(stage, 'previous'); if (current) await renamePath(output, backup);
    try { await renamePath(fresh, output); }
    catch (error) {
      if (current) try { await renamePath(backup, output); } catch { retain = true; throw new Error(`macOS PDF restore failed; previous resources preserved in ${stage}`); }
      throw error;
    }
    return { directory: output, executable: join(output, 'pdftotext'), config: join(output, 'xpdfrc'), cwd: output, platform: 'mac-x64', executableSha256: built.executableSha256, buildFingerprint: fingerprint, cacheHit };
  } catch (error) {
    if (stage && !retain) { retain = true; throw new Error(`${error.message}; owned diagnostic work retained at ${stage}`); }
    throw error;
  } finally {
    if (stage && !retain) await rm(stage, { recursive: true, force: true });
    await rm(join(lock, 'owner.json'), { force: true }); await rmdir(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) { const key = { '--dest': 'destination', '--cache': 'cache', '--archive-dir': 'archiveDirectory' }[process.argv[i]]; if (!key || !process.argv[i + 1]) throw new Error('Usage: prepare-mac-pdf.mjs --dest /path/pdf [--cache PATH] [--archive-dir PATH]'); options[key] = process.argv[i + 1]; }
    console.log(JSON.stringify(await prepareMacPdf(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
