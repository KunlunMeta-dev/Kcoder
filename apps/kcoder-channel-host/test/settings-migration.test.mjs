import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { ChannelSettingsFile } from '../src/channels/settings.mjs';
import { decodeStudioSettings } from '../src/channels/migrations/settings.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/settings/${name}`, import.meta.url));
function storage(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kcoder-settings-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'settings.json'), store: new ChannelSettingsFile(directory) };
}
const backupPath = (path, bytes) => `${path}.v1-${createHash('sha256').update(bytes).digest('hex')}.bak`;

test('all supported v1 layouts convert deterministically in memory and retain unknown fields', () => {
  for (const source of [fixture('gateway-v1-flat.jsonc'), fixture('gateway-v1-nested.jsonc'),
    Buffer.from('{"channels":{"mirror_client_turns":true}}'), Buffer.from('{"mirror_client_turns":false}'), Buffer.from('{}')]) {
    const migrated = decodeStudioSettings(source);
    assert.equal(migrated.sourceVersion, 1);
    assert.equal(migrated.document.meta.config_version, 3);
    assert.equal(typeof migrated.document.channels.mirror_client_turns, 'boolean');
    assert.equal(Object.hasOwn(migrated.document, 'config_version'), false);
    assert.equal(Object.hasOwn(migrated.document, 'mirror_client_turns'), false);
    assert.deepEqual(decodeStudioSettings(JSON.stringify(migrated.document)).document, migrated.document);
  }
  assert.equal(decodeStudioSettings(fixture('gateway-v1-flat.jsonc')).document.appearance.theme, 'dark');
  assert.equal(decodeStudioSettings(fixture('gateway-v1-nested.jsonc')).document.channels.future_option, 3);
});

test('repeated reads do not rewrite v1; first save backs up original bytes and publishes v3 once', t => {
  for (const name of ['gateway-v1-flat.jsonc', 'gateway-v1-nested.jsonc']) {
    const { directory, path, store } = storage(t), original = fixture(name);
    writeFileSync(path, original, { mode: 0o600 });
    const before = statSync(path), expected = name.includes('flat');
    for (let i = 0; i < 30; i++) assert.equal(store.read().mirrorClientTurns, expected);
    assert.deepEqual(readFileSync(path), original);
    assert.equal(statSync(path).mtimeMs, before.mtimeMs);
    assert.equal(statSync(path).ino, before.ino);
    assert.equal(statSync(path).ctimeMs, before.ctimeMs);
    assert.deepEqual(readdirSync(directory), ['settings.json']);
    store.write({ mirrorClientTurns: expected });
    const migrated = readFileSync(path, 'utf8'), document = parse(migrated);
    assert.equal(document.meta.config_version, 3);
    assert.equal(document.channels.mirror_client_turns, expected);
    assert.deepEqual(document, decodeStudioSettings(original).document);
    assert.equal(Object.hasOwn(document, 'config_version'), false);
    assert.equal(Object.hasOwn(document, 'mirror_client_turns'), false);
    assert.ok(migrated.includes('Unrelated preferences') || migrated.includes('Keep the explicit choice'));
    const backup = backupPath(path, original);
    assert.deepEqual(readFileSync(backup), original);
    const backupBefore = statSync(backup);
    store.write({ mirrorClientTurns: !expected });
    assert.equal(readdirSync(directory).filter(name => name.endsWith('.bak')).length, 1);
    assert.equal(statSync(backup).mtimeMs, backupBefore.mtimeMs);
    assert.deepEqual(readFileSync(backup), original);
  }
});

test('v1 punctuation and comments survive upgrade; original BOM bytes remain in the backup', t => {
  for (const source of ['{"mirror_client_turns":true}', '{"other":7,"mirror_client_turns":true}',
    '{"mirror_client_turns":true,"other":7}', '{"config_version":1,/*version*/"mirror_client_turns":true,/*flag*/}',
    '{"channels":{"mirror_client_turns":true},"mirror_client_turns":true}']) {
    const { path, store } = storage(t), original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)]);
    writeFileSync(path, original);
    store.write({ mirrorClientTurns: true });
    const saved = readFileSync(path, 'utf8');
    assert.notEqual(saved.charCodeAt(0), 0xfeff, 'published JSONC normalizes the optional BOM');
    assert.deepEqual(parse(saved), decodeStudioSettings(original).document);
    assert.deepEqual(readFileSync(backupPath(path, original)), original, 'the original BOM is retained in the byte-exact backup');
    if (source.includes('/*version*/')) { assert.ok(saved.includes('/*version*/')); assert.ok(saved.includes('/*flag*/')); }
    assert.deepEqual(readFileSync(backupPath(path, original)), original);
  }
});

test('fresh settings use v3 directly without manufacturing a v1 backup', t => {
  const { directory, path, store } = storage(t);
  assert.equal(store.read().mirrorClientTurns, false);
  assert.deepEqual(readdirSync(directory), []);
  store.write({ mirrorClientTurns: false });
  assert.equal(parse(readFileSync(path, 'utf8')).meta.config_version, 3);
  assert.deepEqual(readdirSync(directory), ['settings.json']);
});

