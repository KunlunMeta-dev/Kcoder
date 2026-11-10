import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { stageDesktopResources } from './stage-desktop-resources.mjs';

test('stages pinned browser resources for the target platform, not the build host', async () => {
  for (const [platform, expected] of [['linux', 'linux64'], ['win32', 'win64']]) {
    const calls = [];
    const dependencyTargets = [];
    await stageDesktopResources({ electronPlatformName: platform, arch: 1 }, {
      stageDependencies: async options => { calls.push('dependencies'); dependencyTargets.push(options); return { p2pNative: { status: 'omitted', targetPlatform: platform, targetArch: 'x64', reason: 'target-does-not-match-build-host' } }; },
      prepareSearch: async options => { assert.equal(options.platform, platform === 'win32' ? 'win-x64' : 'linux-x64'); assert.match(options.destination, /input[/\\]searxng$/); },
      prepareStudioAssets: async () => ({schemaVersion:1,resourceDirectory:'renderer-dist',manifest:'studio-public-assets.json',manifestSha256:'c'.repeat(64)}),
    prepareConnectivity: async () => ({manifestSha256:'b'.repeat(64),nodeMinimumMajor:22}), prepareOffice: async () => {},
      prepareMobileWeb: async () => {},
      prepareBrowser: async options => calls.push(options),
      preparePdfReader: async options => calls.push({ pdf: options }),
      env: { KCODER_CHROME_CACHE: '/fixture/cache', [`KCODER_CHROME_ARCHIVE_${expected.toUpperCase()}`]: '/fixture/official.zip' },
    });
    assert.equal(calls[0], 'dependencies');
    assert.deepEqual(dependencyTargets[0], { targetPlatform: platform, targetArch: 'x64' });
    assert.equal(calls[1].platform, expected);
    assert.match(calls[1].destination, /input[/\\]bin[/\\]chrome$/);
    assert.equal(calls[1].archive, '/fixture/official.zip');
    assert.equal(calls[1].cache, '/fixture/cache');
    assert.equal(calls.length, platform === 'win32' ? 3 : 2);
    if (platform === 'win32') assert.match(calls[2].pdf.destination, /input[/\\]bin[/\\]pdf$/);
  }
});

test('remote clients do not download a local browser and unsupported architectures fail closed', async () => {
  const options = { prepareConnectivity: async () => ({manifestSha256:'b'.repeat(64),nodeMinimumMajor:22}), prepareOffice: async () => assert.fail('remote-thin must not stage Office'), stageDependencies: async () => {}, prepareSearch: async () => assert.fail('unexpected search download'), prepareMobileWeb: async () => assert.fail('unexpected Mobile Web export'), prepareBrowser: async () => assert.fail('unexpected browser download'), preparePdfReader: async () => assert.fail('unexpected PDF download') };
  await stageDesktopResources({ electronPlatformName: 'win32', packager: { appInfo: { id: 'dev.kcoder.studio.remote' } } }, options);
  await assert.rejects(stageDesktopResources({ electronPlatformName: 'linux', arch: 3 }, options), /x64/);
});

test('unknown packaging architecture omits the native Gateway transport', async () => {
  let dependencyTarget;
  await stageDesktopResources({ electronPlatformName: 'linux' }, {
    stageDependencies: async options => {
      dependencyTarget = options;
      return { p2pNative: { status: 'omitted', targetPlatform: 'linux', targetArch: 'unknown', reason: 'target-does-not-match-build-host' } };
    },
    prepareStudioAssets: async () => ({schemaVersion:1,resourceDirectory:'renderer-dist',manifest:'studio-public-assets.json',manifestSha256:'c'.repeat(64)}),
    prepareConnectivity: async () => ({manifestSha256:'b'.repeat(64),nodeMinimumMajor:22}), prepareOffice: async () => {}, prepareSearch: async () => {}, prepareMobileWeb: async () => {}, prepareBrowser: async () => {},
  });
  assert.deepEqual(dependencyTarget, { targetPlatform: 'linux', targetArch: 'unknown' });
});

test('both full desktop resource manifests carry the entire Chrome directory', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const gatewayPackage = JSON.parse(await readFile(new URL('./gateway-package.json', import.meta.url), 'utf8'));
  assert.equal(gatewayPackage.version, packageJson.version, 'Gateway runtime metadata must match the packaged Studio version');
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
  const dependencyTargets = [];
  await stageDesktopResources({ electronPlatformName: 'darwin', arch: 1 }, {
    prepareMacDesktop: async options => { assert.equal(options.arch, 'x64'); assert.match(options.destination, /macos-input[/\\]computer-use$/); },
    stageDependencies: async options => { calls.push('dependencies'); dependencyTargets.push(options); },
    prepareSearch: async options => assert.equal(options.platform, 'mac-x64'),
      prepareStudioAssets: async () => ({schemaVersion:1,resourceDirectory:'renderer-dist',manifest:'studio-public-assets.json',manifestSha256:'c'.repeat(64)}),
    prepareConnectivity: async () => ({manifestSha256:'b'.repeat(64),nodeMinimumMajor:22}), prepareOffice: async () => {},
      prepareMobileWeb: async () => {},
    prepareBrowser: async options => calls.push(options),
    preparePdfReader: async () => assert.fail('unexpected Windows PDF download'),
    prepareMacPdfReader: async options => calls.push(options),
    env: { KCODER_CHROME_ARCHIVE_MAC_X64: '/owned/mac-chrome.zip' },
  });
  assert.equal(calls[0], 'dependencies');
  assert.deepEqual(dependencyTargets[0], { targetPlatform: 'darwin', targetArch: 'x64' });
  assert.equal(calls[1].platform, 'mac-x64');
  assert.equal(calls[1].archive, '/owned/mac-chrome.zip');
  assert.match(calls[2].destination, /macos-input.*bin.*pdf$/);
  assert.equal(calls.length, 3);
});

