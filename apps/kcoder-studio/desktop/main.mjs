import { createWindowResponsiveness } from './window-responsiveness.mjs';
import { createWorkspaceOpenController, parseWorkspaceOpenRequest } from './workspace-open-controller.mjs';
import { createDesktopSessionRenewal } from './session-renewal.mjs';
import { createDesktopGatewayOwner } from './gateway-owner.mjs';
import { refreshGatewayWindows, restoreGatewayLoginPages } from './window-recovery.mjs';
import { preparePackagedStartupResources } from './packaged-resource-startup.mjs';
import { createResourcePreparationOwner } from './resource-preparation-owner.mjs';
import { createStartupWindow, runDesktopStartup, startOwnedGateway } from './startup-window.mjs';
import { app, nativeImage, BrowserWindow, dialog, ipcMain, Menu, Tray, session, shell, powerMonitor } from "electron";
import { registerDownloads } from "./download-controller.mjs";
import { registerFeedbackDiagnostics } from './feedback-controller.mjs';
import { createDesktopTray } from "./tray-controller.mjs";
import { desktopIconPaths, registerTaskbarIcon } from "./desktop-icons.mjs";
import { applicationMenuTemplate } from "./application-menu.mjs";
import { openAdditionalWindow, sendDesktopMenuCommand } from "./additional-window.mjs";
import { registerDesktopMenu } from "./desktop-menu-controller.mjs";
import { registerDirectoryDialog } from "./directory-dialog-controller.mjs";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startGateway } from "./gateway-process.mjs";
import { showGatewayStorageRecovery, storageStartupFailureMessage } from './gateway-startup-failure.mjs';
import { createDesktopGatewayConfig } from "./gateway-env.mjs";
import { prepareWindowsProfileStartup, retryWindowsGatewayStorageStartup } from './windows-profile-startup.mjs';
import { configureDesktopStorage } from './storage-startup.mjs';
import { applyStorageInstallation, chooseStorageFirstLaunch, configureStorageFirstLaunchDialog, parseStorageInstallationArguments,
  runStorageFirstLaunch, shouldOfferStorageFirstLaunch, STORAGE_FIRST_LAUNCH_REPLY } from './storage-installation.mjs';
import { DESKTOP_BROWSER_PARTITION, prepareBrowserCache } from './storage-browser-cache.mjs';
import { registerStorageLocations } from './storage-locations-controller.mjs';
import { createStorageOperationClient } from '../src/storage-operation-client.mjs';
import { defaultStorageLocation, loadStorageContext, STORAGE_STARTUP_ENV } from '../src/storage-paths.mjs';
import { readWindowsCurrentIdentity } from '../src/windows-current-identity.mjs';
import { sourceAppServerBinary } from '../src/source-app-server-binary.js';
import { resolveDesktopPort } from "./desktop-port.mjs";
import { packagedRuntimePaths } from "./packaged-paths.mjs";
import { allowRendererPermission, attachTrustedNavigation, isTrustedGatewayUrl } from "./security-policy.mjs";
import { configureWidgetProcessIsolation, createNativeWidgetIsolationController } from "./widget-isolation/controller.mjs";

configureWidgetProcessIsolation(app);

