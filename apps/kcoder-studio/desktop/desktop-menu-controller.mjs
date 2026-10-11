import { localizeMenu } from './application-menu-labels.mjs';
import { isTrustedGatewayUrl } from './security-policy.mjs';

const CHANNELS = ['kcoder:menu:list', 'kcoder:menu:visible', 'kcoder:menu:open', 'kcoder:menu:invoke', 'kcoder:menu:theme'];

export function registerDesktopMenu({ ipcMain, window, menu, getGatewayOrigin, channelScope = '' }) {
  const channels = CHANNELS.map(channel => channelScope ? `${channel}:${channelScope}` : channel);
  const contents = window.webContents;
  let disposed = false;
  let activePopup = null;
  const authorize = event => {
    if (disposed || window.isDestroyed() || event.sender !== contents ||
        event.senderFrame !== contents.mainFrame ||
        !isTrustedGatewayUrl(event.senderFrame?.url ?? '', getGatewayOrigin())) {
      throw new Error('Desktop menu is restricted to the main application frame');
    }
  };
  ipcMain.handle(channels[0], (event, locale) => {
    authorize(event);
    if (locale !== undefined && (typeof locale !== 'string' || locale.length > 32)) throw new Error('Invalid menu locale');
    localizeMenu(menu, locale);
    const accelerators = { undo: 'Ctrl+Z', redo: 'Ctrl+Y', cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', selectAll: 'Ctrl+A', reload: 'Ctrl+R', forceReload: 'Ctrl+Shift+R', resetZoom: 'Ctrl+0', zoomIn: 'Ctrl++', zoomOut: 'Ctrl+-', togglefullscreen: 'F11' };
    return menu.items.map((item, index) => ({ index, id: item.id, label: item.label,
      ...(item.submenu?.items ? { entries: item.submenu.items.map((entry, position) => ({ position, id: entry.id, label: entry.label, type: entry.type, enabled: entry.enabled !== false, visible: entry.visible !== false, checked: entry.checked === true, accelerator: entry.accelerator || accelerators[entry.role] || '' })) } : {}) }));
  });
  ipcMain.handle(channels[1], (event, visible) => {
    authorize(event);
    if (typeof visible !== 'boolean') throw new Error('Invalid desktop menu visibility');
    window.setMenuBarVisibility(!visible);
  });
  ipcMain.handle(channels[2], (event, params) => {
    authorize(event);
    if (!params || typeof params !== 'object' || Array.isArray(params) ||
        Object.keys(params).some(key => !['index', 'x', 'y'].includes(key)) ||
        !Number.isInteger(params.index) || params.index < 0 || params.index >= menu.items.length ||
        !Number.isFinite(params.x) || !Number.isFinite(params.y)) {
      throw new Error('Invalid desktop menu request');
    }
    const submenu = menu.items[params.index]?.submenu;
    if (!submenu || activePopup) throw new Error('Desktop menu is unavailable or already open');
    const zoom = contents.getZoomFactor();
    const [width, height] = window.getContentSize();
    return new Promise((resolve, reject) => {
      const popup = { submenu, finish: null };
      const finish = () => { if (activePopup === popup) activePopup = null; resolve(); };
      popup.finish = finish;
      activePopup = popup;
      try {
        submenu.popup({
          window,
          x: Math.min(Math.max(0, Math.round(params.x * zoom)), Math.max(0, width - 1)),
          y: Math.min(Math.max(0, Math.round(params.y * zoom)), Math.max(0, height - 1)),
          callback: finish,
        });
      } catch {
        if (activePopup === popup) activePopup = null;
        if (!window.isDestroyed()) window.setMenuBarVisibility(true);
        reject(new Error('Unable to open the desktop menu'));
      }
    });
  });
  ipcMain.handle(channels[3], (event, params) => {
    authorize(event);
    if (!params || Array.isArray(params) || Object.keys(params).some(key => !['index', 'position'].includes(key)) || !Number.isInteger(params.index) || !Number.isInteger(params.position) || params.index < 0 || params.position < 0) throw new Error('Invalid menu command');
    const parent = menu.items[params.index];
    const item = parent?.submenu?.items[params.position];
    if (!item || parent.enabled === false || parent.visible === false || item.enabled === false || item.visible === false || item.type === 'separator' || item.submenu || typeof item.click !== 'function') throw new Error('Menu command unavailable');
    // Electron's MenuItem instance wrapper retains native role semantics and targets
    // this window's WebContents, never whichever window happens to be focused.
    item.click({ triggeredByAccelerator: false }, window, contents);
  });
  ipcMain.handle(channels[4], (event, dark) => {
    authorize(event);
    if (typeof dark !== 'boolean') throw new Error('Invalid menu theme');
    window.setTitleBarOverlay?.({ color: dark ? '#181818' : '#ffffff', symbolColor: dark ? '#ffffff' : '#1a1c1f', height: 40 });
  });
  const dismissPopup = () => {
    const popup = activePopup;
    if (!popup) return;
    activePopup = null;
    try { popup.submenu.closePopup(window); }
    catch { /* The native widget may already be gone during window teardown. */ }
    finally { popup.finish(); }
  };
  const restoreNativeMenu = () => {
    if (!disposed && !window.isDestroyed()) window.setMenuBarVisibility(true);
    dismissPopup();
  };
  const restoreAfterFailedLoad = (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) restoreNativeMenu();
  };
  contents.on('did-navigate', restoreNativeMenu);
  contents.on('render-process-gone', restoreNativeMenu);
  contents.on('did-fail-load', restoreAfterFailedLoad);
  // The tray handler may hide or destroy the window synchronously; dismiss native UI first.
  window.prependListener('close', dismissPopup);
  const dispose = () => {
    if (disposed) return;
    dismissPopup();
    disposed = true;
    contents.removeListener('did-navigate', restoreNativeMenu);
    contents.removeListener('render-process-gone', restoreNativeMenu);
    contents.removeListener('did-fail-load', restoreAfterFailedLoad);
    window.removeListener('close', dismissPopup);
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
  window.once('closed', dispose);
  return dispose;
}
