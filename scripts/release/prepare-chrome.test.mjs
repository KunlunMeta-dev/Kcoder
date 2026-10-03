import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromeRelease, prepareChrome, validateChromeMetadata } from './prepare-chrome.mjs';
import { validateChromeZip } from './chrome-archive.mjs';

function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, content = 'fixture', mode = 0o100644, localName = name } of entries) {
    const body = Buffer.from(content), filename = Buffer.from(name), localFilename = Buffer.from(localName);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(localFilename.length, 26);
    local.push(header, localFilename, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE((mode << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, filename); offset += header.length + localFilename.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function fixtureRelease(archive, platform = 'linux64') {
  return { ...chromeRelease(platform), sha256: createHash('sha256').update(archive).digest('hex') };
}

test('pins both official platforms and rejects metadata URL redirection', () => {
  for (const platform of ['linux64', 'win64']) {
    const release = chromeRelease(platform);
    assert.match(release.sha256, /^[0-9a-f]{64}$/);
    assert.equal(release.version, '152.0.7977.82');
    const metadata = { version: release.version, downloads: { chrome: [{ platform, url: release.url }] } };
    validateChromeMetadata(metadata, release);
    for (const url of ['https://attacker.invalid/chrome.zip', release.url + '?token=private', release.url.replace('https:', 'http:')]) {
      assert.throws(() => validateChromeMetadata({ ...metadata, downloads: { chrome: [{ platform, url }] } }, release), /official/);
    }
  }
  assert.throws(() => chromeRelease('linux-arm64'), /Unsupported/);
});

test('rejects archive traversal, symlinks, alternate local paths, and wrong platforms before extraction', () => {
  const release = chromeRelease('linux64');
  for (const name of ['../outside', '/outside', 'C:/outside', 'chrome-linux64/../outside', 'chrome-linux64/CON', 'chrome-linux64/file:stream', 'chrome-win64/chrome.exe']) {
    assert.throws(() => validateChromeZip(zip([{ name }]), release), /archive/i);
  }
  assert.throws(() => validateChromeZip(zip([{ name: 'chrome-linux64/link', mode: 0o120777 }]), release), /archive/i);
  assert.throws(() => validateChromeZip(zip([{ name: 'chrome-linux64/chrome', localName: '../outside' }]), release), /archive/i);
  assert.throws(() => validateChromeZip(zip([{ name: 'chrome-linux64/A' }, { name: 'chrome-linux64/a' }]), release), /archive/i);
});

test('stages full resources from an explicit archive, verifies cached SHA, and preserves old install on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-chrome-'));
  try {
    const archive = zip([{ name: 'chrome-linux64/chrome', content: 'new executable', mode: 0o100755 }, { name: 'chrome-linux64/LICENSE', content: 'retain license' }]);
    const release = fixtureRelease(archive), source = join(directory, 'source.zip');
    await writeFile(source, archive);
    const destination = join(directory, 'install', 'chrome'), cache = join(directory, 'cache');
    const noNetwork = async () => { throw new Error('offline test attempted a download'); };
    const first = await prepareChrome({ destination, cache, archive: source, release, download: noNetwork });
    assert.equal(await readFile(first.executable, 'utf8'), 'new executable');
    assert.equal(await readFile(join(destination, 'chrome-linux64/LICENSE'), 'utf8'), 'retain license');
    await writeFile(first.executable, 'old valid installation');
    await writeFile(source, 'corrupt zip');
    await assert.rejects(prepareChrome({ destination, cache, archive: source, release, download: noNetwork }), /SHA-256/);
    assert.equal(await readFile(first.executable, 'utf8'), 'old valid installation');
    await assert.rejects(prepareChrome({ destination, cache, release, download: noNetwork, extract: async () => { throw new Error('fixture extraction failure'); } }), /extraction failure/);
    assert.equal(await readFile(first.executable, 'utf8'), 'old valid installation');
    let renames = 0;
    await assert.rejects(prepareChrome({ destination, cache, release, download: noNetwork, renamePath: async (from, to) => {
      if (++renames === 2) throw new Error('fixture commit failure');
      await rename(from, to);
    } }), /commit failure/);
    assert.equal(await readFile(first.executable, 'utf8'), 'old valid installation');
    assert.deepEqual(await readdir(join(directory, 'install')), ['chrome']);
    await prepareChrome({ destination, cache, release, download: noNetwork });
    assert.equal(await readFile(first.executable, 'utf8'), 'new executable');
    const cached = (await readdir(cache)).find(name => name.endsWith('.zip'));
    await writeFile(join(cache, cached), 'corrupt cache');
    await assert.rejects(prepareChrome({ destination, cache, release, download: noNetwork }), /SHA-256/);
    assert.equal(await readFile(first.executable, 'utf8'), 'new executable');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('validates official metadata and SHA before accepting a download', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-chrome-download-'));
  try {
    const archive = zip([{ name: 'chrome-win64/chrome.exe' }, { name: 'chrome-win64/ABOUT', content: 'retain notice' }]);
    const release = fixtureRelease(archive, 'win64'), calls = [];
    const download = async (url, file) => {
      calls.push(url);
      await writeFile(file, url === release.metadataUrl ? JSON.stringify({ version: release.version, downloads: { chrome: [{ platform: release.platform, url: release.url }] } }) : archive);
    };
    const result = await prepareChrome({ destination: join(directory, 'install/chrome'), cache: join(directory, 'cache'), release, download });
    assert.deepEqual(calls, [release.metadataUrl, release.url]);
    assert.match(result.executable, /chrome-win64[/\\]chrome.exe$/);
    assert.equal(await readFile(join(directory, 'install/chrome/chrome-win64/ABOUT'), 'utf8'), 'retain notice');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses broad or unowned destination directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-chrome-unowned-'));
  try {
    const destination = join(directory, 'chrome');
    await mkdir(destination);
    await writeFile(join(destination, 'user-file'), 'preserve');
    await assert.rejects(prepareChrome({ destination, cache: join(directory, 'cache'), platform: 'linux64' }), /managed/);
    await assert.rejects(prepareChrome({ destination: directory, cache: join(directory, 'cache'), platform: 'linux64' }), /dedicated/);
    assert.equal(await readFile(join(destination, 'user-file'), 'utf8'), 'preserve');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
