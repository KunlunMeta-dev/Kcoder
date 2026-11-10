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
  const previousLock = { ...previous, packages: { '': previous, 'node_modules/other': previous } };
  const expo = { android: { versionCode: 31 }, ios: { buildNumber: '7' } };
  const files = {
    'package.json': expected,
    'renderer/package.json': previous,
    'desktop/gateway-package.json': previous,
    'mobile/package.json': previous,
    'mobile/package-lock.json': previousLock,
    'mobile/app.json': { expo: { ...previous, ...expo } },
  };
  for (const [file, value] of Object.entries(files)) {
    const path = join(studio, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  }
  const read = async file => JSON.parse(await readFile(join(studio, file), 'utf8'));
  await assert.rejects(checkClientVersion(root), /mobile\/app\.json/);
  assert.deepEqual(await read('mobile/app.json'), files['mobile/app.json']);
  assert.equal(await syncClientVersion(root), expected.version);
  assert.equal(await checkClientVersion(root), expected.version);
  assert.equal(await syncClientVersion(root), expected.version);
  assert.deepEqual(await read('mobile/package-lock.json'), {
    ...expected, packages: { '': expected, 'node_modules/other': previous },
  });
  assert.deepEqual(await read('mobile/app.json'), { expo: { ...expected, ...expo } });
  await writeFile(join(studio, 'mobile/package-lock.json'), JSON.stringify({
    ...expected, packages: { '': previous },
  }));
  await assert.rejects(checkClientVersion(root), /mobile\/package-lock\.json/);
});
