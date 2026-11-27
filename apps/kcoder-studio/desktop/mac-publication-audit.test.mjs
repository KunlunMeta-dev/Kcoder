import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import test from 'node:test';
import { buildFrozenMac } from './build-macos.mjs';

async function fixture(t, kind = 'artifact') {
  const root = await fs.mkdtemp(join(tmpdir(), 'mac-publication-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '--quiet');
  const desktop = join(root, 'apps/kcoder-studio/desktop');
  await fs.mkdir(desktop, { recursive: true });
  await fs.writeFile(join(desktop, 'build-macos.mjs'), `import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
process.once('message', async claim => {
  const output = join(claim.checkout, 'target/packages/kcoder-studio/macos');
  await mkdir(output, { recursive: true });
  if (process.env.KCODER_TEST_OUTPUT_KIND === 'bundle') {
    const framework = join(output, 'KCoder.app/Contents/Frameworks/Test.framework');
    await mkdir(join(framework, 'Versions/A'), { recursive: true });
    await writeFile(join(framework, 'Versions/A/runtime'), 'owned bundle bytes');
    await symlink('A', join(framework, 'Versions/Current'));
    await symlink('Versions/Current/runtime', join(framework, 'runtime'));
  } else await writeFile(join(output, 'owned.dmg'), 'owned artifact bytes');
  process.disconnect();
});
`);
  git('add', 'apps'); git('commit', '--quiet', '-m', 'owned publication fixture');
  const commit = git('rev-parse', 'HEAD'), tools = join(root, 'fixture-tools');
  await fs.mkdir(tools);
  for (const name of ['pnpm', 'npm']) await fs.writeFile(join(tools, name), '#!/usr/bin/env node\n', { mode: 0o755 });
  const outside = join(root, 'outside.txt'); await fs.writeFile(outside, 'peer data remains intact');
  return { root, outside, identity: { packagingSource: { commit, dirty: false } },
    options: { sourceRoot: root, environment: { PATH: `${tools}:${process.env.PATH}`, HOME: root, KCODER_TEST_OUTPUT_KIND: kind } } };
}

function replaceCopy(t, callback) {
  const original = fs.cp;
  const mock = t.mock.method(fs, 'cp', (...args) => callback(original, ...args));
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

for (const kind of ['absolute', 'relative']) test(`publication rejects an escaping ${kind} link introduced after output validation`, async t => {
  const f = await fixture(t);
  let injected = false;
  replaceCopy(t, async (copy, source, destination, options) => {
    if (!injected && basename(source) === 'owned.dmg') {
      injected = true;
      await fs.rm(source);
      const link = kind === 'absolute' ? f.outside : relative(dirname(destination), f.outside);
      await fs.symlink(link, source);
    }
    return copy(source, destination, options);
  });
  const messages = [], logger = t.mock.method(console, 'log', value => messages.push(String(value)));
  try {
    await assert.rejects(buildFrozenMac(f.identity, f.options), /output|publication|copy/i);
  } finally { logger.mock.restore(); }
  assert.equal(injected, true, 'the race must occur after the initial output-tree check');
  assert.equal(messages.some(value => value.startsWith('Frozen macOS output:')), false);
  assert.equal(await fs.readFile(f.outside, 'utf8'), 'peer data remains intact');
});

test('publication refuses a replacement destination even when its new tree contains only ordinary files', async t => {
  const f = await fixture(t); let replacement;
  replaceCopy(t, async (copy, source, destination, options) => {
    await copy(source, destination, options);
    if (!replacement) {
      replacement = dirname(destination);
      await fs.rename(replacement, `${replacement}-original`);
      await fs.mkdir(replacement, { mode: 0o700 });
      await fs.writeFile(join(replacement, 'peer.txt'), 'replacement owner data');
    }
  });
  await assert.rejects(buildFrozenMac(f.identity, f.options), /output|publication|copy/i);
  assert.ok(replacement);
  assert.equal(await fs.readFile(join(replacement, 'peer.txt'), 'utf8'), 'replacement owner data');
  assert.equal(await fs.readFile(f.outside, 'utf8'), 'peer data remains intact');
});

test('publication refuses a replaced build-output root after its artifact copy completes', async t => {
  const f = await fixture(t); let replaced = false;
  replaceCopy(t, async (copy, source, destination, options) => {
    await copy(source, destination, options);
    if (!replaced) {
      replaced = true;
      const output = dirname(source);
      await fs.rename(output, `${output}-original`);
      await fs.mkdir(output, { mode: 0o700 });
      await fs.writeFile(join(output, 'replacement.txt'), 'different output tree');
    }
  });
  await assert.rejects(buildFrozenMac(f.identity, f.options), /output|publication|copy/i);
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(f.outside, 'utf8'), 'peer data remains intact');
});

test('publication preserves legal internal framework links and their referent bytes', async t => {
  const f = await fixture(t, 'bundle');
  const output = await buildFrozenMac(f.identity, f.options);
  const framework = join(output, 'KCoder.app/Contents/Frameworks/Test.framework');
  assert.equal(await fs.readlink(join(framework, 'Versions/Current')), 'A');
  assert.equal(await fs.readlink(join(framework, 'runtime')), 'Versions/Current/runtime');
  assert.equal(await fs.readFile(join(framework, 'runtime'), 'utf8'), 'owned bundle bytes');
  assert.equal(await fs.readFile(f.outside, 'utf8'), 'peer data remains intact');
});