let gateway = null;
let mainWindow = null;
let startupWindow = null;
const startupAbort = new AbortController();
const resourcePreparation = createResourcePreparationOwner();
let stopping = null;
let quitting = false;
let relaunchAfterStop = false;
const gatewayOwner = createDesktopGatewayOwner({ start: startGateway, signal: startupAbort.signal, isQuitting: () => quitting });
let desktopTray = null;
const desktopPartition = DESKTOP_BROWSER_PARTITION;
let browserCache = null;
const additionalWindows = new Set();
let primaryHiddenForOtherWindows = false;
let stopSessionRenewal = () => {};
let stopDownloads = () => {};
let stopFeedback = () => {};
let widgetIsolation = null;
let responsiveness = null;
let workspaceOpen = null;
const pendingWorkspaceRequests = [];
function desktopLaunchArguments() {
  return app.isPackaged ? [] : [
    ...(app.commandLine.hasSwitch('no-sandbox') ? ['--no-sandbox'] : []),
    ...(app.commandLine.hasSwitch('disable-setuid-sandbox') ? ['--disable-setuid-sandbox'] : []),
    fileURLToPath(import.meta.url),
  ];
}
function localStorageClient(selected, env = process.env, program) {
  return createStorageOperationClient({
    program: program ?? (app.isPackaged ? packagedRuntimePaths(process.resourcesPath).kcoder
      : env.KCODER_STUDIO_KCODER_BIN || sourceAppServerBinary(join(dirname(fileURLToPath(import.meta.url)), '../../..'), env)),
    env: selected ? { ...env, [STORAGE_STARTUP_ENV]: JSON.stringify(selected.context) } : env,
    cwd: selected?.context.home ?? app.getPath('home'),
    ownerRuntime: { program: process.execPath, applicationRoot: app.isPackaged
      ? join(process.resourcesPath, 'gateway') : fileURLToPath(new URL('../', import.meta.url)), runAsNode: true },
    relaunch: { program: process.execPath, args: desktopLaunchArguments(), cwd: selected?.context.home ?? app.getPath('home') },
  });
}
async function initialStorageDefaults(initial) {
  const home = initial.context.home;
  const platformCache = process.platform === 'win32' ? (await readWindowsCurrentIdentity()).localAppData
    : process.platform === 'darwin' ? join(home, 'Library', 'Caches') : process.env.XDG_CACHE_HOME || join(home, '.cache');
  return { ...initial, paths: { ...initial.paths, ...defaultStorageLocation({ home, platformCache }) } };
}
async function confirmStorageInstallation(plan) {
  await app.whenReady();
  const chinese = app.getLocale().toLowerCase().startsWith('zh');
  const components = (plan.components ?? []).map(component => `${component.source}\n→ ${component.destination}`);
  const bytes = (plan.components ?? []).reduce((sum, component) => sum + component.estimatedBytes, 0);
  const answer = await dialog.showMessageBox({ type: 'warning', defaultId: 0, cancelId: 0,
    message: chinese ? '迁移 KCoder 配置与数据？' : 'Move KCoder configuration and data?',
    detail: (chinese ? '请先退出当前实例及使用这些目录的 CLI。原数据会保留，临时与缓存无需复制。' : 'Close Studio and CLI writers using these folders first. Original data will be kept; temporary files and cache are not copied.')
      + `\n\n${plan.from.dataRoot}\n→ ${plan.target.dataRoot}\n\n${plan.from.cacheRoot}\n→ ${plan.target.cacheRoot}`
      + (components.length ? `\n\n${chinese ? '复制范围（保守估算）' : 'Copy scope (conservative estimate)'} (${bytes} bytes):\n${components.join('\n\n')}` : ''),
    buttons: chinese ? ['取消', '迁移'] : ['Cancel', 'Move'] });
  return answer.response === 1;
}
function acceptWorkspaceArguments(argv, cwd) {
  try {
    const request = parseWorkspaceOpenRequest(argv, cwd);
    if (!request) return;
    if (workspaceOpen) workspaceOpen.enqueue(request);
    else {
      if (pendingWorkspaceRequests.length >= 64) throw new Error('Too many pending workspace-open requests');
      pendingWorkspaceRequests.push(request);
    }
  } catch (error) {
    dialog.showErrorBox('KCoder Studio', error.message);
  }
}

function stopGateway() {
  startupAbort.abort();
  widgetIsolation?.dispose();
  widgetIsolation = null;
  stopSessionRenewal();
  stopDownloads();
  if (stopping) return stopping;
  stopping = Promise.allSettled([resourcePreparation.stop(), gatewayOwner.stop()]).then(results => {
    const confirmed = results.every(result => result.status === 'fulfilled' && result.value !== false);
    if (!confirmed) console.error('DESKTOP_GATEWAY_STOP_UNCONFIRMED');
    return confirmed;
  });
  gateway = null;
  return stopping;
}

