import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { buildAiVerifyGatewayEnvironment } from '../../../renderer/scripts/ai-verify-environment.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { appRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { assertChromiumSingletonSocketPathBudget } from '../../harness/short-chromium-temp.mjs';
import { waitForSelectedModel } from '../../harness/model-selector.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

let commandSequence = 0;

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function runOwnedCommand(context, name, binary, args, env, timeoutMs = 10_000) {
  const label = name + '-' + (++commandSequence);
  const child = context.spawnOwned(label, binary, args, { env });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-32_000); });
  await waitFor(() => child.exitCode !== null, timeoutMs, label + ' exit', 25, context.abortSignal);
  if (child.exitCode !== 0) throw new Error(label + ' failed with exit code ' + child.exitCode);
  return stdout.trim();
}

function parseWindowGeometry(output) {
  const fields = Object.fromEntries(output.split(/\r?\n/).map(line => line.split('=')));
  const geometry = {
    x: Number(fields.X), y: Number(fields.Y), width: Number(fields.WIDTH), height: Number(fields.HEIGHT),
  };
  if (Object.values(geometry).some(value => !Number.isFinite(value)) || geometry.width < 1 || geometry.height < 1) {
    throw new Error('Owned tray window geometry is invalid');
  }
  return geometry;
}

async function readWindowMapState(context, xwininfo, windowId, env, label) {
  const output = await runOwnedCommand(context, label, xwininfo, ['-id', String(windowId)], env);
  const state = output.match(/Map State:\s+(IsViewable|IsUnMapped|IsUnviewable)/)?.[1];
  if (!state) throw new Error('Owned X11 window map state was not reported');
  return state;
}

const x11TrayProbe = [
  'import ctypes, ctypes.util, json',
  'from ctypes import POINTER, byref, c_int, c_long, c_ubyte, c_uint, c_ulong, c_void_p',
  'lib = ctypes.CDLL(ctypes.util.find_library("X11"))',
  'lib.XOpenDisplay.restype = c_void_p',
  'lib.XInternAtom.argtypes = [c_void_p, ctypes.c_char_p, c_int]',
  'lib.XInternAtom.restype = c_ulong',
  'lib.XGetSelectionOwner.argtypes = [c_void_p, c_ulong]',
  'lib.XGetSelectionOwner.restype = c_ulong',
  'lib.XQueryTree.argtypes = [c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_ulong), POINTER(POINTER(c_ulong)), POINTER(c_uint)]',
  'lib.XQueryTree.restype = c_int',
  'lib.XGetGeometry.argtypes = [c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_int), POINTER(c_int), POINTER(c_uint), POINTER(c_uint), POINTER(c_uint), POINTER(c_uint)]',
  'lib.XGetGeometry.restype = c_int',
  'lib.XGetWindowProperty.argtypes = [c_void_p, c_ulong, c_ulong, c_long, c_long, c_int, c_ulong, POINTER(c_ulong), POINTER(c_int), POINTER(c_ulong), POINTER(c_ulong), POINTER(POINTER(c_ubyte))]',
  'lib.XGetWindowProperty.restype = c_int',
  'lib.XFree.argtypes = [c_void_p]',
  'display = lib.XOpenDisplay(None)',
  'if not display: raise SystemExit("XOpenDisplay failed")',
  'def property_value(window, name):',
  '    atom = lib.XInternAtom(display, name.encode(), 0)',
  '    actual, fmt, count, remaining = c_ulong(), c_int(), c_ulong(), c_ulong()',
  '    data = POINTER(c_ubyte)()',
  '    status = lib.XGetWindowProperty(display, window, atom, 0, 8, 0, 0, byref(actual), byref(fmt), byref(count), byref(remaining), byref(data))',
  '    try:',
  '        if status != 0 or not actual.value or not count.value or not data: return None',
  '        if fmt.value == 32: return int(ctypes.cast(data, POINTER(c_ulong))[0])',
  '        return True',
  '    finally:',
  '        if data: lib.XFree(data)',
  'def geometry(window):',
  '    root, x, y, width, height, border, depth = c_ulong(), c_int(), c_int(), c_uint(), c_uint(), c_uint(), c_uint()',
  '    if not lib.XGetGeometry(display, window, byref(root), byref(x), byref(y), byref(width), byref(height), byref(border), byref(depth)): return None',
  '    return {"x": x.value, "y": y.value, "width": width.value, "height": height.value}',
  'selection = lib.XGetSelectionOwner(display, lib.XInternAtom(display, b"_NET_SYSTEM_TRAY_S0", 0))',
  'embedded, seen = [], set()',
  'def visit(window, depth=0):',
  '    if window in seen or depth > 16: return',
  '    seen.add(window)',
  '    root, parent, children, count = c_ulong(), c_ulong(), POINTER(c_ulong)(), c_uint()',
  '    if not lib.XQueryTree(display, window, byref(root), byref(parent), byref(children), byref(count)): return',
  '    try:',
  '        for index in range(count.value):',
  '            child = int(children[index])',
  '            embed = property_value(child, "_XEMBED_INFO")',
  '            if embed is not None:',
  '                embedded.append({"window": child, "pid": property_value(child, "_NET_WM_PID"), "geometry": geometry(child)})',
  '            visit(child, depth + 1)',
  '    finally:',
  '        if children: lib.XFree(children)',
  'root = c_ulong()',
  'lib.XDefaultRootWindow.argtypes = [c_void_p]',
  'lib.XDefaultRootWindow.restype = c_ulong',
  'visit(int(lib.XDefaultRootWindow(display)))',
  'selection_owner_pid = property_value(selection, "_NET_WM_PID") if selection else None',
  'lib.XCloseDisplay.argtypes = [c_void_p]',
  'lib.XCloseDisplay(display)',
  'print(json.dumps({"selectionOwner": int(selection), "selectionOwnerPid": selection_owner_pid, "embedded": embedded}))',
].join('\n');

