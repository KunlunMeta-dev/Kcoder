import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';

const rendererRoot = fileURLToPath(new URL('../../../renderer/', import.meta.url));
const requireRenderer = createRequire(join(rendererRoot, 'package.json'));
const { build } = await import(requireRenderer.resolve('vite'));
const JSZip = requireRenderer('jszip');
const electronBinary = process.env.KCODER_E2E_ELECTRON_BIN;
assert.ok(electronBinary?.startsWith('/'), 'Set KCODER_E2E_ELECTRON_BIN to an installed Electron binary');
assert.equal(process.platform, 'linux', 'This native acceptance uses an owned Xvfb display');
assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1', 'Explicit isolated-host sandbox opt-in required');

await runE2E(import.meta.url, {
  testId: 'feedback-export-browser-electron', tier: 'manual-live',
  modelPolicy: 'model-independent actual export helper, native preload/IPC/capture/download and Chromium; no model or shared Gateway',
}, async context => {
  const bundle = await build({ configFile: false, root: rendererRoot, logLevel: 'error',
    resolve: { alias: { '@': join(rendererRoot, 'src') } },
    build: { write: false, minify: false, rollupOptions: {
      input: fileURLToPath(new URL('../../fixtures/feedback-export/renderer.ts', import.meta.url)),
      output: { inlineDynamicImports: true },
    } } });
  const script = bundle.output.find(item => item.type === 'chunk').code;
  const server = createServer((request, response) => {
    if (request.url === '/entry.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' }).end(script);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Owned feedback</title><h1>Feedback acceptance</h1><button>Export</button><output></output><script type="module" src="/entry.js"></script>');
    }
  });
  context.addCleanup('close owned feedback server', async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.registerPort('feedback-server', server.address().port);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const downloads = context.pathInState('downloads');
  await mkdir(downloads, { mode: 0o700 });
  const chromium = await startChromium(context, { label: 'feedback-browser' });
  const page = await chromium.newPage();
  await page.goto(origin);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export' }).click()]);
  const browserPath = join(downloads, 'browser.zip');
  await download.saveAs(browserPath);
  await page.waitForFunction(() => document.querySelector('output').textContent.length > 0);
  const browserResult = JSON.parse(await page.locator('output').textContent());
  assert.equal(browserResult.downloadStatus, 'requested');
  const browserZip = await JSZip.loadAsync(await readFile(browserPath));
  assert.equal(browserZip.file('screenshot.png'), null);
  assert.equal(browserZip.file('logs/runtime.log'), null);
  assert.equal(JSON.parse(await browserZip.file('context/task.json').async('string')).taskId, 'owned-feedback-task');
  await page.close();
  await chromium.close();

  const display = await startOwnedDisplay(context);
  const directories = Object.fromEntries(['home', 'tmp', 'cache', 'config', 'data', 'runtime'].map(name => [name, context.pathInState(name)]));
  for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true, mode: 0o700 });
  const reportPath = context.pathInState('electron-result.json');
  const configPath = await context.writeStateJson('electron-config.json', {
    origin, downloads, reportPath, profile: context.pathInState('electron-profile'),
  });
  const child = context.spawnOwned('feedback-electron', electronBinary, [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--ozone-platform=x11',
    '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    fileURLToPath(new URL('../../fixtures/feedback-export/electron.mjs', import.meta.url)), `--owned-config=${configPath}`,
  ], { env: context.isolatedEnvironment({
    DISPLAY: display.display, XAUTHORITY: display.authority, HOME: directories.home, USERPROFILE: directories.home,
    TMPDIR: directories.tmp, TMP: directories.tmp, TEMP: directories.tmp, XDG_CACHE_HOME: directories.cache,
    XDG_CONFIG_HOME: directories.config, XDG_DATA_HOME: directories.data, XDG_RUNTIME_DIR: directories.runtime,
  }) });
  await waitFor(() => child.exitCode !== null, 35_000, 'owned feedback Electron export', 50);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  await context.writeArtifactJson('electron-report.json', report);
  assert.equal(report.error, null, `Electron phase: ${report.phase}`);
  assert.equal(child.exitCode, 0);
  const desktopZip = await JSZip.loadAsync(await readFile(join(downloads, report.result.path)));
  const png = await desktopZip.file('screenshot.png').async('nodebuffer');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length > 100);
  const logs = await desktopZip.file('logs/runtime.log').async('string');
  assert.match(logs, /Owned Gateway log/);
  assert.doesNotMatch(logs, /synthetic-private-value/);
  assert.equal(JSON.parse(await desktopZip.file('environment.json').async('string')).platform, process.platform);
  const result = { browserDownload: browserResult.downloadStatus, electronDownload: report.result.downloadStatus,
    screenshotBytes: png.length, logRedacted: true, osSaveDialog: 'not exercised; owned destination', sharedServices: 'untouched' };
  await context.writeArtifactJson('feedback-export.json', result);
  return result;
});