function requestQuit(exitCode = 0) {
  if (quitting) return;
  quitting = true;
  stopFeedback();
  responsiveness?.dispose();
  workspaceOpen?.dispose();
  startupWindow?.dispose();
  startupWindow = null;
  desktopTray?.dispose();
  void stopGateway().then(confirmed => {
    if (confirmed && relaunchAfterStop) app.relaunch();
    app.exit(confirmed ? exitCode : 1);
  }, () => {
    console.error('DESKTOP_GATEWAY_STOP_UNCONFIRMED'); app.exit(1);
  });
}

async function createMainWindow() {
  const desktopGatewayConfig = await createDesktopGatewayConfig(desktopStorage.env);
  if (quitting) return;
  const gatewayEnv = { ...desktopGatewayConfig.env };
  for (const name of Object.keys(gatewayEnv)) {
    if (["KCODER_NATIVE_OFFICE_BINDING_V1","KCODER_NATIVE_CONNECTIVITY_BINDING_V1","KCODER_NATIVE_COMPONENT_IMAGE_BINDING_V1"].includes(name.toUpperCase())) delete gatewayEnv[name];
  }
  let connectivityPrivateEnvironment;
  let componentImagePrivateEnvironment;
  let bundledRelayUrl;
  gatewayEnv.KCODER_STUDIO_DESKTOP_HOST = "1";
  if (app.isPackaged) gatewayEnv.KCODER_STUDIO_DEPLOYMENT_MODE = 'release';
  // Match the repository's source-tree CLI launchers: development builds retain bundled
  // provider profiles while user/project profiles override same-name entries. Packaged builds
  // continue to honor the strict provider_profiles ownership rule.
  if (!app.isPackaged) gatewayEnv.KCODER_INCLUDE_BUNDLED_PROFILES ||= "1";
  const desktopPort = await resolveDesktopPort({
    userDataDir: app.getPath("userData"),
    configuredPort: gatewayEnv.KCODER_STUDIO_DESKTOP_PORT,
  });
  if (quitting) return;
  let gatewayScript;
  let gatewayCwd;
  if (app.isPackaged) {
    const runtimePaths = packagedRuntimePaths(process.resourcesPath);
    gatewayScript = join(process.resourcesPath, "gateway", "dev-server.mjs");
    gatewayCwd = process.resourcesPath;
    gatewayEnv.KCODER_STUDIO_WEB_ROOT ||= join(process.resourcesPath, "renderer-dist");
    gatewayEnv.KCODER_STUDIO_KCODER_BIN ||= runtimePaths.kcoder;
    if (process.platform === "win32") {
      gatewayEnv.KCODER_STUDIO_PACKAGED_WINDOWS_BIN = runtimePaths.kcoder;
      gatewayEnv.KCODER_E2E_PROCESS_SUPERVISOR_BIN ||= runtimePaths.supervisor;
    }
    gatewayEnv.KCODER_STUDIO_WORKSPACE ||= app.getPath("home");
    const resources = await resourcePreparation.run(() => preparePackagedStartupResources({
      resourcesPath: process.resourcesPath,
      metadataPath: join(app.getAppPath(), "package.json"),
      signal: startupAbort.signal,
    }));
    if (!resources || quitting) return;
    bundledRelayUrl = resources.relayPublicUrl;
    connectivityPrivateEnvironment = resources.channel;
    componentImagePrivateEnvironment = resources.component;

  }
  const gatewayOptions = {
    env: gatewayEnv,
    // Recovery may have deliberately removed an unusable legacy catalog.
    inheritParentEnv: false,
    privateEnvironment: { ...connectivityPrivateEnvironment, ...componentImagePrivateEnvironment },
    token: desktopGatewayConfig.token,
    gatewayScript,
    cwd: gatewayCwd,
    port: desktopPort,
    stopGraceMs: 5_000,
    onStdout: (chunk) => process.stdout.write(`[gateway] ${chunk}`),
    onStderr: (chunk) => process.stderr.write(`[gateway] ${chunk}`),
  };
  Object.assign(gatewayEnv, {
    KCODER_STUDIO_RELAY_CONFIG_DIR: desktopStorage.paths.gatewayRoot,
    KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE: process.env.KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE,
    KCODER_STUDIO_DESKTOP_RELAY_REGISTRATION_KEY: process.env.KCODER_STUDIO_DESKTOP_RELAY_REGISTRATION_KEY ?? process.env.KCODER_RELAY_REGISTRATION_KEY,
    ...(app.isPackaged ? { KCODER_STUDIO_RELAY_RESOURCES_PATH: process.resourcesPath } : {}),
    KCODER_STUDIO_RELAY_DEFAULT_URL: process.env.KCODER_STUDIO_DESKTOP_RELAY_URL ?? process.env.KCODER_RELAY_PUBLIC_URL ?? gatewayEnv.KCODER_STUDIO_RELAY_DEFAULT_URL ?? bundledRelayUrl ?? '',
  });
  let gatewayOrigin = null;
  const desktopSession = session.fromPartition(desktopPartition);
  if (browserCache) desktopSession.setCodeCachePath(browserCache.codeCachePath);
  let expectedWebContentsId = null;
  const restartTimes = [];
  const restoreLoginPages = () => restoreGatewayLoginPages({ windows: [mainWindow, ...additionalWindows], origin: gatewayOrigin });
  const sessionRenewal = createDesktopSessionRenewal({
    observe: process.env.KCODER_E2E_AUTH_OBSERVE === '1'
      ? value => console.log('KCODER_AUTH_OBSERVE ' + JSON.stringify(value)) : undefined,
    getGateway: () => gateway,
    canRun: () => !quitting,
    installSession: instance => installGatewaySession(instance),
    recoverLoginPages: restoreLoginPages,
    warn: message => console.warn(message),
  });
  const renewDesktopSession = sessionRenewal.renew;
  const onResume = () => { void renewDesktopSession(); };
  powerMonitor.on('resume', onResume);
  stopSessionRenewal = () => {
    sessionRenewal.stop();
    powerMonitor.removeListener('resume', onResume);
  };
  responsiveness?.dispose();
  responsiveness = createWindowResponsiveness({ dialog, powerMonitor, locale: app.getLocale(),
    getGatewayOrigin: () => gatewayOrigin ?? '', isQuitting: () => quitting,
    warn: message => console.warn(message) });
  const bindLoginRecovery = window => {
    if (!window || window.isDestroyed() || quitting) return window;
    responsiveness.attach(window);
    window.webContents.on('did-navigate', (_event, value) => {
      const url = new URL(value);
      if (url.origin === gatewayOrigin && url.pathname === '/login') void renewDesktopSession();
    });
    window.on('focus', onResume);
    if (new URL(window.webContents.getURL() || 'about:blank').pathname === '/login') onResume();
    return window;
  };
  const installGatewaySession = async (instance) => {
    gatewayOrigin = new URL(instance.baseUrl).origin;
    await desktopSession.cookies.set({
      url: instance.baseUrl,
      name: "kcoder_studio_session",
      value: instance.cookieValue,
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
  };
  const monitorGateway = (instance) => {
    return instance.exit.then(async ({ code, signal }) => {
      if (quitting || gateway !== instance) return;
      const previousOrigin = gatewayOrigin;
      gateway = null;
      const now = Date.now();
      restartTimes.push(now);
      while (restartTimes.length && now - restartTimes[0] > 60_000) restartTimes.shift();
      if (restartTimes.length > 3) {
        throw new Error(`KCoder Studio gateway repeatedly exited (code=${String(code)}, signal=${String(signal)})`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      const replacement = await gatewayOwner.start(gatewayOptions);
      if (!replacement) return;
      if (quitting || !mainWindow) {
        await replacement.stop();
        return;
      }
      gateway = replacement;
      await installGatewaySession(replacement);
      sessionRenewal.installed(replacement);
      void monitorGateway(replacement);
      // A same-origin restart has already installed a fresh HttpOnly session.
      // Retain the WebView's unsent drafts and refresh the existing runtime;
      // navigating would discard in-memory composer state for no identity gain.
      void refreshGatewayWindows({ windows: [mainWindow, ...additionalWindows], previousOrigin,
        baseUrl: replacement.baseUrl, warn: message => console.warn(message) });
      console.warn(`KCoder Studio gateway restarted after code=${String(code)} signal=${String(signal)}`);
    }).catch(async (error) => {
      if (quitting) return;
      console.error("KCoder Studio gateway recovery failed", error);
      if (!process.env.KCODER_STUDIO_DESKTOP_SMOKE_MS) {
        try {
          const recovered = await retryWindowsGatewayStorageStartup({ error, dialog,
            locale: app.getLocale(), signal: startupAbort.signal,
            restart: async () => { if (!quitting) relaunchAfterStop = true; } });
          if (recovered) { requestQuit(0); return; }
        } catch {
          console.warn('WINDOWS_STARTUP_RECOVERY_UNCONFIRMED');
        }
        const recovered = await showGatewayStorageRecovery({ error, dialog, shell, locale: app.getLocale(),
          dataDirectory: desktopStorage.paths.gatewayRoot }).catch(() => false);
        if (!recovered) dialog.showErrorBox("KCoder Studio 网关恢复失败", error instanceof Error ? error.message : String(error));
      }
      requestQuit(1);
    });
  };
  if (quitting) return;
  const initialGateway = await startOwnedGateway({ start: () => gatewayOwner.start(gatewayOptions), isQuitting: () => quitting });
  if (!initialGateway || quitting) return;
  gateway = initialGateway;
  await installGatewaySession(initialGateway);
  sessionRenewal.installed(initialGateway);
  if (quitting) return;
  desktopSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowRendererPermission({
      permission,
      requestingUrl: details.requestingUrl,
      gatewayOrigin: gatewayOrigin ?? "",
      webContentsId: webContents.id,
      expectedWebContentsId: [...additionalWindows].some(window => !window.isDestroyed() && window.webContents.id === webContents.id) ? webContents.id : expectedWebContentsId,
    }));
  });
  desktopSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return allowRendererPermission({
      permission,
      requestingUrl: details.requestingUrl || requestingOrigin,
      gatewayOrigin: gatewayOrigin ?? "",
      webContentsId: webContents?.id,
      expectedWebContentsId: [...additionalWindows].some(window => !window.isDestroyed() && window.webContents.id === webContents?.id) ? webContents.id : expectedWebContentsId,
    });
  });
  stopDownloads();
  stopDownloads = registerDownloads({ session: desktopSession, ipcMain,
    getWindow: contents => [mainWindow, ...additionalWindows].find(window => window && !window.isDestroyed() && window.webContents === contents),
    getGatewayOrigin: () => gatewayOrigin ?? "", downloadsDirectory: app.getPath("downloads"),
  });
  stopFeedback();
  stopFeedback = registerFeedbackDiagnostics({ ipcMain,
    getWindow: contents => [mainWindow, ...additionalWindows].find(window => window && !window.isDestroyed() && window.webContents === contents),
    getGatewayOrigin: () => gatewayOrigin ?? '', getVersion: () => app.getVersion(),
    getRuntimeLogs: () => gateway?.getRecentLogs() ?? null,
  });
  widgetIsolation?.dispose();
  widgetIsolation = createNativeWidgetIsolationController({ app, ipcMain,
    getWindow: contents => [mainWindow, ...additionalWindows].find(window => window && !window.isDestroyed() && window.webContents === contents),
    getGatewayOrigin: () => gatewayOrigin ?? '', verifiedPlatforms: ['win32'],
  });
  const customMenu = process.platform === "win32" || (!app.isPackaged && process.env.KCODER_STUDIO_TEST_WINDOWS_MENU === "1");
  mainWindow = new BrowserWindow({
    icon: desktopIconPaths().window,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#111111",
    ...(customMenu ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#ffffff", symbolColor: "#1a1c1f", height: 40 } } : {}),
    title: "KCoder Studio",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: desktopPartition,
      preload: fileURLToPath(new URL("./menu-preload.cjs", import.meta.url)),
      additionalArguments: ["--kcoder-local-workspace-open", "--kcoder-local-directory-picker", "--kcoder-local-storage-locations", ...(customMenu ? ["--kcoder-custom-menu"] : [])],
    },
  });
  expectedWebContentsId = mainWindow.webContents.id;
  const directoryOptions = {
    getGatewayOrigin: () => gatewayOrigin ?? '',
    getHomeDirectory: () => app.getPath('home'),
    getServers: async () => {
      if (!gatewayOrigin) throw new Error('Local Gateway is unavailable');
      const response = await desktopSession.fetch(`${gatewayOrigin}/api/servers`, { cache: 'no-store', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Unable to verify local directory selection target');
      return (await response.json()).servers;
    },
  };
  registerDirectoryDialog({ ...directoryOptions, ipcMain, dialog, window: mainWindow });
  const storageOptions = {
    selected: desktopStorage,
    client: localStorageClient(desktopStorage, desktopStorage.env,
      gatewayEnv.KCODER_STUDIO_KCODER_BIN || sourceAppServerBinary(join(dirname(fileURLToPath(import.meta.url)), '../../..'), gatewayEnv)),
    confirmStop: async (_plan, ownerWindow) => {
      const chinese = app.getLocale().toLowerCase().startsWith('zh');
      const answer = await dialog.showMessageBox(ownerWindow, { type: 'warning', defaultId: 0, cancelId: 0,
        message: chinese ? '停止本实例的所有工作并迁移目录？' : 'Stop this instance’s work and migrate storage?',
        detail: chinese ? '所有窗口、后台工作和工具都将退出。若要等待任务完成，请先取消，任务完成后再重试。原数据会保留。'
          : 'All windows, background work and tools will exit. To wait for current tasks, cancel and retry after they finish. Original data will be kept.',
        buttons: chinese ? ['取消', '停止并迁移'] : ['Cancel', 'Stop and migrate'] });
      return answer.response === 1;
    },
    stopInstance: () => { relaunchAfterStop = false; requestQuit(0); },
  };
  registerStorageLocations({ ipcMain, dialog, window: mainWindow,
    getGatewayOrigin: directoryOptions.getGatewayOrigin, ...storageOptions });
  workspaceOpen?.dispose();
  workspaceOpen = createWorkspaceOpenController({ ipcMain, getWindow: () => mainWindow,
    getGatewayOrigin: directoryOptions.getGatewayOrigin, getServers: directoryOptions.getServers });
  for (const request of pendingWorkspaceRequests.splice(0)) workspaceOpen.enqueue(request);
  desktopTray = createDesktopTray({
    Tray, Menu, ipcMain, dialog, nativeImage, window: mainWindow,
    icon: desktopIconPaths().tray,
    getGatewayOrigin: () => gatewayOrigin ?? '', isQuitting: () => quitting, requestQuit,
    requestWindowClose: () => {
      if (additionalWindows.size) { primaryHiddenForOtherWindows = true; mainWindow.hide(); }
      else requestQuit(0);
    },
  });
  const menuCommand = command => (_item, focused) => sendDesktopMenuCommand(command, focused, mainWindow, additionalWindows, gatewayOrigin ?? '');
  const menuTemplate = applicationMenuTemplate({
    newWindow: () => {
      void openAdditionalWindow({ BrowserWindow, Menu, ipcMain, dialog, shell, nativeImage, windows: additionalWindows,
        partition: desktopPartition, getGatewayOrigin: () => gatewayOrigin ?? '', createMenu: () => Menu.buildFromTemplate(menuTemplate),
        customMenu, directoryOptions, storageOptions, isQuitting: () => quitting, requestQuit,
        onLastClosed: () => {
          if (primaryHiddenForOtherWindows && mainWindow && !mainWindow.isDestroyed() && !quitting) mainWindow.show();
          primaryHiddenForOtherWindows = false;
        },
      }).then(bindLoginRecovery).catch(error => dialog.showErrorBox('无法新建窗口', error.message));
    },
    newChat: menuCommand('new-chat'), newTemporaryChat: menuCommand('new-temporary-chat'),
    openFolder: menuCommand('open-folder'), canLogout: false,
    openSettings: (_item, focused) => {
      const target = focused ?? mainWindow;
      if (target && !target.isDestroyed() && (target === mainWindow || additionalWindows.has(target)) && gatewayOrigin && isTrustedGatewayUrl(target.webContents.getURL(), gatewayOrigin)) {
        target.webContents.send('kcoder:tray:settings');
      }
    },
    openAutomations: (_item, focused) => {
      const target = focused ?? mainWindow;
      if (target && !target.isDestroyed() && (target === mainWindow || additionalWindows.has(target)) && gatewayOrigin && isTrustedGatewayUrl(target.webContents.getURL(), gatewayOrigin)) {
        void target.webContents.executeJavaScript("history.pushState({}, '', '/automations'); window.dispatchEvent(new PopStateEvent('popstate'));")
          .catch(error => console.error("Failed to open scheduled tasks", error));
      }
    },
    quit: () => requestQuit(0),
  });
  const applicationMenu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(applicationMenu);
  if (customMenu) registerDesktopMenu({ ipcMain, window: mainWindow, menu: applicationMenu, getGatewayOrigin: () => gatewayOrigin ?? "" });

  attachTrustedNavigation({ webContents: mainWindow.webContents, getGatewayOrigin: () => gatewayOrigin ?? '', shell,
    warn: message => console.warn(message) });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  const initialRecovery = monitorGateway(gateway);
  bindLoginRecovery(mainWindow);
  try { await mainWindow.loadURL(initialGateway.baseUrl); }
  catch (error) {
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
    if (gateway === initialGateway) throw error;
    await initialRecovery;
    if (quitting || !gateway) return;
  }
  console.log(`KCoder Studio desktop ready: ${gateway.baseUrl}`);

  const screenshotPath = process.env.KCODER_STUDIO_DESKTOP_SCREENSHOT;
  if (screenshotPath) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    const image = await mainWindow.webContents.capturePage();
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, image.toPNG());
    console.log(`KCoder Studio desktop screenshot: ${screenshotPath}`);
  }
  const smokeMs = Number(process.env.KCODER_STUDIO_DESKTOP_SMOKE_MS || 0);
  if (Number.isFinite(smokeMs) && smokeMs > 0) {
    const timer = setTimeout(() => requestQuit(0), smokeMs);
    timer.unref?.();
  }
}

