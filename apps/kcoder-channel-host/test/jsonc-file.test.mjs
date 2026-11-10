import assert from 'node:assert/strict';
import test from 'node:test';
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
  for (const value of ['null', '[]', '{bad', '{"meta":null}', '{"$schema":4}', '{"meta":{"config_version":null}}', '{"meta":{"config_version":99}}']) {
    assert.throws(() => parseVersionedJsonc(value, 1));
  }
  const corrupt = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  assert.throws(() => parseVersionedJsonc(corrupt, 1), { code: 'CONFIG_JSONC_INVALID' });
});

test('both readers reject oversized, linked and nonregular files without changing them', async t => {
  const root = fixture(t), path = join(root, 'settings.json');
  writeFileSync(path, '{"value":1}');
  for (const read of [readBoundedFile, readBoundedFileSync]) {
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

test('both private publishers preserve prior data on size/rename failures and clean only their temporary file', async t => {
  const root = fixture(t), path = join(root, 'settings.json'), directory = join(root, 'directory');
  mkdirSync(directory);
  for (const write of [writePrivateFile, writePrivateFileSync]) {
    writeFileSync(path, 'old');
    await assert.rejects(async () => write(path, 'too large', 3), { code: 'CONFIG_FILE_TOO_LARGE' });
    assert.equal(readFileSync(path, 'utf8'), 'old');
    await assert.rejects(async () => write(directory, 'new'));
    assert.deepEqual(readdirSync(root).sort(), ['directory', 'settings.json']);
    await write(path, 'new', 3);
    assert.equal(readFileSync(path, 'utf8'), 'new');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});
