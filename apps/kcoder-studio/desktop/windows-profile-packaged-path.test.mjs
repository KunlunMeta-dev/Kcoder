import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import { verifyDesktopEntryClosure } from '../../../scripts/release/desktop-entry-closure.mjs';

test('actual configured Desktop ASAR includes storage selection and the registered-source SID import closure', async t => {
  const studio = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const metadata = JSON.parse(await readFile(join(studio, 'package.json'), 'utf8'));
  const host = createRequire(join(studio, 'package.json'));
  const builder = createRequire(host.resolve('electron-builder'));
  const library = createRequire(builder.resolve('app-builder-lib'));
  const asar = library('@electron/asar');
  const root = await mkdtemp(join(tmpdir(), 'kcoder-windows-profile-asar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'app');
  const copy = async (source, target) => { await mkdir(dirname(target), { recursive: true }); await copyFile(source, target); };
  for (const entry of metadata.build.files) {
    if (typeof entry === 'string') {
      if (entry.startsWith('!')) continue;
      if (entry.includes('*')) {
        assert.equal(entry, 'desktop/widget-isolation/*.mjs');
        const parent = dirname(entry);
        for (const name of await readdir(join(studio, parent))) {
          if (name.endsWith('.mjs') && !name.includes('.test.')) await copy(join(studio, parent, name), join(stage, parent, name));
        }
      } else await copy(join(studio, entry), join(stage, entry));
    } else {
      for (const name of entry.filter) {
        assert.equal(name.includes('*'), false, 'the fixture must materialize actual declared source files');
        await copy(join(studio, entry.from, name), join(stage, entry.to, name));
      }
    }
  }
  const archive = join(root, 'app.asar');
  const output = await asar.createPackage(stage, archive);
  if (output && typeof output.on === 'function') await finished(output);
  const result = verifyDesktopEntryClosure(archive);
  for (const name of ['desktop/main.mjs', 'desktop/storage-installation.mjs', 'src/migrations/windows-registered-sources.mjs', 'src/windows-current-identity.mjs']) {
    assert.ok(result.files.includes(name), `${name} must resolve inside the actual ASAR`);
    assert.ok(asar.extractFile(archive, name).length > 0);
  }
  await rm(join(stage, 'src/windows-current-identity.mjs'));
  const broken = join(root, 'missing-shared-sid.asar');
  const brokenOutput = await asar.createPackage(stage, broken);
  if (brokenOutput && typeof brokenOutput.on === 'function') await finished(brokenOutput);
  assert.throws(() => verifyDesktopEntryClosure(broken), /Desktop archive dependency missing:.*windows-current-identity/);
});
