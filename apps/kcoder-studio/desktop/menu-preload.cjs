const { contextBridge, ipcRenderer } = require('electron');
const scope = process.argv.find(value => value.startsWith('--kcoder-window-scope='))?.split('=')[1];
if (scope && !/^[a-zA-Z0-9-]{1,64}$/.test(scope)) throw new Error('Invalid desktop window scope');
const invoke = (channel, ...args) => ipcRenderer.invoke(scope ? `${channel}:${scope}` : channel, ...args);

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('kcoderDesktopHost', Object.freeze({
    ...(process.argv.includes('--kcoder-local-directory-picker') ? {
      pickWorkspacePaths: options => invoke('kcoder:directories:pick', options),
    } : {}),
    setPreferences: preferences => invoke('kcoder:tray:preferences', preferences),
    setTrayState: state => invoke('kcoder:tray:state', state),
    setTaskActivity: count => invoke('kcoder:tray:activity', count),
    hideToTray: () => invoke('kcoder:tray:hide'),
    windowAction: action => invoke('kcoder:tray:window', action),
    onMenuCommand: callback => {
      if (typeof callback !== 'function') throw new TypeError('Expected a menu listener');
      const listener = (_event, command) => {
        if (['new-chat', 'new-temporary-chat', 'open-folder', 'logout'].includes(command)) callback(command);
      };
      ipcRenderer.on('kcoder:menu:command', listener);
      return () => ipcRenderer.removeListener('kcoder:menu:command', listener);
    },
    onSettings: callback => {
      if (typeof callback !== 'function') throw new TypeError('Expected a settings listener');
      const listener = () => callback();
      ipcRenderer.on('kcoder:tray:settings', listener);
      return () => ipcRenderer.removeListener('kcoder:tray:settings', listener);
    },
  }));
}

// Expose only allowlisted menu operations, never the IPC object or Node primitives.
if (process.isMainFrame && process.argv.includes('--kcoder-custom-menu')) {
  contextBridge.exposeInMainWorld('kcoderDesktopMenu', Object.freeze({
    list: locale => invoke('kcoder:menu:list', locale),
    invoke: (index, position) => invoke('kcoder:menu:invoke', { index, position }),
    setTheme: dark => invoke('kcoder:menu:theme', dark),
    setVisible: visible => invoke('kcoder:menu:visible', visible),
    open: (index, x, y) => invoke('kcoder:menu:open', { index, x, y }),
  }));
}
