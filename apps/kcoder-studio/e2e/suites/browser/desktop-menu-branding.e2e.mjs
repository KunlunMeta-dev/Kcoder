import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, expect } from "../../../renderer/node_modules/@playwright/test/index.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { startFixtureSite } from "../../harness/fixture-site.mjs";
import { openRpc } from "../../harness/rpc.mjs";

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: "electron-menu-ipc-and-home-branding",
  tier: "full-integration",
  modelPolicy: "model-independent Electron preload IPC, keyboard navigation and fixed home layout; no model turns",
}, async context => {
  // Linux exercises the real Electron bridge with the source-only Windows menu flag.
  // This is not evidence of native Windows painting or Windows browser startup.
  if (process.platform !== "linux") throw new Error("UNMET_PREREQUISITE: this Xvfb desktop check requires Linux");
  if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== "1") throw new Error("UNMET_PREREQUISITE: explicit isolated VM no-sandbox opt-in required");
  const xvfb = await requireExecutable("/usr/bin/xvfb-run", "Xvfb runner");
  const electron = await requireExecutable(process.env.KCODER_E2E_ELECTRON_BIN || resolve(appRoot, "node_modules/electron/dist/electron"), "Electron");
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder");
  const workspace = await materializeWorkspace(context, "minimal", { instanceId: "desktop-menu" });
  const externalSite = await startFixtureSite(context, { title: "Untrusted Menu Frame" });
  const profile = context.pathInState("profile");
  await context.writeStateJson("profile/settings.json", {});
  await context.writeStateJson("profile/credentials.json", {});
  const serversFile = await context.writeStateJson("servers.json", [
    { id: "local", label: "Menu Layout Fixture", transport: "local", command: binary, workspace: workspace.path },
  ]);
  let output = "";
  const child = context.spawnOwned("electron-menu-branding", xvfb,
    ["-a", "-s", "-screen 0 1440x900x24 -nolisten tcp", electron, "--no-sandbox",
      // Match the owned Chromium harness when exercising multiple windows without a window manager.
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--inspect=127.0.0.1:0",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", resolve(appRoot, "desktop/main.mjs")],
    { cwd: appRoot, env: context.isolatedEnvironment({
      KCODER_CONFIG_DIR: profile,
      KCODER_STUDIO_SERVERS_FILE: serversFile,
      KCODER_STUDIO_WORKSPACE: workspace.path,
      KCODER_STUDIO_KCODER_BIN: binary,
      KCODER_STUDIO_DESKTOP_USER_DATA_DIR: context.pathInState("electron-profile"),
      KCODER_STUDIO_WEB_ROOT: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, "renderer/dist"),
      KCODER_STUDIO_TEST_WINDOWS_MENU: "1",
    }) });
  const capture = chunk => { output = `${output}${chunk}`.slice(-16000); };
  child.stderr.on("data", capture);
  child.stdout.on("data", capture);
  const cdpUrl = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode})`);
    return output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
  }, 30000, "Electron CDP", 100, context.abortSignal);
  context.registerPort("electron-cdp", Number(new URL(cdpUrl).port));
  const browser = await chromium.connectOverCDP(cdpUrl);
  context.addCleanup("close Electron CDP", () => browser.close());
  const page = await waitFor(() => browser.contexts().flatMap(item => item.pages())
    .find(item => item.url().startsWith("http://127.0.0.1:")), 30000, "desktop window", 100, context.abortSignal);
  const checks = {};

  checks.rendererErrors = [];
  page.on('pageerror', error => { checks.rendererErrors.push(error.message); });
  try {
    const menu = page.getByTestId("desktop-menu-bar");
    const sidebar = page.getByTestId("desktop-sidebar");
    const logo = page.getByTestId("home-brand-logo");
    await sidebar.waitFor({ timeout: 60000 });
    await menu.waitFor({ timeout: 30000 });
    await logo.waitFor({ timeout: 30000 });
    checks.menuGeometry = await menu.evaluate(element => ({
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      buttons: [...element.querySelectorAll('button')].map(button => ({height:button.getBoundingClientRect().height,classes:button.className})),
    }));
    await context.writeArtifactJson('menu-initial-geometry.json', checks.menuGeometry);
    assert.ok(checks.menuGeometry.scrollHeight <= checks.menuGeometry.clientHeight, 'menu triggers must not create a vertical scrollbar');
    assert.ok(checks.menuGeometry.scrollWidth <= checks.menuGeometry.clientWidth, 'normal-width menubar must fit its triggers');
    const labels = ["文件", "编辑", "视图"];
    assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), labels);
    checks.hostItems = await page.evaluate(() => window.kcoderDesktopMenu.list());
    assert.deepEqual(checks.hostItems.map(({ index, label }) => ({ index, label })), labels.map((label, index) => ({ index, label })));
    assert.deepEqual(await page.evaluate(() => Object.keys(window.kcoderDesktopMenu).sort()), ["invoke", "list", "open", "setTheme", "setVisible"]);

    checks.rejectedRequests = await page.evaluate(async () => {
      const bridge = window.kcoderDesktopMenu;
      const requests = [
        () => bridge.open(-1, 0, 32),
        () => bridge.open(999, 0, 32),
        () => bridge.open("0", 0, 32),
        () => bridge.open({ index: 0, x: 0, y: 32 }),
        () => bridge.open(0, Number.NaN, 32),
        () => bridge.open(),
        () => bridge.setVisible("true"),
      ];
      return Promise.all(requests.map(async request => {
        try { await request(); return false; } catch { return true; }
      }));
    });
    assert.ok(checks.rejectedRequests.every(Boolean), "invalid IPC arguments must fail closed");

    await page.evaluate(url => {
      const iframe = document.createElement("iframe");
      iframe.id = "untrusted-menu-frame";
      iframe.src = url;
      iframe.hidden = true;
      document.body.append(iframe);
    }, externalSite.url);
    const untrusted = await waitFor(() => page.frames().find(frame => frame.url() === externalSite.url),
      10000, "external-origin fixture frame", 50, context.abortSignal);
    checks.externalFrameBridge = await untrusted.evaluate(() => typeof window.kcoderDesktopMenu);
    assert.equal(checks.externalFrameBridge, "undefined");
    await page.locator("#untrusted-menu-frame").evaluate(element => element.remove());

    const composer = page.getByTestId("chat-message-input");
    await composer.click();
    await page.keyboard.press("F10");
    await expect(page.getByTestId("desktop-menu-0")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("desktop-menu-1")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("desktop-menu-0")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("desktop-menu-2")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(composer).toBeFocused();
    checks.keyboardNavigation = true;

    await composer.fill('menu-selection-fixture');
    await page.getByTestId('desktop-menu-1').click();
    await page.getByTestId('desktop-command-selectAll').click();
    await page.getByTestId('desktop-menu-1').click();
    await page.getByTestId('desktop-command-cut').click();
    await expect(composer).toHaveText('');
    await page.getByTestId('desktop-menu-1').click();
    await page.getByTestId('desktop-command-paste').click();
    await expect(composer).toHaveText('menu-selection-fixture');
    await composer.fill('');
    checks.customMenuNativeEditRoles = true;
    await page.getByTestId('desktop-menu-0').click();
    await expect(page.getByTestId('desktop-wordmark')).toBeVisible();
    await page.screenshot({ path: context.pathInArtifacts('menu-file-zh.png') });
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu', { name: '编辑', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('desktop-menu-1')).toBeFocused();
    await page.keyboard.press('Escape');

    const menuOrigin = new URL(page.url()).origin;
    await page.goto(`${menuOrigin}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('general-language-en-button').click();
    await expect(menu.getByRole('menuitem').first()).toHaveText('File');
    assert.equal(/[\u3400-\u9fff]/u.test(await page.getByTestId('studio-settings-page').innerText()), false, 'English settings shell must not fall back to Chinese');
    for (let index = 0; index < 3; index++) {
      await page.getByTestId(`desktop-menu-${index}`).click();
      assert.equal(/[\u3400-\u9fff]/u.test(await page.getByRole('menu', { exact: true, name: ['File','Edit','View'][index] }).innerText()), false);
      await page.screenshot({ path: context.pathInArtifacts(`menu-en-${index}.png`) });
      await page.keyboard.press('Escape');
    }
    await page.getByTestId('general-language-zh-CN-button').click();
    await expect(menu.getByRole('menuitem').first()).toHaveText('文件');
    await page.goto(menuOrigin, { waitUntil: 'domcontentloaded' });
    await sidebar.waitFor();
    const fullViewport = await page.evaluate(() => ({ width:innerWidth,height:innerHeight }));
    await page.setViewportSize({width:960,height:480});
    for (let index=0; index<3; index++) {
      await page.getByTestId(`desktop-menu-${index}`).click();
      const popup=page.getByRole('menu',{exact:true,name:['文件','编辑','视图'][index]});
      await expect(popup).toBeVisible();
      const box=await popup.boundingBox();
      assert.ok(box.y>=40 && box.y+box.height<=480,'narrow menu remains below titlebar and inside viewport');
      await page.mouse.wheel(0,300);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(`desktop-menu-${index}`)).toBeFocused();
      await page.keyboard.press('Escape');
    }
    await page.getByTestId('model-selector-button').click();
    const modelMenu=page.getByTestId('model-selector-menu');
    await expect(modelMenu).toBeVisible();
    const modelBox=await modelMenu.boundingBox();
    assert.ok(modelBox.x>=0 && modelBox.y>=40 && modelBox.x+modelBox.width<=960 && modelBox.y+modelBox.height<=480,'model popup fits narrow viewport below titlebar');
    await page.screenshot({path:context.pathInArtifacts('narrow-model-menu.png')});
    await page.keyboard.press('Escape');
    await expect(modelMenu).toHaveCount(0);
    await expect(page.getByTestId('model-selector-button')).toBeFocused();
    await page.setViewportSize(fullViewport);

    checks.menuLanguageSwitch = true;


    await expect(logo).toHaveAttribute("alt", "KunlunMeta");
    await expect(sidebar.getByText("KCoder Studio", { exact: true })).toBeVisible();
    await expect(page.getByTestId("sidebar-brand-logo")).toHaveCount(0);
    await expect(page.locator('[data-testid^="task-suggestion-category-"]')).toHaveCount(4);
    await expect.poll(() => logo.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    checks.layout = await page.evaluate(() => {
      const bounds = element => {
        const { x, y, width, height, bottom, right } = element.getBoundingClientRect();
        return { x, y, width, height, bottom, right };
      };
      const menu = document.querySelector('[data-testid="desktop-menu-bar"]');
      return {
        menu: bounds(menu),
        chrome: bounds(menu.parentElement),
        content: bounds(menu.parentElement.nextElementSibling),
        logo: bounds(document.querySelector('[data-testid="home-brand-logo"]')),
        home: bounds(document.querySelector('[data-testid="desktop-empty-composer-frame"]')),
        cards: bounds(document.querySelector('[data-testid="task-suggestion-categories"]')),
        sidebar: bounds(document.querySelector('[data-testid="desktop-sidebar"]')),
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    const { layout } = checks;
    assert.equal(layout.menu.height, 32);
    assert.ok(Math.abs(layout.menu.y + layout.menu.height / 2 - layout.chrome.y - layout.chrome.height / 2) <= 1, "menu is centered within the custom titlebar");
    assert.ok(layout.content.y >= layout.menu.bottom, "menu must reserve space above content");
    assert.ok(layout.sidebar.y >= layout.menu.bottom, "menu must not cover sidebar");
    assert.ok(layout.content.bottom <= layout.viewport.height + 1, "menu must not push content below viewport");
    assert.ok(Math.abs(layout.logo.x + layout.logo.width / 2 - layout.home.x - layout.home.width / 2) <= 2,
      "homepage logo must be centered in the main content, not the sidebar");
    assert.ok(layout.logo.bottom < layout.cards.y, "logo must remain above the four suggestion cards");
    // Keep one successful screenshot for review of the requested branding/menu relocation.
    await page.screenshot({ path: context.pathInArtifacts("desktop-menu-home-branding.png") });

    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('logout-menu-button')).toHaveCount(0);
    await expect(page.getByTestId('quit-app-menu-button')).toBeVisible();
    await expect(page.getByTestId('check-app-update-button')).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('kcoder:simulate-app-update')));
    await expect(page.getByTestId('app-update-download-progress')).toHaveCount(0);
    await expect(page.getByTestId('app-update-status')).toHaveCount(0);
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('app-update-status')).toHaveCount(0);
    const origin = new URL(page.url()).origin;
    await page.goto(`${origin}/settings/about`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('about-check-update-button')).toBeDisabled();
    await expect(page.getByTestId('about-update-status')).toHaveCount(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('about-check-update-button')).toBeDisabled();
    await expect(page.getByTestId('about-update-status')).toHaveCount(0);
    checks.unsupportedUpdaterIsNonInteractive = true;
    checks.localHostUsesQuitNotLogout = true;
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await sidebar.waitFor({ timeout: 30000 });

    const inspectorUrl = output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
    assert.ok(inspectorUrl, "Electron main-process inspector must be available for native window closure");
    context.registerPort("electron-main-inspector", Number(new URL(inspectorUrl).port));
    const inspector = await openRpc(inspectorUrl);
    context.addCleanup("close Electron main inspector", () => inspector.close());
    let inspectorSequence = 0;
    const evaluateInMain = async expression => {
      const id = ++inspectorSequence;
      // The V8 inspector accepts CDP envelopes, not JSON-RPC's jsonrpc field.
      inspector.socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
      const response = await inspector.waitFor(message => message.id === id, 5000, "Electron main evaluation");
      if (response.error) throw new Error(response.error.message);
      return response.result;
    };
    const probe = await evaluateInMain("2 + 2");
    assert.equal(probe.result?.value, 4, JSON.stringify(probe));
    checks.mainInspectorBeforePopup = true;

    const primaryId = (await evaluateInMain(`process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').BrowserWindow.getAllWindows()[0].id`)).result.value;
    const fileItems = (await evaluateInMain(`process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').Menu.getApplicationMenu().items[0].submenu.items.map(item => ({label:item.label, type:item.type, enabled:item.enabled}))`)).result.value;
    assert.deepEqual(fileItems.filter(item => item.type !== 'separator').map(item => item.label), ['新建窗口', '新聊天', '新建临时聊天', '打开文件夹…', '关闭', '注销', '退出 KCoder Studio']);
    assert.equal(fileItems.find(item => item.label === '注销').enabled, false);
    const clickFile = async (label, windowId = primaryId) => {
      const result = await evaluateInMain(`(() => {
        const e = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
        const item = e.Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === ${JSON.stringify(label)});
        if (!item?.enabled) throw new Error('File action is unavailable');
        item.click(item, e.BrowserWindow.fromId(${windowId})); return true;
      })()`);
      assert.equal(result.result?.value, true, JSON.stringify(result));
    };
    await page.goto(`${origin}/settings/about`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('about-check-update-button').waitFor();
    await clickFile('新聊天');
    await expect(page).toHaveURL(`${origin}/`);
    await clickFile('新建临时聊天');
    await expect(page.getByTestId('right-workspace-chat-panel')).toBeVisible();
    checks.fileNewChatAndTemporaryChat = true;

    // Observe the real native dialog; do not substitute fake selected paths.
    const display = (await evaluateInMain(`(() => {
      const e = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
      const original = e.dialog.showOpenDialog.bind(e.dialog);
      globalThis.__fileMenuFolderOpened = false; globalThis.__fileMenuFolderClosed = false;
      e.dialog.showOpenDialog = (...args) => { globalThis.__fileMenuFolderOpened = true; return original(...args).finally(() => { globalThis.__fileMenuFolderClosed = true; }); };
      return { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY };
    })()`)).result.value;
    context.registerSecret(display.XAUTHORITY);
    await clickFile('打开文件夹…');
    await waitFor(async () => (await evaluateInMain('globalThis.__fileMenuFolderOpened')).result?.value, 10000, 'native File folder dialog', 100, context.abortSignal);
    const xdotool = await requireExecutable('/usr/bin/xdotool', 'isolated native dialog cancellation');
    // Native dialog realization follows the API request; allow its first X event cycle.
    await page.waitForTimeout(300);
    const cancel = context.spawnOwned('cancel-file-menu-native-dialog', xdotool, ['key', 'Escape'], { env: context.isolatedEnvironment(display) });
    await waitFor(() => cancel.exitCode !== null, 5000, 'native dialog cancellation input', 50, context.abortSignal);
    assert.equal(cancel.exitCode, 0);
    await waitFor(async () => (await evaluateInMain('globalThis.__fileMenuFolderClosed')).result?.value, 10000, 'native dialog cancellation result', 100, context.abortSignal);
    await expect(page.getByTestId('standalone-folder-project-dialog')).toBeVisible();
    await page.getByTestId('close-standalone-folder-project-dialog').click();
    await expect(page.getByTestId('standalone-folder-project-dialog-overlay')).toHaveCount(0);
    checks.fileFolderPickerOpenedAndCancelled = true;


    await page.getByTestId('chat-message-input').first().fill('primary-window-draft');
    await clickFile('新建窗口');
    const secondary = await waitFor(() => browser.contexts().flatMap(item => item.pages()).find(item => item !== page && item.url() === `${origin}/`), 15000, 'additional desktop window', 100, context.abortSignal);
    await secondary.getByTestId('desktop-sidebar').waitFor({ timeout: 30000 });
    await secondary.getByTestId('desktop-menu-bar').waitFor();
    assert.deepEqual(await secondary.evaluate(() => window.kcoderDesktopMenu.list()), checks.hostItems);
    assert.deepEqual(await page.evaluate(() => window.kcoderDesktopMenu.list()), checks.hostItems);
    const secondaryId = (await evaluateInMain(`process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').BrowserWindow.getAllWindows().find(window => window.id !== ${primaryId}).id`)).result.value;
    await secondary.goto(`${origin}/settings/about`, { waitUntil: 'domcontentloaded' });
    await secondary.getByTestId('about-check-update-button').waitFor();
    await clickFile('新聊天', secondaryId);
    await expect(secondary).toHaveURL(`${origin}/`);
    await expect(page.getByTestId('chat-message-input').first()).toHaveText('primary-window-draft');
    await secondary.evaluate(() => window.kcoderDesktopHost.setTaskActivity(0));
    const secondaryClosed = secondary.waitForEvent('close');
    await clickFile('关闭', secondaryId);
    await secondaryClosed;
    await page.bringToFront();
    assert.equal(child.exitCode, null);
    assert.deepEqual(await page.evaluate(() => window.kcoderDesktopMenu.list()), checks.hostItems);
    checks.additionalWindowOpenedAndClosedWithoutAffectingPrimary = true;

    if (process.env.KCODER_E2E_FILE_ACTIONS_ONLY === '1') {
      // A focused File-action run does not claim the separate close-to-tray painting regression.
      const quit = await evaluateInMain(`(() => {
        const e = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
        const item = e.Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === '退出 KCoder Studio');
        setTimeout(() => item.click(item, e.BrowserWindow.fromId(${primaryId})), 100); return true;
      })()`);
      assert.equal(quit.result?.value, true);
      inspector.close();
      await browser.close();
      await waitFor(() => child.exitCode !== null, 15000, 'File menu application quit', 100, context.abortSignal);
      assert.equal(child.exitCode, 0);
      checks.fileExplicitQuitStoppedOwnedGateway = true;
      await context.writeArtifactJson('checks.json', checks);
      return { passed: true, scope: 'File menu actions and window isolation only', windowsNativeExecution: false, modelTurns: 0 };
    }

    // Native popup surfaces are not DOM. Exercise the real preload request, then close
    // the owning window to verify bounded cleanup without claiming native Windows clicks.
    await page.evaluate(() => {
      window.__desktopMenuPopupError = null;
      window.__desktopMenuPopupClosed = false;
      void window.kcoderDesktopMenu.open(0, 0, 32).then(() => {
        window.__desktopMenuPopupClosed = true;
      }).catch(error => {
        window.__desktopMenuPopupError = String(error);
      });
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__desktopMenuPopupError), null);
    checks.nativePopupRequestSent = true;
    // Close to tray first: dismiss the native popup without destroying the live renderer.
    await page.evaluate(() => window.kcoderDesktopHost.setPreferences({ closeToTrayEnabled: true, language: 'zh-CN' }));
    const closure = await evaluateInMain(`(() => {
        const electron = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
        const windows = electron.BrowserWindow.getAllWindows();
        if (windows.length !== 1) throw new Error('Expected one test-owned BrowserWindow');
        globalThis.__desktopMenuOwnerClosed = false;
        windows[0].once('close', () => { globalThis.__desktopMenuOwnerClosed = true; });
        setTimeout(() => windows[0].close(), 100);
        return 'native-window-close-scheduled';
      })()`);
    assert.equal(closure.result?.value, "native-window-close-scheduled", JSON.stringify(closure));
    await expect.poll(() => page.evaluate(() => window.__desktopMenuPopupClosed)).toBe(true);
    // Popup dismissal may precede the scheduled native close. Restoring before the
    // close actually fires would hide the window again during the next UI action.
    await waitFor(async () => (await evaluateInMain(`(() => {
      const e = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
      return globalThis.__desktopMenuOwnerClosed && !e.BrowserWindow.fromId(${primaryId}).isVisible();
    })()`)).result?.value, 5000, 'native window is hidden before restore', 50, context.abortSignal);
    assert.equal(child.exitCode, null);
    await evaluateInMain(`process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').app.emit('second-instance')`);
    await page.bringToFront();
    checks.nativePopupDismissedOnCloseToTray = true;
    checks.restoredWindowState = (await evaluateInMain(`process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').BrowserWindow.getAllWindows().map(window => ({id:window.id, visible:window.isVisible(), focused:window.isFocused()}))`)).result.value;

    await page.getByTestId('settings-button').click();
    await page.getByTestId('quit-app-menu-button').click();
    await expect(page.getByTestId('quit-app-dialog')).toBeVisible();
    checks.quitDialogState = await page.evaluate(async () => {
      let frames = 0;
      const rectangles = [];
      let running = true;
      const frame = () => { frames += 1; if (running) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      const timer = setInterval(() => {
        const rect = document.querySelector('[data-testid="quit-app-dialog-close"]')?.getBoundingClientRect();
        if (rect) rectangles.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }, 100);
      await new Promise(resolve => setTimeout(resolve, 600));
      running = false; clearInterval(timer);
      return { visibility: document.visibilityState, focus: document.activeElement?.getAttribute('data-testid'), frames, rectangles };
    });
    await context.writeArtifactJson('quit-dialog-before-cancel.json', checks);
    await page.getByTestId('quit-app-dialog-close').click({ timeout: 5000 });
    await expect(page.getByTestId('quit-app-dialog')).toHaveCount(0);
    await expect(page.getByTestId('settings-menu')).toBeVisible();
    assert.equal(child.exitCode, null);
    await page.getByTestId('quit-app-menu-button').click();
    await expect(page.getByTestId('quit-app-dialog')).toBeVisible();
    await page.screenshot({ path: context.pathInArtifacts('desktop-quit-confirmation.png') });
    inspector.close();
    await page.getByTestId('quit-app-dialog-confirm').click();
    checks.windowCloseMode = "confirmed-renderer-quit";
    await browser.close();
    checks.cdpDisconnectedBeforeQuit = true;
    await waitFor(() => child.exitCode !== null, 15000, "desktop graceful quit", 100, context.abortSignal);
    assert.equal(child.exitCode, 0);
    checks.gracefulQuit = true;
    checks.cancelledQuitKeptWindow = true;
    checks.confirmedQuitStoppedOwnedGateway = true;
    await context.writeArtifactJson("checks.json", checks);
    return { passed: true, host: process.platform, windowsNativeExecution: false, modelTurns: 0 };
  } catch (error) {
    if (!page.isClosed()) await page.screenshot({ path: context.pathInArtifacts("failure.png"), timeout: 1500 }).catch(() => {});
    await context.writeArtifactJson("failure-checks.json", checks);
    throw error;
  }
});
