import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { stageDesktopResources } from './stage-desktop-resources.mjs';

test('stages pinned browser resources for the target platform, not the build host', async () => {
  for (const [platform, expected] of [['linux', 'linux64'], ['win32', 'win64']]) {
    const calls = [];
    await stageDesktopResources({ electronPlatformName: platform, arch: 1 }, {
      stageDependencies: async () => calls.push('dependencies'),
      prepareMobileWeb: async () => {},
      prepareBrowser: async options => calls.push(options),
      preparePdfReader: async options => calls.push({ pdf: options }),
      env: { KCODER_CHROME_CACHE: '/fixture/cache', [`KCODER_CHROME_ARCHIVE_${expected.toUpperCase()}`]: '/fixture/official.zip' },
    });
    assert.equal(calls[0], 'dependencies');
    assert.equal(calls[1].platform, expected);
    assert.match(calls[1].destination, /input[/\\]bin[/\\]chrome$/);
    assert.equal(calls[1].archive, '/fixture/official.zip');
    assert.equal(calls[1].cache, '/fixture/cache');
    assert.equal(calls.length, platform === 'win32' ? 3 : 2);
    if (platform === 'win32') assert.match(calls[2].pdf.destination, /input[/\\]bin[/\\]pdf$/);
  }
});

test('remote clients do not download a local browser and unsupported architectures fail closed', async () => {
  const options = { stageDependencies: async () => {}, prepareMobileWeb: async () => assert.fail('unexpected Mobile Web export'), prepareBrowser: async () => assert.fail('unexpected browser download'), preparePdfReader: async () => assert.fail('unexpected PDF download') };
  await stageDesktopResources({ electronPlatformName: 'win32', packager: { appInfo: { id: 'dev.kcoder.studio.remote' } } }, options);
  await assert.rejects(stageDesktopResources({ electronPlatformName: 'linux', arch: 3 }, options), /x64/);
});

test('both full desktop resource manifests carry the entire Chrome directory', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.build.beforePack, 'desktop/stage-desktop-resources.mjs');
  for (const platform of ['linux', 'win']) {
    const resource = packageJson.build[platform].extraResources.find(item => item.to === 'bin/chrome');
    assert.match(resource.from, /input\/bin\/chrome$/);
    assert.equal(resource.filter, undefined, 'licenses and supporting assets must not be stripped');
  }
});

test('Windows package includes the complete PDF resource directory', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const pdf = pkg.build.win.extraResources.find(item => item.to === 'bin/pdf');
  assert.match(pdf.from, /windows-input\/bin\/pdf$/);
  assert.equal(pdf.filter, undefined, 'licenses, source archive and character maps must be retained');
});

test('macOS stages the official Intel Chrome bundle and native PDF resources', async () => {
  const calls = [];
  await stageDesktopResources({ electronPlatformName: 'darwin', arch: 1 }, {
    stageDependencies: async () => calls.push('dependencies'),
      prepareMobileWeb: async () => {},
    prepareBrowser: async options => calls.push(options),
    preparePdfReader: async () => assert.fail('unexpected Windows PDF download'),
    prepareMacPdfReader: async options => calls.push(options),
    env: { KCODER_CHROME_ARCHIVE_MAC_X64: '/owned/mac-chrome.zip' },
  });
  assert.equal(calls[0], 'dependencies');
  assert.equal(calls[1].platform, 'mac-x64');
  assert.equal(calls[1].archive, '/owned/mac-chrome.zip');
  assert.match(calls[2].destination, /macos-input.*bin.*pdf$/);
  assert.equal(calls.length, 3);
});

test('full desktop stages one Mobile Web package before browser resources and bundles its manifest', async () => {
  const calls = [];
  await stageDesktopResources({ electronPlatformName: 'linux', arch: 1 }, {
    stageDependencies: async () => calls.push('dependencies'),
    prepareMobileWeb: async () => calls.push('mobile'),
    prepareBrowser: async () => calls.push('browser'),
  });
  assert.deepEqual(calls, ['dependencies', 'mobile', 'browser']);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.build.extraResources.find(row => row.to === 'gateway/mobile/dist'), {
    from: 'mobile/dist', to: 'gateway/mobile/dist',
  });
});
