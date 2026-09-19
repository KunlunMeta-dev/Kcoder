import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { desktopIconPaths } from './desktop-icons.mjs';

test('Windows shell menu icon is bound for every window without pointing into app.asar', async () => {
  const { registerTaskbarIcon } = await import('./desktop-icons.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-shell-icon-'));
  try {
  for (const appId of ['dev.kcoder.studio', 'dev.kcoder.studio.remote']) {
    const app = new EventEmitter();
    app.isPackaged = true;
    app.getPath = () => directory;
    app.getName = () => 'KCoder Studio';
    registerTaskbarIcon(app, appId, 'win32', 'C:\\Program Files\\KCoder\\kcoder.exe');
    for (let index = 0; index < 2; index++) {
      let details;
      app.emit('browser-window-created', {}, { setAppDetails(value) { details = value; } });
      assert.equal(details.appId, appId);
      assert.equal(details.appIconIndex, 0);
      assert.equal(details.relaunchCommand, '"C:\\Program Files\\KCoder\\kcoder.exe"');
      assert.equal(details.relaunchDisplayName, 'KCoder Studio');
      assert.ok(details.appIconPath.startsWith(join(directory, 'shell-icons')));
      assert.match(details.appIconPath, /kcoder-[a-f0-9]{64}\.ico$/);
      assert.deepEqual(await readFile(details.appIconPath), await readFile(desktopIconPaths('win32').window));
    }
  }
  const linux = new EventEmitter();
  registerTaskbarIcon(linux, 'dev.kcoder.studio', 'linux');
  assert.equal(linux.listenerCount('browser-window-created'), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Shell ICO uses a new real path for changed artwork and reuses matching contents', async () => {
  const { materializeShellIcon } = await import('./desktop-icons.mjs');
  const root = await mkdtemp(join(tmpdir(), 'kcoder-shell-art-'));
  try {
    const source = join(root, 'source.ico');
    await writeFile(source, await readFile(desktopIconPaths('win32').window));
    const first = materializeShellIcon(join(root, 'cache'), source);
    assert.equal(materializeShellIcon(join(root, 'cache'), source), first);
    await writeFile(source, Buffer.from('changed fixture bytes'));
    const second = materializeShellIcon(join(root, 'cache'), source);
    assert.notEqual(second, first);
    await writeFile(second, 'corrupt cache');
    assert.throws(() => materializeShellIcon(join(root, 'cache'), source), /expected regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Shell relaunch uses the final userData override and quotes source application paths', async () => {
  const { registerTaskbarIcon } = await import('./desktop-icons.mjs');
  const root = await mkdtemp(join(tmpdir(), 'kcoder-shell-source-'));
  try {
    const app = new EventEmitter();
    app.isPackaged = false;
    app.getPath = () => { throw new Error('must resolve after registration'); };
    app.getName = () => 'KCoder Studio Remote';
    app.getAppPath = () => 'C:\\source folder\\studio';
    registerTaskbarIcon(app, 'dev.kcoder.studio.remote', 'win32', 'C:\\Electron Test\\electron.exe');
    app.getPath = () => root;
    let details;
    app.emit('browser-window-created', {}, { setAppDetails(value) { details = value; } });
    assert.equal(details.relaunchCommand, '"C:\\Electron Test\\electron.exe" "C:\\source folder\\studio"');
    assert.equal(details.relaunchDisplayName, 'KCoder Studio Remote');
    assert.ok(details.appIconPath.startsWith(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

const asset = name => fileURLToPath(new URL(`../renderer/src-tauri/icons/${name}`, import.meta.url));

for (const host of ['main.mjs', 'remote-main.mjs']) {
  test(`${host} explicitly gives the native window and tray their canonical application icons`, async () => {
    const url = new URL(host, import.meta.url);
    const source = await readFile(url, 'utf8');
    const windowCode = source.match(/mainWindow = new BrowserWindow\(\{[\s\S]*?\n  \}\);/)?.[0];
    const trayCode = source.match(/desktopTray = createDesktopTray\(\{[\s\S]*?\n  \}\);/)?.[0];
    assert.ok(windowCode && trayCode, 'both native constructors must remain explicit');
    for (const platform of ['win32', 'linux']) {
      let windowOptions;
      let trayOptions;
      const context = {
        BrowserWindow: function (options) { windowOptions = options; },
        createDesktopTray(options) { trayOptions = options; },
        desktopIconPaths: () => desktopIconPaths(platform), process: { platform },
        Tray: {}, Menu: {}, ipcMain: {}, dialog: {}, requestQuit() {},
        customMenu: false, desktopPartition: 'fixture', remotePartition: 'fixture', fileURLToPath, URL,
      };
      runInNewContext(`${windowCode}\n${trayCode}`.replaceAll('import.meta.url', JSON.stringify(url.href)), context);
      assert.equal(windowOptions.icon, asset(platform === 'win32' ? 'icon.ico' : '128x128.png'));
      assert.equal(trayOptions.icon, asset(platform === 'win32' ? 'icon.ico' : '32x32.png'));
      assert.equal(windowOptions.webPreferences.contextIsolation, true);
      assert.equal(windowOptions.webPreferences.nodeIntegration, false);
    }
  });
}

test('both desktop packages include icon policy and window resources while disabling only signing', async () => {
  const local = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).build;
  const remote = JSON.parse(await readFile(new URL('../electron-builder.remote.json', import.meta.url), 'utf8'));
  for (const config of [local, remote]) {
    for (const name of ['desktop/desktop-icons.mjs', 'renderer/src-tauri/icons/128x128.png', 'renderer/src-tauri/icons/32x32.png', 'renderer/src-tauri/icons/icon.ico']) {
      assert.ok(config.files.includes(name), `packaged app is missing ${name}`);
    }
    assert.equal(config.win.icon, 'renderer/src-tauri/icons/icon.ico');
    assert.equal(config.win.signAndEditExecutable, true);
    assert.equal(config.win.signExecutable, false);
    assert.notEqual(config.forceCodeSigning, true);
  }
});

test('Windows taskbar identities match each host package and do not use the Electron default', async () => {
  const local = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).build;
  const remote = JSON.parse(await readFile(new URL('../electron-builder.remote.json', import.meta.url), 'utf8'));
  for (const [host, config] of [['main.mjs', local], ['remote-main.mjs', remote]]) {
    const source = await readFile(new URL(host, import.meta.url), 'utf8');
    const call = source.match(/app\.setAppUserModelId\([^;]+\);/)?.[0];
    assert.ok(call, `${host} must identify its own taskbar group`);
    let appId;
    runInNewContext(call, { app: { setAppUserModelId(value) { appId = value; } } });
    assert.equal(appId, config.appId);
  }
});

test('both builder configs explicitly select Linux and macOS icons without adding release targets', async () => {
  const local = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).build;
  const remote = JSON.parse(await readFile(new URL('../electron-builder.remote.json', import.meta.url), 'utf8'));
  for (const config of [local, remote]) {
    assert.equal(config.linux?.icon, 'renderer/src-tauri/icons/icon.png');
    assert.equal(config.mac?.icon, 'renderer/src-tauri/icons/icon.icns');
    assert.equal(config.mac.target, undefined);
  }
  assert.deepEqual(local.linux.target, ['AppImage']);
  assert.equal(remote.linux.target, undefined);
  assert.deepEqual(local.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.deepEqual(remote.win.target, [{ target: 'zip', arch: ['x64'] }]);
});

test('installed electron-builder writes ICO resources into an unsigned fixture PE for both package configs', async () => {
  const require = createRequire(import.meta.url);
  require('electron-builder');
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const { WinPackager } = builderRequire('app-builder-lib/out/winPackager.js');
  const resourceRequire = createRequire(builderRequire.resolve('app-builder-lib/out/util/resEdit.js'));
  const { NtExecutable, NtExecutableResource, Resource, Data } = resourceRequire('resedit');
  const local = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).build;
  const remote = JSON.parse(await readFile(new URL('../electron-builder.remote.json', import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-icon-resources-'));
  try {
    for (const config of [local, remote]) {
      const file = join(directory, 'fixture.exe');
      await writeFile(file, Buffer.from(NtExecutable.createEmpty(false, false).generate()));
      let signed = false;
      const packager = {
        appInfo: { productFilename: 'fixture', productName: config.productName, copyright: 'fixture', buildVersion: '1.0.0', getVersionInWeirdWindowsForm: () => '1.0.0' },
        platformSpecificBuildOptions: config.win, forceCodeSigning: false,
        config: { electronDist: 'fixture-only-no-signing-cache' },
        getIconPath: async () => asset('icon.ico'),
        shouldSignFile: () => true,
        _sign: async () => { signed = true; throw new Error('fixture must not request signing credentials'); },
        signIf: WinPackager.prototype.signIf,
        signAndEditResources: WinPackager.prototype.signAndEditResources,
      };
      await WinPackager.prototype.signApp.call(packager, { appOutDir: directory, arch: 1, outDir: directory }, true);
      const resources = NtExecutableResource.from(NtExecutable.from(await readFile(file)));
      const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
      assert.equal(groups.length, 1, 'the unsigned executable must contain the application icon');
      const original = Data.IconFile.from(await readFile(asset('icon.ico')));
      assert.equal(original.icons.length, 6, 'the canonical ICO must supply all six application sizes');
      assert.ok(original.icons.some(icon => icon.data.isRaw()), 'the canonical ICO must exercise PNG resource frames');
      assert.equal(groups[0].icons.length, original.icons.length);
      const embedded = groups[0].getIconItemsFromEntries(resources.entries);
      // PNG RawIconItem exposes its exact payload via bin; bitmap IconItem serializes via generate.
      const bytes = icon => Buffer.from(icon.isRaw() ? icon.bin : icon.generate());
      assert.equal(embedded.length, 6);
      assert.deepEqual(embedded.map(icon => icon.isRaw()), original.icons.map(icon => icon.data.isRaw()));
      assert.deepEqual(embedded.map(bytes), original.icons.map(icon => bytes(icon.data)));
      assert.equal(signed, false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('packaged Windows icons resolve to the real shell resource outside asar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-packaged-icon-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'shell'));
    const icon = join(root, 'shell', 'icon.ico');
    await writeFile(icon, await readFile(desktopIconPaths('win32').window));
    assert.deepEqual(desktopIconPaths('win32', root), { window: icon, tray: icon });
    assert.notEqual(desktopIconPaths('linux', root).tray, icon);
  } finally { await rm(root, { recursive: true, force: true }); }
});
