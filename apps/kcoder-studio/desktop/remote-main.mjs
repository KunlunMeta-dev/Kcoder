import { app, BrowserWindow, dialog, ipcMain, Menu, Tray, session, shell } from "electron";
import { fileURLToPath } from "node:url";
import { createDesktopTray } from "./tray-controller.mjs";
import { desktopIconPaths, registerTaskbarIcon } from "./desktop-icons.mjs";
import { applicationMenuTemplate } from "./application-menu.mjs";
import { openAdditionalWindow, sendDesktopMenuCommand } from "./additional-window.mjs";
import { registerDesktopMenu } from "./desktop-menu-controller.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  loginRemoteGateway,
  resolveRemoteClientOptions,
} from "./remote-config.mjs";
import {
  allowRendererPermission,
  isTrustedGatewayUrl,
} from "./security-policy.mjs";

let mainWindow = null;
let quitting = false;
let desktopTray = null;
const remotePartition = "persist:kcoder-studio-remote";
const additionalWindows = new Set();
let primaryHiddenForOtherWindows = false;

function requestQuit(exitCode = 0) {
  if (quitting) return;
  quitting = true;
  desktopTray?.dispose();
  app.exit(exitCode);
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

async function createMainWindow() {
  const remote = resolveRemoteClientOptions();
  const desktopSession = session.fromPartition(remotePartition);
  // Tailscale 100.64.0.0/10 addresses require direct connections; inheriting the host
  // HTTP proxy produces a proxy-side 502. Restore Chromium system-proxy configuration
  // only when explicitly targeting a public gateway that requires it.
  await desktopSession.setProxy({
    mode:
      process.env.KCODER_STUDIO_REMOTE_USE_SYSTEM_PROXY === "1"
        ? "system"
        : "direct",
  });
  const cookieValue = await loginRemoteGateway(remote);
  await desktopSession.cookies.set({
    url: remote.origin,
    name: "kcoder_studio_session",
    value: cookieValue,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });

  let expectedWebContentsId = null;
  desktopSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        allowRendererPermission({
          permission,
          requestingUrl: details.requestingUrl,
          gatewayOrigin: remote.origin,
          webContentsId: webContents.id,
      expectedWebContentsId: [...additionalWindows].some(window => !window.isDestroyed() && window.webContents.id === webContents.id) ? webContents.id : expectedWebContentsId,
        }),
      );
    },
  );
  desktopSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      allowRendererPermission({
        permission,
        requestingUrl: details.requestingUrl || requestingOrigin,
        gatewayOrigin: remote.origin,
        webContentsId: webContents?.id,
      expectedWebContentsId: [...additionalWindows].some(window => !window.isDestroyed() && window.webContents.id === webContents?.id) ? webContents.id : expectedWebContentsId,
      }),
  );

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
    title: "KCoder Studio Remote",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: remotePartition,
      preload: fileURLToPath(new URL("./menu-preload.cjs", import.meta.url)),
      ...(customMenu ? { additionalArguments: ["--kcoder-custom-menu"] } : {}),
    },
  });
  expectedWebContentsId = mainWindow.webContents.id;
  desktopTray = createDesktopTray({
    Tray, Menu, ipcMain, dialog, window: mainWindow,
    icon: desktopIconPaths().tray,
    getGatewayOrigin: () => remote.origin, isQuitting: () => quitting, requestQuit,
    requestWindowClose: () => {
      if (additionalWindows.size) { primaryHiddenForOtherWindows = true; mainWindow.hide(); }
      else requestQuit(0);
    },
  });
  const openRoute = (path, target = mainWindow) => {
    if (!target || target.isDestroyed() || (target !== mainWindow && !additionalWindows.has(target)) || !isTrustedGatewayUrl(target.webContents.getURL(), remote.origin)) return;
    void target.webContents.executeJavaScript(
      `history.pushState({}, '', ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent('popstate'));`,
    ).catch(error => console.error("Failed to open desktop route", error));
  };
  const applicationMenu = Menu.buildFromTemplate(applicationMenuTemplate({
    newWindow: () => {
      void openAdditionalWindow({ BrowserWindow, Menu, ipcMain, dialog, shell, windows: additionalWindows,
        partition: remotePartition, getGatewayOrigin: () => remote.origin, initialUrl: remote.initialUrl, menu: applicationMenu,
        customMenu, isQuitting: () => quitting, requestQuit,
        onLastClosed: () => {
          if (primaryHiddenForOtherWindows && mainWindow && !mainWindow.isDestroyed() && !quitting) mainWindow.show();
          primaryHiddenForOtherWindows = false;
        },
      }).catch(error => dialog.showErrorBox('无法新建窗口', error.message));
    },
    newChat: (_item, focused) => sendDesktopMenuCommand('new-chat', focused, mainWindow, additionalWindows, remote.origin),
    newTemporaryChat: (_item, focused) => sendDesktopMenuCommand('new-temporary-chat', focused, mainWindow, additionalWindows, remote.origin),
    openFolder: (_item, focused) => sendDesktopMenuCommand('open-folder', focused, mainWindow, additionalWindows, remote.origin),
    logout: (_item, focused) => sendDesktopMenuCommand('logout', focused, mainWindow, additionalWindows, remote.origin),
    canLogout: true,
    openSettings: (_item, focused) => openRoute("/settings", focused ?? mainWindow),
    openAutomations: (_item, focused) => openRoute("/automations", focused ?? mainWindow),
    quit: () => requestQuit(0),
  }));
  Menu.setApplicationMenu(applicationMenu);
  if (customMenu) registerDesktopMenu({ ipcMain, window: mainWindow, menu: applicationMenu, getGatewayOrigin: () => remote.origin });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external && new URL(external).origin !== remote.origin)
      void shell.openExternal(external);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isTrustedGatewayUrl(url, remote.origin)) return;
    event.preventDefault();
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(remote.initialUrl);
  console.log(`KCoder Studio remote desktop ready: ${remote.initialUrl}`);

  const screenshotPath = process.env.KCODER_STUDIO_DESKTOP_SCREENSHOT;
  if (screenshotPath) {
    if (!isAbsolute(screenshotPath)) {
      throw new Error("KCODER_STUDIO_DESKTOP_SCREENSHOT 必须是绝对路径");
    }
    const screenshotDelayMs = Number(
      process.env.KCODER_STUDIO_DESKTOP_SCREENSHOT_DELAY_MS || 4_000,
    );
    await new Promise((resolveDelay) =>
      setTimeout(
        resolveDelay,
        Number.isFinite(screenshotDelayMs) && screenshotDelayMs >= 0
          ? screenshotDelayMs
          : 4_000,
      ),
    );
    const image = await mainWindow.webContents.capturePage();
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, image.toPNG());
    console.log(`KCoder Studio remote desktop screenshot: ${screenshotPath}`);
  }
  const smokeMs = Number(process.env.KCODER_STUDIO_DESKTOP_SMOKE_MS || 0);
  if (Number.isFinite(smokeMs) && smokeMs > 0) {
    const timer = setTimeout(() => requestQuit(0), smokeMs);
    timer.unref?.();
  }
}

app.setName("KCoder Studio Remote");
if (process.platform === "win32") app.setAppUserModelId("dev.kcoder.studio.remote");
registerTaskbarIcon(app, "dev.kcoder.studio.remote");
const userDataOverride = process.env.KCODER_STUDIO_DESKTOP_USER_DATA_DIR;
if (userDataOverride && !isAbsolute(userDataOverride)) {
  throw new Error("KCODER_STUDIO_DESKTOP_USER_DATA_DIR 必须是绝对路径");
}
app.setPath(
  "userData",
  userDataOverride || join(app.getPath("appData"), "kcoder-studio-remote"),
);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => requestQuit(0));
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    requestQuit(0);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => requestQuit(0));
  }
  app
    .whenReady()
    .then(createMainWindow)
    .catch((error) => {
      console.error(error);
      if (!process.env.KCODER_STUDIO_DESKTOP_SMOKE_MS) {
        dialog.showErrorBox(
          "KCoder Studio 远程客户端启动失败",
          error instanceof Error ? error.message : String(error),
        );
      }
      requestQuit(1);
    });
}
