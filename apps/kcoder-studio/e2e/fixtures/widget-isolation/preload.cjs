const { ipcRenderer } = require('electron');
// A trusted preload reports actual renderer flags; the page receives no IPC API.
ipcRenderer.send('kcoder-widget-isolation-probe', {
  sandboxed: process.sandboxed === true,
  contextIsolated: process.contextIsolated === true,
  mainFrame: process.isMainFrame === true,
});
