import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import test from 'node:test';
import { PDF_ASSETS, PDF_EXE_SHA256, preparePdf, verifyPdfHash, verifyWin64PdfExecutable } from './prepare-pdf.mjs';
import { readPdfTarGz, readPdfZip } from './pdf-archive.mjs';
import { applyXpdfPatch } from './build-pdf.mjs';

function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const { name, content = 'fixture', mode = 0o100644, localName = name } of entries) {
    const body = Buffer.from(content), filename = Buffer.from(name), localFilename = Buffer.from(localName);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(localFilename.length, 26);
    local.push(header, localFilename, body);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE((mode << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, filename); offset += header.length + localFilename.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function tar(entries) {
  const blocks = [];
  for (const { name, type = '0', data = 'x', size = Buffer.byteLength(data) } of entries) {
    const header = Buffer.alloc(512); header.write(name);
    header.write(size.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write(type, 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512); body.write(data);
    blocks.push(header, body);
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const zipRoot = 'xpdf-tools-win-4.06', tarRoot = 'xpdf-chinese-simplified';
test('fixed official pins and PE architecture are explicit, not configurable URLs', () => {
  assert.equal(Object.keys(PDF_ASSETS).length, 4);
  for (const asset of Object.values(PDF_ASSETS)) { assert.equal(asset.url, `https://dl.xpdfreader.com/${asset.name}`); assert.match(asset.sha256, /^[a-f0-9]{64}$/); }
  assert.throws(() => { PDF_ASSETS.tools.url = 'https://invalid'; }, TypeError);
  assert.throws(() => execFileSync(process.execPath, [resolve('scripts/release/prepare-pdf.mjs'), '--url', 'https://invalid'], { stdio: 'pipe' }));
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 0x3c); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(0x20b, 88);
  verifyWin64PdfExecutable(pe); pe.writeUInt16LE(0x14c, 68); assert.throws(() => verifyWin64PdfExecutable(pe), /x64/);
});
test('ZIP validation rejects traversal, link, alternate local names and bad CRC', () => {
  const exe = { name: `${zipRoot}/bin64/pdftotext.exe` };
  assert.equal(readPdfZip(zip([exe])).length, 1);
  for (const entry of [
    { name: `${zipRoot}/../outside` }, { name: `${zipRoot}/CON` }, { name: `${zipRoot}/link`, mode: 0o120777 },
    { name: `${zipRoot}/safe`, localName: '../outside' },
  ]) assert.throws(() => readPdfZip(zip([exe, entry])));
  const bytes = zip([exe]); bytes[30 + Buffer.byteLength(exe.name)] ^= 1;
  assert.throws(() => readPdfZip(bytes), /checksum/);
});
test('TAR validation rejects links, duplicate names, truncation and excessive expansion metadata', () => {
  assert.equal(readPdfTarGz(tar([{ name: `${tarRoot}/CMap/map` }]), tarRoot).length, 1);
  for (const entries of [
    [{ name: `${tarRoot}/../outside` }], [{ name: `${tarRoot}/link`, type: '2' }],
    [{ name: `${tarRoot}/a` }, { name: `${tarRoot}/A` }],
    [{ name: `${tarRoot}/file` }, { name: `${tarRoot}/file/child` }],
    [{ name: `${tarRoot}/huge`, size: 64 * 1024 * 1024 + 1 }],
  ]) assert.throws(() => readPdfTarGz(tar(entries), tarRoot));
  assert.throws(() => readPdfTarGz(gzipSync(Buffer.from('broken')), tarRoot), /Truncated/);
});
test('unowned destination and live lock are never removed; corrupt archives fail before replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-pdf-boundary-'));
  try {
    const destination = join(root, 'bin/pdf'), cache = join(root, 'cache'); await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'user-data'), 'keep');
    await assert.rejects(preparePdf({ destination, cache, offline: true }), /unowned/);
    assert.equal(await readFile(join(destination, 'user-data'), 'utf8'), 'keep');
    await mkdir(join(root, 'bin/.kcoder-pdf.lock'));
    await assert.rejects(preparePdf({ destination, cache, offline: true }), /locked/);
    assert.ok(await lstat(join(root, 'bin/.kcoder-pdf.lock')));
    await assert.rejects(preparePdf({ destination: root, cache, offline: true }), /ending in pdf/);
    await assert.rejects(preparePdf({ destination: join(root, 'nested/pdf'), cache: join(root, 'nested/pdf/cache'), offline: true }), /non-overlapping/);
    const corrupt = join(root, 'corrupt'); await writeFile(corrupt, 'bad');
    await assert.rejects(verifyPdfHash(corrupt, PDF_ASSETS.tools.sha256), /SHA-256/);
    if (process.platform !== 'win32') {
      await symlink(join(root, 'bin'), join(root, 'linked'));
      await assert.rejects(preparePdf({ destination: join(root, 'linked/pdf'), cache, offline: true }), /symlinks/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('source patches cannot be substituted with unpinned modifications', async () => {
  await assert.rejects(applyXpdfPatch('/unused', Buffer.from('untrusted patch')), /SHA-256/);
});
const archiveDirectory = process.env.KCODER_PDF_TEST_ARCHIVE_DIR;
test('real pinned offline resources, cached rebuild, rollback and retained recovery', { skip: !archiveDirectory }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-pdf-real-'));
  try {
    const destination = join(root, '安装 spaces/bin/pdf'), cache = join(root, 'cache');
    const options = { destination, cache, archiveDirectory, offline: true };
    const result = await preparePdf(options);
    await verifyPdfHash(result.executable, result.executableSha256);
    assert.notEqual(result.executableSha256, PDF_EXE_SHA256);
    assert.equal(result.variant, '4.06-kcoder.1');
    const resourceMarker = JSON.parse(await readFile(join(destination, '.kcoder-pdf.json'), 'utf8'));
    assert.equal(resourceMarker.modifiedComponentLicense, 'GPL-3.0-only');
    assert.equal(resourceMarker.buildRecipeLicense, 'MIT');
    assert.ok((await readFile(join(destination, 'source/BUILD-INFO.json'), 'utf8')).includes('compiler'));
    assert.ok((await readFile(join(destination, 'source/KCODER-MODIFICATIONS.txt'), 'utf8')).includes('modified'));
    verifyWin64PdfExecutable(await readFile(result.executable));
    await verifyPdfHash(result.source, PDF_ASSETS.source.sha256);
    const cfg = await readFile(result.config, 'utf8');
    assert.ok(cfg.includes('cMapDir Adobe-GB1 data/chinese-simplified/CMap'));
    assert.ok(!cfg.includes('/usr/local/') && !cfg.includes(root));
    for (const file of ['README', 'COPYING', 'COPYING3', 'doc/xpdfrc.txt', 'doc/pdftotext.txt', 'data/chinese-simplified/CMap/LICENSE.md', 'data/chinese-traditional/README']) assert.ok((await readFile(join(destination, file))).length > 10);
    const cached = await preparePdf({ destination, cache, offline: true });
    assert.equal(cached.buildCacheHit, true);
    assert.equal(cached.executableSha256, result.executableSha256);
    const provenance = await readFile(join(destination, 'source/BUILD-INFO.json'), 'utf8');
    assert.ok(!provenance.includes(root) && !provenance.includes('/tmp/kcoder'));
    assert.ok((await readFile(join(destination, 'source/runtime-licenses/GCC-COPYRIGHT.txt'), 'utf8')).includes('Runtime Library Exception'));
    await writeFile(join(destination, 'old-owned-sentinel'), 'old');
    const failInstall = async (from, to) => { if (basename(from) === 'fresh') throw new Error('injected install failure'); return rename(from, to); };
    await assert.rejects(preparePdf({ ...options, renamePath: failInstall }), /injected/);
    assert.equal(await readFile(join(destination, 'old-owned-sentinel'), 'utf8'), 'old');
    const failRestore = async (from, to) => { if (['fresh', 'previous'].includes(basename(from))) throw new Error('injected failure'); return rename(from, to); };
    await assert.rejects(preparePdf({ ...options, renamePath: failRestore }), /retained/);
    const journal = join(dirname(destination), '.kcoder-pdf-recovery.json');
    const record = JSON.parse(await readFile(journal, 'utf8'));
    assert.equal(await readFile(join(dirname(destination), record.stage, 'previous/old-owned-sentinel'), 'utf8'), 'old');
    const corrupt = join(root, 'bad.zip'); await writeFile(corrupt, 'bad');
    await assert.rejects(preparePdf({ ...options, archives: { tools: corrupt } }), /SHA-256/);
    assert.equal(await readFile(join(destination, 'old-owned-sentinel'), 'utf8'), 'old');
    await assert.rejects(lstat(journal), { code: 'ENOENT' });
    await assert.rejects(lstat(join(dirname(destination), '.kcoder-pdf.lock')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