if (process.platform !== 'linux') throw new Error('UNMET_PREREQUISITE: owned native tray GUI currently requires Linux Xvfb');
if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== '1') throw new Error('UNMET_PREREQUISITE: isolated VM no-sandbox opt-in required');
if (!process.env.KCODER_E2E_RENDERER_ROOT) throw new Error('UNMET_PREREQUISITE: explicit isolated renderer root required');
if (!process.env.KCODER_E2E_KCODER_BIN || !process.env.KCODER_E2E_KCODER_BIN_SHA256) {
  throw new Error('UNMET_PREREQUISITE: explicitly pinned KCoder CLI path and SHA256 required');
}
if (!process.env.KCODER_E2E_DESKTOP_TRAY_SNI_BIN) throw new Error('UNMET_PREREQUISITE: task-owned GTK SNI tray host binary required');
if (!process.env.KCODER_E2E_DESKTOP_TRAY_WM_BIN || !process.env.KCODER_E2E_DESKTOP_TRAY_WM_LIBDIR) {
  throw new Error('UNMET_PREREQUISITE: task-owned window manager binary and private library directory required');
}
if (!process.env.KCODER_E2E_DESKTOP_TRAY_WMCTRL_BIN) {
  throw new Error('UNMET_PREREQUISITE: task-owned wmctrl binary required to request WM close for the owned Electron window');
}
if (!process.env.KCODER_E2E_CHROMIUM_BIN) throw new Error('UNMET_PREREQUISITE: explicit CFT Chromium path required for this isolated desktop run');
if (Boolean(process.env.KCODER_E2E_DESKTOP_TRAY_XEMBED_BIN) !== Boolean(process.env.KCODER_E2E_DESKTOP_TRAY_XEMBED_LIBDIR)) {
  throw new Error('UNMET_PREREQUISITE: XEmbed host binary and private library directory must be provided together');
}
await assertRendererBuildFresh();

const rendererRoot = await realpath(resolve(process.env.KCODER_E2E_RENDERER_ROOT));
const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'pinned KCoder binary');
const binarySha256 = await sha256File(binary);
assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256, 'KCoder binary must match the explicitly pinned frozen artifact');
const electron = await requireExecutable(
  process.env.KCODER_E2E_ELECTRON_BIN || resolve(appRoot, 'node_modules/electron/dist/electron'),
  'Electron',
);
const electronVersion = JSON.parse(await readFile(resolve(appRoot, 'node_modules/electron/package.json'), 'utf8')).version;
const sniHostBin = await requireExecutable(process.env.KCODER_E2E_DESKTOP_TRAY_SNI_BIN, 'task-owned GTK SNI tray host');
const windowManagerBin = await requireExecutable(process.env.KCODER_E2E_DESKTOP_TRAY_WM_BIN, 'task-owned Openbox window manager');
const windowManagerLibraryDirectory = await realpath(resolve(process.env.KCODER_E2E_DESKTOP_TRAY_WM_LIBDIR));
const windowManagerControlBin = await requireExecutable(process.env.KCODER_E2E_DESKTOP_TRAY_WMCTRL_BIN, 'task-owned EWMH window control');
const xembedHostBin = process.env.KCODER_E2E_DESKTOP_TRAY_XEMBED_BIN
  ? await requireExecutable(process.env.KCODER_E2E_DESKTOP_TRAY_XEMBED_BIN, 'task-owned XEmbed tray host')
  : null;
const xdotool = await requireExecutable(process.env.KCODER_E2E_XDOTOOL_BIN || '/usr/bin/xdotool', 'xdotool');
const xwininfo = await requireExecutable('/usr/bin/xwininfo', 'X11 window state probe');
const xprop = await requireExecutable('/usr/bin/xprop', 'X11 window-manager readiness probe');
const python = await requireExecutable('/usr/bin/python3', 'Python X11 probe');
const dbusDaemon = await requireExecutable('/usr/bin/dbus-daemon', 'D-Bus session daemon');
const busctl = await requireExecutable('/usr/bin/busctl', 'D-Bus inspector');
const busctlGetProperty = ['--user', 'get-property'];
const providerGate = { released: false };

