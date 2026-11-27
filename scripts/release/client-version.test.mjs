import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkClientVersion, syncClientVersion } from './client-version.mjs';

test('Studio version sync updates release manifests and preserves platform and dependency versions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-client-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const studio = join(root, 'apps/kcoder-studio');
  const previous = { version: '2.0.9' };
  const expected = { version: '2.0.10' };
  const files = {
    'package.json': expected,
    'renderer/package.json': previous,
    'desktop/gateway-package.json': previous,
  };
  for (const [file, value] of Object.entries(files)) {
    const path = join(studio, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  }
  const read = async file => JSON.parse(await readFile(join(studio, file), 'utf8'));
  await assert.rejects(checkClientVersion(root), /renderer\/package\.json/);
  assert.deepEqual(await read('renderer/package.json'), previous);
  assert.equal(await syncClientVersion(root), expected.version);
  assert.equal(await checkClientVersion(root), expected.version);
  assert.deepEqual(await read('renderer/package.json'), expected);
  assert.deepEqual(await read('desktop/gateway-package.json'), expected);
});
