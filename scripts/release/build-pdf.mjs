// Rebuild the GPL Xpdf component; never download a private/prebuilt replacement.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractPdfEntries, readPdfTarGz } from './pdf-archive.mjs';
const run = promisify(execFile), here = dirname(fileURLToPath(import.meta.url));
export const XPDF_PATCH_SHA256 = 'f70cd61035980ab94523b975de523252b783a708b2e403660e0f83d52e54ca53';
export const XPDF_SOURCE_SHA256 = '1c38f527c46caee0f712386d42a885b96a31ed9ce11904e872559859894d137e';
export const XPDF_VARIANT = '4.06-kcoder.1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const names = new Set(['CMakeLists.txt', 'goo/gfile.cc', 'xpdf/PDFDoc.cc', 'xpdf/CMakeLists.txt', 'xpdf/winLongPath.rc.in']);
async function plain(path, limit = 64 * 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Invalid PDF build input');
  return readFile(path);
}
export async function applyXpdfPatch(root, patch) {
  if (digest(patch) !== XPDF_PATCH_SHA256) throw new Error('Xpdf patch SHA-256 mismatch');
  const lines = patch.toString('utf8').split('\n');
  const changed = new Set();
  for (let i = 0; i < lines.length;) {
    if (!lines[i]) { i++; continue; }
    const original = /^--- a\/(.+)$/.exec(lines[i++]);
    const next = /^\+\+\+ b\/(.+)$/.exec(lines[i++]);
    if (!original || !next || original[1] !== next[1] || !names.has(next[1]) || changed.has(next[1])) throw new Error('Unsupported Xpdf patch path');
    const path = join(root, next[1]); changed.add(next[1]);
    let text;
    try { text = (await plain(path)).toString('utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; text = ''; }
    const source = text ? text.replace(/\n$/, '').split('\n') : [], output = [];
    let position = 0;
    while (i < lines.length && lines[i].startsWith('@@')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i++]);
      if (!hunk) throw new Error('Invalid Xpdf patch hunk');
      const start = Math.max(0, Number(hunk[1]) - 1), oldCount = Number(hunk[2] ?? 1), newCount = Number(hunk[4] ?? 1);
      if (start < position || start > source.length) throw new Error('Invalid Xpdf patch range');
      output.push(...source.slice(position, start)); position = start;
      let oldLines = 0, newLines = 0;
      while (i < lines.length && /^[ +\-]/.test(lines[i]) && !lines[i].startsWith('--- a/')) {
        const line = lines[i++], value = line.slice(1);
        if (line[0] !== '+') { if (source[position++] !== value) throw new Error('Xpdf source differs from patch context'); oldLines++; }
        if (line[0] !== '-') { output.push(value); newLines++; }
      }
      if (oldLines !== oldCount || newLines !== newCount) throw new Error('Xpdf patch hunk count mismatch');
    }
    output.push(...source.slice(position));
    await writeFile(path, output.join('\n') + '\n');
  }
  if (changed.size !== names.size) throw new Error('Incomplete Xpdf source patch');
}
export function pdfPeImports(bytes) {
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : bytes.length;
  if (pe + 264 > bytes.length || bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b) throw new Error('PDF build must be x64 PE32+');
  const optional = pe + 24, table = optional + bytes.readUInt16LE(pe + 20), count = bytes.readUInt16LE(pe + 6);
  const at = rva => {
    for (let i = 0; i < count; i++) {
      const p = table + i * 40;
      if (p + 40 > bytes.length) break;
      const start = bytes.readUInt32LE(p + 12), size = bytes.readUInt32LE(p + 16);
      if (rva >= start && rva < start + size) { const offset = bytes.readUInt32LE(p + 20) + rva - start; if (offset < bytes.length) return offset; }
    }
    throw new Error('Invalid PDF PE import address');
  };
  if (bytes.readUInt32LE(optional + 112 + 13 * 8)) throw new Error('PDF delayed imports require separate review');
  const imports = [], rva = bytes.readUInt32LE(optional + 120);
  if (!rva) throw new Error('PDF PE import directory is missing');
  for (let p = at(rva), n = 0; n < 128; n++, p += 20) {
    if (p + 20 > bytes.length) throw new Error('Truncated PDF PE imports');
    const name = bytes.readUInt32LE(p + 12);
    if (!name) return imports;
    const start = at(name), end = bytes.indexOf(0, start);
    if (end < start || end - start > 128) throw new Error('Invalid PDF imported DLL');
    const dll = bytes.toString('ascii', start, end);
    if (!/^(kernel32|shell32|ole32|oleaut32|advapi32|user32|gdi32|msvcrt|ucrtbase|ntdll|bcrypt|ws2_32|secur32|crypt32|version|shlwapi|rpcrt4|comdlg32|comctl32)\.dll$/i.test(dll) && !/^api-ms-win-[a-z0-9-]+\.dll$/i.test(dll)) throw new Error(`PDF build has an unbundled/non-system runtime dependency: ${dll}`);
    imports.push(dll);
  }
  throw new Error('Too many PDF imports');
}
async function invoke(program, args, log, env) {
  try {
    const result = await run(program, args, { env, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
    await writeFile(log, result.stdout + result.stderr);
    return result.stdout;
  } catch (error) {
    await writeFile(log, String(error.stdout ?? '') + String(error.stderr ?? ''));
    throw new Error(`PDF source build failed; inspect ${log}; provide KCODER_PDF_CMAKE/CC/CXX/TOOLCHAIN for an offline toolchain`);
  }
}
async function compilerMetadata(build) {
  const candidates = await readdir(join(build, 'CMakeFiles'));
  for (const entry of candidates) {
    if (!/^\d+\.\d+/.test(entry)) continue;
    try {
      const text = (await plain(join(build, 'CMakeFiles', entry, 'CMakeCXXCompiler.cmake'), 64 * 1024)).toString('utf8');
      const get = key => new RegExp(`set\\(${key} "([^"]+)"\\)`).exec(text)?.[1];
      const executable = get('CMAKE_CXX_COMPILER');
      if (!executable) continue;
      // Compiler aliases are normal toolchain installation entries, not archive resources.
      return { id: get('CMAKE_CXX_COMPILER_ID'), version: get('CMAKE_CXX_COMPILER_VERSION'), executable: basename(executable), sha256: digest(await readFile(executable)) };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('CMake did not identify the PDF C++ compiler');
}
export async function buildPdf({ sourceArchive, workDirectory, cache, env = process.env }) {
  const source = await plain(sourceArchive);
  if (digest(source) !== XPDF_SOURCE_SHA256) throw new Error('Xpdf source SHA-256 mismatch');
  const patch = await plain(join(here, 'xpdf-windows-paths.patch'), 1024 * 1024);
  const work = join(workDirectory, 'source-build'); await mkdir(work, { mode: 0o700 });
  await extractPdfEntries(readPdfTarGz(source, 'xpdf-4.06'), work);
  const sourceRoot = join(work, 'xpdf-4.06'); await applyXpdfPatch(sourceRoot, patch);
  const build = join(work, 'build'), cmake = env.KCODER_PDF_CMAKE || 'cmake';
  const args = ['-S', sourceRoot, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DMULTITHREADED=OFF', '-DNO_FONTCONFIG=ON',
    '-DCMAKE_DISABLE_FIND_PACKAGE_Qt6Widgets=ON', '-DCMAKE_DISABLE_FIND_PACKAGE_Qt5Widgets=ON',
    '-DCMAKE_DISABLE_FIND_PACKAGE_PNG=ON', '-DCMAKE_DISABLE_FIND_PACKAGE_ZLIB=ON',
    '-DFREETYPE_INCLUDE_DIR_ft2build=', '-DFREETYPE_INCLUDE_DIR_freetype=', '-DFREETYPE_INCLUDE_DIR_freetype_freetype=', '-DFREETYPE_LIBRARY=', '-DPAPER_LIBRARY=', '-DLCMS_LIBRARY='];
  let toolchain = null;
  if (env.KCODER_PDF_TOOLCHAIN) { const path = resolve(env.KCODER_PDF_TOOLCHAIN); toolchain = digest(await readFile(path)); args.push(`-DCMAKE_TOOLCHAIN_FILE=${path}`); }
  else if (process.platform !== 'win32') args.push('-DCMAKE_SYSTEM_NAME=Windows', '-DCMAKE_SYSTEM_PROCESSOR=x86_64');
  if (env.KCODER_PDF_CC || (process.platform !== 'win32' && !toolchain)) args.push(`-DCMAKE_C_COMPILER=${env.KCODER_PDF_CC || 'x86_64-w64-mingw32-gcc'}`);
  if (env.KCODER_PDF_CXX || (process.platform !== 'win32' && !toolchain)) args.push(`-DCMAKE_CXX_COMPILER=${env.KCODER_PDF_CXX || 'x86_64-w64-mingw32-g++'}`);
  if (env.KCODER_PDF_RC) args.push(`-DCMAKE_RC_COMPILER=${env.KCODER_PDF_RC}`);
  const cmakeVersion = (await invoke(cmake, ['--version'], join(workDirectory, 'pdf-cmake-version.log'), env)).split(/\r?\n/)[0].trim();
  await invoke(cmake, args, join(workDirectory, 'pdf-configure.log'), env);
  const compiler = await compilerMetadata(build);
  if (!['GNU', 'MSVC'].includes(compiler.id)) throw new Error('PDF toolchain must be reviewed MinGW GCC or MSVC');
  const recipes = {};
  for (const name of ['build-pdf.mjs', 'pdf-archive.mjs', 'chrome-archive.mjs']) recipes[name] = digest(await readFile(join(here, name)));
  const inputs = { variant: XPDF_VARIANT, source: XPDF_SOURCE_SHA256, patch: XPDF_PATCH_SHA256, compiler, cmakeVersion, recipes, toolchain };
  const fingerprint = digest(Buffer.from(JSON.stringify(inputs))), destination = join(cache, `xpdf-build-${fingerprint}`);
  async function readCache() {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unowned PDF build cache');
    const marker = JSON.parse((await plain(join(destination, 'build.json'), 64 * 1024)).toString('utf8'));
    const executable = join(destination, 'pdftotext.exe'), bytes = await plain(executable);
    if (marker.schema !== 'kcoder.xpdf-build.v1' || marker.fingerprint !== fingerprint || digest(Buffer.from(JSON.stringify(marker.inputs))) !== fingerprint || digest(bytes) !== marker.executableSha256) throw new Error('PDF build cache verification failed');
    pdfPeImports(bytes);
    return { executable, metadata: marker, cacheHit: true };
  }
  try { return await readCache(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await invoke(cmake, ['--build', build, '--target', 'pdftotext', '--config', 'Release', '--parallel', '8'], join(workDirectory, 'pdf-build.log'), env);
  let executable = join(build, 'xpdf', 'pdftotext.exe');
  try { await lstat(executable); } catch (error) { if (error.code !== 'ENOENT') throw error; executable = join(build, 'xpdf', 'Release', 'pdftotext.exe'); }
  const bytes = await plain(executable), imports = pdfPeImports(bytes);
  const metadata = { schema: 'kcoder.xpdf-build.v1', fingerprint, inputs, executableSha256: digest(bytes), imports,
    modified: true, upstreamLicense: 'GPL-2.0-only OR GPL-3.0-only', modifiedComponentLicense: 'GPL-3.0-only', buildRecipeLicense: 'MIT', changes: 'UTF-8/wide dynamic Windows path handling, surrogate pairs, extended drive/UNC opens, static CLI runtime and MinGW longPathAware resource' };
  const stage = await mkdtemp(join(cache, '.pdf-source-build-'));
  try {
    await copyFile(executable, join(stage, 'pdftotext.exe')); await writeFile(join(stage, 'build.json'), JSON.stringify(metadata, null, 2) + '\n');
    try { await rename(stage, destination); } catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error; return await readCache(); }
  } finally { await rm(stage, { recursive: true, force: true }); }
  return { executable: join(destination, 'pdftotext.exe'), metadata, cacheHit: false };
}
export async function includePdfBuildMaterials(sourceDirectory, metadata) {
  for (const name of ['xpdf-windows-paths.patch', 'build-pdf.mjs', 'pdf-archive.mjs', 'chrome-archive.mjs']) await copyFile(join(here, name), join(sourceDirectory, name));
  await cp(join(here, 'pdf-runtime-licenses'), join(sourceDirectory, 'runtime-licenses'), { recursive: true });
  await copyFile(join(here, 'pdf-runtime-licenses', 'MIT.txt'), join(sourceDirectory, 'BUILD-RECIPE-LICENSE.txt'));
  await writeFile(join(sourceDirectory, 'BUILD-INFO.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(join(sourceDirectory, 'KCODER-MODIFICATIONS.txt'), `Xpdf ${XPDF_VARIANT}, modified by KCoder on 2026-09-24. Not the unmodified official binary.\nModified Xpdf component: GPL-3.0-only. Upstream permits GPL v2 or v3; retain both license texts. KCoder build recipe: MIT. This does not relicense the KCoder application.\n${metadata.changes}\nOriginal complete source: xpdf-4.06.tar.gz; apply xpdf-windows-paths.patch with build-pdf.mjs.\nRebuild: node build-pdf.mjs --source xpdf-4.06.tar.gz --work <empty-private-directory> --cache <private-cache>.\nWindows: CMake and MSVC build tools; upstream selects static /MT. Linux: MinGW-w64 GCC C++11 and CMake.\nOptional offline toolchain: KCODER_PDF_CMAKE, KCODER_PDF_CC, KCODER_PDF_CXX, KCODER_PDF_RC, KCODER_PDF_TOOLCHAIN.\nOnly pdftotext is built. GUI, Qt, FreeType, PNG and host font libraries are disabled.\nStatic GNU/MinGW runtime notices are in runtime-licenses; no non-system DLL imports are accepted.\nRetain upstream README, docs, COPYING/COPYING3 and all data notices.\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) { const key = { '--source': 'sourceArchive', '--work': 'workDirectory', '--cache': 'cache' }[process.argv[i]]; if (!key || !process.argv[i+1]) throw new Error('Usage: build-pdf.mjs --source ARCHIVE --work PRIVATE_DIR --cache CACHE'); options[key] = resolve(process.argv[i+1]); }
    if (!options.sourceArchive || !options.workDirectory || !options.cache) throw new Error('All build paths are required');
    await mkdir(options.workDirectory, { recursive: true, mode: 0o700 }); await mkdir(options.cache, { recursive: true, mode: 0o700 });
    console.log(JSON.stringify(await buildPdf(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
