import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { chownSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const deploy = fileURLToPath(new URL('../deploy/', import.meta.url));
const rootTest = process.platform === 'linux' && process.getuid?.() === 0 ? test : test.skip;

function stage(t) {
  const root = `/var/tmp/kcoder-relay-deploy-${randomBytes(12).toString('hex')}`;
  mkdirSync(root);
  mkdirSync(join(root, 'deploy'));
  for (const script of ['relay-host.sh', 'stun-host.sh']) copyFileSync(join(deploy, script), join(root, 'deploy', script));
  for (const module of ['relay-lifecycle.mjs', 'stun-lifecycle.mjs']) {
    writeFileSync(join(root, 'deploy', module), "console.log('owned-helper');\n");
  }
  writeFileSync(join(root, 'deploy/caddy-lifecycle.mjs'), '');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(script, args = [], env = {}) {
  return spawnSync('/bin/bash', [script, ...args], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
}

rootTest('privileged wrappers resolve their real source without enforcing helper modes', t => {
  const root = stage(t);
  const links = mkdtempSync('/tmp/kcoder-relay-wrapper-links-');
  t.after(() => rmSync(links, { recursive: true, force: true }));
  for (const [script, helper] of [['relay-host.sh', 'relay-lifecycle.mjs'], ['stun-host.sh', 'stun-lifecycle.mjs']]) {
    const link = join(links, script);
    symlinkSync(join(root, 'deploy', script), link);
    writeFileSync(join(links, helper), "console.log('wrong-helper');\n");
    const args = script === 'relay-host.sh' ? ['status', '--stage-dir', root] : ['status'];
    const result = run(link, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'owned-helper');
    chmodSync(join(root, 'deploy', helper), 0o666);
    const changedMode = run(link, args);
    assert.equal(changedMode.status, 0, changedMode.stderr);
    assert.equal(changedMode.stdout.trim(), 'owned-helper');
  }
});

rootTest('private authorized deployment stages may belong to the invoking deployment user', t => {
  const root = stage(t);
  for (const path of [root, join(root, 'deploy'), ...['relay-host.sh', 'stun-host.sh', 'relay-lifecycle.mjs', 'stun-lifecycle.mjs', 'caddy-lifecycle.mjs'].map(file => join(root, 'deploy', file))]) {
    chownSync(path, 65534, 65534);
  }
  for (const [script, args] of [['relay-host.sh', ['status', '--stage-dir', root]], ['stun-host.sh', ['status']]]) {
    const result = run(join(root, 'deploy', script), args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'owned-helper');
  }
});

rootTest('privileged STUN execution refuses fixture mode before invoking any helper', t => {
  const root = stage(t);
  const result = run(join(root, 'deploy/stun-host.sh'), ['status'], { KCODER_STUN_FIXTURE_ROOT: root });
  assert.equal(result.status, 4);
  assert.match(result.stderr, /ordinary user/);
  assert.equal(result.stdout, '');
});

test('compatibility update entry resolves symlinks and fails clearly when its module is absent', { skip: process.platform !== 'linux' }, t => {
  const root = mkdtempSync('/tmp/kcoder-relay-update-wrapper-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'deploy'));
  mkdirSync(join(root, 'src'));
  copyFileSync(join(deploy, 'update-server.sh'), join(root, 'deploy/update-server.sh'));
  writeFileSync(join(root, 'src/deploy.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  symlinkSync(join(root, 'deploy/update-server.sh'), join(root, 'update'));
  const result = run(join(root, 'update'), ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['upgrade', '--dry-run']);
  rmSync(join(root, 'src/deploy.mjs'));
  const missing = run(join(root, 'update'));
  assert.equal(missing.status, 4);
  assert.match(missing.stderr, /deployment module is missing or unsafe/);
});
