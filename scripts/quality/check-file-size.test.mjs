import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { physicalLines, inspectFile, evaluate, repositoryPaths, thirdPartySkillRoot } from './check-file-size.mjs';

const policy = { maxLines: 3000, warnLines: 2400, debt: { 'old.rs': { lines: 4000 } }, resources: { 'Cargo.lock': { category: 'lockfile' } } };
test('physical lines handle empty, CRLF and final unterminated line', () => {
  for (const [text, count] of [['', 0], ['a', 1], ['a\n', 1], ['a\r\nb', 2], ['\n\n', 2]]) assert.equal(physicalLines(Buffer.from(text)), count);
});
test('3000 is accepted; 3001 fails; historical debt cannot grow', () => {
  const report = evaluate([
    { path: 'ok.rs', kind: 'text', lines: 3000 },
    { path: 'new.rs', kind: 'text', lines: 3001 },
    { path: 'old.rs', kind: 'text', lines: 4001 },
  ], policy);
  assert.deepEqual(report.violations.map(row => row.path), ['new.rs', 'old.rs']);
  assert.equal(evaluate([{ path: 'old.rs', kind: 'text', lines: 3999 }], policy).debt.length, 1);
  assert.equal(evaluate([{ path: 'old.rs', kind: 'text', lines: 3999 }], policy, { strict: true }).violations.length, 1);
});
test('resources remain visible, and undecodable or LFS content cannot silently pass', () => {
  const result = evaluate([
    { path: 'Cargo.lock', kind: 'text', lines: 7000 },
    { path: 'invalid.rs', kind: 'undecodable' },
    { path: 'hidden.rs', kind: 'lfs-pointer', lines: 3 },
  ], policy);
  assert.equal(result.resources.length, 1);
  assert.equal(result.violations.length, 2);
});
test('Unicode paths work and symlinks are not followed', () => {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-file-size-'));
  try {
    writeFileSync(join(root, '中文 [file].rs'), 'one\ntwo');
    assert.equal(inspectFile(root, '中文 [file].rs').lines, 2);
    writeFileSync(join(root, 'invalid.rs'), Buffer.from([255, 254, 253]));
    assert.equal(inspectFile(root, 'invalid.rs').kind, 'undecodable');
    writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2]));
    assert.equal(inspectFile(root, 'binary').kind, 'binary');
    symlinkSync('/not-a-repository-file', join(root, 'link'));
    assert.equal(inspectFile(root, 'link').kind, 'symlink');
    assert.throws(() => inspectFile(root, '../escape'), /Outside repository/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('upstream resources cannot turn into symlink/LFS bypasses or change unnoticed', () => {
  const pinned = { ...policy, resources: { 'vendor.js': { category: 'upstream', sha256: 'expected' } } };
  assert.equal(evaluate([{ path: 'vendor.js', kind: 'text', lines: 8000, sha256: 'expected' }], pinned).violations.length, 0);
  assert.equal(evaluate([{ path: 'vendor.js', kind: 'text', lines: 8000, sha256: 'changed' }], pinned).violations.length, 1);
  assert.ok(evaluate([{ path: 'vendor.js', kind: 'symlink' }], pinned).violations.length);
});
test('UTF-16 source is counted and embedded NUL cannot hide oversized UTF-8 code', () => {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-encoded-size-'));
  try {
    writeFileSync(join(root, 'encoded.ps1'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('上\r\n末', 'utf16le')]));
    assert.equal(inspectFile(root, 'encoded.ps1').lines, 2);
    writeFileSync(join(root, 'nul.ts'), '/*\0*/\n'.repeat(3001));
    const inspected = inspectFile(root, 'nul.ts');
    assert.equal(inspected.lines, 3001);
    assert.equal(evaluate([inspected], policy).violations.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('untracked files are checked and tracked files deleted in the working tree are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-file-size-paths-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(root, '.gitignore'), 'ignored.rs\n');
    writeFileSync(join(root, 'kept.rs'), 'a\n');
    writeFileSync(join(root, 'removed.rs'), 'b\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
    rmSync(join(root, 'removed.rs'));
    writeFileSync(join(root, 'new.rs'), 'x\n'.repeat(3001));
    writeFileSync(join(root, 'ignored.rs'), 'y\n'.repeat(3001));
    const paths = repositoryPaths(root).sort();
    assert.deepEqual(paths, ['.gitignore', 'kept.rs', 'new.rs']);
    const report = evaluate(paths.map(path => inspectFile(root, path)), policy);
    assert.deepEqual(report.violations.map(row => row.path), ['new.rs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('third-party skills with upstream provenance are exempt from the line ceiling only', () => {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-file-size-skills-'));
  try {
    mkdirSync(join(root, 'skills', 'vendor', 'data'), { recursive: true });
    mkdirSync(join(root, 'skills', 'own'), { recursive: true });
    writeFileSync(join(root, 'skills', 'vendor', 'UPSTREAM.md'), 'upstream\n');
    assert.equal(thirdPartySkillRoot(root, 'skills/vendor/data/index.json'), 'skills/vendor');
    assert.equal(thirdPartySkillRoot(root, 'skills/own/SKILL.md'), null);
    assert.equal(thirdPartySkillRoot(root, 'skills/README.md'), null);
    assert.equal(thirdPartySkillRoot(root, 'crates/x/skills/vendor/a.rs'), null);
    const report = evaluate([
      { path: 'skills/vendor/data/index.json', kind: 'text', lines: 40000, thirdPartySkill: true },
      { path: 'skills/vendor/data/link', kind: 'symlink', thirdPartySkill: true },
      { path: 'skills/vendor/data/hidden.py', kind: 'lfs-pointer', lines: 3, thirdPartySkill: true },
      { path: 'skills/own/SKILL.md', kind: 'text', lines: 3001 },
    ], policy);
    assert.deepEqual(report.thirdParty.map(row => row.path), ['skills/vendor/data/index.json']);
    assert.deepEqual(report.violations.map(row => row.path).sort(), ['skills/own/SKILL.md', 'skills/vendor/data/hidden.py']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
