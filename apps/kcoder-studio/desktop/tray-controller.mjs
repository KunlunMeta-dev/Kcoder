import { isTrustedGatewayUrl } from './security-policy.mjs';

const CHANNELS = ['preferences', 'state', 'hide', 'window', 'activity'].map(name => `kcoder:tray:${name}`);

function validRecord(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key));
}

export function createDesktopTray({ Tray, Menu, ipcMain, dialog, window, icon,
  getGatewayOrigin, isQuitting, requestQuit, onError = console.error,
  channelScope = '', enableTray = true, requestWindowClose = requestQuit }) {
  const channels = CHANNELS.map(channel => channelScope ? `${channel}:${channelScope}` : channel);
  const contents = window.webContents;
  let tray = null;
  let disposed = false;
  let promptPending = false;
  let language = 'zh-CN';
  // Keep the renderer alive until its own persisted preference has been synchronized.
  let closeToTrayEnabled = true;
  let activeTaskCount = null;
  const trusted = () => !disposed && !window.isDestroyed() &&
    isTrustedGatewayUrl(contents.mainFrame?.url ?? '', getGatewayOrigin());
  const authorize = event => {
    if (!trusted() || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
      throw new Error('Desktop tray is restricted to the main application frame');
    }
  };
  const show = () => {
    if (disposed || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const hide = () => {
    if (!tray || disposed) throw new Error('System tray is unavailable');
    window.hide();
  };
  const rebuildMenu = () => {
    if (!tray) return;
    const english = language === 'en';
    tray.setContextMenu(Menu.buildFromTemplate([
      { id: 'show', label: english ? 'Show KCoder Studio' : '显示 KCoder Studio', click: show },
      { id: 'settings', label: english ? 'Settings' : '设置', click: () => {
        show();
        if (trusted()) contents.send('kcoder:tray:settings');
      } },
      { type: 'separator' },
      { id: 'quit', label: english ? 'Quit' : '退出', click: () => requestQuit(0) },
    ]));
  };
  try {
    if (enableTray) {
      tray = new Tray(icon);
      tray.setToolTip('KCoder Studio');
      tray.on('click', show);
      tray.on('double-click', show);
      rebuildMenu();
    }
  } catch (error) {
    tray?.destroy();
    tray = null;
    onError('KCoder Studio system tray is unavailable; window closing remains guarded', error);
  }

  const confirmClose = async () => {
    if (promptPending) return;
    promptPending = true;
    const english = language === 'en';
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'question', title: 'KCoder Studio',
        message: english ? 'Tasks may still be running.' : '任务可能仍在运行。',
        detail: !enableTray ? (english ? 'Closing disconnects this window but keeps other windows open.' : '关闭会断开此窗口，但不会关闭其他窗口。') : english ? 'Keep the window open or run in the background. Quitting disconnects this client and stops its local Gateway.' :
          '可保留窗口或在后台继续运行。退出会断开此客户端并停止其本地 Gateway。',
        buttons: tray
          ? (english ? ['Run in background', 'Cancel', 'Quit'] : ['后台运行', '取消', '退出'])
          : (english ? ['Keep open', 'Cancel', enableTray ? 'Quit' : 'Close window'] : ['保留窗口', '取消', enableTray ? '退出' : '关闭窗口']),
        defaultId: 1, cancelId: 1, noLink: true,
      });
      if (disposed || isQuitting()) return;
      if (result.response === 0 && tray) hide();
      if (result.response === 2) {
        if (enableTray) requestQuit(0);
        else requestWindowClose(0);
      }
    } catch (error) {
      onError('KCoder Studio could not confirm window closure', error);
    } finally {
      promptPending = false;
    }
  };
  const onClose = event => {
    if (disposed || isQuitting()) return;
    event.preventDefault();
    if (closeToTrayEnabled && tray) { hide(); return; }
    // Unknown task state is protected too, including startup and renderer failure.
    if (activeTaskCount === null || activeTaskCount > 0) { void confirmClose(); return; }
    requestWindowClose(0);
  };
  const resetTaskKnowledge = () => { activeTaskCount = null; };
  window.on('close', onClose);
  contents.on('render-process-gone', resetTaskKnowledge);
  contents.on('did-start-navigation', resetTaskKnowledge);
  ipcMain.handle(channels[0], (event, value) => {
    authorize(event);
    if (!validRecord(value, ['closeToTrayEnabled', 'language']) ||
        typeof value.closeToTrayEnabled !== 'boolean' || !['en', 'zh-CN'].includes(value.language)) {
      throw new Error('Invalid desktop tray preferences');
    }
    closeToTrayEnabled = value.closeToTrayEnabled;
    language = value.language;
    rebuildMenu();
    return { available: Boolean(tray) };
  });
  ipcMain.handle(channels[1], (event, value) => {
    authorize(event);
    if (!validRecord(value, ['language', 'activeTaskIds']) || !['en', 'zh-CN'].includes(value.language) ||
        (value.activeTaskIds !== null && (!Array.isArray(value.activeTaskIds) || value.activeTaskIds.length > 10000 ||
        value.activeTaskIds.some(id => typeof id !== 'string' || id.length > 4096)))) {
      throw new Error('Invalid desktop tray state');
    }
    language = value.language;
    rebuildMenu();
    return { available: Boolean(tray) };
  });
  ipcMain.handle(channels[2], event => { authorize(event); hide(); });
  ipcMain.handle(channels[3], (event, action) => {
    authorize(event);
    if (action === 'quit') return requestQuit(0);
    if (action === 'close') return window.close();
    if (action === 'minimize') return window.minimize();
    if (action === 'isMaximized') return window.isMaximized();
    if (action === 'toggleMaximize') return window.isMaximized() ? window.unmaximize() : window.maximize();
    throw new Error('Invalid desktop window action');
  });
  ipcMain.handle(channels[4], (event, count) => {
    authorize(event);
    if (count !== null && (!Number.isInteger(count) || count < 0 || count > 10000)) {
      throw new Error('Invalid desktop task activity');
    }
    activeTaskCount = count;
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeListener('close', onClose);
    contents.removeListener('render-process-gone', resetTaskKnowledge);
    contents.removeListener('did-start-navigation', resetTaskKnowledge);
    for (const channel of channels) ipcMain.removeHandler(channel);
    tray?.destroy();
    tray = null;
  };
  window.once('closed', dispose);
  return { get available() { return Boolean(tray); }, show, dispose };
}