app.setName("KCoder Studio");
if (process.platform === "win32") app.setAppUserModelId("dev.kcoder.studio");
registerTaskbarIcon(app, "dev.kcoder.studio");
const storageInstallation = parseStorageInstallationArguments(process.argv, { platform: process.platform });
const preparingWindowsStartup = storageInstallation !== null;
if (storageInstallation?.firstLaunchUserData) {
  configureStorageFirstLaunchDialog({ app, userData: storageInstallation.firstLaunchUserData });
}
const desktopStorage = preparingWindowsStartup ? null : await configureDesktopStorage({ app,
  prepareInitialSelection: async selected => {
    if (!await shouldOfferStorageFirstLaunch(selected)) return false;
    const result = await runStorageFirstLaunch({ program: process.execPath, args: desktopLaunchArguments(),
      cwd: selected.context.home });
    if (result.state === 'cancelled') throw Object.assign(new Error('STORAGE_FIRST_LAUNCH_CANCELLED'), { code: 'STORAGE_FIRST_LAUNCH_CANCELLED' });
    return true;
  },
  createStartupClient: selected => localStorageClient(selected) }).catch(async error => {
  if (error?.code === 'STORAGE_FIRST_LAUNCH_CANCELLED') { app.exit(0); throw error; }
  console.error('DESKTOP_STORAGE_STARTUP_FAILED', error);
  await app.whenReady();
  dialog.showErrorBox('KCoder Studio', storageStartupFailureMessage(error, app.getLocale())
    ?? (error instanceof Error ? error.message : String(error)));
  app.exit(1);
  throw error;
});

