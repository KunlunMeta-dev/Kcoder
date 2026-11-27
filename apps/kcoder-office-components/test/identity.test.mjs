import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('the component identity changes when any shipped entry or verifier changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'office-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['src', 'package.json', 'package-lock.json'])
    await cp(new URL('../' + path, import.meta.url), join(root, path), { recursive: true });
  const { generatorIdentity } = await import(pathToFileURL(join(root, 'src/identity.mjs')));
  let previous = await generatorIdentity();
  for (const path of ['src/cli.mjs', 'src/acceptance.mjs', 'src/package-manifest.mjs']) {
    const file = join(root, path);
    await writeFile(file, (await readFile(file, 'utf8')) + '\n// Controlled identity mutation.\n');
    const next = await generatorIdentity();
    assert.notEqual(next.implementationSha256, previous.implementationSha256, path);
    previous = next;
  }
});
