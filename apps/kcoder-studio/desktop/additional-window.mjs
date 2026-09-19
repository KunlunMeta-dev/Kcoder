import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { desktopIconPaths } from './desktop-icons.mjs';
import { registerDesktopMenu } from './desktop-menu-controller.mjs';
import { registerDirectoryDialog } from './directory-dialog-controller.mjs';
import { createDesktopTray } from './tray-controller.mjs';
import { isTrustedGatewayUrl } from './security-policy.mjs';

export function sendDesktopMenuCommand(command, focused, primary, windows, origin) {
  if (!['new-chat', 'new-temporary-chat', 'open-folder', 'logout'].includes(command)) return;
  const target = focused ?? primary;
  if (!target || (target !== primary && !windows.has(target)) || target.isDestroyed() ||
      !isTrustedGatewayUrl(target.webContents.getURL(), origin)) return;
  target.webContents.send('kcoder:menu:command', command);
}

export async function openAdditionalWindow({ BrowserWindow, Menu, ipcMain, dialog, shell,
  windows, partition, getGatewayOrigin, initialUrl, menu, customMenu, directoryOptions,
  isQuitting, requestQuit, onLastClosed = () => {} }) {
  if (isQuitting()) return;
  if (windows.size >= 8) throw new Error('最多同时打开 8 个额外窗口，请先关闭不需要的窗口。');
  const channelScope = randomUUID();
  const origin = getGatewayOrigin();
  const url = initialUrl || `${origin}/`;
  if (!isTrustedGatewayUrl(url, origin)) throw new Error('Gateway is unavailable');
  const window = new BrowserWindow({
    icon: desktopIconPaths().window, width: 1440, height: 900, minWidth: 960, minHeight: 640,
    show: false, backgroundColor: '#111111', title: 'KCoder Studio',
    ...(customMenu ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#ffffff', symbolColor: '#1a1c1f', height: 40 } } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      partition, preload: fileURLToPath(new URL('./menu-preload.cjs', import.meta.url)),
      additionalArguments: [`--kcoder-window-scope=${channelScope}`,
        ...(customMenu ? ['--kcoder-custom-menu'] : []),
        ...(directoryOptions ? ['--kcoder-local-directory-picker'] : [])] },
  });
  windows.add(window);
  window.once('closed', () => { windows.delete(window); if (!windows.size) onLastClosed(); });
  try {
    window.setMenu(menu);
    createDesktopTray({ Menu, ipcMain, dialog, window, getGatewayOrigin, isQuitting, requestQuit,
      channelScope, enableTray: false, requestWindowClose: () => window.destroy() });
    if (customMenu) registerDesktopMenu({ ipcMain, window, menu, getGatewayOrigin, channelScope });
    if (directoryOptions) registerDirectoryDialog({ ...directoryOptions, ipcMain, dialog, window, channelScope });
    const external = value => {
      try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && url.origin !== getGatewayOrigin()) void shell.openExternal(url.href); }
      catch { /* Invalid URLs never leave the app. */ }
    };
    window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => {
      if (isTrustedGatewayUrl(url, getGatewayOrigin())) return;
      event.preventDefault(); external(url);
    });
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
    await window.loadURL(url);
    return window;
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}
