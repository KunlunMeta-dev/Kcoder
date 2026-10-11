import { isAbsolute } from 'node:path';
import { isTrustedGatewayUrl } from './security-policy.mjs';

const CHANNEL = 'kcoder:directories:pick';

export function registerDirectoryDialog({ ipcMain, dialog, window, getGatewayOrigin,
  getServers, getHomeDirectory, channelScope = '' }) {
  const channel = channelScope ? `${CHANNEL}:${channelScope}` : CHANNEL;
  const contents = window.webContents;
  let pending = false;
  let disposed = false;
  const authorize = event => {
    if (disposed || window.isDestroyed() || event.sender !== contents ||
        event.senderFrame !== contents.mainFrame ||
        !isTrustedGatewayUrl(event.senderFrame?.url ?? '', getGatewayOrigin())) {
      throw new Error('Directory picker is restricted to the main application frame');
    }
  };
  const requireLocalTarget = async serverId => {
    const servers = await getServers();
    if (!Array.isArray(servers) || !servers.some(server => server.id === serverId && server.transport === 'local')) {
      throw new Error('Native directory selection requires a local target on this computer');
    }
  };
  ipcMain.handle(channel, async (event, params) => {
    authorize(event);
    if (!params || typeof params !== 'object' || Array.isArray(params) ||
        Object.keys(params).some(key => !['serverId', 'initialDirectory', 'multiple'].includes(key)) ||
        typeof params.serverId !== 'string' || !params.serverId.trim() || params.serverId.length > 512 || params.serverId.includes('\0') ||
        typeof params.multiple !== 'boolean' ||
        (params.initialDirectory != null && (typeof params.initialDirectory !== 'string' ||
          params.initialDirectory.length > 32767 || params.initialDirectory.includes('\0') || !isAbsolute(params.initialDirectory)))) {
      throw new Error('Invalid directory picker request');
    }
    if (pending) throw new Error('A directory picker is already open');
    pending = true;
    try {
      await requireLocalTarget(params.serverId);
      authorize(event);
      const result = await dialog.showOpenDialog(window, {
        defaultPath: params.initialDirectory || getHomeDirectory(),
        properties: params.multiple ? ['openDirectory', 'multiSelections'] : ['openDirectory'],
      });
      authorize(event);
      if (result.canceled) return [];
      // A target can be edited while an OS dialog is open; never return PC paths for SSH.
      await requireLocalTarget(params.serverId);
      authorize(event);
      if (!Array.isArray(result.filePaths) || result.filePaths.length > 64 || (!params.multiple && result.filePaths.length > 1) ||
          result.filePaths.some(path => typeof path !== 'string' || path.length > 32767 || path.includes('\0') || !isAbsolute(path))) {
        throw new Error('Native directory selection returned invalid paths');
      }
      return [...new Set(result.filePaths)];
    } finally {
      pending = false;
    }
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeHandler(channel);
  };
  window.once('closed', dispose);
  return dispose;
}
