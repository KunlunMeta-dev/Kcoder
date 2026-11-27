import { app, BrowserWindow, session } from 'electron';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const input = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
app.setPath('userData', input.profile);
app.setPath('sessionData', input.profile);
console.log('SESSION_PATH_PROBE_CONFIGURED');
// Electron must finish evaluating its entry module before becoming ready.
app.whenReady().then(async () => {
  console.log('SESSION_PATH_PROBE_READY');
  const partition = session.fromPartition('persist:kcoder-studio-desktop');
  const window = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:kcoder-studio-desktop', sandbox: true } });
  await window.loadURL(input.url);
  console.log('SESSION_PATH_PROBE_DOCUMENT');
  if (input.phase === 'write') {
    await window.webContents.executeJavaScript(`localStorage.setItem('kcoder-owned-path-probe', ${JSON.stringify(input.marker)})`);
    await partition.cookies.set({ url: input.url, name: 'kcoder_owned_path_probe', value: input.marker, httpOnly: true,
      expirationDate: Math.floor(Date.now() / 1000) + 3600 });
  }
  const local = await window.webContents.executeJavaScript(`localStorage.getItem('kcoder-owned-path-probe') === ${JSON.stringify(input.marker)}`);
  const cookies = await partition.cookies.get({ url: input.url, name: 'kcoder_owned_path_probe' });
  await writeFile(input.result, JSON.stringify({ phase: input.phase, localStorage: local,
    partitionCookieMatched: cookies.some(row => row.value === input.marker), persistent: partition.isPersistent(),
    storagePathLength: partition.storagePath?.length, namespace: partition.storagePath?.startsWith('\\\\?\\') }), { flag: 'wx' });
  if (input.quit === 'quit') app.quit(); else app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