await runE2E(import.meta.url, {
  testId: 'desktop-tray-background-task-continues-and-restores-original-thread',
  tier: 'manual-live',
  modelPolicy: 'model-independent held local provider; owned Electron, Xvfb, D-Bus and tray hosts; actual xdotool tray activation; no external model',
}, async context => {
  const display = await startOwnedDisplay(context);
  const home = context.pathInState('private-home');
  const runtimeDir = context.pathInState('xdg-runtime');
  const tempDir = context.pathInState('tmp');
  const xdgConfig = context.pathInState('xdg-config');
  const xdgCache = context.pathInState('xdg-cache');
  const xdgData = context.pathInState('xdg-data');
  const electronSocketScratch = await context.createOwnedScratchDirectory('electron-sockets', { baseDirectory: '/tmp' });
  const electronSingletonSocketPathBytes = assertChromiumSingletonSocketPathBudget(electronSocketScratch.path);
  const busName = 'kcoder-e2e-' + process.pid + '-' + randomBytes(8).toString('hex');
  const busAddress = 'unix:abstract=' + busName;
  context.registerSecret(busAddress);
  for (const directory of [home, runtimeDir, tempDir, xdgConfig, xdgCache, xdgData]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const displayEnv = context.isolatedEnvironment({
    DISPLAY: display.display,
    XAUTHORITY: display.authority,
    DBUS_SESSION_BUS_ADDRESS: busAddress,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tempDir,
  });
  const ownedDisplayGeometry = await runOwnedCommand(context, 'owned-display-geometry',
    xdotool, ['getdisplaygeometry'], displayEnv);
  assert.match(ownedDisplayGeometry, /^1280\s+900$/,
    'xdotool must authenticate to this run-owned Xvfb display before Electron starts');
  const bus = context.spawnOwned('private-dbus-session', dbusDaemon,
    ['--session', '--nofork', '--nopidfile', '--nosyslog', '--address=' + busAddress], { env: displayEnv });
  await waitFor(async () => {
    if (bus.exitCode !== null) throw new Error('Owned D-Bus session exited before readiness');
    try {
      await runOwnedCommand(context, 'dbus-ready', busctl,
        ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetId'], displayEnv);
      return true;
    } catch { return false; }
  }, 10_000, 'owned D-Bus session readiness', 50, context.abortSignal);

  const windowManagerPackageConfig = resolve(dirname(windowManagerBin), '../../etc/xdg/openbox/rc.xml');
  const windowManagerConfig = context.pathInState('openbox-rc.xml');
  const packageConfig = await readFile(windowManagerPackageConfig, 'utf8');
  assert.match(packageConfig, /<name>Clearlooks<\/name>/,
    'The extracted Openbox package config must use the known package default theme');
  await writeFile(windowManagerConfig, packageConfig.replace('<name>Clearlooks</name>', '<name>Natura</name>'),
    { mode: 0o600, flag: 'wx' });
  const trayDependencyLibraryDirectory = await realpath(process.env.KCODER_E2E_DESKTOP_TRAY_XEMBED_LIBDIR
    ? resolve(process.env.KCODER_E2E_DESKTOP_TRAY_XEMBED_LIBDIR)
    : resolve(dirname(windowManagerBin), '../../../usr/lib/x86_64-linux-gnu'));
  const windowManagerEnv = context.isolatedEnvironment({
    ...displayEnv,
    XDG_DATA_DIRS: [resolve(dirname(windowManagerBin), '../share'), '/usr/local/share', '/usr/share'].join(':'),
    LD_LIBRARY_PATH: [windowManagerLibraryDirectory, trayDependencyLibraryDirectory].join(':'),
  });
  const windowManager = context.spawnOwned('owned-openbox-window-manager', windowManagerBin,
    ['--sm-disable', '--config-file', windowManagerConfig], { cwd: context.stateDir, env: windowManagerEnv });
  const windowManagerProof = await waitFor(async () => {
    if (windowManager.exitCode !== null) {
      const stderr = await readFile(resolve(context.logsDir, 'owned-openbox-window-manager.log'), 'utf8').catch(() => '');
      throw new Error(`Owned Openbox exited before readiness (exitCode=${windowManager.exitCode}, signalCode=${windowManager.signalCode}): ${stderr.slice(-8000)}`);
    }
    const output = await runOwnedCommand(context, 'owned-window-manager-proof', xprop,
      ['-root', '_NET_SUPPORTING_WM_CHECK'], displayEnv);
    return /_NET_SUPPORTING_WM_CHECK\(WINDOW\): window id # 0x[1-9a-f]/i.test(output) ? output : null;
  }, 10_000, 'owned EWMH window manager selection', 50, context.abortSignal);

  const sniHost = context.spawnOwned('sni-tray-host', sniHostBin,
    ['--bottom', '--beginning', '--size', '32', '--padding', '4', '--length', '1%8', '--watcher'],
    { cwd: context.stateDir, env: displayEnv });
  let xembedHost = null;
  if (xembedHostBin) {
    const tint2Config = context.pathInState('tint2rc');
    await writeFile(tint2Config,
      'panel_items = S\n' +
      'panel_size = 44 44\n' +
      'panel_margin = 0 0\n' +
      'panel_padding = 0 0 0\n' +
      'panel_background_id = 0\n' +
      'panel_dock = 1\n' +
      'panel_position = top left horizontal\n' +
      'panel_layer = top\n' +
      'panel_monitor = 1\n' +
      'panel_shrink = 1\n' +
      'autohide = 0\n' +
      'systray_padding = 4 4 4\n' +
      'systray_background_id = 0\n' +
      'systray_sort = ascending\n' +
      'systray_icon_size = 24\n' +
      'systray_icon_asb = 100 0 0\n' +
      'systray_monitor = 1\n' +
      'panel_window_name = KCoderTrayXEmbedHost\n',
      { mode: 0o600, flag: 'wx' });
    const libraryDirectory = await realpath(resolve(process.env.KCODER_E2E_DESKTOP_TRAY_XEMBED_LIBDIR));
    const xembedEnv = context.isolatedEnvironment({ ...displayEnv, LD_LIBRARY_PATH: libraryDirectory });
    xembedHost = context.spawnOwned('xembed-tray-host', xembedHostBin, ['-c', tint2Config],
      { cwd: context.stateDir, env: xembedEnv });
  }
  assert.equal(sniHost.exitCode, null, 'Owned SNI tray host must remain alive');
  if (xembedHost) assert.equal(xembedHost.exitCode, null, 'Owned XEmbed tray host must remain alive');

  let fixtureRequests = null;
  const model = await startApprovalModelFixture(context, {
    responseSteps: ({ requestNumber }) => {
      assert.equal(requestNumber, 1, 'The original task must make exactly one provider request');
      return [
        { ready: () => providerGate.released, delta: { role: 'assistant', content: 'TRAY_BACKGROUND_TASK_FINISHED' } },
        { finishReason: 'stop' },
      ];
    },
  });
  fixtureRequests = model.requests;
  const workspace = (await materializeWorkspace(context, 'minimal', { instanceId: 'desktop-tray-background' })).path;
  const targetHome = context.pathInState('target-home');
  const settingsFile = await context.writeStateJson('target-home/settings.json', {
    credential_store: 'file',
    active_provider: 'fixture',
    model: 'tray-fixture',
    permission_mode: 'yolo',
    max_retries: 0,
    providers: {
      fixture: {
        api_format: 'openai_chat_completions',
        authentication: { mode: 'none' },
        endpoint: model.baseUrl,
        default_model: 'tray-fixture',
        context_window_tokens: 128000,
        output_headroom_tokens: 1024,
        max_output_tokens: 1024,
        no_proxy: true,
        discover_models: false,
      },
    },
  });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local', label: 'Owned tray target', transport: 'local', command: binary, workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    label: 'tray-background-gateway',
    auth: true,
    serversFile,
    workspace,
    kcoderBin: binary,
    startTimeoutMs: 300_000,
    env: {
      HOME: home,
      USERPROFILE: home,
      KCODER_HOME: targetHome,
      KCODER_CONFIG_DIR: targetHome,
      KCODER_STUDIO_WEB_ROOT: rendererRoot,
      KCODER_STUDIO_HEALTH_TIMEOUT_MS: '30000',
      TMPDIR: tempDir,
    },
  });
  assert.equal(sniHost.exitCode, null, 'Owned SNI tray host must remain available before Electron startup');
  const watcherOwner = await runOwnedCommand(context, 'sni-watcher-owner', busctl,
    ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
      'GetNameOwner', 's', 'org.kde.StatusNotifierWatcher'], displayEnv);
  const electronProfile = context.pathInState('electron-profile');
  await mkdir(electronProfile, { recursive: true, mode: 0o700 });
  const electronEnv = buildAiVerifyGatewayEnvironment(process.env, { sessionDirectory: context.stateDir });
  Object.assign(electronEnv, {
    DISPLAY: display.display,
    XAUTHORITY: display.authority,
    DBUS_SESSION_BUS_ADDRESS: busAddress,
    XDG_RUNTIME_DIR: electronSocketScratch.path,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    HOME: home,
    TMPDIR: electronSocketScratch.path,
    KCODER_HOME: targetHome,
    KCODER_CONFIG_DIR: targetHome,
    KCODER_STUDIO_REMOTE_URL: gateway.baseUrl,
    KCODER_STUDIO_REMOTE_TOKEN: gateway.authToken,
    KCODER_STUDIO_DESKTOP_USER_DATA_DIR: electronProfile,
    KCODER_STUDIO_KCODER_BIN: binary,
    KCODER_STUDIO_WEB_ROOT: rendererRoot,
    KCODER_STUDIO_DATA_DIR: context.pathInState('desktop-data'),
    KCODER_STUDIO_WORKSPACE: workspace,
    GDK_BACKEND: 'x11',
  });
  const app = context.spawnOwned('electron-remote-desktop', electron,
    [resolve(appRoot, 'desktop/remote-main.mjs'), '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox'],
    { cwd: appRoot, env: electronEnv });
  const cdpUrl = await waitFor(async () => {
    if (app.exitCode !== null) throw new Error('Owned Electron exited before CDP was ready');
    const activePort = await readFile(join(electronProfile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const [port, path] = activePort.trim().split('\n');
    if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535 ||
        !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path || '')) return null;
    return `ws://127.0.0.1:${port}${path}`;
  }, 30_000, 'owned Electron DevToolsActivePort endpoint', 50, context.abortSignal);
  context.registerPort('electron-cdp', Number(new URL(cdpUrl).port));
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 });
  context.addCleanup('close Electron CDP client', () => browser.close());
  const page = await waitFor(() => browser.contexts().flatMap(item => item.pages())
    .find(item => item.url().startsWith(gateway.baseUrl + '/')),
  30_000, 'owned Electron Gateway window', 50, context.abortSignal);
  await page.waitForLoadState('load', { timeout: 30_000 });
  const pageSession = await page.context().newCDPSession(page);
  context.addCleanup('detach original Electron page CDP session', () => pageSession.detach());

  const wire = { threadId: null, turnId: null, starts: [], terminals: [], sent: [], received: [] };
  let closeEvidence = null;
  let submissionEvidence = null;
  let closeToTrayPreference = null;
  let sniRegisteredItems = null;
  let selectedTray = null;
  let x11Probe = null;
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      try {
        const value = JSON.parse(String(frame.payload));
        if (value.method) wire.sent.push({ method: value.method, id: value.id ?? null });
      } catch { /* Non-JSON WebSocket frames are irrelevant to the RPC contract. */ }
    });
    socket.on('framereceived', frame => {
      try {
        const value = JSON.parse(String(frame.payload));
        wire.received.push(value);
        const threadId = value.result?.thread?.id ?? value.params?.threadId ?? value.params?.thread?.id;
        if (value.result?.thread?.id) wire.threadId = value.result.thread.id;
        if (value.method === 'turn/started' && threadId) {
          wire.threadId = threadId;
          wire.turnId = value.params?.turnId ?? value.params?.turn?.id ?? null;
        }
        if (value.method === 'turn/completed' || value.method === 'turn/failed' || value.method === 'turn/interrupted') {
          wire.terminals.push({ method: value.method, threadId, turnId: value.params?.turnId ?? value.params?.turn?.id ?? null });
        }
      } catch { /* Non-JSON WebSocket frames are irrelevant to the RPC contract. */ }
    });
  });

  try {
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60_000 });
    await page.getByTestId('chat-message-input').waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(() => page.evaluate(() =>
      typeof window.__KCODER_STUDIO_E2E__?.invokeRuntimeCommand === 'function'),
    15_000, 'automation-enabled renderer runtime command bridge', 50, context.abortSignal);
    closeToTrayPreference = await page.evaluate(async () => {
      const bridge = window.__KCODER_STUDIO_E2E__;
      const updated = await bridge.invokeRuntimeCommand('update_app_preferences', {
        patch: { closeToTrayEnabled: true, language: 'en' },
      });
      const persisted = await bridge.invokeRuntimeCommand('get_app_preferences');
      const tray = await window.kcoderDesktopHost.getTrayCapabilities();
      return {
        updated: { closeToTrayEnabled: updated.closeToTrayEnabled, language: updated.language },
        persisted: { closeToTrayEnabled: persisted.closeToTrayEnabled, language: persisted.language },
        tray,
      };
    });
    assert.equal(closeToTrayPreference.updated.closeToTrayEnabled, true,
      'The run-owned app preference update must enable close-to-tray');
    assert.equal(closeToTrayPreference.persisted.closeToTrayEnabled, true,
      'The run-owned app preference read must confirm close-to-tray remains enabled');
    assert.deepEqual(closeToTrayPreference.tray, { available: true },
      'The actual Electron host must create a system tray item');

    const taskMarker = 'TRAY_BACKGROUND_TASK_ORIGINAL';
    await waitFor(async () => {
      const offline = page.getByTestId('conversation-device-offline-banner');
      return !(await offline.isVisible()) && await page.getByTestId('chat-message-input').isEditable();
    }, 60_000, 'owned local target online and composer editable', 100, context.abortSignal);
    const composer = page.getByTestId('chat-message-input');
    const sendButton = page.getByTestId('send-message-button');
    submissionEvidence = {
      beforeModelReadiness: {
        modelSelectorLabel: await page.getByTestId('model-selector-button').innerText().catch(() => null),
        draft: await composer.innerText().catch(() => null),
        sendEnabled: await sendButton.isEnabled().catch(() => null),
      },
    };
    submissionEvidence.selectedModelLabel = await waitForSelectedModel(page, 'tray-fixture', 15_000);
    submissionEvidence.selectedModelReady = true;
    await composer.fill(taskMarker);
    await waitFor(() => sendButton.isEnabled(),
      15_000, 'composer send enabled for the selected fixture model', 50, context.abortSignal);
    submissionEvidence.beforeClick = {
      draft: await composer.innerText(),
      sendEnabled: await sendButton.isEnabled(),
      visibleAlerts: await page.locator('[role="alert"]:visible').allTextContents(),
    };
    await sendButton.click();
    submissionEvidence.afterClick = {
      draft: await composer.innerText().catch(() => null),
      sendEnabled: await sendButton.isEnabled().catch(() => null),
      visibleAlerts: await page.locator('[role="alert"]:visible').allTextContents().catch(() => []),
    };
    await page.getByTestId('pause-response-button').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.getByTestId('message-user').filter({ hasText: taskMarker })).toHaveCount(1);
    await waitFor(() => model.requests.length === 1 && model.activeResponseCount === 1,
      30_000, 'held original model request', 50, context.abortSignal);
    await waitFor(() => wire.threadId && wire.turnId, 30_000, 'original task and turn identity', 50, context.abortSignal);
    const originalThreadId = wire.threadId;
    const originalTurnId = wire.turnId;
    const originalUrl = page.url();
    const targetInfo = await pageSession.send('Target.getTargetInfo');
    const originalPageTargetId = targetInfo.targetInfo.targetId;
    const nativeWindowIds = (await runOwnedCommand(context, 'electron-window-search', xdotool,
      ['search', '--onlyvisible', '--pid', String(app.pid)], displayEnv))
      .split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number);
    assert.ok(nativeWindowIds.length > 0, 'The owned Electron process must have a visible native X11 window');
    const managedClientsOutput = await runOwnedCommand(context, 'owned-window-manager-clients', xprop,
      ['-root', '_NET_CLIENT_LIST'], displayEnv);
    const managedClientIds = [...managedClientsOutput.matchAll(/0x([0-9a-f]+)/gi)]
      .map(match => Number.parseInt(match[1], 16));
    const nativeWindowId = nativeWindowIds.find(windowId => managedClientIds.includes(windowId));
    assert.ok(nativeWindowId, 'The Electron application window must be a client managed by the owned window manager');
    const nativeWindowProtocols = await runOwnedCommand(context, 'electron-window-protocols', xprop,
      ['-id', String(nativeWindowId), 'WM_PROTOCOLS', '_NET_WM_PID'], displayEnv);
    assert.match(nativeWindowProtocols, /WM_DELETE_WINDOW/, 'The managed Electron window must advertise the native close protocol');
    const nativeWindowGeometry = parseWindowGeometry(await runOwnedCommand(context,
      'electron-window-geometry', xdotool, ['getwindowgeometry', '--shell', String(nativeWindowId)], displayEnv));
    assert.ok(nativeWindowGeometry.width >= 960 && nativeWindowGeometry.height >= 640,
      'The visible Electron native window must match the main application window bounds');
    assert.equal(await readWindowMapState(context, xwininfo, nativeWindowId, displayEnv,
      'electron-window-map-state-before-close'), 'IsViewable');
    assert.equal(windowManager.exitCode, null, 'The owned window manager must still be alive before the native close action');
    const matchingTaskRows = page.locator('[data-testid^="runtime-local-task-row-"]').filter({ hasText: taskMarker });
    await expect(matchingTaskRows).toHaveCount(1, { timeout: 30_000 });
    const originalTaskRowTestId = await matchingTaskRows.getAttribute('data-testid');
    assert.ok(originalTaskRowTestId?.startsWith('runtime-local-task-row-'));
    const activeRow = page.getByTestId(originalTaskRowTestId);
    await expect(activeRow).toBeVisible();

    const startCountsBeforeClose = {
      thread: wire.sent.filter(frame => frame.method === 'thread/start').length,
      turn: wire.sent.filter(frame => frame.method === 'turn/start').length,
    };
    assert.ok(startCountsBeforeClose.thread >= 1, 'The original task must have created a thread');
    assert.equal(startCountsBeforeClose.turn, 1, 'The original task must have started exactly one turn');
    assert.equal(windowManager.exitCode, null, 'The owned window manager must remain alive to handle EWMH close');
    const windowManagerInfo = await runOwnedCommand(context, 'owned-window-manager-info', windowManagerControlBin,
      ['-m'], displayEnv);
    const windowManagerSupportedAtoms = await runOwnedCommand(context, 'owned-window-manager-supported-atoms', xprop,
      ['-root', '_NET_SUPPORTED'], displayEnv);
    assert.match(windowManagerSupportedAtoms, /_NET_CLOSE_WINDOW/,
      'The owned window manager must advertise the EWMH close request before this test uses it');
    const wmctrlWindowList = await runOwnedCommand(context, 'wmctrl-owned-client-list', windowManagerControlBin,
      ['-l', '-p'], displayEnv);
    const wmctrlTargetLine = wmctrlWindowList.split(/\r?\n/)
      .find(line => Number.parseInt(line.match(/^0x([0-9a-f]+)/i)?.[1] || '', 16) === nativeWindowId);
    assert.ok(wmctrlTargetLine, 'wmctrl must enumerate the same native window XID owned by Electron');
    closeEvidence = {
      manager: windowManagerInfo,
      managerAdvertisesNetCloseWindow: true,
      wmctrlTargetLine,
      request: 'wmctrl -i -c',
      nativeWindowId,
    };
    const closeRequest = await runOwnedCommand(context, 'native-window-wmctrl-close', windowManagerControlBin,
      ['-i', '-c', '0x' + nativeWindowId.toString(16)], displayEnv);
    assert.equal(closeRequest, '', 'wmctrl should send an EWMH _NET_CLOSE_WINDOW request to the owned window manager');
    await waitFor(async () => await readWindowMapState(context, xwininfo, nativeWindowId, displayEnv,
      'electron-window-map-state-hidden') === 'IsUnMapped',
    5000, 'hidden tray window', 150, context.abortSignal);
    assert.equal(app.exitCode, null, 'Hiding the window must keep the Electron process alive');
    assert.equal(gateway.child.exitCode, null, 'Hiding the window must keep its independently owned Gateway alive');
    assert.equal(page.isClosed(), false, 'Hiding the native window must preserve the original renderer target');
    assert.equal(model.activeResponseCount, 1, 'The original model request must remain held while the window is hidden');
    assert.equal(model.requestOutcomes[0]?.aborted, false);

    const sniItemsOutput = await runOwnedCommand(context, 'sni-registered-items', busctl,
      [...busctlGetProperty, 'org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
        'org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems'], displayEnv);
    sniRegisteredItems = [...sniItemsOutput.matchAll(/"([^"\n]+)"/g)].map(match => match[1]);
    for (const item of sniRegisteredItems) {
      const slash = item.indexOf('/');
      if (slash === 0) continue;
      const service = slash > 0 ? item.slice(0, slash) : item;
      const objectPath = slash > 0 ? item.slice(slash) : '/StatusNotifierItem';
      const ownerOutput = await runOwnedCommand(context, 'sni-item-owner', busctl,
        ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
          'GetConnectionUnixProcessID', 's', service], displayEnv);
      const itemPid = Number(ownerOutput.match(/\bu\s+(\d+)/)?.[1]);
      const titleOutput = await runOwnedCommand(context, 'sni-item-title', busctl,
        [...busctlGetProperty, service, objectPath, 'org.kde.StatusNotifierItem', 'Title'], displayEnv);
      const pixmapOutput = await runOwnedCommand(context, 'sni-item-pixmap', busctl,
        [...busctlGetProperty, service, objectPath, 'org.kde.StatusNotifierItem', 'IconPixmap'], displayEnv);
      if (itemPid === app.pid) {
        selectedTray = { backend: 'sni', service, objectPath, itemPid, titleOutput, iconPixmapReceived: /a\(iiay\)\s+[1-9]/.test(pixmapOutput) };
        break;
      }
    }

    if (!selectedTray) {
      const probeOutput = await runOwnedCommand(context, 'xembed-backend-probe', python,
        ['-c', x11TrayProbe], displayEnv);
      x11Probe = JSON.parse(probeOutput);
      const electronEmbedded = x11Probe.embedded.find(item => item.pid === app.pid && item.geometry?.width > 8 && item.geometry?.height > 8);
      if (xembedHost && x11Probe.selectionOwner !== 0 && electronEmbedded) {
        selectedTray = { backend: 'xembed', selectionOwner: x11Probe.selectionOwner,
          selectionOwnerPid: x11Probe.selectionOwnerPid, iconWindow: electronEmbedded.window,
          iconGeometry: electronEmbedded.geometry, iconPid: electronEmbedded.pid };
      }
    }
    assert.ok(selectedTray, 'The app tray must be delivered to an owned visible SNI or XEmbed tray host');
    if (selectedTray.backend === 'sni') {
      assert.equal(selectedTray.itemPid, app.pid, 'The registered StatusNotifierItem must belong to this Electron process');
      assert.equal(selectedTray.iconPixmapReceived, true, 'The owned SNI host must receive an actual tray icon pixmap');
    } else {
      assert.equal(selectedTray.iconPid, app.pid, 'The XEmbed tray icon must belong to this Electron process');
      assert.ok(selectedTray.selectionOwner, 'An XEmbed system-tray selection owner must be active');
    }

    let clickWindowId;
    let clickX;
    let clickY;
    let clickGeometry;
    if (selectedTray.backend === 'sni') {
      const hostWindows = (await runOwnedCommand(context, 'sni-host-windows', xdotool,
        ['search', '--onlyvisible', '--pid', String(sniHost.pid)], displayEnv))
        .split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number);
      assert.ok(hostWindows.length > 0, 'The owned SNI host must have a visible window on this run display');
      clickWindowId = hostWindows[0];
      clickGeometry = parseWindowGeometry(await runOwnedCommand(context, 'sni-host-geometry', xdotool,
        ['getwindowgeometry', '--shell', String(clickWindowId)], displayEnv));
      clickX = Math.min(clickGeometry.width - 2, 20);
      clickY = Math.floor(clickGeometry.height / 2);
    } else {
      clickWindowId = selectedTray.iconWindow;
      clickGeometry = selectedTray.iconGeometry;
      clickX = Math.floor(clickGeometry.width / 2);
      clickY = Math.floor(clickGeometry.height / 2);
    }
    assert.ok(clickGeometry.width > clickX && clickGeometry.height > clickY, 'Tray click must land inside the owned tray icon host');
    await runOwnedCommand(context, 'tray-icon-pointer-move', xdotool,
      ['mousemove', '--sync', '--window', String(clickWindowId), String(clickX), String(clickY)], displayEnv);
    await runOwnedCommand(context, 'tray-icon-left-click', xdotool, ['click', '--clearmodifiers', '1'], displayEnv);
    await waitFor(async () => await readWindowMapState(context, xwininfo, nativeWindowId, displayEnv,
      'electron-window-map-state-restored') === 'IsViewable',
    10_000, 'native tray click restores the hidden original window', 150, context.abortSignal);
    assert.equal(page.isClosed(), false, 'Tray activation must restore the same renderer target');
    assert.equal((await pageSession.send('Target.getTargetInfo')).targetInfo.targetId, originalPageTargetId,
      'Tray activation must preserve the same Chromium page target');
    assert.equal(page.url(), originalUrl, 'Tray activation must preserve the original task route');
    await expect(page.getByTestId('message-user').filter({ hasText: taskMarker })).toHaveCount(1);
    await expect(page.getByTestId('pause-response-button')).toBeVisible();
    await expect(activeRow).toBeVisible();
    assert.equal(model.activeResponseCount, 1, 'The original task must still be running after tray restoration');
    assert.equal(await activeRow.getAttribute('data-testid'), originalTaskRowTestId,
      'The visible task row must keep its original taskId after tray restoration');
    assert.equal(wire.sent.filter(frame => frame.method === 'turn/start').length, startCountsBeforeClose.turn,
      'Restoring the tray must not start a replacement turn');
    assert.equal(wire.sent.filter(frame => frame.method === 'thread/start').length, startCountsBeforeClose.thread,
      'Restoring the tray must not create a replacement task');

    providerGate.released = true;
    await expect(page.getByText('TRAY_BACKGROUND_TASK_FINISHED', { exact: true })).toHaveCount(1, { timeout: 30_000 });
    await waitFor(() => model.requestOutcomes[0]?.closed && !model.requestOutcomes[0]?.aborted,
      10_000, 'original provider response completed normally', 50, context.abortSignal);
    await waitFor(() => wire.terminals.some(event => event.method === 'turn/completed' &&
      event.threadId === originalThreadId && event.turnId === originalTurnId),
    10_000, 'original task turn completion receipt', 50, context.abortSignal);
    assert.equal(model.requests.length, 1, 'The original task must finish with exactly one provider request');
    assert.equal(wire.sent.filter(frame => frame.method === 'turn/start').length, startCountsBeforeClose.turn);
    assert.equal(wire.sent.filter(frame => frame.method === 'thread/start').length, startCountsBeforeClose.thread);
    await context.writeArtifactJson('desktop-tray-background.json', {
      cli: { path: binary, sha256: binarySha256 },
      electron: { path: electron, sha256: await sha256File(electron), version: electronVersion },
      rendererRoot,
      ownedDisplayGeometry,
      electronSocketScratch: {
        pathBytes: Buffer.byteLength(electronSocketScratch.path),
        singletonSocketPathBytes: electronSingletonSocketPathBytes,
      },
      windowManager: {
        path: windowManagerBin,
        sha256: await sha256File(windowManagerBin),
        configPath: windowManagerConfig,
        proof: windowManagerProof,
      },
      wmctrl: { path: windowManagerControlBin, sha256: await sha256File(windowManagerControlBin) },
      sniWatcherOwner: watcherOwner,
      trayBackend: selectedTray.backend,
      sniHost: { path: sniHostBin, sha256: await sha256File(sniHostBin), receivedIcon: selectedTray.backend === 'sni' },
      xembedHost: xembedHostBin ? { path: xembedHostBin, sha256: await sha256File(xembedHostBin), used: selectedTray.backend === 'xembed' } : null,
      x11Probe,
      sniRegisteredItems,
      selectedTray,
      originalThreadId,
      originalTurnId,
      originalTaskRowTestId,
      originalPageTargetId,
      submissionEvidence,
      closeToTrayPreference,
      nativeWindowId,
      hiddenWithProviderRequestActive: true,
      restoredByXdotoolTrayClick: true,
      restoredOriginalRoute: page.url() === originalUrl,
      modelRequests: model.requests.length,
    });
    await page.screenshot({ path: context.pathInArtifacts('tray-restored-original-task.png') });
    return { trayBackend: selectedTray.backend, actualTrayClick: true, sameWindowRestored: true,
      sameTaskRestored: true, taskRemainedRunningWhileHidden: true, originalTurnCompleted: true, modelRequests: 1 };
  } catch (error) {
    if (!page.isClosed()) await page.screenshot({ path: context.pathInArtifacts('tray-background-failure.png') }).catch(() => {});
    const serverHealth = await page.evaluate(async () => {
      const response = await fetch('/api/servers/status', { cache: 'no-store' }).catch(() => null);
      return response ? { status: response.status, body: await response.json().catch(() => null) } : null;
    }).catch(() => null);
    if (!page.isClosed()) {
      submissionEvidence ??= {};
      submissionEvidence.failureSnapshot = {
        draft: await page.getByTestId('chat-message-input').innerText().catch(() => null),
        sendEnabled: await page.getByTestId('send-message-button').isEnabled().catch(() => null),
        visibleAlerts: await page.locator('[role="alert"]:visible').allTextContents().catch(() => []),
      };
    }
    const windowManagerStderr = await readFile(resolve(context.logsDir, 'owned-openbox-window-manager.log'), 'utf8').catch(() => '');
    await context.writeArtifactJson('tray-background-failure.json', {
      appAlive: app.exitCode === null,
      gatewayAlive: gateway.child.exitCode === null,
      pageClosed: page.isClosed(),
      serverHealth,
      closeEvidence,
      sniRegisteredItems,
      selectedTray,
      x11Probe,
      wmctrl: { path: windowManagerControlBin, sha256: await sha256File(windowManagerControlBin) },
      windowManager: {
        pid: windowManager.pid,
        exitCode: windowManager.exitCode,
        signalCode: windowManager.signalCode,
        stderr: windowManagerStderr.slice(-8000),
      },
      providerRequests: fixtureRequests?.length ?? 0,
      providerResponseActive: model.activeResponseCount,
      submissionEvidence,
      closeToTrayPreference,
      webSocketFramesSent: wire.sent,
      webSocketTerminals: wire.terminals,
    });
    throw error;
  }
});
