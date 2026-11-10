import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { shouldOmitMobileSourceEntry } from './mobile-source-policy.mjs';

test('only exact public migration module paths bypass the credential filename exclusion', () => {
  for (const path of ['src/runtime/migration-client/credential-sources-contracts.ts',
    'src/runtime/migration-source/private-credential-controller.ts', 'src/runtime/migration-source/private-credentials.ts',
    'generated/contracts.migration-source-credentials.ts']) {
    const name = path.split('/').at(-1);
    assert.equal(shouldOmitMobileSourceEntry(name, path), false);
    assert.equal(shouldOmitMobileSourceEntry(name, `other/${path}`), true);
    assert.equal(shouldOmitMobileSourceEntry(name, path, true), true);
    assert.equal(shouldOmitMobileSourceEntry(name, `../${path}`), true);
  }
  for (const name of ['credentials.json', 'private-credentials.json', 'token.secret.json', '.env.local', 'private-credential-controller.test.ts']) {
    assert.equal(shouldOmitMobileSourceEntry(name, `src/runtime/migration-source/${name}`), true);
  }
});


test('public credential contract exports remain present in isolated source snapshots', async () => {
  let checked = 0;
  for (const barrel of ['contracts.ts', 'contractGuards.mjs']) {
    const source = await readFile(new URL(`../../shared/generated/${barrel}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/from '\.\/([^']*credentials[^']*)'/g)) {
      const name = match[1].replace(/\.js$/, '.ts');
      const path = `generated/${name}`;
      assert.equal(shouldOmitMobileSourceEntry(name, path), false, `${path} is an imported public contract`);
      assert.equal(shouldOmitMobileSourceEntry(name, `other/${path}`), true);
      assert.equal(shouldOmitMobileSourceEntry(name, path, true), true);
      checked += 1;
    }
  }
  assert.ok(checked >= 6, 'both public contract barrels must be checked');
});