test('full desktop stages one Mobile Web package before browser resources and bundles its manifest', async () => {
  const calls = [];
  await stageDesktopResources({ electronPlatformName: 'linux', arch: 1 }, {
    stageDependencies: async () => calls.push('dependencies'),
    prepareStudioAssets: async () => ({schemaVersion:1,resourceDirectory:'renderer-dist',manifest:'studio-public-assets.json',manifestSha256:'c'.repeat(64)}),
    prepareConnectivity: async () => ({manifestSha256:'b'.repeat(64),nodeMinimumMajor:22}), prepareOffice: async () => {},
    prepareSearch: async () => {},
    prepareMobileWeb: async () => calls.push('mobile'),
    prepareBrowser: async () => calls.push('browser'),
  });
  assert.deepEqual(calls, ['dependencies', 'mobile', 'browser']);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.build.extraResources.find(row => row.to === 'gateway/mobile/dist'), {
    from: 'mobile/dist', to: 'gateway/mobile/dist',
  });
});

test('Apple Silicon stages matching search, Chrome and PDF resources away from Intel inputs', async () => {
  const calls = [];
  await stageDesktopResources({ electronPlatformName: 'darwin', arch: 3 }, {
    prepareMacDesktop: async options => { assert.equal(options.arch, 'arm64'); assert.match(options.destination, /macos-arm64-input[/\\]computer-use$/); },
    stageDependencies: async options => calls.push(['gateway', options]),
    prepareSearch: async options => calls.push(['search', options]),
    prepareMobileWeb: async () => {},
    prepareConnectivity: async options => { assert.match(options.destination, /macos-arm64-input[/\\]channel$/); return {manifestSha256:'b'.repeat(64),nodeMinimumMajor:22}; },
    prepareStudioAssets: async () => ({manifestSha256:'c'.repeat(64)}),
    prepareBrowser: async options => calls.push(['chrome', options]),
    prepareMacPdfReader: async options => calls.push(['pdf', options]),
    env: { KCODER_CHROME_ARCHIVE_MAC_ARM64: '/owned/arm-chrome.zip' },
  });
  assert.deepEqual(calls[0], ['gateway', { targetPlatform: 'darwin', targetArch: 'arm64' }]);
  assert.equal(calls[1][1].platform, 'mac-arm64');
  assert.equal(calls[2][1].platform, 'mac-arm64');
  assert.equal(calls[2][1].archive, '/owned/arm-chrome.zip');
  assert.equal(calls[3][1].arch, 'arm64');
  assert.ok(calls.slice(1).every(([, options]) => options.destination.includes('macos-arm64-input')));
});

test('full desktop resource manifests retain the search interpreter, service, licenses and source', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const platform of ['linux', 'win']) {
    const resource = pkg.build[platform].extraResources.find(item => item.to === 'searxng');
    assert.match(resource.from, /input\/searxng$/);
    assert.equal(resource.filter, undefined);
  }
});


test('desktop packages do not bundle the removed Office component', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const platform of ['linux', 'win']) {
    assert.ok(!pkg.build[platform].extraResources.some(item => item.to === 'office'));
  }
});

test('full target staging pins the actual channel receipt and includes the sealed resource directory',async()=>{
 const calls=[];const packager={config:{}};
 await stageDesktopResources({electronPlatformName:'linux',arch:1,packager},{
  prepareStudioAssets:async()=>({schemaVersion:1,resourceDirectory:'renderer-dist',manifest:'studio-public-assets.json',manifestSha256:'c'.repeat(64)}),
  stageDependencies:async()=>{},
  prepareConnectivity:async options=>{calls.push(options);return{manifestSha256:'b'.repeat(64),nodeMinimumMajor:22};},
  prepareSearch:async()=>{},prepareMobileWeb:async()=>{},prepareBrowser:async()=>{},
 });
 assert.match(calls[0].destination,/linux-input[/\\]channel$/);
 assert.deepEqual(packager.config.extraMetadata.nativeConnectivityResources,{schemaVersion:1,resourceDirectory:'kcoder-channel-host',manifestSha256:'b'.repeat(64),nodeMinimumMajor:22});
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 for(const platform of ['linux','win']){
  assert.match(pkg.build[platform].extraResources.find(row=>row.to==='kcoder-channel-host').from,/input\/channel$/);
  const dependencies=pkg.build[platform].extraResources.find(row=>row.to==='kcoder-channel-host/node_modules');
  assert.match(dependencies.from,/input\/channel\/node_modules$/);assert.ok(dependencies.filter.includes('**/.*'));
 }
});
