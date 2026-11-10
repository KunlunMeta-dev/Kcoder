import { randomUUID } from 'node:crypto';

/** A cancelled await can dispose its captured owner without touching another window. */
export async function runDesktopStartup({ createWindow, publish, clear, isQuitting, startMain }) {
  const owned = createWindow();
  publish(owned);
  const dispose = () => { owned.dispose(); clear(owned); };
  try {
    await owned.ready;
    if (isQuitting()) { dispose(); return; }
    await startMain();
    dispose();
  } catch (error) {
    if (isQuitting()) { dispose(); return; }
    // Keep the window owned until the caller reports failure and quits the app.
    throw error;
  }
}

export async function startOwnedGateway({ start, isQuitting }) {
  if (isQuitting()) return null;
  const owned = await start();
  if (isQuitting()) { await owned.stop(); return null; }
  return owned;
}

/** Native startup status has no preload, application Cookie, IPC or network access. */
export function createStartupWindow({ BrowserWindow, session, locale = 'en', icon, onClose }) {
  const chinese = String(locale).toLowerCase().startsWith('zh');
  const heading = chinese ? '正在启动 KCoder Studio…' : 'Starting KCoder Studio…';
  const detail = chinese ? '请稍候。' : 'Please wait.';
  // The authenticated renderer theme is unavailable until its Gateway starts.
  // Native system colors preserve dark mode and high-contrast accessibility here.
  const html = `<!doctype html><html lang="${chinese ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="kcoder-desktop-startup" content="restricted"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>KCoder Studio</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-content:center;gap:12px;background:Canvas;color:CanvasText;font:14px system-ui,'Segoe UI',sans-serif}h1{margin:0;font-size:18px;font-weight:600}p{margin:0;color:GrayText}span{width:16px;height:16px;border:2px solid GrayText;border-right-color:transparent;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){span{animation:none}}</style></head><body><span aria-hidden="true"></span><h1 role="status" aria-live="polite">${heading}</h1><p>${detail}</p></body></html>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  const partition = `kcoder-startup-${randomUUID()}`;
  const isolated = session.fromPartition(partition);
  isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, reply) => reply({ cancel: details.url !== url }));
  const window = new BrowserWindow({ width: 640, height: 400, minWidth: 480, minHeight: 280, show: true,
    title: 'KCoder Studio', icon, autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  let disposed = false;
  window.on('closed', () => { if (!disposed) onClose(); });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    isolated.webRequest.onBeforeRequest(null);
    if (!window.isDestroyed()) window.destroy();
  };
  return { dispose, ready: window.loadURL(url) };
}
