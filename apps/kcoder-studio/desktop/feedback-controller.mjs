import { isTrustedGatewayUrl } from './security-policy.mjs';

/** Diagnostics expose only this application's bounded output and requesting window. */
export function registerFeedbackDiagnostics({ ipcMain, getWindow, getGatewayOrigin,
  getRuntimeLogs = () => null, getVersion = () => '' }) {
  const channels = ['kcoder:feedback:diagnostics', 'kcoder:feedback:capture'];
  let disposed = false;
  const owner = event => {
    const window = getWindow(event.sender);
    const frame = event.senderFrame;
    const origin = getGatewayOrigin();
    const authorize = () => {
      if (disposed || !window || getWindow(event.sender) !== window || window.isDestroyed() ||
          event.sender.isDestroyed() || frame !== event.sender.mainFrame ||
          getGatewayOrigin() !== origin || !isTrustedGatewayUrl(frame?.url, origin)) {
        throw new Error('Feedback is restricted to the main application frame');
      }
    };
    authorize();
    return { authorize };
  };
  ipcMain.handle(channels[0], (event, options) => {
    owner(event);
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some(key => !['runtimeLogs', 'systemInfo'].includes(key)) ||
        typeof options.runtimeLogs !== 'boolean' || typeof options.systemInfo !== 'boolean') {
      throw new Error('Invalid feedback diagnostics request');
    }
    return {
      runtimeLogs: options.runtimeLogs ? getRuntimeLogs()?.slice(-1024 * 1024) ?? null : null,
      systemInfo: options.systemInfo ? { version: getVersion(), platform: process.platform,
        architecture: process.arch, electron: process.versions.electron } : null,
    };
  });
  ipcMain.handle(channels[1], async event => {
    const ticket = owner(event);
    const image = await event.sender.capturePage();
    ticket.authorize();
    const png = image.toPNG();
    if (png.length > 8 * 1024 * 1024) throw new Error('Feedback screenshot exceeds 8 MiB');
    return `data:image/png;base64,${png.toString('base64')}`;
  });
  return () => {
    disposed = true;
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
