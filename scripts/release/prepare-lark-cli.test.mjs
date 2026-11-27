import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  crc32, LARK_CLI_COMMIT, LARK_CLI_RELEASE, prepareLarkCli, readLarkCliTarGz, readLarkCliZip, verifyLarkCliChecksums,
} from './prepare-lark-cli.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-lark-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function elf() {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32BE(0x7f454c46, 0); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(0x3e, 18);
  return bytes;
}

function pe() {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ', 0, 'ascii'); bytes.writeUInt32LE(0x80, 0x3c); bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84); bytes.writeUInt16LE(0x20b, 0x98);
  return bytes;
}

function macho(cpuType) {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpuType, 4); bytes.writeUInt32LE(2, 12);
  return bytes;
}

function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
  header.write('        ', 148); header.write(type, 156); header.write('ustar\0' + '00', 257);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}

function tarGz(files, { type } = {}) {
  const parts = [];
  for (const [name, data] of files) {
    parts.push(tarHeader(name, data.length, type?.[name] ?? '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function zip(files) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); directory.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** A fake release whose pins describe archives written into `directory`. */
async function fakeRelease(directory, archives) {
  await mkdir(directory, { recursive: true });
  const assets = {};
  for (const [platform, { name, bytes, format, executable, binary }] of Object.entries(archives)) {
    await writeFile(join(directory, name), bytes);
    assets[platform] = { name, sha256: sha256(bytes), url: `https://invalid.example/${name}`, format, executable, binary };
  }
  const checksums = Buffer.from(Object.values(assets).map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n');
  await writeFile(join(directory, 'checksums.txt'), checksums);
  return { version: '9.9.9', tag: 'v9.9.9', commit: 'f'.repeat(40), checksums: { name: 'checksums.txt', sha256: sha256(checksums), url: 'https://invalid.example/checksums.txt' }, assets };
}

const LICENSE = Buffer.from('MIT License\n');
const linuxArchive = (binary = elf(), extra = []) => ({
  name: 'lark-cli-9.9.9-linux-amd64.tar.gz', format: 'tar.gz', executable: 'lark-cli', binary: 'elf-x64',
  bytes: tarGz([['CHANGELOG.md', Buffer.from('log')], ['LICENSE', LICENSE], ['README.md', Buffer.from('readme')], ['lark-cli', binary], ...extra]),
});

test('the recorded pins cover every Studio desktop platform and agree with the release checksums', async () => {
  assert.equal(LARK_CLI_RELEASE.version, '1.0.100');
  assert.match(LARK_CLI_COMMIT, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(LARK_CLI_RELEASE.assets).sort(), ['linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']);
  for (const entry of [LARK_CLI_RELEASE.checksums, ...Object.values(LARK_CLI_RELEASE.assets)]) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.url, `https://github.com/larksuite/cli/releases/download/v1.0.100/${entry.name}`);
  }
  // The published checksums.txt lines for the pinned assets (others omitted).
  const published = Object.values(LARK_CLI_RELEASE.assets).map(entry => `${entry.sha256}  ${entry.name}`).join('\n');
  verifyLarkCliChecksums(published + '\n');
  assert.throws(() => verifyLarkCliChecksums(published.replace(/^[0-9a-f]/, c => (c === '0' ? '1' : '0'))), /does not confirm/);
  assert.throws(() => verifyLarkCliChecksums('not a checksum line\n'), /malformed/);
});

test('a Linux archive is verified, extracted and recorded, and a warm run reuses it untouched', async t => {
  const root = await scratch(t);
  const release = await fakeRelease(join(root, 'offline'), { 'linux-x64': linuxArchive() });
  const destination = join(root, 'stage', 'lark-cli');
  const first = await prepareLarkCli({ platform: 'linux-x64', destination, cache: join(root, 'cache'), archiveDirectory: join(root, 'offline'), offline: true, release });
  assert.equal(first.reused, false);
  assert.deepEqual((await readdir(destination)).sort(), ['.kcoder-lark-cli.json', 'LICENSE', 'lark-cli']);
  assert.equal((await stat(join(destination, 'lark-cli'))).mode & 0o777, 0o755);
  assert.deepEqual(await readFile(join(destination, 'LICENSE')), LICENSE);
  const marker = JSON.parse(await readFile(join(destination, '.kcoder-lark-cli.json'), 'utf8'));
  assert.equal(marker.commit, release.commit);
  assert.equal(marker.executableSha256, sha256(elf()));
  assert.equal(marker.archive.sha256, release.assets['linux-x64'].sha256);
  assert.deepEqual((await readdir(join(root, 'stage'))).sort(), ['lark-cli'], 'no stage or lock remains');

  const inode = (await lstat(join(destination, 'lark-cli'))).ino;
  // The verified cache now satisfies an offline run without the archive directory.
  const second = await prepareLarkCli({ platform: 'linux-x64', destination, cache: join(root, 'cache'), offline: true, release });
  assert.equal(second.reused, true);
  assert.equal((await lstat(join(destination, 'lark-cli'))).ino, inode);

  await writeFile(join(destination, 'lark-cli'), Buffer.concat([elf(), Buffer.from('tampered')]));
  const repaired = await prepareLarkCli({ platform: 'linux-x64', destination, cache: join(root, 'cache'), offline: true, release });
  assert.equal(repaired.reused, false, 'a modified binary is replaced from the verified cache');
  assert.deepEqual(await readFile(join(destination, 'lark-cli')), elf());
});

test('Windows ZIP and macOS archives must carry the matching executable format', async t => {
  const root = await scratch(t);
  const release = await fakeRelease(join(root, 'offline'), {
    'win-x64': { name: 'w.zip', format: 'zip', executable: 'lark-cli.exe', binary: 'pe-x64', bytes: zip([['LICENSE', LICENSE], ['lark-cli.exe', pe()]]) },
    'mac-arm64': { name: 'm.tar.gz', format: 'tar.gz', executable: 'lark-cli', binary: 'macho-arm64', bytes: tarGz([['LICENSE', LICENSE], ['lark-cli', macho(0x0100000c)]]) },
    'mac-x64': { name: 'x.tar.gz', format: 'tar.gz', executable: 'lark-cli', binary: 'macho-x64', bytes: tarGz([['LICENSE', LICENSE], ['lark-cli', macho(0x0100000c)]]) },
  });
  const common = { cache: join(root, 'cache'), archiveDirectory: join(root, 'offline'), offline: true, release };
  const windows = await prepareLarkCli({ platform: 'win-x64', destination: join(root, 'win', 'lark-cli'), ...common });
  assert.equal(windows.executable, join(root, 'win', 'lark-cli', 'lark-cli.exe'));
  await prepareLarkCli({ platform: 'mac-arm64', destination: join(root, 'arm', 'lark-cli'), ...common });
  await assert.rejects(prepareLarkCli({ platform: 'mac-x64', destination: join(root, 'intel', 'lark-cli'), ...common }), /x86_64 Mach-O/);
  await assert.rejects(readdir(join(root, 'intel', 'lark-cli')), { code: 'ENOENT' });
  await assert.rejects(prepareLarkCli({ platform: 'linux-arm64', destination: join(root, 'x', 'lark-cli'), ...common }), /Unsupported/);
});

test('hash, checksum and archive-shape violations fail closed and keep the previous copy', async t => {
  const root = await scratch(t);
  const release = await fakeRelease(join(root, 'offline'), { 'linux-x64': linuxArchive() });
  const destination = join(root, 'stage', 'lark-cli');
  const options = { platform: 'linux-x64', destination, cache: join(root, 'cache'), archiveDirectory: join(root, 'offline'), offline: true };
  await prepareLarkCli({ ...options, release });
  const before = await readFile(join(destination, '.kcoder-lark-cli.json'));

  const tampered = { ...release, version: '9.9.10', assets: { 'linux-x64': { ...release.assets['linux-x64'], sha256: '0'.repeat(64) } } };
  await assert.rejects(prepareLarkCli({ ...options, cache: join(root, 'cache-2'), release: tampered }), /does not confirm|SHA-256/);
  const badChecksums = { ...release, version: '9.9.10', checksums: { ...release.checksums, sha256: '0'.repeat(64) } };
  await assert.rejects(prepareLarkCli({ ...options, cache: join(root, 'cache-3'), release: badChecksums }), /SHA-256 mismatch/);
  assert.deepEqual(await readFile(join(destination, '.kcoder-lark-cli.json')), before);

  for (const [label, archive] of [
    ['extra entry', linuxArchive(elf(), [['install.sh', Buffer.from('#!/bin/sh')]])],
    ['path entry', { ...linuxArchive(), bytes: tarGz([['LICENSE', LICENSE], ['bin/lark-cli', elf()]]) }],
    ['link entry', { ...linuxArchive(), bytes: tarGz([['LICENSE', LICENSE], ['lark-cli', Buffer.alloc(0)]], { type: { 'lark-cli': '2' } }) }],
    ['missing license', { ...linuxArchive(), bytes: tarGz([['lark-cli', elf()]]) }],
    ['wrong format', linuxArchive(pe())],
  ]) {
    const scratchRelease = await fakeRelease(join(root, label), { 'linux-x64': archive });
    await assert.rejects(prepareLarkCli({ ...options, archiveDirectory: join(root, label), cache: join(root, `cache-${label}`), release: { ...scratchRelease, version: '9.9.11' } }),
      /Unexpected|forbidden|lacks LICENSE|ELF/, label);
    assert.deepEqual(await readFile(join(destination, '.kcoder-lark-cli.json')), before, label);
  }
  assert.deepEqual((await readdir(join(root, 'stage'))).sort(), ['lark-cli']);
});

test('destinations must be dedicated and owned; offline runs never download', async t => {
  const root = await scratch(t);
  const release = await fakeRelease(join(root, 'offline'), { 'linux-x64': linuxArchive() });
  const common = { platform: 'linux-x64', cache: join(root, 'cache'), release };
  await assert.rejects(prepareLarkCli({ ...common, destination: join(root, 'bin') }), /ending in lark-cli/);
  await mkdir(join(root, 'user', 'lark-cli'), { recursive: true });
  await writeFile(join(root, 'user', 'lark-cli', 'notes.txt'), 'keep');
  await assert.rejects(prepareLarkCli({ ...common, destination: join(root, 'user', 'lark-cli'), archiveDirectory: join(root, 'offline') }), /unowned/);
  assert.deepEqual(await readdir(join(root, 'user', 'lark-cli')), ['notes.txt']);
  await assert.rejects(prepareLarkCli({ ...common, destination: join(root, 'absent', 'lark-cli'), offline: true }), /absent from the offline archive directory and cache/);
  await symlink(join(root, 'offline'), join(root, 'linked'));
  await assert.rejects(prepareLarkCli({ ...common, destination: join(root, 'linked', 'lark-cli') }), /symbolic links/);
  await mkdir(join(root, 'locked', '.kcoder-lark-cli.lock'), { recursive: true });
  await assert.rejects(prepareLarkCli({ ...common, destination: join(root, 'locked', 'lark-cli'), archiveDirectory: join(root, 'offline') }), /locked/);
});

test('archive readers accept only the flat upstream layout', () => {
  const entries = readLarkCliTarGz(tarGz([['LICENSE', LICENSE], ['lark-cli', elf()]]), 'lark-cli');
  assert.deepEqual([...entries.keys()], ['LICENSE', 'lark-cli']);
  assert.throws(() => readLarkCliTarGz(tarGz([['LICENSE', LICENSE], ['LICENSE', LICENSE]]), 'lark-cli'), /Duplicate/);
  assert.throws(() => readLarkCliTarGz(tarGz([['../lark-cli', elf()]]), 'lark-cli'), /Unexpected/);
  const zipped = readLarkCliZip(zip([['LICENSE', LICENSE], ['lark-cli.exe', pe()]]), 'lark-cli.exe');
  assert.deepEqual(zipped.get('lark-cli.exe'), pe());
  const corrupt = zip([['lark-cli.exe', pe()]]);
  corrupt[30 + 'lark-cli.exe'.length] ^= 0xff;
  assert.throws(() => readLarkCliZip(corrupt, 'lark-cli.exe'), /checksum/);
  assert.throws(() => readLarkCliZip(zip([['lark-cli', elf()]]), 'lark-cli.exe'), /Unexpected/);
});