if (preparingWindowsStartup) {
  // NSIS runs this before offering to open Studio. Resolve and confirm the
  // installing user's selection without a business window, Gateway, or instance.
  (async () => {
    await prepareWindowsProfileStartup({ env: process.env });
    const loadOptions = { env: process.env, home: app.getPath('home'), platformConfig: app.getPath('appData'), consumer: 'desktop' };
    const loadSelected = async () => {
      const selected = await loadStorageContext(loadOptions);
      // Legacy tmp lives inside its source. Use the normal new-layout target
      // defaults for omitted fields; Native preview still owns source discovery.
      return selected.paths.layout === 'legacy' ? initialStorageDefaults(selected) : selected;
    };
    let intent = storageInstallation;
    let initialSelection;
    if (storageInstallation.firstLaunchUserData) {
      const initial = await loadStorageContext(loadOptions);
      if (!await shouldOfferStorageFirstLaunch(initial)) {
        return 'complete';
      }
      initialSelection = await initialStorageDefaults(initial);
      await app.whenReady();
      intent = await chooseStorageFirstLaunch({ dialog,
        selected: initialSelection, locale: app.getLocale() });
      if (!intent) return 'cancelled';
    } else if (intent.dataRoot || intent.cacheRoot) {
      const initial = await loadStorageContext(loadOptions);
      if (await shouldOfferStorageFirstLaunch(initial)) initialSelection = await initialStorageDefaults(initial);
    }
    const result = await applyStorageInstallation({ intent, loadSelected, initialSelection,
      createClient: selected => localStorageClient(selected), confirm: confirmStorageInstallation });
    return result?.state === 'cancelled' ? 'cancelled' : 'complete';
  })().then(state => {
      if (storageInstallation.firstLaunchUserData) {
        process.stdout.write(`${STORAGE_FIRST_LAUNCH_REPLY}${JSON.stringify({ version: 1, state })}\n`, () => app.exit(0));
      } else app.exit(0);
    }, error => {
      const reason = error?.code === 'WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE' &&
        ['system_directory_unavailable', 'timeout', 'execution_failed', 'invalid_identity',
          'powershell_unavailable', 'unsupported_platform'].includes(error.reason) ? ` ${error.reason}` : '';
      process.stderr.write(`KCODER_INSTALL_PROFILE_PREPARATION_FAILED ${error?.code || 'UNKNOWN'}${reason}\n`, () => app.exit(1));
    });
} else if (!app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() })) {
  app.quit();
} else {
  if (desktopStorage.browserCacheRoot) {
    browserCache = await prepareBrowserCache({ desktopRoot: desktopStorage.paths.desktopRoot,
      cacheRoot: desktopStorage.paths.cacheRoot, partition: desktopPartition }).catch(error => {
      console.error('DESKTOP_BROWSER_CACHE_STARTUP_FAILED', error);
      dialog.showErrorBox('KCoder Studio', error instanceof Error ? error.message : String(error));
      app.releaseSingleInstanceLock();
      app.exit(1);
      throw error;
    });
  }
  acceptWorkspaceArguments(process.argv, process.cwd());
  app.on("second-instance", (_event, argv, cwd, original) => {
    // Chromium may reorder switches; preserve the invoking process's original arguments.
    acceptWorkspaceArguments(original?.argv ?? argv, original?.cwd ?? cwd);
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    requestQuit(0);
  });
  app.on("window-all-closed", () => requestQuit(0));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => requestQuit(0));
  }

  app.whenReady().then(() => runDesktopStartup({
    createWindow: () => createStartupWindow({ BrowserWindow, session, locale: app.getLocale(), icon: desktopIconPaths().window, onClose: () => requestQuit(0) }),
    publish: owned => { startupWindow = owned; },
    clear: owned => { if (startupWindow === owned) startupWindow = null; },
    isQuitting: () => quitting,
    startMain: createMainWindow,
  })).catch(async (error) => {
    if (quitting) return;
    try {
      const recovered = await retryWindowsGatewayStorageStartup({ error, dialog,
        locale: app.getLocale(), signal: startupAbort.signal,
        restart: async () => { if (!quitting) relaunchAfterStop = true; } });
      if (recovered) { requestQuit(0); return; }
    } catch {
      console.warn('WINDOWS_STARTUP_RECOVERY_UNCONFIRMED');
    }
    console.error(error);
    if (!process.env.KCODER_STUDIO_DESKTOP_SMOKE_MS) {
      const recovered = await showGatewayStorageRecovery({ error, dialog, shell, locale: app.getLocale(),
        dataDirectory: error.storageDataDirectory ?? desktopStorage.paths.gatewayRoot }).catch(() => false);
      if (!recovered) dialog.showErrorBox("KCoder Studio 启动失败", error instanceof Error ? error.message : String(error));
    }
    requestQuit(1);
  });
}
