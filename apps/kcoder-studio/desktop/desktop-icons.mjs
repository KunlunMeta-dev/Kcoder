import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function materializeShellIcon(directory, source = desktopIconPaths('win32').window) {
  const bytes = readFileSync(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `kcoder-${digest}.ico`);
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !readFileSync(path).equals(bytes)) {
      throw new Error('Shell icon cache is not the expected regular file');
    }
  }
  return path;
}

function quoteWindowsPath(path) {
  if (/["\r\n\0]/.test(path)) throw new Error('Invalid relaunch path');
  return `"${path.replace(/\\+$/, suffix => suffix + suffix)}"`;
}

export function registerTaskbarIcon(app, appId, platform = process.platform, executable = process.execPath) {
  if (platform !== 'win32') return;
  let details;
  app.on('browser-window-created', (_event, window) => {
    // Resolve lazily: each host configures its userData path after registering this listener.
    if (!details) {
      let appIconPath = app.isPackaged ? executable : desktopIconPaths('win32').window;
      try {
        // Shell cannot open app.asar resources. A content-addressed real ICO also changes
        // its cache identity when the artwork changes, independently of the EXE filename.
        appIconPath = materializeShellIcon(join(app.getPath('userData'), 'shell-icons'));
      } catch (error) {
        console.warn('KCoder shell icon materialization failed; using executable/source icon', error.code || 'invalid-cache');
      }
      details = {
        appId, appIconPath, appIconIndex: 0,
        relaunchCommand: app.isPackaged ? quoteWindowsPath(executable)
          : `${quoteWindowsPath(executable)} ${quoteWindowsPath(app.getAppPath())}`,
        relaunchDisplayName: app.getName(),
      };
    }
    window.setAppDetails(details);
  });
}

/** Runtime icons resolve identically in source trees and packaged app.asar resources. */
export function desktopIconPaths(platform = process.platform, resourcesPath = process.resourcesPath) {
  // Electron Builder excludes ICO files from asar; Windows ships this real shell resource.
  const shellIcon = platform === 'win32' && resourcesPath ? join(resourcesPath, 'shell', 'icon.ico') : null;
  if (shellIcon && existsSync(shellIcon)) return { window: shellIcon, tray: shellIcon };
  const asset = name => fileURLToPath(new URL(`../renderer/src-tauri/icons/${name}`, import.meta.url));
  return {
    window: asset(platform === 'win32' ? 'icon.ico' : '128x128.png'),
    tray: asset(platform === 'win32' ? 'icon.ico' : '32x32.png'),
  };
}
