import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseVersionedJsonc, readBoundedFile, readBoundedFileSync, writePrivateFile, writePrivateFileSync } from '../src/jsonc-file.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-jsonc-file-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('format versions remain domain-owned and unversioned documents always mean v1', () => {
  const raw = '// retained\n{"$schema":"./settings.schema.json","domain":{},}';
  assert.equal(parseVersionedJsonc(Buffer.from(raw), 1).raw, raw);
  assert.deepEqual(parseVersionedJsonc('{"meta":{"config_version":2}}', 2).document.meta, { config_version: 2 });
  assert.throws(() => parseVersionedJsonc('{}', 2), { code: 'CONFIG_VERSION_UNSUPPORTED' });
  assert.equal(parseVersionedJsonc('{}', 1, 2).version, 1);
  assert.equal(parseVersionedJsonc('{"meta":{"config_version":2}}', 1, 2).version, 2);
  assert.throws(() => parseVersionedJsonc('{"meta":{"config_version":3}}', 1, 2), { code: 'CONFIG_VERSION_UNSUPPORTED' });
  for (const value of ['null', '[]', '{bad', '{"meta":null}', '{"$schema":4}'])
    assert.throws(() => parseVersionedJsonc(value, 1), { code: 'CONFIG_JSONC_INVALID' });
  for (const value of ['{"meta":{"config_version":null}}', '{"meta":{"config_version":99}}'])
    assert.throws(() => parseVersionedJsonc(value, 1), { code: 'CONFIG_VERSION_UNSUPPORTED' });
  const corrupt = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  assert.throws(() => parseVersionedJsonc(corrupt, 1), { code: 'CONFIG_JSONC_INVALID' });
});

test('both readers reject oversized, linked and nonregular files without changing them', async t => {
  const root = fixture(t), path = join(root, 'settings.json');
  writeFileSync(path, '{"value":1}');
  for (const read of [readBoundedFile, readBoundedFileSync]) {
    await assert.rejects(async () => read(join(root, 'missing.json'), 32), { code: 'ENOENT' });
    assert.equal(String(await read(path, 32)), '{"value":1}');
    await assert.rejects(async () => read(path, 3), { code: 'CONFIG_FILE_TOO_LARGE' });
    await assert.rejects(async () => read(root, 32), { code: 'CONFIG_FILE_INVALID' });
  }
  linkSync(path, path + '.hardlink');
  for (const read of [readBoundedFile, readBoundedFileSync]) {
    await assert.rejects(async () => read(path, 32), { code: 'CONFIG_FILE_INVALID' });
  }
  rmSync(path + '.hardlink');
  if (process.platform !== 'win32') {
    symlinkSync(path, path + '.symlink');
    for (const read of [readBoundedFile, readBoundedFileSync]) {
      await assert.rejects(async () => read(path + '.symlink', 32), { code: 'CONFIG_FILE_INVALID' });
    }
  }
  assert.equal(readFileSync(path, 'utf8'), '{"value":1}');
});

