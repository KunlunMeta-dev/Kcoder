import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stageInstallerHelpers } from './release-artifact-hook.mjs';

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
