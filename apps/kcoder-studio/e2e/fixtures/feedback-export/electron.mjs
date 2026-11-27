import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { registerFeedbackDiagnostics } from '../../../desktop/feedback-controller.mjs';
import { registerDownloads } from '../../../desktop/download-controller.mjs';

const configPath = process.argv.find(value => value.startsWith('--owned-config='))?.slice('--owned-config='.length);
assert.ok(configPath && isAbsolute(configPath));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
for (const path of [config.profile, config.downloads, config.reportPath]) assert.ok(isAbsolute(path));
app.setPath('userData', config.profile);
app.setPath('sessionData', join(config.profile, 'session'));
let window, stopFeedback = () => {}, stopDownloads = () => {}, finishing = false, phase = 'ready';
const watchdog = setTimeout(() => void finish(new Error('Owned feedback deadline exceeded')), 25_000);
async function finish(error, result) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  stopFeedback(); stopDownloads();
  await writeFile(config.reportPath, JSON.stringify({ error: error ? String(error.message ?? error) : null, phase, result }));
  window?.destroy();
  app.exit(error ? 1 : 0);
}
void app.whenReady().then(async () => {
 try {
  window = new BrowserWindow({ width: 640, height: 480, show: true, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: fileURLToPath(new URL('../../../desktop/menu-preload.cjs', import.meta.url)),
  } });
  window.webContents.on('console-message', (_event, _level, message) => console.log(message));
  const getWindow = contents => contents === window.webContents ? window : null;
  const getGatewayOrigin = () => config.origin;
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !details.url.startsWith('blob:') && new URL(details.url).origin !== config.origin });
  });
  stopFeedback = registerFeedbackDiagnostics({ ipcMain, getWindow, getGatewayOrigin,
    getRuntimeLogs: () => 'Owned Gateway log\nAuthorization: Bearer synthetic-private-value\n', getVersion: () => app.getVersion() });
  stopDownloads = registerDownloads({ ipcMain, getWindow, getGatewayOrigin,
    session: window.webContents.session, downloadsDirectory: config.downloads });
  // Exercise the production download receipt with an owned destination, bypassing only the OS save dialog.
  window.webContents.session.on('will-download', (_event, item) => item.setSavePath(item.getSaveDialogOptions().defaultPath));
  phase = 'load';
  await window.loadURL(config.origin);
  phase = 'click';
  await window.webContents.executeJavaScript("document.querySelector('button').click()");
  phase = 'result';
  let result;
  while (!result) {
    const output = await window.webContents.executeJavaScript("document.querySelector('output').textContent");
    if (output) result = JSON.parse(output);
    else await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(result.error, undefined);
  assert.equal(result.downloadStatus, 'completed');
  await finish(null, result);
 } catch (error) { await finish(error); }
});
