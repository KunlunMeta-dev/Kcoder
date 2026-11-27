import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageInstallerHelpers, stageWindowsShellIcon } from './release-artifact-hook.mjs';
import { verifyManifest, writeManifest } from '../../../scripts/release/artifact-manifest.mjs';

test('the actual NSIS target helper finishes before release inventory', async () => {
  let staged = false;
  const target = { name: 'nsis', packageHelper: { elevateHelper: { async copy(directory, received) {
    assert.equal(directory, '/owned/app'); assert.equal(received, target);
    await Promise.resolve(); staged = true;
  } } } };
  await stageInstallerHelpers({ electronPlatformName: 'win32', appOutDir: '/owned/app', targets: [target] });
  assert.equal(staged, true);
});
test('a changed NSIS internal contract fails explicitly instead of omitting executable inventory', async () => {
  await assert.rejects(stageInstallerHelpers({ electronPlatformName: 'win32', targets: [{ name: 'nsis' }] }), /Unsupported NSIS/);
  await stageInstallerHelpers({ electronPlatformName: 'linux', targets: [{ name: 'AppImage' }] });
});

test('Windows shortcut icons are inventoried before installation and staging is idempotent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-shell-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, 'resources'), shell = join(resources, 'shell');
  await mkdir(shell, { recursive: true });
  const bytes = await readFile(new URL('./icons/icon.ico', import.meta.url));
  await writeFile(join(shell, 'icon.ico'), bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const context = { electronPlatformName: 'win32', appOutDir: root };
  await stageWindowsShellIcon(context);
  const manifest = await writeManifest(resources, { kind: 'fixture', platform: 'win32', identity: {
    versions: { studio: '1' }, packagingSource: { commit: 'a'.repeat(40), dirty: false },
  } });
  assert.equal(manifest.resources.find(file => file.path === `shell/kcoder-${hash}.ico`)?.sha256, hash);
  await stageWindowsShellIcon(context);
  await verifyManifest(resources);
  await writeFile(join(shell, `kcoder-${hash}.ico`), 'unexpected replacement');
  await assert.rejects(stageWindowsShellIcon(context), /expected regular file/);
});
