import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { stageDesktopResources } from './stage-desktop-resources.mjs';

const skipStorageAddon = async () => {};

test('stages pinned browser resources for the target platform, not the build host', async () => {
  for (const [platform, expected] of [['linux', 'linux64'], ['win32', 'win64']]) {
    const calls = [];
    const dependencyTargets = [];
    await stageDesktopResources({ electronPlatformName: platform, arch: 1 }, {
      prepareLarkCli: async () => {}, stageSkillRuntime: async () => {}, stageNativeStorage: skipStorageAddon,
      stageDependencies: async options => { calls.push('dependencies'); dependencyTargets.push(options); return { p2pNative: { status: 'omitted', targetPlatform: platform, targetArch: 'x64', reason: 'target-does-not-match-build-host' } }; },
      prepareSearch: async options => { assert.equal(options.platform, platform === 'win32' ? 'win-x64' : 'linux-x64'); assert.match(options.destination, /input[/\\]searxng$/); },
      prepareStudioAssets: async () => ({schemaVersion:1,resourceDirectory:'renderer-dist',manifest:'studio-public-assets.json',manifestSha256:'c'.repeat(64)}),
    prepareConnectivity: async () => ({manifestSha256:'b'.repeat(64),nodeMinimumMajor:22}), prepareOffice: async () => {},
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

test('remote clients do not stage local native resources and unsupported architectures fail closed', async () => {
  const options = { stageSkillRuntime: async () => {}, prepareLarkCli: async () => assert.fail('remote-thin must not stage lark-cli'), stageNativeStorage: async () => assert.fail('remote-thin must not stage native storage'), prepareConnectivity: async () => ({manifestSha256:'b'.repeat(64),nodeMinimumMajor:22}), prepareOffice: async () => assert.fail('remote-thin must not stage Office'), stageDependencies: async () => {}, prepareSearch: async () => assert.fail('unexpected search download'), prepareBrowser: async () => assert.fail('unexpected browser download'), preparePdfReader: async () => assert.fail('unexpected PDF download') };
  await stageDesktopResources({ electronPlatformName: 'win32', packager: { appInfo: { id: 'dev.kcoder.studio.remote' } } }, options);
  await assert.rejects(stageDesktopResources({ electronPlatformName: 'linux', arch: 3 }, options), /x64/);
});

test('unknown packaging architecture omits the native Gateway transport', async () => {
  let dependencyTarget;
  await stageDesktopResources({ electronPlatformName: 'linux' }, {
    prepareLarkCli: async () => {}, stageSkillRuntime: async () => {}, stageNativeStorage: skipStorageAddon,
    stageDependencies: async options => {
      dependencyTarget = options;
      return { p2pNative: { status: 'omitted', targetPlatform: 'linux', targetArch: 'unknown', reason: 'target-does-not-match-build-host' } };
    },
    prepareStudioAssets: async () => ({schemaVersion:1,resourceDirectory:'renderer-dist',manifest:'studio-public-assets.json',manifestSha256:'c'.repeat(64)}),
    prepareConnectivity: async () => ({manifestSha256:'b'.repeat(64),nodeMinimumMajor:22}), prepareOffice: async () => {}, prepareSearch: async () => {}, prepareBrowser: async () => {},
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
    const storage = packageJson.build[platform].extraResources.find(item => item.to === 'bin/kcoder-native-storage.node');
    assert.match(storage.from, new RegExp(`${platform === 'linux' ? 'linux' : 'windows'}-input/bin/kcoder-native-storage\\.node$`));
  }
  const gatewaySource = packageJson.build.files.find(item => typeof item === 'object' && item.from === 'src');
  assert.ok(gatewaySource.filter.includes('storage-operation-client.mjs'), 'the shared local operation client must be in ASAR');
  assert.ok(gatewaySource.filter.includes('migrations/storage-startup.mjs'), 'the shared startup hook must be in ASAR');
  assert.ok(gatewaySource.filter.includes('storage-lease.mjs'), 'the packaged Gateway lease loader must be in ASAR');
  for (const dependency of ['storage-source-retirement.mjs', 'storage-active-operation.mjs', 'storage-component-publication-scope.mjs']) {
    assert.ok(gatewaySource.filter.includes(dependency), `the Desktop storage lease dependency ${dependency} must be in ASAR`);
  }
  assert.ok(gatewaySource.filter.includes('source-app-server-binary.js'), 'the packaged app-server binary resolver must be in ASAR');
  for (const file of ['desktop/storage-locations-controller.mjs']) {
    assert.ok(packageJson.build.files.includes(file), `${file} must be in ASAR`);
  }
});

test('full desktop staging delegates native storage to the exact packaging context', async () => {
  let staged;
  const context = { electronPlatformName: 'linux', arch: 1 };
  const env = { KCODER_TARGET_DIR: '/owned/checkout/target' };
  await stageDesktopResources(context, {
    env,
    stageSkillRuntime: async () => {}, prepareLarkCli: async () => {},
    stageNativeStorage: async (targetContext, options) => { staged = { targetContext, options }; },
    stageDependencies: async () => {},
    prepareStudioAssets: async () => ({ schemaVersion: 1, resourceDirectory: 'renderer-dist', manifest: 'studio-public-assets.json', manifestSha256: 'c'.repeat(64) }),
    prepareConnectivity: async () => ({ manifestSha256: 'b'.repeat(64), nodeMinimumMajor: 22 }),
    prepareSearch: async () => {},
    prepareMobileWeb: async () => {},
    prepareBrowser: async () => {},
  });
  assert.equal(staged.targetContext, context);
  assert.equal(staged.options.env, env);
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
    stageNativeStorage: skipStorageAddon,
    prepareMacDesktop: async options => { assert.equal(options.arch, 'x64'); assert.match(options.destination, /macos-input[/\\]computer-use$/); },
    prepareLarkCli: async () => {}, stageSkillRuntime: async () => {}, stageDependencies: async options => { calls.push('dependencies'); dependencyTargets.push(options); },
    prepareSearch: async options => assert.equal(options.platform, 'mac-x64'),
      prepareStudioAssets: async () => ({schemaVersion:1,resourceDirectory:'renderer-dist',manifest:'studio-public-assets.json',manifestSha256:'c'.repeat(64)}),
    prepareConnectivity: async () => ({manifestSha256:'b'.repeat(64),nodeMinimumMajor:22}), prepareOffice: async () => {},
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

test('Apple Silicon stages matching search, Chrome and PDF resources away from Intel inputs', async () => {
  const calls = [];
  await stageDesktopResources({ electronPlatformName: 'darwin', arch: 3 }, {
    stageNativeStorage: skipStorageAddon,
    prepareMacDesktop: async options => { assert.equal(options.arch, 'arm64'); assert.match(options.destination, /macos-arm64-input[/\\]computer-use$/); },
    prepareLarkCli: async () => {}, stageSkillRuntime: async () => {}, stageDependencies: async options => calls.push(['gateway', options]),
    prepareSearch: async options => calls.push(['search', options]),
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
  stageNativeStorage:skipStorageAddon,
  prepareStudioAssets:async()=>({schemaVersion:1,resourceDirectory:'renderer-dist',manifest:'studio-public-assets.json',manifestSha256:'c'.repeat(64)}),
  prepareLarkCli: async () => {}, stageSkillRuntime: async () => {}, stageDependencies:async()=>{},
  prepareConnectivity:async options=>{calls.push(options);return{manifestSha256:'b'.repeat(64),nodeMinimumMajor:22};},
  prepareSearch:async()=>{},prepareBrowser:async()=>{},
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

test('Gateway and npm source resources retain the adjacent shared legacy namespace JSON',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.ok(pkg.files.includes('src'),'npm must retain the production source directory');
  const source=pkg.build.extraResources.find(item=>item.from==='src'&&item.to==='gateway/src');
  assert.ok(source.filter.includes('**/*'),'Gateway resources must include JSON beside the migration module');
  assert.ok(!source.filter.some(pattern=>pattern.startsWith('!')&&(pattern.includes('*.json')||pattern.includes('migrations'))),
    'the shared production descriptor must not be filtered out');
  const descriptor=JSON.parse(await readFile(new URL('../src/migrations/legacy-owner-namespaces.json',import.meta.url),'utf8'));
  assert.equal(descriptor.version,1);assert.ok(Array.isArray(descriptor.gatewayFiles));
});

test('full desktop stages the pinned skill runtime and packages it outside the Gateway tree', async () => {
  const calls = [];
  const common = {
    stageNativeStorage: skipStorageAddon,
    stageDependencies: async () => calls.push('gateway'),
    stageSkillRuntime: async () => { calls.push('skill-runtime'); return { packages: { docx: '9.16.0' } }; },
    prepareLarkCli: async () => {},
    prepareStudioAssets: async () => ({ manifestSha256: 'c'.repeat(64) }),
    prepareConnectivity: async () => ({ manifestSha256: 'b'.repeat(64), nodeMinimumMajor: 22 }),
    prepareSearch: async () => {}, prepareMobileWeb: async () => {}, prepareBrowser: async () => {},
  };
  await stageDesktopResources({ electronPlatformName: 'linux', arch: 1 }, common);
  assert.deepEqual(calls, ['gateway', 'skill-runtime']);
  calls.length = 0;
  await stageDesktopResources({ electronPlatformName: 'win32', packager: { appInfo: { id: 'dev.kcoder.studio.remote' } } }, common);
  assert.deepEqual(calls, ['gateway'], 'remote-thin clients do not run a local app-server');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.build.extraResources.find(row => row.to === 'skill-runtime/node_modules'), {
    from: '../../target/packages/kcoder-studio/skill-runtime/node_modules', to: 'skill-runtime/node_modules',
  });
});

test('full desktop stages the pinned lark-cli for each target platform and packages it as resources/lark-cli', async () => {
  const stub = {
    stageNativeStorage: skipStorageAddon,
    stageDependencies: async () => {}, stageSkillRuntime: async () => {},
    prepareStudioAssets: async () => ({ manifestSha256: 'c'.repeat(64) }),
    prepareConnectivity: async () => ({ manifestSha256: 'b'.repeat(64), nodeMinimumMajor: 22 }),
    prepareSearch: async () => {}, prepareMobileWeb: async () => {}, prepareBrowser: async () => {},
    preparePdfReader: async () => {}, prepareMacPdfReader: async () => {}, prepareMacDesktop: async () => {},
  };
  for (const [electronPlatformName, arch, platform, stage] of [
    ['linux', 1, 'linux-x64', 'linux-input'], ['win32', 1, 'win-x64', 'windows-input'],
    ['darwin', 1, 'mac-x64', 'macos-input'], ['darwin', 3, 'mac-arm64', 'macos-arm64-input'],
  ]) {
    const calls = [];
    await stageDesktopResources({ electronPlatformName, arch }, {
      ...stub, prepareLarkCli: async options => calls.push(options),
      env: { KCODER_LARK_CLI_CACHE: '/owned/lark-cache', KCODER_LARK_CLI_ARCHIVE_DIR: '/owned/lark-archives' },
    });
    assert.equal(calls.length, 1, platform);
    assert.equal(calls[0].platform, platform);
    assert.match(calls[0].destination, new RegExp(`${stage}[/\\\\]lark-cli$`));
    assert.equal(calls[0].cache, '/owned/lark-cache');
    assert.equal(calls[0].archiveDirectory, '/owned/lark-archives');
  }
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const [platform, stage] of [['linux', 'linux-input'], ['win', 'windows-input']]) {
    assert.deepEqual(pkg.build[platform].extraResources.find(row => row.to === 'lark-cli'), {
      from: `../../target/packages/kcoder-studio/${stage}/lark-cli`, to: 'lark-cli',
    });
  }
  assert.ok(!pkg.build.extraResources.some(row => row.to === 'lark-cli'), 'remote-thin packages share no lark-cli resource');
});
