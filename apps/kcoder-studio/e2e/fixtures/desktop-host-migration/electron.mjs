import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { createWindowResponsiveness } from '../../../desktop/window-responsiveness.mjs';
import { createWorkspaceOpenController, parseWorkspaceOpenRequest } from '../../../desktop/workspace-open-controller.mjs';

console.log('OWNED_MIGRATION_MODULE_LOADED');
const configPath = process.argv.find(value => value.startsWith('--owned-config='))?.slice('--owned-config='.length);
assert.ok(configPath);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
app.setPath('userData', config.profile); app.setPath('sessionData', join(config.profile, 'session'));
let window, recovery, queue, finishing = false, phase = 'startup', decision = 0;
const prompts = [];
const deadline = setTimeout(() => void finish(new Error('Owned desktop migration deadline exceeded')), 30_000);
async function finish(error, result) {
  if (finishing) return;
  console.log('OWNED_MIGRATION_FINISH', phase, error?.message ?? 'passed');
  finishing = true; clearTimeout(deadline); recovery?.dispose(); queue?.dispose();
  await writeFile(config.reportPath, JSON.stringify({ phase, error: error?.message ?? null, result }));
  window?.destroy(); app.exit(error ? 1 : 0);
}
async function until(read, label) {
  const end = Date.now() + 8_000;
  while (Date.now() < end) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Owned wait failed: ' + label);
}
if (!app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() })) { clearTimeout(deadline); app.quit(); }
else {
  const pending = [];
  process.on('uncaughtException', error => void finish(error));
  process.on('unhandledRejection', error => void finish(error));
  app.on('second-instance', (_event, argv, cwd, original) => {
    console.log('OWNED_MIGRATION_SECOND_EVENT');
    try {
      const request = parseWorkspaceOpenRequest(original?.argv ?? argv, original?.cwd ?? cwd);
      console.log('OWNED_MIGRATION_SECOND_PARSED');
      if (queue) queue.enqueue(request); else pending.push(request);
      console.log('OWNED_MIGRATION_SECOND_QUEUED');
    } catch (error) { void finish(error); }
  });
  void app.whenReady().then(async () => {
    console.log('OWNED_MIGRATION_APP_READY');
    try {
      window = new BrowserWindow({ width: 640, height: 480, show: true, webPreferences: {
        sandbox: true, nodeIntegration: false, contextIsolation: true,
        preload: fileURLToPath(new URL('../../../desktop/menu-preload.cjs', import.meta.url)),
        additionalArguments: ['--kcoder-local-workspace-open'],
      } });
      queue = createWorkspaceOpenController({ ipcMain, getWindow: () => window, getGatewayOrigin: () => config.origin,
        getServers: async () => [{ id: 'selected-ssh', transport: 'ssh' }, { id: 'verified-native', transport: 'local' }] });
      queue.enqueue(parseWorkspaceOpenRequest(process.argv, process.cwd()));
      pending.splice(0).forEach(request => queue.enqueue(request));
      recovery = createWindowResponsiveness({ powerMonitor, getGatewayOrigin: () => config.origin, timeoutMs: 150,
        locale: 'en', dialog: { showMessageBox: async (_window, options) => { prompts.push(options); return { response: decision }; } } });
      recovery.attach(window);
      window.webContents.on('console-message', event => console.log('OWNED_RENDERER', event.message));
      console.log('OWNED_MIGRATION_WINDOW_CREATED');
      await window.loadURL(config.origin); window.focus();
      await until(() => window.isFocused(), 'owned window focus');
      await until(async () => (await window.webContents.executeJavaScript('window.hostMigration?.opened.length')) === 1, 'cold-start request');
      console.log('OWNED_MIGRATION_FIRST_REQUEST_OPENED');
      phase = 'second-instance'; await writeFile(config.readyPath, '{}');
      await until(async () => (await window.webContents.executeJavaScript('window.hostMigration.opened.length')) === 2, 'real second-instance request');
      console.log('OWNED_MIGRATION_SECOND_OPENED');
      const opened = await window.webContents.executeJavaScript('window.hostMigration.opened');
      assert.equal(opened[0].serverId, 'verified-native'); assert.equal(opened[0].path, config.firstWorkspace);
      assert.equal(opened[1].serverId, 'verified-native'); assert.equal(opened[1].path, config.secondWorkspace);
      assert.deepEqual(await window.webContents.executeJavaScript('window.hostMigration.errors'), []);
      await until(async () => (await window.webContents.executeJavaScript('window.kcoderDesktopHost.takeWorkspaceOpenRequests()')).length === 0, 'request acknowledgements');
      console.log('OWNED_MIGRATION_PAINT_PHASE');
      phase = 'paint'; assert.equal(await recovery.probe(window), 'responsive');
      await window.webContents.executeJavaScript("document.querySelector('textarea').value = 'owned unsent draft'; window.requestAnimationFrame = () => 1; true");
      assert.equal(await recovery.probe(window), 'waiting');
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('textarea').value"), 'owned unsent draft');
      assert.equal(prompts[0].defaultId, 0); assert.match(prompts[0].detail, /unsent drafts/);
      console.log('OWNED_MIGRATION_RELOAD_PHASE');
      phase = 'reload'; decision = 1;
      const loaded = once(window.webContents, 'did-finish-load');
      assert.equal(await recovery.probe(window), 'reload-requested'); await loaded;
      assert.equal(await recovery.probe(window), 'responsive');
      console.log('OWNED_MIGRATION_CRASH_PHASE');
      phase = 'crash';
      const recovered = once(window.webContents, 'did-finish-load');
      const rendererPid = window.webContents.getOSProcessId();
      assert.ok(rendererPid > 0 && rendererPid !== process.pid);
      process.kill(rendererPid, 'SIGKILL'); await recovered;
      assert.equal(await recovery.probe(window), 'responsive');
      await finish(null, { opened, realSecondInstance: true, waitPreservedDraft: true, reloadRecovered: true,
        rendererCrashRecovered: true, prompts: prompts.length, backendTurns: 0 });
    } catch (error) { await finish(error); }
  });
}
