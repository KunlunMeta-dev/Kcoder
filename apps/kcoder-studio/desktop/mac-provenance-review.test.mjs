import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { link, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMacFrozenIdentityUnchanged, macBuildIdentity, macDevelopmentIdentity } from './build-macos.mjs';
import { cargoPackageVersion } from '../../../scripts/release/artifact-manifest.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
async function frozen(t) {
  const root = await mkdtemp(join(tmpdir(), 'mac-provenance-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const studio = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
  const cli = cargoPackageVersion(await readFile(new URL('../../../crates/kcoder_cli/Cargo.toml', import.meta.url), 'utf8'), await readFile(new URL('../../../Cargo.toml', import.meta.url), 'utf8'));
  const identity = { packagingSource: { commit: 'a'.repeat(40), dirty: false }, versions: { cli: studio, cliNative: cli, studio, mobile: studio } };
  const file = join(root, 'identity.json'); await writeFile(file, JSON.stringify(identity));
  return { identity, env: { KCODER_RELEASE_IDENTITY_FILE: file } };
}

function gitFixture(t, result) {
  const mock = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    assert.equal(command, 'git'); assert.equal(options.cwd, repository);
    return result(args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

test('a failed Git status cannot certify a clean frozen macOS build', async t => {
  const { env } = await frozen(t);
  gitFixture(t, args => {
    if (args.includes('--show-toplevel')) return repository + '\n';
    if (args[0] === 'rev-parse') return 'a'.repeat(40) + '\n';
    throw Object.assign(new Error('owned status read failure'), { code: 'EIO' });
  });
  await assert.rejects(macBuildIdentity(env), /source|Git|checkout/i);
});

test('a containing Git repository cannot certify an unversioned source archive', async t => {
  const { env } = await frozen(t);
  gitFixture(t, args => args.includes('--show-toplevel') ? dirname(repository) + '\n'
    : args[0] === 'rev-parse' ? 'a'.repeat(40) + '\n' : '');
  await assert.rejects(macBuildIdentity(env), /source|Git|checkout/i);
});

test('verified checkout accepts the frozen identity without inheriting ambient Git routing', async t => {
  const { env, identity } = await frozen(t), original = process.env.GIT_DIR;
  process.env.GIT_DIR = '/owned/unrelated-git-directory';
  t.after(() => { if (original === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = original; });
  gitFixture(t, (args, options) => {
    assert.equal(options.env.GIT_DIR, undefined);
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    if (args[0] === 'ls-files') return 'H source.mjs\0';
    return args.includes('--show-toplevel') ? repository + '\n' : args[0] === 'rev-parse' ? 'a'.repeat(40) + '\n' : '';
  });
  assert.deepEqual(await macBuildIdentity(env), identity);
});

test('unavailable archive provenance stays rejected even with an explicit frozen commit', async t => {
  const { env, identity } = await frozen(t);
  gitFixture(t, () => { throw new Error('owned no-Git archive'); });
  await assert.rejects(macBuildIdentity({ ...env, KCODER_BUILD_COMMIT: identity.packagingSource.commit }), /source|Git|checkout/i);
});

test('a dirty frozen identity cannot prove which source bytes are being built', async t => {
  const { env, identity } = await frozen(t);
  identity.packagingSource.dirty = true;
  await writeFile(env.KCODER_RELEASE_IDENTITY_FILE, JSON.stringify(identity));
  await assert.rejects(macBuildIdentity(env, () => ({ commit: identity.packagingSource.commit, dirty: true })),
    /dirty|clean|provenance/i);
});

test('a clean frozen identity must match the current commit and CLI version', async t => {
  const { env, identity } = await frozen(t);
  await assert.rejects(macBuildIdentity(env, () => ({ commit: 'b'.repeat(40), dirty: false })), /source|checkout/i);
  identity.versions.cli = '0.0.0';
  await writeFile(env.KCODER_RELEASE_IDENTITY_FILE, JSON.stringify(identity));
  await assert.rejects(macBuildIdentity(env, () => ({ commit: 'a'.repeat(40), dirty: false })), /version/i);
});

test('untracked source cannot be treated as a clean frozen checkout', async t => {
  const { env } = await frozen(t);
  gitFixture(t, args => {
    if (args.includes('--show-toplevel')) return repository + '\n';
    if (args[0] === 'rev-parse') return 'a'.repeat(40) + '\n';
    if (args[0] === 'ls-files') return 'H source.mjs\0';
    return args.includes('--untracked-files=no') ? '' : '?? untracked-source.mjs\n';
  });
  await assert.rejects(macBuildIdentity(env), /dirty|clean|source|checkout/i);
});

for (const flag of ['h', 'S']) test(`a ${flag} index flag cannot certify a frozen clean checkout`, async t => {
  const { env } = await frozen(t);
  gitFixture(t, args => {
    if (args.includes('--show-toplevel')) return repository + '\n';
    if (args[0] === 'rev-parse') return 'a'.repeat(40) + '\n';
    if (args[0] === 'ls-files') return `${flag} source.mjs\0`;
    return '';
  });
  await assert.rejects(macBuildIdentity(env), /source|Git|checkout/i);
});

test('a HEAD change during the Git probe cannot certify the earlier revision', async t => {
  const { env } = await frozen(t); let heads = 0;
  gitFixture(t, args => {
    if (args.includes('--show-toplevel')) return repository + '\n';
    if (args[0] === 'rev-parse') return (++heads === 1 ? 'a' : 'b').repeat(40) + '\n';
    if (args[0] === 'ls-files') return 'H source.mjs\0';
    return '';
  });
  await assert.rejects(macBuildIdentity(env), /source|Git|checkout/i);
});

test('non-frozen development remains available when Git identity is unknown', () => {
  assert.deepEqual(macDevelopmentIdentity(() => { throw new Error('Git unavailable'); }), { commit: null, dirty: true });
});

test('the frozen source identity must remain unchanged across build phases', async () => {
  const original = { packagingSource: { commit: 'a'.repeat(40), dirty: false }, versions: { cli: '1' } };
  const expected = JSON.stringify(original);
  await assertMacFrozenIdentityUnchanged(expected, {}, async () => structuredClone(original));
  await assert.rejects(assertMacFrozenIdentityUnchanged(expected, {}, async () => ({
    ...original, packagingSource: { ...original.packagingSource, commit: 'b'.repeat(40) },
  })), /changed during packaging/);
  await assert.rejects(assertMacFrozenIdentityUnchanged(expected, {}, async () => undefined), /changed during packaging/);
});

test('frozen identity rejects a symlink', { skip: process.platform === 'win32' }, async t => {
  const { env, identity } = await frozen(t);
  const original = env.KCODER_RELEASE_IDENTITY_FILE;
  const linked = original + '.symlink';
  await symlink(original, linked);
  await assert.rejects(macBuildIdentity({ KCODER_RELEASE_IDENTITY_FILE: linked }, () => identity.packagingSource));
});

test('frozen identity rejects hardlinks and invalid UTF-8', async t => {
  const { env, identity } = await frozen(t);
  const original = env.KCODER_RELEASE_IDENTITY_FILE;
  const hardlink = original + '.hardlink';
  await link(original, hardlink);
  await assert.rejects(macBuildIdentity(env, () => identity.packagingSource), /identity file/i);
  await rm(hardlink);
  await writeFile(original, Buffer.from([0xff, 0xfe]));
  await assert.rejects(macBuildIdentity(env, () => identity.packagingSource));
});
