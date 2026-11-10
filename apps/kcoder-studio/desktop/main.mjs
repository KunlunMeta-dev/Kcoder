import { createDesktopSessionRenewal } from './session-renewal.mjs';
import { preparePackagedStartupResources } from './packaged-resource-startup.mjs';
import { createResourcePreparationOwner } from './resource-preparation-owner.mjs';
import { createStartupWindow, runDesktopStartup, startOwnedGateway } from './startup-window.mjs';
import { app, nativeImage, BrowserWindow, dialog, ipcMain, Menu, Tray, session, shell, powerMonitor } from "electron";
import { registerDownloads } from "./download-controller.mjs";
import { createDesktopTray } from "./tray-controller.mjs";
import { desktopIconPaths, registerTaskbarIcon } from "./desktop-icons.mjs";
import { applicationMenuTemplate } from "./application-menu.mjs";
import { openAdditionalWindow, sendDesktopMenuCommand } from "./additional-window.mjs";
import { registerDesktopMenu } from "./desktop-menu-controller.mjs";
import { registerDirectoryDialog } from "./directory-dialog-controller.mjs";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { startGateway } from "./gateway-process.mjs";
import { showGatewayStorageRecovery } from './gateway-startup-failure.mjs';
import { createDesktopGatewayConfig } from "./gateway-env.mjs";
import { studioDataDirectory } from '../src/studio-login-link.js';
import { resolveDesktopPort } from "./desktop-port.mjs";
import { packagedRuntimePaths } from "./packaged-paths.mjs";
import { allowRendererPermission, isTrustedGatewayUrl } from "./security-policy.mjs";
import { configureWidgetProcessIsolation, createNativeWidgetIsolationController } from "./widget-isolation/controller.mjs";

configureWidgetProcessIsolation(app);

let gateway = null;
let mainWindow = null;
let startupWindow = null;
let initialGatewayPending = null;
const startupAbort = new AbortController();
const resourcePreparation = createResourcePreparationOwner();
let stopping = null;
let quitting = false;
let desktopTray = null;
const desktopPartition = "persist:kcoder-studio-desktop";
const additionalWindows = new Set();
let primaryHiddenForOtherWindows = false;
let stopSessionRenewal = () => {};
let stopDownloads = () => {};
let widgetIsolation = null;

function stopGateway() {
  startupAbort.abort();
  widgetIsolation?.dispose();
  widgetIsolation = null;
  stopSessionRenewal();
  stopDownloads();
  if (stopping) return stopping;
  const pending = initialGatewayPending;
  stopping = Promise.all([
    resourcePreparation.stop(),
    gateway?.stop().catch((error) => console.error("Failed to stop KCoder Studio gateway", error)),
    pending?.then(instance => instance.stop(), () => {}).catch(() => console.error('Failed to stop pending KCoder Studio gateway')),
  ]);
  gateway = null;
  return stopping;
}

