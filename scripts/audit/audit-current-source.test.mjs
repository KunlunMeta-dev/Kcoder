import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('current source gate scans committed material, rejects standalone credentials, and ignores task identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-source-gate-'));
  try {
    await mkdir(join(root, 'scripts/audit'), { recursive: true });
    const script = join(root, 'scripts/audit/audit_release_check.sh');
    await copyFile(new URL('./audit_release_check.sh', import.meta.url), script);
    const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid', ...args], { stdio: 'pipe' });
    git('init', '-q');
    await writeFile(join(root, 'fixture.txt'), `task-${'a'.repeat(60)}\n`);
    git('add', '.'); git('commit', '-qm', 'safe tracked source');
    const run = () => spawnSync('bash', [script, '--current-source-only'], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    const syntheticKey = `sk-cp-${'b'.repeat(40)}`;
    await writeFile(join(root, 'private-untracked.env'), syntheticKey);
    assert.equal(run().status, 0, 'unpublished local files are not the committed release source');
    await writeFile(join(root, 'fixture.txt'), `API_KEY=${syntheticKey}\n`);
    git('add', 'fixture.txt'); git('commit', '-qm', 'unsafe tracked fixture');
    const rejected = run();
    assert.equal(rejected.status, 1);
    assert.ok(!`${rejected.stdout}${rejected.stderr}`.includes(syntheticKey), 'credential contents must not enter diagnostics');
    git('checkout', 'HEAD~1', '--', 'fixture.txt'); git('commit', '-qm', 'safe current source again');
    assert.equal(run().status, 0, 'historical remediation is a separate explicit audit');
  } finally { await rm(root, { recursive: true, force: true }); }
});
