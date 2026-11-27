import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { assertChromiumSingletonSocketPathBudget } from '../../harness/short-chromium-temp.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';

process.umask(0o077);
const electron = process.env.KCODER_E2E_ELECTRON_BIN;
assert.ok(electron?.startsWith('/'), 'Explicit Electron binary required');
assert.equal(process.platform, 'linux');
assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1', 'Explicit owned-host sandbox opt-in required');
const rendererRoot = fileURLToPath(new URL('../../../renderer/', import.meta.url));
const requireRenderer = createRequire(join(rendererRoot, 'package.json'));
const { build } = await import(requireRenderer.resolve('vite'));
await runE2E(import.meta.url, { testId: 'desktop-host-migration', tier: 'manual-live', retainSuccessEvidence: true,
  modelPolicy: 'model-independent real Electron preload/controllers, paint fault injection, renderer crash and two OS processes; no Gateway/model/backend task or shared configuration' }, async context => {
  const bundle = await build({ configFile: false, root: rendererRoot, logLevel: 'error', resolve: { alias: { '@': join(rendererRoot, 'src') } },
    build: { write: false, minify: false, rollupOptions: { input: fileURLToPath(new URL('../../fixtures/desktop-host-migration/renderer.ts', import.meta.url)), output: { codeSplitting: false } } } });
  const script = bundle.output.find(value => value.type === 'chunk').code;
  const server = createServer((request, response) => {
    if (request.url === '/entry.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; script-src &#39;self&#39;"><title>Owned desktop migration</title><textarea></textarea><script type="module" src="/entry.js"></script>');
  });
  context.addCleanup('close owned desktop migration server', async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); context.registerPort('desktop-migration-server', server.address().port);
  const display = await startOwnedDisplay(context);
  const sockets = await context.createOwnedScratchDirectory('host-migration-sockets', { baseDirectory: '/tmp' });
  assertChromiumSingletonSocketPathBudget(sockets.path);
  const directories = Object.fromEntries(['home', 'tmp', 'cache', 'config', 'data', 'runtime', 'first project', 'second project'].map(name => [name, context.pathInState(name)]));
  for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(context.pathInState('electron-profile'), { mode: 0o700 });
  const reportPath = context.pathInState('electron-report.json'), readyPath = context.pathInState('ready.json');
  const config = await context.writeStateJson('electron-config.json', { origin: `http://127.0.0.1:${server.address().port}`, reportPath, readyPath,
    profile: context.pathInState('electron-profile'), firstWorkspace: directories['first project'], secondWorkspace: directories['second project'] });
  const fixture = fileURLToPath(new URL('../../fixtures/desktop-host-migration/electron.mjs', import.meta.url));
  const busAddress = `unix:path=${sockets.path}/bus`;
  const env = context.isolatedEnvironment({ DISPLAY: display.display, XAUTHORITY: display.authority, HOME: directories.home, USERPROFILE: directories.home,
    TMPDIR: sockets.path, TMP: sockets.path, TEMP: sockets.path, XDG_CACHE_HOME: directories.cache, XDG_CONFIG_HOME: directories.config,
    XDG_DATA_HOME: directories.data, XDG_RUNTIME_DIR: sockets.path, DBUS_SESSION_BUS_ADDRESS: busAddress });
  const bus = context.spawnOwned('desktop-migration-bus', '/usr/bin/dbus-daemon', ['--session', '--nofork', '--nopidfile', '--print-address=1', '--address=' + busAddress], { env });
  let busOutput = ''; bus.stdout.on('data', chunk => { busOutput += String(chunk); });
  await waitFor(() => busOutput.includes(busAddress), 5_000, 'owned D-Bus ready');
  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--ozone-platform=x11', '--disable-background-networking', '--disable-component-update',
    '--no-proxy-server', fixture, `--owned-config=${config}`];
  let primaryExit = null;
  const primary = context.spawnOwned('desktop-migration-primary', electron, [...args, '--open-workspace', directories['first project']], { env });
  let primaryOutput = ''; primary.stdout.on('data', chunk => { primaryOutput += String(chunk); });
  primary.once('exit', (code, signal) => { primaryExit = { code, signal }; });
  await waitFor(async () => { if (primary.exitCode !== null || primary.signalCode !== null) throw new Error('Primary exited before second-instance delivery: ' + JSON.stringify({ code: primary.exitCode, signal: primary.signalCode, report: await readFile(reportPath, 'utf8').then(JSON.parse, () => null) })); return access(readyPath).then(() => true, () => false); }, 35_000, 'owned primary ready');
  const secondary = context.spawnOwned('desktop-migration-secondary', electron, [...args, '--open-workspace', directories['second project'], '--workspace-label', 'Second project'], { env });
  await waitFor(() => secondary.exitCode !== null, 10_000, 'owned second instance exits'); assert.equal(secondary.exitCode, 0);
  try {
    await waitFor(() => primaryExit !== null || primary.exitCode !== null || primary.signalCode !== null, 35_000, 'owned recovery and workspace acceptance');
  } finally {
    const report = await readFile(reportPath, 'utf8').then(JSON.parse, () => null);
    await context.writeArtifactJson('desktop-native-exit.json', { primaryExit, report, output: primaryOutput });
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8')); await context.writeArtifactJson('desktop-host-migration.json', report);
  assert.equal(report.error, null, report.phase); assert.equal(primary.exitCode, 0); return report.result;
});
