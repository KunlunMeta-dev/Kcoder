const { contextBridge, ipcRenderer } = require('electron');
const scope = process.argv.find(value => value.startsWith('--kcoder-window-scope='))?.split('=')[1];
if (scope && !/^[a-zA-Z0-9-]{1,64}$/.test(scope)) throw new Error('Invalid desktop window scope');
const invoke = (channel, ...args) => ipcRenderer.invoke(scope ? `${channel}:${scope}` : channel, ...args);

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('kcoderDesktopHost', Object.freeze({
    capabilities: Object.freeze({ completionBadge: process.platform === 'win32' }),
    widgets: Object.freeze({
      getCapabilities: () => ipcRenderer.invoke('kcoder:widgets:capabilities'),
      authorize: request => ipcRenderer.invoke('kcoder:widgets:authorize', request),
      heartbeat: request => ipcRenderer.invoke('kcoder:widgets:heartbeat', request),
      revoke: request => ipcRenderer.invoke('kcoder:widgets:revoke', request),
      onRevoked: callback => {
        if (typeof callback !== 'function') throw new TypeError('Expected a widget listener');
        const listener = (_event, value) => callback(value);
        ipcRenderer.on('kcoder:widgets:revoked', listener);
        return () => ipcRenderer.removeListener('kcoder:widgets:revoked', listener);
      },
    }),
    ...(process.argv.includes('--kcoder-local-directory-picker') ? {
      pickWorkspacePaths: options => invoke('kcoder:directories:pick', options),
    } : {}),
    ...(process.argv.includes('--kcoder-local-storage-locations') ? {
      storageLocations: Object.freeze({
        read: () => invoke('kcoder:storage-locations:read'),
        pick: options => invoke('kcoder:storage-locations:pick', options),
        preview: options => invoke('kcoder:storage-locations:preview', options),
        migrate: options => invoke('kcoder:storage-locations:migrate', options),
        retry: options => invoke('kcoder:storage-locations:retry', options),
        cleanupPreview: options => invoke('kcoder:storage-locations:cleanupPreview', options),
        cleanupConfirm: options => invoke('kcoder:storage-locations:cleanupConfirm', options),
        cleanupStatus: options => invoke('kcoder:storage-locations:cleanupStatus', options),
      }),
    } : {}),
    ...(process.argv.includes('--kcoder-local-workspace-open') ? {
      takeWorkspaceOpenRequests: () => ipcRenderer.invoke('kcoder:workspace-open:pending'),
      acknowledgeWorkspaceOpen: id => ipcRenderer.invoke('kcoder:workspace-open:ack', id),
      onWorkspaceOpen: callback => {
        if (typeof callback !== 'function') throw new TypeError('Expected a workspace listener');
        const listener = () => callback();
        ipcRenderer.on('kcoder:workspace-open:changed', listener);
        return () => ipcRenderer.removeListener('kcoder:workspace-open:changed', listener);
      },
    } : {}),
    download: params => ipcRenderer.invoke('kcoder:download', params),
    readFeedbackDiagnostics: options => ipcRenderer.invoke('kcoder:feedback:diagnostics', options),
    captureFeedbackScreenshot: () => ipcRenderer.invoke('kcoder:feedback:capture'),
    setPreferences: preferences => invoke('kcoder:tray:preferences', preferences),
    setTrayState: state => invoke('kcoder:tray:state', state),
    setTaskActivity: count => invoke('kcoder:tray:activity', count),
    getTrayCapabilities: () => invoke('kcoder:tray:capabilities'),
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
  try {
    if (typeof contextBridge.executeInMainWorld !== 'function') throw new Error('Adapter unavailable');
    contextBridge.executeInMainWorld({ func: () => {
      const nativeClick = HTMLAnchorElement.prototype.click;
      let downloadPending = false;
      const notify = result => window.dispatchEvent(new CustomEvent('kcoder:download-result', { detail: result }));
      const download = link => {
        if (link.ownerDocument !== document || !link.download || !link.href.startsWith('blob:')) return false;
        try { if (new URL(link.href).origin !== location.origin) return false; }
        catch { return false; }
        if (downloadPending) return true;
        downloadPending = true;
        const filename = link.download;
        void (async () => {
          try { notify(await window.kcoderDesktopHost.download({ url: link.href, filename })); }
          catch { console.warn('DESKTOP_LEGACY_DOWNLOAD_FAILED'); notify({ status: 'interrupted', filename }); }
          finally { downloadPending = false; }
        })();
        return true;
      };
      Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
        configurable: true, writable: true,
        value: function () { if (this.isConnected || !download(this)) nativeClick.call(this); },
      });
      document.addEventListener('click', event => {
        const link = event.target?.closest?.('a[download]');
        if (!event.defaultPrevented && link && download(link)) event.preventDefault();
      });
    } });
  } catch { console.warn('DESKTOP_BLOB_ADAPTER_UNAVAILABLE'); }
}

// Expose only allowlisted menu operations, never the IPC object or Node primitives.
if (process.isMainFrame && process.argv.includes('--kcoder-custom-menu')) {
  contextBridge.exposeInMainWorld('kcoderDesktopMenu', Object.freeze({
    list: locale => invoke('kcoder:menu:list', locale),
    invoke: (index, position) => invoke('kcoder:menu:invoke', { index, position }),
    setTheme: (dark, backgroundColor) => invoke('kcoder:menu:theme', dark, backgroundColor),
    setVisible: visible => invoke('kcoder:menu:visible', visible),
    open: (index, x, y) => invoke('kcoder:menu:open', { index, x, y }),
  }));
}
