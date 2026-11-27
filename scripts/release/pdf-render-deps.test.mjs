import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  buildPdfRenderDependencies, fetchPdfRenderAssets, includeRenderDependencyMaterials, normalizedRenderOptions, PDF_RENDER_ASSETS, PDF_RENDER_KEYS,
  renderDependencyPlan, renderDownloadArgs, resolveRenderLibrary, verifyRenderHash, xpdfRenderArgs,
} from './pdf-render-deps.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function tar(entries) {
  const blocks = [];
  for (const { name, type = '0', data = 'x' } of entries) {
    const header = Buffer.alloc(512); header.write(name);
    header.write(Buffer.byteLength(data).toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write(type, 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512); body.write(data);
    blocks.push(header, body);
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test('renderer dependencies are fixed HTTPS pins with recorded licenses', () => {
  assert.deepEqual(Object.keys(PDF_RENDER_ASSETS), ['zlib', 'libpng', 'freetype']);
  assert.deepEqual([...PDF_RENDER_KEYS], ['zlib', 'libpng', 'freetype']);
  for (const asset of Object.values(PDF_RENDER_ASSETS)) {
    assert.match(asset.url, /^https:\/\//); assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.equal(asset.root, asset.name.replace(/\.tar\.gz$/, '')); assert.ok(asset.license && asset.notices.length);
  }
  assert.equal(PDF_RENDER_ASSETS.freetype.license, 'FTL OR GPL-2.0-or-later');
  assert.throws(() => { PDF_RENDER_ASSETS.zlib.url = 'https://invalid'; }, TypeError);
  assert.throws(() => { PDF_RENDER_ASSETS.freetype.notices.push('x'); }, TypeError);
});

test('downloads stay on HTTPS across redirects and use argv, not a shell', () => {
  const args = renderDownloadArgs('https://example.invalid/zlib.tar.gz', '/owned/stage/zlib.tar.gz');
  for (const [flag, value] of [['--proto', '=https'], ['--proto-redir', '=https'], ['--max-redirs', '5'], ['--output', '/owned/stage/zlib.tar.gz']]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.equal(args.at(-1), 'https://example.invalid/zlib.tar.gz');
  assert.ok(!args.includes('--insecure') && !args.includes('-k'));
  assert.throws(() => renderDownloadArgs('http://example.invalid/zlib.tar.gz', '/x'), /HTTPS/);
});

test('fetch prefers explicit, archive directory, then cache; verifies and caches; offline never downloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-pdf-render-fetch-'));
  try {
    const good = Buffer.from('pinned archive'), stage = join(root, 'stage'), cacheRoot = join(root, 'cache'), offered = join(root, 'offered');
    for (const directory of [stage, cacheRoot, offered]) await mkdir(directory);
    const assets = { zlib: { name: 'zlib.tar.gz', sha256: sha(good), url: 'https://example.invalid/zlib.tar.gz' } };
    await assert.rejects(fetchPdfRenderAssets({ stage, cacheRoot, offline: true, assets, fetch: () => assert.fail('offline download') }), /absent from the offline cache/);
    const downloads = [];
    const verified = await fetchPdfRenderAssets({ stage, cacheRoot, assets, fetch: async (url, output) => { downloads.push(url); await writeFile(output, good); } });
    assert.deepEqual(downloads, ['https://example.invalid/zlib.tar.gz']);
    assert.deepEqual(await readFile(verified.zlib), good);
    assert.deepEqual(await readFile(join(cacheRoot, `zlib.tar.gz.${sha(good)}`)), good);
    await fetchPdfRenderAssets({ stage, cacheRoot, offline: true, assets, fetch: () => assert.fail('cache hit must not download') });
    await writeFile(join(offered, 'zlib.tar.gz'), 'tampered');
    await assert.rejects(fetchPdfRenderAssets({ stage, cacheRoot, archiveDirectory: offered, offline: true, assets }), /SHA-256 mismatch/);
    const explicit = join(root, 'explicit'); await writeFile(explicit, 'also tampered');
    await assert.rejects(fetchPdfRenderAssets({ stage, cacheRoot, archives: { zlib: explicit }, offline: true, assets }), /SHA-256 mismatch/);
    await assert.rejects(verifyRenderHash(join(root, 'missing'), sha(good)), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dependency plan is static-only, ordered, and forwards the caller toolchain', () => {
  const toolchain = ['-DCMAKE_SYSTEM_NAME=Windows', '-DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc'];
  const plan = renderDependencyPlan({ sources: '/w/src', builds: '/w/deps', prefix: '/w/prefix', toolchain });
  assert.deepEqual(plan.map(step => step.key), ['zlib', 'libpng', 'freetype']);
  const [zlib, png, freetype] = plan.map(step => step.configure({ zlib: '/w/prefix/lib/libzs.a' }));
  for (const args of [zlib, png, freetype]) {
    for (const option of ['-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_INSTALL_PREFIX=/w/prefix', '-DCMAKE_INSTALL_LIBDIR=lib', ...toolchain]) assert.ok(args.includes(option), option);
  }
  assert.deepEqual(zlib.slice(0, 4), ['-S', join('/w/src', 'zlib-1.3.2'), '-B', join('/w/deps', 'zlib')]);
  assert.ok(zlib.includes('-DZLIB_BUILD_SHARED=OFF') && png.includes('-DPNG_SHARED=OFF') && png.includes('-DPNG_TOOLS=OFF'));
  assert.ok(png.includes('-DZLIB_LIBRARY=/w/prefix/lib/libzs.a'));
  for (const option of ['-DFT_DISABLE_ZLIB=TRUE', '-DFT_DISABLE_BZIP2=TRUE', '-DFT_DISABLE_PNG=TRUE', '-DFT_DISABLE_HARFBUZZ=TRUE', '-DFT_DISABLE_BROTLI=TRUE']) assert.ok(freetype.includes(option));
});

test('xpdf renderer configuration enables FreeType and PNG from the private prefix only', () => {
  const libraries = { zlib: '/w/prefix/lib/libz.a', libpng: '/w/prefix/lib/libpng16.a', freetype: '/w/prefix/lib/libfreetype.a' };
  const args = xpdfRenderArgs({ prefix: '/w/prefix', libraries });
  assert.ok(args.includes(`-DFREETYPE_INCLUDE_DIR_ft2build=${join('/w/prefix', 'include', 'freetype2')}`));
  assert.ok(args.includes('-DFREETYPE_LIBRARY=/w/prefix/lib/libfreetype.a') && args.includes('-DPNG_LIBRARY_RELEASE=/w/prefix/lib/libpng16.a') && args.includes('-DZLIB_LIBRARY_RELEASE=/w/prefix/lib/libz.a'));
  assert.ok(!args.some(option => /DISABLE_FIND_PACKAGE_(PNG|ZLIB)|FREETYPE_LIBRARY=$/.test(option)));
  assert.deepEqual(normalizedRenderOptions(args, '/w'), args.map(option => option.replaceAll('/w', '<work>')));
});

test('dependency builds run configure, build and install in order and resolve static libraries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-pdf-render-build-'));
  try {
    // Fixture archives cannot match the real pins, so hash verification must reject them first.
    const archives = {};
    for (const key of PDF_RENDER_KEYS) { archives[key] = join(root, PDF_RENDER_ASSETS[key].name); await writeFile(archives[key], tar([{ name: `${PDF_RENDER_ASSETS[key].root}/LICENSE`, data: 'license' }])); }
    await assert.rejects(buildPdfRenderDependencies({ archives, work: join(root, 'work'), cmake: 'cmake', invoke: () => assert.fail('must not build unverified sources') }), /SHA-256 mismatch/);
    await assert.rejects(includeRenderDependencyMaterials({ archives, sourceDirectory: root, licenseDirectory: join(root, 'licenses') }), /SHA-256 mismatch/);
    const prefix = join(root, 'prefix'); await mkdir(join(prefix, 'lib'), { recursive: true });
    await assert.rejects(resolveRenderLibrary(prefix, 'libpng'), /Static libpng library is missing/);
    await writeFile(join(prefix, 'lib', 'libpng16_static.lib'), 'msvc');
    assert.equal(await resolveRenderLibrary(prefix, 'libpng'), join(prefix, 'lib', 'libpng16_static.lib'));
    await writeFile(join(prefix, 'lib', 'libpng16.a'), 'gnu');
    assert.equal(await resolveRenderLibrary(prefix, 'libpng'), join(prefix, 'lib', 'libpng16.a'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

const archiveDirectory = process.env.KCODER_PDF_TEST_ARCHIVE_DIR;
test('real pinned renderer archives extract and carry their license notices', { skip: !archiveDirectory }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-pdf-render-real-'));
  try {
    const archives = Object.fromEntries(PDF_RENDER_KEYS.map(key => [key, join(archiveDirectory, PDF_RENDER_ASSETS[key].name)]));
    await mkdir(join(root, 'source')); await includeRenderDependencyMaterials({ archives, sourceDirectory: join(root, 'source'), licenseDirectory: join(root, 'licenses') });
    assert.ok((await readFile(join(root, 'licenses/freetype-2.14.3/FTL.TXT'), 'utf8')).includes('FreeType'));
    assert.ok((await readFile(join(root, 'licenses/zlib-1.3.2/LICENSE'), 'utf8')).length > 100);
    const calls = [];
    const work = join(root, 'work');
    const result = await buildPdfRenderDependencies({ archives, work, cmake: 'cmake', invoke: async (program, args) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === '--install') { await mkdir(join(work, 'render-prefix', 'lib'), { recursive: true }); for (const name of ['libz.a', 'libpng16.a', 'libfreetype.a']) await writeFile(join(work, 'render-prefix', 'lib', name), 'fixture'); }
    } });
    assert.equal(calls.length, 9);
    assert.deepEqual(Object.keys(result.libraries), ['zlib', 'libpng', 'freetype']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