function requestQuit(exitCode = 0) {
  if (quitting) return;
  quitting = true;
  startupWindow?.dispose();
  startupWindow = null;
  desktopTray?.dispose();
  void stopGateway().finally(() => app.exit(exitCode));
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

async function createMainWindow() {
  const desktopGatewayConfig = await createDesktopGatewayConfig(process.env);
  if (quitting) return;
  const gatewayEnv = { ...desktopGatewayConfig.env };
  for (const name of Object.keys(gatewayEnv)) {
    if (["KCODER_NATIVE_OFFICE_BINDING_V1","KCODER_NATIVE_CONNECTIVITY_BINDING_V1","KCODER_NATIVE_COMPONENT_IMAGE_BINDING_V1"].includes(name.toUpperCase())) delete gatewayEnv[name];
  }
  let connectivityPrivateEnvironment;
  let componentImagePrivateEnvironment;
  let bundledRelayUrl;
  gatewayEnv.KCODER_STUDIO_DESKTOP_HOST = "1";
  if (!gatewayEnv.KCODER_STUDIO_DATA_DIR && !gatewayEnv.KCODER_STUDIO_SERVERS_STORE) {
    gatewayEnv.KCODER_STUDIO_DATA_DIR = app.getPath("userData");
  }
  gatewayEnv.KCODER_STUDIO_SERVERS_STORE ||= join(
    studioDataDirectory({ dataDirectory: gatewayEnv.KCODER_STUDIO_DATA_DIR }), 'servers.json');
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
    const requestedProfile = gatewayEnv.KCODER_STUDIO_DESKTOP_PROFILE?.trim();
    if (
      requestedProfile &&
      !gatewayEnv.KCODER_STUDIO_SERVERS &&
      !gatewayEnv.KCODER_STUDIO_SERVERS_FILE
    ) {
      const profileOverlay = join(app.getPath("userData"), "desktop-profile-overlay.json");
      await mkdir(dirname(profileOverlay), { recursive: true });
      await writeFile(profileOverlay, `${JSON.stringify({ active_profile: requestedProfile }, null, 2)}\n`, {
        mode: 0o600,
      });
      gatewayEnv.KCODER_STUDIO_SERVERS = JSON.stringify([
        {
          id: "local",
          label: "当前计算机",
          description: "内置 KCoder app-server",
          transport: "local",
          workspace: app.getPath("home"),
          settingsFile: profileOverlay,
          profile: requestedProfile,
        },
      ]);
    }
  }
  const gatewayOptions = {
    env: gatewayEnv,
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
    KCODER_STUDIO_RELAY_CONFIG_DIR: app.getPath('userData'),
    KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE: process.env.KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE,
    KCODER_STUDIO_DESKTOP_RELAY_REGISTRATION_KEY: process.env.KCODER_STUDIO_DESKTOP_RELAY_REGISTRATION_KEY ?? process.env.KCODER_RELAY_REGISTRATION_KEY,
    ...(app.isPackaged ? { KCODER_STUDIO_RELAY_RESOURCES_PATH: process.resourcesPath } : {}),
    KCODER_STUDIO_RELAY_DEFAULT_URL: process.env.KCODER_STUDIO_DESKTOP_RELAY_URL ?? process.env.KCODER_RELAY_PUBLIC_URL ?? bundledRelayUrl ?? '',
  });
  let gatewayOrigin = null;
  const desktopSession = session.fromPartition(desktopPartition);
  let expectedWebContentsId = null;
  const restartTimes = [];
  const restoreLoginPages = async () => {
    for (const window of [mainWindow, ...additionalWindows]) {
      if (!window || window.isDestroyed()) continue;
      const current = new URL(window.webContents.getURL() || 'about:blank');
      if (current.origin !== gatewayOrigin || current.pathname !== '/login') continue;
      let target = new URL('/', gatewayOrigin);
      try {
        const candidate = new URL(current.searchParams.get('returnTo') || '/', gatewayOrigin);
        if (candidate.origin === gatewayOrigin && candidate.pathname !== '/login') target = candidate;
      } catch {}
      await window.loadURL(target.href);
    }
  };
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
  const bindLoginRecovery = window => {
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
    void instance.exit.then(async ({ code, signal }) => {
      if (quitting || gateway !== instance) return;
      const previousOrigin = gatewayOrigin;
      gateway = null;
      const now = Date.now();
      restartTimes.push(now);
      while (restartTimes.length && now - restartTimes[0] > 60_000) restartTimes.shift();
      if (restartTimes.length > 3) {
        throw new Error(`KCoder Studio gateway repeatedly exited (code=${String(code)}, signal=${String(signal)})`);
      }
      let route = "/";
      try {
        const current = new URL(mainWindow?.webContents.getURL() || "/", previousOrigin);
        if (current.origin === previousOrigin) route = `${current.pathname}${current.search}${current.hash}`;
      } catch {}
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      const replacement = await startGateway(gatewayOptions);
      if (quitting || !mainWindow) {
        await replacement.stop();
        return;
      }
      gateway = replacement;
      await installGatewaySession(replacement);
      sessionRenewal.installed(replacement);
      monitorGateway(replacement);
      // A same-origin restart has already installed a fresh HttpOnly session.
      // Retain the WebView's unsent drafts and refresh the existing runtime;
      // navigating would discard in-memory composer state for no identity gain.
      const currentUrl = new URL(mainWindow.webContents.getURL() || "/", previousOrigin);
      if (new URL(replacement.baseUrl).origin === previousOrigin &&
          currentUrl.origin === previousOrigin && currentUrl.pathname !== "/login") {
        await mainWindow.webContents.executeJavaScript("window.dispatchEvent(new Event('kcoder:servers-changed'));");
      } else {
        await mainWindow.loadURL(`${replacement.baseUrl}${route}`);
      }
      console.warn(`KCoder Studio gateway restarted after code=${String(code)} signal=${String(signal)}`);
    }).catch(async (error) => {
      if (quitting) return;
      console.error("KCoder Studio gateway recovery failed", error);
      if (!process.env.KCODER_STUDIO_DESKTOP_SMOKE_MS) {
        const recovered = await showGatewayStorageRecovery({ error, dialog, shell, locale: app.getLocale(),
          dataDirectory: app.getPath('userData') }).catch(() => false);
        if (!recovered) dialog.showErrorBox("KCoder Studio 网关恢复失败", error instanceof Error ? error.message : String(error));
      }
      requestQuit(1);
    });
  };
  if (quitting) return;
  const pendingInitial = startGateway({ ...gatewayOptions, signal: startupAbort.signal });
  initialGatewayPending = pendingInitial;
  let initialGateway;
  try {
    initialGateway = await startOwnedGateway({ start: () => pendingInitial, isQuitting: () => quitting });
    if (!initialGateway) return;
    if (quitting) { await initialGateway.stop(); return; }
    gateway = initialGateway;
  } finally {
    if (initialGatewayPending === pendingInitial) initialGatewayPending = null;
  }
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
      additionalArguments: ["--kcoder-local-directory-picker", ...(customMenu ? ["--kcoder-custom-menu"] : [])],
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
  const applicationMenu = Menu.buildFromTemplate(applicationMenuTemplate({
    newWindow: () => {
      void openAdditionalWindow({ BrowserWindow, Menu, ipcMain, dialog, shell, nativeImage, windows: additionalWindows,
        partition: desktopPartition, getGatewayOrigin: () => gatewayOrigin ?? '', menu: applicationMenu,
        customMenu, directoryOptions, isQuitting: () => quitting, requestQuit,
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
  }));
  Menu.setApplicationMenu(applicationMenu);
  if (customMenu) registerDesktopMenu({ ipcMain, window: mainWindow, menu: applicationMenu, getGatewayOrigin: () => gatewayOrigin ?? "" });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external && new URL(external).origin !== gatewayOrigin) void shell.openExternal(external);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isTrustedGatewayUrl(url, gatewayOrigin ?? "")) return;
    event.preventDefault();
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  monitorGateway(gateway);
  bindLoginRecovery(mainWindow);
  await mainWindow.loadURL(gateway.baseUrl);
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
const userDataOverride = process.env.KCODER_STUDIO_DESKTOP_USER_DATA_DIR;
if (userDataOverride && !isAbsolute(userDataOverride)) {
  throw new Error("KCODER_STUDIO_DESKTOP_USER_DATA_DIR must be an absolute path");
}
app.setPath("userData", userDataOverride || join(app.getPath("appData"), "kcoder-studio"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
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
    console.error(error);
    if (!process.env.KCODER_STUDIO_DESKTOP_SMOKE_MS) {
      const recovered = await showGatewayStorageRecovery({ error, dialog, shell, locale: app.getLocale(),
        dataDirectory: error.storageDataDirectory ?? app.getPath('userData') }).catch(() => false);
      if (!recovered) dialog.showErrorBox("KCoder Studio 启动失败", error instanceof Error ? error.message : String(error));
    }
    requestQuit(1);
  });
}
