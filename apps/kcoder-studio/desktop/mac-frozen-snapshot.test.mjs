import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runFrozenOwned, withFrozenMacSnapshot } from './mac-frozen-snapshot.mjs';
import { buildFrozenMac } from './build-macos.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mac-snapshot-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: root, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  run('init', '--quiet'); await writeFile(join(root, 'input.txt'), 'committed A\n');
  run('add', 'input.txt'); run('commit', '--quiet', '-m', 'fixture');
  return { root, commit: run('rev-parse', 'HEAD') };
}

test('private frozen checkout continues to read committed bytes during transient live edits', async t => {
  const { root, commit } = await fixture(t); let snapshot;
  await withFrozenMacSnapshot({ sourceRoot: root, commit }, async ({ checkout }) => {
    snapshot = checkout;
    assert.notEqual(checkout, root);
    await writeFile(join(root, 'input.txt'), 'transient B\n');
    assert.equal(await readFile(join(checkout, 'input.txt'), 'utf8'), 'committed A\n');
    await writeFile(join(root, 'input.txt'), 'committed A\n');
    assert.equal(await readFile(join(checkout, 'input.txt'), 'utf8'), 'committed A\n');
  });
  await assert.rejects(readFile(join(snapshot, 'input.txt')), { code: 'ENOENT' });
});

test('missing commits and linked source entries cannot be certified as snapshots', async t => {
  const { root, commit } = await fixture(t);
  await assert.rejects(withFrozenMacSnapshot({ sourceRoot: root, commit: 'f'.repeat(40) }, async () => {}), /materialize/);
  await assert.rejects(withFrozenMacSnapshot({ sourceRoot: root, commit: 'not-a-commit' }, async () => {}), /commit/);
  const { symlink } = await import('node:fs/promises');
  await symlink('/outside', join(root, 'external-link'));
  const run = (...args) => execFileSync('git', args, { cwd: root, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  run('add', 'external-link'); run('commit', '--quiet', '-m', 'add link');
  await assert.rejects(withFrozenMacSnapshot({ sourceRoot: root, commit: run('rev-parse', 'HEAD') }, async () => {}), /unsupported links/);
  assert.equal(await readFile(join(root, 'input.txt'), 'utf8'), 'committed A\n');
  assert.match(commit, /^[a-f0-9]{40}$/);
});


test('owned build process and IPC handshake settle before its checkout is removed', async t => {
  const { root, commit } = await fixture(t); let snapshot;
  await withFrozenMacSnapshot({ sourceRoot: root, commit }, async ({ checkout }) => {
    snapshot = checkout;
    const script = "process.once('message', m => { if (m.expected !== 'owned') process.exitCode = 1; process.disconnect(); });";
    await runFrozenOwned(process.execPath, ['-e', script], { cwd: checkout, env: process.env, handshake: { expected: 'owned' } });
  });
  await assert.rejects(readFile(join(snapshot, 'input.txt')), { code: 'ENOENT' });
});

test('unconfirmed process-group termination retains the owned checkout', async t => {
  const { root, commit } = await fixture(t); let retained;
  const mock = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('owned group probe denied'), { code: 'EPERM' }); });
  try {
    await assert.rejects(withFrozenMacSnapshot({ sourceRoot: root, commit }, async ({ checkout }) => {
      await runFrozenOwned(process.execPath, ['-e', ''], { cwd: checkout, env: process.env });
    }), error => { retained = error.ownedSnapshot; return error.retainOwnedSnapshot === true && Boolean(retained); });
  } finally { mock.mock.restore(); }
  assert.equal(await readFile(join(retained, 'source', 'input.txt'), 'utf8'), 'committed A\n');
  await rm(retained, { recursive: true, force: true });
});


