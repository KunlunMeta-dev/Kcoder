import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeGeneratedArtifact } from './artifact-files.mjs';

test('repeated generation preserves unchanged watcher inputs and updates changed artifacts', t => {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-contract-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'contracts.ts');
  assert.equal(writeGeneratedArtifact(path, 'export const label = "版本一";\n'), true);
  const checkpoint = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(path, checkpoint, checkpoint);
  const before = statSync(path);
  assert.equal(writeGeneratedArtifact(path, 'export const label = "版本一";\n'), false);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  assert.equal(statSync(path).ino, before.ino);
  assert.equal(writeGeneratedArtifact(path, 'export const label = "版本二";\n'), true);
  assert.equal(readFileSync(path, 'utf8'), 'export const label = "版本二";\n');
  assert.notEqual(statSync(path).mtimeMs, before.mtimeMs);
});

test('unexpected filesystem errors are not treated as missing artifacts', t => {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-contract-error-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => writeGeneratedArtifact(root, 'invalid'), { code: 'EISDIR' });
});