test('disappearance after the initial file observation is a conflict instead of a missing config', t => {
  const root = fixture(t), path = join(root, 'settings.json');
  writeFileSync(path, '{"value":1}');
  const original = fs.lstatSync; let calls = 0;
  const mocked = t.mock.method(fs, 'lstatSync', (...args) => {
    if (args[0] === path && ++calls === 2) rmSync(path);
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => readBoundedFileSync(path, 32), { code: 'CONFIG_FILE_CHANGED' });
});

test('the async reader also distinguishes a deleted observed file from initial absence', async t => {
  const root = fixture(t), path = join(root, 'settings.json');
  writeFileSync(path, '{"value":1}');
  const original = fsPromises.lstat; let calls = 0;
  const mocked = t.mock.method(fsPromises, 'lstat', async (...args) => {
    if (args[0] === path && ++calls === 2) rmSync(path);
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(readBoundedFile(path, 32), { code: 'CONFIG_FILE_CHANGED' });
});

test('both private publishers preserve prior data on size/rename failures and clean only their temporary file', async t => {
  const root = fixture(t), path = join(root, 'settings.json'), directory = join(root, 'directory');
  mkdirSync(directory);
  for (const write of [writePrivateFile, writePrivateFileSync]) {
    writeFileSync(path, 'old');
    await assert.rejects(async () => write(path, 'too large', 3), { code: 'CONFIG_FILE_TOO_LARGE' });
    assert.equal(readFileSync(path, 'utf8'), 'old');
    await assert.rejects(async () => write(directory, 'new'));
    assert.equal(statSync(directory).isDirectory(), true);
    assert.deepEqual(readdirSync(root).sort(), ['directory', 'settings.json']);
    await write(path, 'new', 3);
    assert.equal(readFileSync(path, 'utf8'), 'new');
  }
});

test('sync reader rejects a pathname replacement between observation and opening', t => {
  const root = fixture(t), path = join(root, 'settings.json'), replacement = join(root, 'replacement');
  writeFileSync(path, 'old'); writeFileSync(replacement, 'new');
  const open = fs.openSync, mocked = t.mock.method(fs, 'openSync', (...args) => {
    if (args[0] === path) fs.renameSync(replacement, path);
    return open(...args);
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => readBoundedFileSync(path, 32), { code: 'CONFIG_FILE_CHANGED' });
  assert.equal(readFileSync(path, 'utf8'), 'new');
});

test('async reader also rejects a replacement between observation and opening', async t => {
  const root = fixture(t), path = join(root, 'settings.json'), replacement = join(root, 'replacement');
  writeFileSync(path, 'old'); writeFileSync(replacement, 'new');
  const open = fsPromises.open, mocked = t.mock.method(fsPromises, 'open', async (...args) => {
    if (args[0] === path) await fsPromises.rename(replacement, path);
    return open(...args);
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(readBoundedFile(path, 32), { code: 'CONFIG_FILE_CHANGED' });
  assert.equal(readFileSync(path, 'utf8'), 'new');
});

test('escaped prototype properties cannot supply inherited version or resource policy fields', () => {
  for (const raw of ['{"__proto__":{"meta":{"config_version":2}}}',
    '{"meta":{"config_version":1},"__proto__":{"resources":{"idle_budget":{"max_processes":0}}}}',
    '{"meta":{"config_version":1},"resources":{"\\u005f_proto__":{"idle_budget":{}}}}']) {
    const parsed = parseVersionedJsonc(raw, 1, 2);
    assert.equal(parsed.version, 1);
    assert.equal(Object.getPrototypeOf(parsed.document), Object.prototype);
    assert.deepEqual(parsed.document, JSON.parse(raw));
  }
});

test('string and byte BOM inputs have the same normalized JSONC and deep inputs fail with a domain code', () => {
  const raw = '\uFEFF// retained\n{"x":1}';
  assert.deepEqual(parseVersionedJsonc(raw, 1), parseVersionedJsonc(Buffer.from(raw), 1));
  const deep = '{"x":' + '['.repeat(8000) + '0' + ']'.repeat(8000) + '}';
  assert.throws(() => parseVersionedJsonc(deep, 1), { code: 'CONFIG_JSONC_INVALID' });
});

test('small warm reads retain only a file-sized buffer instead of the configured maximum', async t => {
  const root = fixture(t), path = join(root, 'settings.json'); writeFileSync(path, '{}');
  for (const read of [readBoundedFileSync, readBoundedFile]) {
    const bytes = await read(path, 256 * 1024);
    assert.equal(bytes.toString(), '{}'); assert.ok(bytes.buffer.byteLength <= 3);
  }
});

test('sync publication preserves its write failure and attempts owned cleanup even when close also fails', t => {
  const root = fixture(t), path = join(root, 'settings.json'); writeFileSync(path, 'old');
  const close = fs.closeSync, write = fs.writeFileSync;
  const writeMock = t.mock.method(fs, 'writeFileSync', (...args) => {
    if (typeof args[0] === 'number') throw Object.assign(new Error('CONTROLLED_WRITE_FAILURE'), { code: 'ENOSPC' });
    return write(...args);
  });
  const closeMock = t.mock.method(fs, 'closeSync', fd => {
    close(fd); throw Object.assign(new Error('CONTROLLED_CLOSE_FAILURE'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  t.after(() => { writeMock.mock.restore(); closeMock.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => writePrivateFileSync(path, 'new'), /CONTROLLED_WRITE_FAILURE/);
  assert.equal(readFileSync(path, 'utf8'), 'old');
  assert.deepEqual(readdirSync(root), ['settings.json']);
});

test('async publication preserves its write failure and attempts owned cleanup even when close also fails', async t => {
  const root = fixture(t), path = join(root, 'settings.json'); writeFileSync(path, 'old');
  const open = fsPromises.open;
  const mocked = t.mock.method(fsPromises, 'open', async (...args) => {
    const file = await open(...args), close = file.close.bind(file);
    file.writeFile = async () => { throw new Error('CONTROLLED_WRITE_FAILURE'); };
    file.close = async () => { await close(); throw new Error('CONTROLLED_CLOSE_FAILURE'); };
    return file;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(writePrivateFile(path, 'new'), /CONTROLLED_WRITE_FAILURE/);
  assert.equal(readFileSync(path, 'utf8'), 'old');
  assert.deepEqual(readdirSync(root), ['settings.json']);
});

test('POSIX sync publishers sync the held parent after rename and report a lost durability receipt truthfully', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t), path = join(root, 'settings.json'), order = [], directories = new Set();
  writeFileSync(path, 'old');
  const open = fs.openSync, sync = fs.fsyncSync, rename = fs.renameSync;
  let failDirectory = false;
  const mocks = [
    t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); if (args[0] === root) directories.add(fd); return fd; }),
    t.mock.method(fs, 'fsyncSync', fd => {
      const kind = directories.has(fd) ? 'directory' : 'file'; order.push(kind);
      if (kind === 'directory' && failDirectory) throw Object.assign(new Error('CONTROLLED_DIRECTORY_SYNC_FAILED'), { code: 'EIO' });
      return sync(fd);
    }),
    t.mock.method(fs, 'renameSync', (...args) => { order.push('rename'); return rename(...args); }),
  ];
  syncBuiltinESMExports(); t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
  writePrivateFileSync(path, 'confirmed'); assert.deepEqual(order, ['file', 'rename', 'directory']);
  directories.clear(); order.length = 0; failDirectory = true;
  assert.throws(() => writePrivateFileSync(path, 'possibly published'), { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED' });
  assert.equal(readFileSync(path, 'utf8'), 'possibly published');
  assert.deepEqual(readdirSync(root), ['settings.json']);
});

test('POSIX async publishers also sync the held parent and retain the published bytes after a sync failure', { skip: process.platform === 'win32' }, async t => {
  const root = fixture(t), path = join(root, 'settings.json'), order = [];
  writeFileSync(path, 'old');
  const open = fsPromises.open, rename = fsPromises.rename;
  let failDirectory = false;
  const mocks = [
    t.mock.method(fsPromises, 'open', async (...args) => {
      const file = await open(...args), sync = file.sync.bind(file), directory = args[0] === root;
      file.sync = async () => {
        order.push(directory ? 'directory' : 'file');
        if (directory && failDirectory) throw Object.assign(new Error('CONTROLLED_DIRECTORY_SYNC_FAILED'), { code: 'EIO' });
        return sync();
      }; return file;
    }),
    t.mock.method(fsPromises, 'rename', async (...args) => { order.push('rename'); return rename(...args); }),
  ];
  syncBuiltinESMExports(); t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
  await writePrivateFile(path, 'confirmed'); assert.deepEqual(order, ['file', 'rename', 'directory']);
  order.length = 0; failDirectory = true;
  await assert.rejects(writePrivateFile(path, 'possibly published'), { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED' });
  assert.equal(readFileSync(path, 'utf8'), 'possibly published');
  assert.deepEqual(readdirSync(root), ['settings.json']);
});

test('a parent replaced after sync rename produces an unconfirmed receipt without deleting peer files', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t), parent = join(root, 'active'), retired = join(root, 'retired'); mkdirSync(parent);
  const path = join(parent, 'settings.json'), rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (...args) => {
    rename(...args); rename(parent, retired); mkdirSync(parent); writeFileSync(path, 'peer-owned');
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => writePrivateFileSync(path, 'original-owned'), { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED' });
  assert.equal(readFileSync(path, 'utf8'), 'peer-owned');
  assert.equal(readFileSync(join(retired, 'settings.json'), 'utf8'), 'original-owned');
});

test('a parent replaced after async rename also produces an unconfirmed receipt and preserves the peer', { skip: process.platform === 'win32' }, async t => {
  const root = fixture(t), parent = join(root, 'active'), retired = join(root, 'retired'); mkdirSync(parent);
  const path = join(parent, 'settings.json'), rename = fsPromises.rename;
  const mocked = t.mock.method(fsPromises, 'rename', async (...args) => {
    await rename(...args); await rename(parent, retired); mkdirSync(parent); writeFileSync(path, 'peer-owned');
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(writePrivateFile(path, 'original-owned'), { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED' });
  assert.equal(readFileSync(path, 'utf8'), 'peer-owned');
  assert.equal(readFileSync(join(retired, 'settings.json'), 'utf8'), 'original-owned');
});

test('failed exclusive temporary creation never authorizes deleting the existing file', t => {
  const root = fixture(t), path = join(root, 'settings.json'), open = fs.openSync;
  writeFileSync(path, 'old'); let peer;
  const mocked = t.mock.method(fs, 'openSync', (...args) => {
    if (args[1] === 'wx') {
      peer = args[0]; const fd = open(peer, 'wx', 0o600);
      try { fs.writeFileSync(fd, 'peer-owned'); } finally { fs.closeSync(fd); }
      throw Object.assign(new Error('CONTROLLED_PEER_CREATED'), { code: 'EEXIST' });
    }
    return open(...args);
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => writePrivateFileSync(path, 'new'), { code: 'EEXIST' });
  assert.equal(readFileSync(path, 'utf8'), 'old'); assert.equal(readFileSync(peer, 'utf8'), 'peer-owned');
});

for (const asynchronous of [false, true]) test(`${asynchronous ? 'async' : 'sync'} cleanup preserves a peer replacement of its already created temporary leaf`, { skip: process.platform === 'win32' }, async t => {
  const root = fixture(t), path = join(root, 'settings.json'); writeFileSync(path, 'old');
  let temporary;
  const original = Object.assign(Error('OWNED_WRITE_FAILURE'), { code: 'ENOSPC' });
  if (asynchronous) {
    const open = fsPromises.open;
    const mocked = t.mock.method(fsPromises, 'open', async (...args) => {
      const file = await open(...args);
      if (args[1] === 'wx') {
        temporary = args[0];
        file.writeFile = async () => {
          await fsPromises.rename(temporary, temporary + '.owned-original');
          await fsPromises.writeFile(temporary, 'peer-owned', { flag: 'wx', mode: 0o600 });
          throw original;
        };
      }
      return file;
    });
    syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    await assert.rejects(writePrivateFile(path, 'new'), error => error === original);
  } else {
    const open = fs.openSync, write = fs.writeFileSync;
    const mocks = [
      t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); if (args[1] === 'wx') temporary = args[0]; return fd; }),
      t.mock.method(fs, 'writeFileSync', (...args) => {
        if (typeof args[0] !== 'number') return write(...args);
        fs.renameSync(temporary, temporary + '.owned-original');
        write(temporary, 'peer-owned', { flag: 'wx', mode: 0o600 }); throw original;
      }),
    ];
    syncBuiltinESMExports(); t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
    assert.throws(() => writePrivateFileSync(path, 'new'), error => error === original);
  }
  assert.equal(readFileSync(path, 'utf8'), 'old');
  assert.equal(readFileSync(temporary, 'utf8'), 'peer-owned');
});

for (const asynchronous of [false, true]) test(`${asynchronous ? 'async' : 'sync'} publisher refuses a replaced temporary leaf before publishing`, { skip: process.platform === 'win32' }, async t => {
  const root = fixture(t), path = join(root, 'settings.json'); writeFileSync(path, 'old');
  let temporary, swapped = false;
  if (asynchronous) {
    const open = fsPromises.open;
    const mocked = t.mock.method(fsPromises, 'open', async (...args) => {
      const file = await open(...args);
      if (args[1] === 'wx') {
        temporary = args[0]; const close = file.close.bind(file);
        file.close = async () => {
          await close();
          if (!swapped) {
            swapped = true; await fsPromises.rename(temporary, temporary + '.owned-original');
            await fsPromises.writeFile(temporary, 'peer-owned', { flag: 'wx', mode: 0o600 });
          }
        };
      }
      return file;
    });
    syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    await assert.rejects(writePrivateFile(path, 'new'), { code: 'CONFIG_FILE_CHANGED' });
  } else {
    const open = fs.openSync, close = fs.closeSync; let ownedFd;
    const mocks = [
      t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); if (args[1] === 'wx') { temporary = args[0]; ownedFd = fd; } return fd; }),
      t.mock.method(fs, 'closeSync', fd => {
        close(fd);
        if (fd === ownedFd && !swapped) {
          swapped = true; fs.renameSync(temporary, temporary + '.owned-original');
          writeFileSync(temporary, 'peer-owned', { flag: 'wx', mode: 0o600 });
        }
      }),
    ];
    syncBuiltinESMExports(); t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
    assert.throws(() => writePrivateFileSync(path, 'new'), { code: 'CONFIG_FILE_CHANGED' });
  }
  assert.equal(readFileSync(path, 'utf8'), 'old');
  assert.equal(readFileSync(temporary, 'utf8'), 'peer-owned');
});

test('byte and string input both reject a second leading BOM instead of decoding it away twice', () => {
  for (const raw of ['\ufeff\ufeff{}', '\ufeff\ufeff\ufeff{}']) {
    assert.throws(() => parseVersionedJsonc(raw, 1), { code: 'CONFIG_JSONC_INVALID' });
    assert.throws(() => parseVersionedJsonc(Buffer.from(raw), 1), { code: 'CONFIG_JSONC_INVALID' });
  }
});