test('frozen orchestration installs offline, runs from the private checkout and retains its output', async t => {
  const { root } = await fixture(t);
  const childPath = join(root, 'apps/kcoder-studio/desktop/build-macos.mjs');
  await mkdir(join(root, 'apps/kcoder-studio/desktop'), { recursive: true });
  await writeFile(childPath, `import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
process.once('message', async claim => {
  if (process.cwd() !== claim.checkout || process.env.CARGO_TARGET_DIR !== join(claim.checkout, 'target')) process.exit(2);
  if (process.env.KCODER_TEST_ESCAPE) {
    await mkdir(process.env.KCODER_TEST_ESCAPE, { recursive: true });
    await symlink(process.env.KCODER_TEST_ESCAPE, join(claim.checkout, 'target'));
  }
  const out = join(claim.checkout, 'target/packages/kcoder-studio/macos');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'owned.dmg'), JSON.stringify({ checkout: claim.checkout, commit: claim.commit }));
  process.disconnect();
});
`);
  const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const run = (...args) => execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  run('add', 'apps'); run('commit', '--quiet', '-m', 'snapshot child');
  const commit = run('rev-parse', 'HEAD');
  const bin = join(root, 'fixture-tools'); await mkdir(bin);
  const shim = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.KCODER_TEST_INSTALL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`;
  for (const name of ['pnpm', 'npm']) await writeFile(join(bin, name), shim, { mode: 0o755 });
  const log = join(root, 'owned-install-log');
  const output = await buildFrozenMac({ packagingSource: { commit, dirty: false } }, {
    sourceRoot: root, environment: { PATH: `${bin}:${process.env.PATH}`, HOME: root, KCODER_TEST_INSTALL_LOG: log },
  });
  const proof = JSON.parse(await readFile(join(output, 'owned.dmg'), 'utf8'));
  assert.equal(proof.commit, commit);
  assert.notEqual(proof.checkout, root);
  await assert.rejects(readFile(join(proof.checkout, 'input.txt')), { code: 'ENOENT' });
  const installs = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(installs.length, 3);
  assert.ok(installs.every(args => args.includes('--offline')));
  assert.ok(installs.slice(0, 3).every(args => args.includes('--frozen-lockfile')));
  assert.ok(installs[2].includes(join(proof.checkout, 'apps/kcoder-studio/skill-runtime')) && installs[2].includes('--ignore-scripts'),
    'the skill runtime installs from its own lockfile without lifecycle scripts');
  assert.ok(installs.slice(3).every(args => args.includes('ci')));
  await assert.rejects(buildFrozenMac({ packagingSource: { commit, dirty: false } }, {
    sourceRoot: root, environment: { PATH: `${bin}:${process.env.PATH}`, HOME: root, KCODER_TEST_INSTALL_LOG: log, KCODER_TEST_ESCAPE: join(root, 'outside') },
  }), /output ancestor/);
  await rm(join(root, 'target'), { recursive: true, force: true });
  const peer = join(root, 'peer'); await mkdir(peer);
  const { lstat, symlink } = await import('node:fs/promises');
  await symlink(peer, join(root, 'target'));
  await assert.rejects(buildFrozenMac({ packagingSource: { commit, dirty: false } }, {
    sourceRoot: root, environment: { PATH: `${bin}:${process.env.PATH}`, HOME: root, KCODER_TEST_INSTALL_LOG: log },
  }), /publication ancestor/);
  await assert.rejects(lstat(join(peer, 'packages')), { code: 'ENOENT' });
});


test('forged IPC cannot invoke the frozen child from the shared source checkout', async t => {
  const { root } = await fixture(t);
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const script = fileURLToPath(new URL('./build-macos.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--owned-frozen-child'], { cwd: repository,
    env: { ...process.env, KCODER_RELEASE_IDENTITY_FILE: join(root, 'identity.json') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', part => { diagnostic += part; });
  child.send({ version: 1, root: dirname(repository.replace(/\/$/, '')), checkout: repository, sourceRoot: root, commit: 'a'.repeat(40) });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 1);
  assert.match(diagnostic, /private owned source snapshot/);
});

test('interrupting an owned build forwards termination and waits for its child', async t => {
  const { root } = await fixture(t);
  const pidFile = join(root, 'owned-child.pid');
  const helperUrl = new URL('./mac-frozen-snapshot.mjs', import.meta.url).href;
  const childScript = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const wrapperScript = `import { runFrozenOwned } from ${JSON.stringify(helperUrl)};
try { await runFrozenOwned(process.execPath, ['-e', ${JSON.stringify(childScript)}], { cwd: ${JSON.stringify(root)}, env: process.env }); }
catch (error) { process.exitCode = error.interruptedSignal === 'SIGTERM' ? 143 : 2; }`;
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperScript], { cwd: root, stdio: 'ignore' });
  t.after(() => { if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGTERM'); });
  let childPid;
  for (let attempt = 0; attempt < 100 && !childPid; attempt++) {
    childPid = await readFile(pidFile, 'utf8').then(Number).catch(() => null);
    if (!childPid) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  wrapper.kill('SIGTERM');
  const code = await new Promise((resolve, reject) => { wrapper.once('error', reject); wrapper.once('close', resolve); });
  assert.equal(code, 143);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});

test('a symlinked temporary directory is resolved before snapshot paths are handed to the child', async t => {
  const { root, commit } = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), 'mac-snapshot-temp-root-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const { realpath, symlink } = await import('node:fs/promises');
  const actual = join(external, 'actual'), alias = join(external, 'alias');
  await mkdir(actual); await symlink(actual, alias);
  const original = process.env.TMPDIR;
  process.env.TMPDIR = alias;
  try {
    await withFrozenMacSnapshot({ sourceRoot: root, commit }, async ({ root: owned, checkout }) => {
      assert.equal(owned, await realpath(owned));
      assert.equal(checkout, join(owned, 'source'));
    });
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
  }
});
