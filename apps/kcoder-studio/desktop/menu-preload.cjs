const { contextBridge, ipcRenderer } = require('electron');
const scope = process.argv.find(value => value.startsWith('--kcoder-window-scope='))?.split('=')[1];
if (scope && !/^[a-zA-Z0-9-]{1,64}$/.test(scope)) throw new Error('Invalid desktop window scope');
const invoke = (channel, ...args) => ipcRenderer.invoke(scope ? `${channel}:${scope}` : channel, ...args);

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('kcoderDesktopHost', Object.freeze({
    capabilities: Object.freeze({ completionBadge: process.platform === 'win32' }),
    ...(process.argv.includes('--kcoder-local-directory-picker') ? {
      pickWorkspacePaths: options => invoke('kcoder:directories:pick', options),
    } : {}),
    download: params => ipcRenderer.invoke('kcoder:download', params),
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
  // Older Gateway renderers export Blob files with a disconnected anchor. Adapt
  // only this main document; the host still mints its ordinary one-use permit.
  contextBridge.executeInMainWorld?.({ func: () => {
    const nativeClick = HTMLAnchorElement.prototype.click;
    const notify = result => window.dispatchEvent(new CustomEvent('kcoder:download-result', { detail: result }));
    const download = link => {
      if (link.ownerDocument !== document || !link.download || !link.href.startsWith('blob:')) return false;
      try { if (new URL(link.href).origin !== location.origin) return false; }
      catch { return false; }
      const filename = link.download;
      void window.kcoderDesktopHost.download({ url: link.href, filename }).then(notify, () => notify({ status: 'interrupted', filename }));
      return true;
    };
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      configurable: true, writable: true,
      value: function () { if (!download(this)) nativeClick.call(this); },
    });
    document.addEventListener('click', event => {
      const link = event.target?.closest?.('a[download]');
      if (link && download(link)) event.preventDefault();
    }, true);
  } });
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