test('a settings file created after the initial read is preserved instead of replaced', t => {
  const { path, store } = storage(t);
  const read = store.readDocument.bind(store);
  const concurrent = '{"meta":{"config_version":2},"other_domain":{"keep":true}}\n';
  store.readDocument = () => {
    const loaded = read();
    writeFileSync(path, concurrent, { mode: 0o600 });
    return loaded;
  };
  assert.throws(() => store.write({ mirrorClientTurns: true }), /CHANNEL_SETTINGS_CHANGED/);
  assert.equal(readFileSync(path, 'utf8'), concurrent);
});

test('future versions, conflicting choices and corrupt files remain byte-for-byte unchanged', t => {
  const { directory, path, store } = storage(t);
  for (const [source, message] of [
    ['{"meta":{"config_version":4}}', 'CHANNEL_SETTINGS_VERSION_UNSUPPORTED'],
    ['{"config_version":99,"mirror_client_turns":true}', 'CHANNEL_SETTINGS_VERSION_UNSUPPORTED'],
    ['{"meta":{"config_version":1},"mirror_client_turns":true,"channels":{"mirror_client_turns":false}}', 'CHANNEL_SETTINGS_MIGRATION_CONFLICT'],
    ['{"mirror_client_turns":"true"}', 'CHANNEL_SETTINGS_INVALID'], ['{bad', 'CHANNEL_SETTINGS_INVALID']]) {
    writeFileSync(path, source);
    assert.throws(() => store.read(), { message });
    assert.throws(() => store.write({ mirrorClientTurns: false }), { message });
    assert.equal(readFileSync(path, 'utf8'), source);
    assert.deepEqual(readdirSync(directory), ['settings.json']);
  }
});

test('a blocked or mismatching backup prevents migration; retry reuses a confirmed original backup', t => {
  const { path, store } = storage(t), original = fixture('gateway-v1-flat.jsonc');
  writeFileSync(path, original);
  const backup = backupPath(path, original);
  mkdirSync(backup);
  assert.throws(() => store.write({ mirrorClientTurns: true }), /CHANNEL_SETTINGS_BACKUP_CONFLICT/);
  assert.deepEqual(readFileSync(path), original);
  rmSync(backup, { recursive: true });
  writeFileSync(backup, 'not the original');
  assert.throws(() => store.write({ mirrorClientTurns: true }), /BACKUP_CONFLICT/);
  assert.equal(readFileSync(backup, 'utf8'), 'not the original');
  assert.deepEqual(readFileSync(path), original);
  writeFileSync(backup, original, { mode: 0o600 });
  const before = statSync(backup);
  store.write({ mirrorClientTurns: true });
  assert.equal(parse(readFileSync(path, 'utf8')).meta.config_version, 3);
  assert.deepEqual(readFileSync(backup), original);
  assert.equal(statSync(backup).mtimeMs, before.mtimeMs);
});


test('channel restrictions preserve unrelated JSONC settings and old-client partial saves', t => {
  const { store, path } = storage(t);
  writeFileSync(path, '{\n // keep my model\n "meta":{"config_version":2}, "model":"mine", "channels":{"mirror_client_turns":true,"future":1}\n}');
  const original = readFileSync(path, 'utf8');
  assert.ok(store.read().toolRestrictions.disabledTools.includes('AskUserQuestion'));
  assert.equal(readFileSync(path, 'utf8'), original, 'reading defaults never rewrites settings');
  const policy = { enabled: true, disabledTools: ['WebSearch', 'AskUserQuestion', 'WebSearch'] };
  store.write({ toolRestrictions: policy });
  assert.deepEqual(store.read().toolRestrictions, { enabled: true, disabledTools: ['AskUserQuestion', 'WebSearch'] });
  assert.equal(store.read().mirrorClientTurns, true);
  assert.deepEqual(new ChannelSettingsFile(dirname(store.path)).read(), store.read());
  store.write({ mirrorClientTurns: false });
  assert.deepEqual(store.read().toolRestrictions.disabledTools, ['AskUserQuestion', 'WebSearch']);
  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('// keep my model'));
  assert.equal(parse(saved).channels.future, 1);
  for (const disabledTools of [['bad name'], [''], ['x'.repeat(257)], Array(129).fill('x')]) {
    assert.throws(() => store.write({ toolRestrictions: { enabled: true, disabledTools } }), /CHANNEL_SETTINGS_INVALID/);
    assert.equal(readFileSync(path, 'utf8'), saved);
  }
});

test('saving restrictions while upgrading v1 also preserves its mirror setting', t => {
  const { store, path } = storage(t);
  writeFileSync(path, '{"mirror_client_turns":true}');
  store.write({ toolRestrictions: { enabled: false, disabledTools: ['AskUserQuestion'] } });
  assert.equal(store.read().mirrorClientTurns, true);
  assert.deepEqual(store.read().toolRestrictions, { enabled: false, disabledTools: ['AskUserQuestion'] });
});

test('unknown prototype-named data is retained without supplying inherited channel settings', t => {
  const { store, path } = storage(t);
  const raw = '{"meta":{"config_version":2},"__proto__":{"channels":{"mirror_client_turns":true}},"other":{"id":"__proto__"}}';
  writeFileSync(path, raw);
  assert.equal(store.read().mirrorClientTurns, false);
  store.write({ mirrorClientTurns: false });
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(saved.__proto__, JSON.parse(raw).__proto__);
  assert.equal(saved.other.id, '__proto__');
  assert.equal(Object.getPrototypeOf(saved), Object.prototype);
});
