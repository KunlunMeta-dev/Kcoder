import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { fingerprintRegularTree } from "../harness/settings-fingerprints.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const PREFERENCES_KEY = "kcoder-studio:mobile-app-preferences:v1";
const BASELINE_MANIFEST_SHA256 = "0b49ebb1fd31a618d65719632c1e4c440175751b4d622f149a09a706eb3ba3db";
const BASELINE_SOURCE_SHA256 = "59170f6071d744fa7db23cbe6947d85e93a11fffad49f0ace4b767fb7ae20acb";
const currentWebRootInput = process.env.KCODER_E2E_LOCAL_PREFS_CURRENT_WEB_ROOT;
const currentManifestShaInput = process.env.KCODER_E2E_LOCAL_PREFS_CURRENT_MANIFEST_SHA256;
const baselineWebRootInput = process.env.KCODER_E2E_LOCAL_PREFS_BASELINE_WEB_ROOT;
const configuredKcoderBin = process.env.KCODER_E2E_KCODER_BIN;

assert.ok(currentWebRootInput && isAbsolute(currentWebRootInput),
  "set KCODER_E2E_LOCAL_PREFS_CURRENT_WEB_ROOT to the current private Mobile builder's artifacts/mobile-web");
assert.match(currentManifestShaInput ?? "", /^[a-f0-9]{64}$/,
  "set KCODER_E2E_LOCAL_PREFS_CURRENT_MANIFEST_SHA256 to the current builder's manifest SHA256");
assert.ok(!baselineWebRootInput || isAbsolute(baselineWebRootInput),
  "KCODER_E2E_LOCAL_PREFS_BASELINE_WEB_ROOT must be an absolute path when supplied");
assert.ok(!configuredKcoderBin || isAbsolute(configuredKcoderBin),
  "KCODER_E2E_KCODER_BIN must be an absolute binary path");

const currentWebRoot = resolve(currentWebRootInput);
const expectedCurrentManifestSha256 = currentManifestShaInput;
const baselineWebRoot = baselineWebRootInput ? resolve(baselineWebRootInput) : null;
const kcBin = configuredKcoderBin ? resolve(configuredKcoderBin) : resolve(repoRoot, "target/release/kcoder");
const preferencesTestRoot = resolve(repoRoot, "target/test");
const sourceRoot = resolve(repoRoot, "apps/kcoder-studio/mobile/src");
const currentMobileSourceShaAtStart = await fingerprintRegularTree(sourceRoot);

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function inspectMobileWebRoot(root, expectedManifestSha256, expectedSourceSha256 = null) {
  assert.ok(isWithin(preferencesTestRoot, root), "Mobile Web input must be a RunContext artifact under target/test");
  assert.equal(root.split(sep).at(-1), "mobile-web", "Mobile Web input must be the builder's artifacts/mobile-web directory");
  const manifestBytes = await readFile(resolve(root, "kcoder-mobile-web.json"));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  assert.equal(manifestSha256, expectedManifestSha256, "Mobile Web manifest does not match the supplied builder SHA256");
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.version, 1);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  for (const file of manifest.files) {
    assert.ok(file.path && !isAbsolute(file.path) && !file.path.split(/[\\/]/).includes(".."));
    const bytes = await readFile(resolve(root, file.path));
    assert.equal(bytes.length, file.size, `${file.path} size must match its mobile manifest`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256,
      `${file.path} content must match its mobile manifest`);
  }
  const sourceBeforePath = resolve(dirname(root), "mobile-source-before.json");
  const sourceAfterPath = resolve(dirname(root), "mobile-source-after.json");
  const sourceBefore = JSON.parse(await readFile(sourceBeforePath, "utf8"));
  const sourceAfter = JSON.parse(await waitFor(async () => {
    try { return await readFile(sourceAfterPath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, 60_000, "builder source postflight", 500));
  assert.deepEqual(sourceAfter, sourceBefore, "Mobile source inventory must be stable across the build");
  assert.match(sourceBefore.digest ?? "", /^[a-f0-9]{64}$/);
  if (expectedSourceSha256) assert.equal(sourceBefore.digest, expectedSourceSha256);
  return {
    webRoot: root,
    manifestSha256,
    sourceSha256: sourceBefore.digest,
    fileCount: manifest.files.length,
  };
}

async function makeOwnedGateway(context, label, webRoot) {
  const workspace = context.pathInState(`${label}-workspace`);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const serversFile = await context.writeStateJson(`${label}-servers.json`, [
    { id: "local", label: "Preferences acceptance", transport: "local", workspace },
  ]);
  const gateway = await startGateway(context, {
    label: `${label}-gateway`,
    auth: true,
    workspace,
    serversFile,
    kcoderBin: kcBin,
    env: { KCODER_STUDIO_WEB_ROOT: "", KCODER_STUDIO_MOBILE_WEB_ROOT: webRoot },
  });
  context.registerSecret(gateway.authToken);
  return { gateway, workspace };
}

function createRpcObserver(page) {
  const methods = new Set();
  const targetWriteMethods = new Set();
  let enabled = false;
  const targetDomain = /(?:target|workspace|config(?:uration)?|settings|permission|instruction|execution|provider|model)/i;
  const mutationVerb = /(?:^|[./:_-])(?:write|set|update|save|patch|apply|create|delete|remove|clear|reset)(?:$|[./:_-])/i;
  page.on("websocket", socket => {
    socket.on("framesent", frame => {
      if (!enabled) return;
      try {
        const value = JSON.parse(String(frame?.payload));
        if (typeof value?.method !== "string") return;
        methods.add(value.method);
        if (targetDomain.test(value.method) && mutationVerb.test(value.method))
          targetWriteMethods.add(value.method);
      } catch { /* Non-JSON frames and notifications have no method name to record. */ }
    });
  });
  return {
    enable() { enabled = true; },
    result() { return { methods: [...methods].sort(), targetWriteMethods: [...targetWriteMethods].sort() }; },
  };
}

async function installPreferenceWriteFault(page) {
  await page.addInitScript(key => {
    const state = { enabled: false, rejectedWrites: 0 };
    Object.defineProperty(window, "__kcoderLocalPreferenceWriteFault", { value: state });
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && state.enabled) {
        state.rejectedWrites += 1;
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      }
      return originalSetItem.call(this, name, value);
    };
  }, PREFERENCES_KEY);
}

async function readPreferenceProjection(page) {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const preferences = JSON.parse(raw);
    return {
      theme: preferences.theme ?? null,
      language: preferences.language ?? null,
      terminalScrollbackLines: preferences.terminalScrollbackLines ?? null,
    };
  }, PREFERENCES_KEY);
}

async function readUnrelatedLocalStorageKeySet(page) {
  return page.evaluate(async key => {
    const names = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const name = localStorage.key(index);
      if (name && name !== key) names.push(name);
    }
    names.sort();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(names)));
    return {
      count: names.length,
      namesSha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
    };
  }, PREFERENCES_KEY);
}

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameLocalStorageKeySet(left, right) {
  return left.count === right.count && left.namesSha256 === right.namesSha256;
}

async function waitForRejectedWrites(page, minimum) {
  await page.waitForFunction(expected =>
    window.__kcoderLocalPreferenceWriteFault.rejectedWrites >= expected,
  minimum, { timeout: 10_000 });
}

async function waitForStoredPreferences(page, expected) {
  await page.waitForFunction(({ key, expected: wanted }) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return false;
      const actual = JSON.parse(raw);
      return Object.entries(wanted).every(([field, value]) => actual[field] === value);
    } catch { return false; }
  }, { key: PREFERENCES_KEY, expected }, { timeout: 10_000 });
}

async function chooseAppearance(page, field, value) {
  const rowId = field === "theme" ? "settings-theme-row" : "settings-language-row";
  const optionId = field === "theme"
    ? `settings-theme-choice-${value}`
    : `settings-language-choice-${value === "zh-CN" ? "zh-cn" : value}`;
  await page.locator(`[data-testid="${rowId}"]:visible`).click();
  await page.locator(`[data-testid="${optionId}"]:visible`).click();
  if (field === "theme") {
    await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, value);
  } else {
    await page.waitForFunction(expected => document.documentElement.lang === expected, value);
  }
}

async function assertCurrentPreferenceError(page, testID, locale) {
  const notice = page.locator(`[data-testid="${testID}-write-error"]:visible`);
  await notice.waitFor({ state: "visible", timeout: 10_000 });
  const message = await notice.locator('[role="alert"]').innerText();
  assert.ok(locale === "en"
    ? /current choices are active but have not been saved/i.test(message)
    : /当前选项已生效，但未保存到本机/.test(message),
  "visible write error must explain that current preferences are active but not persisted");
  await page.locator(`[data-testid="${testID}-write-retry"]:visible`).waitFor({ state: "visible" });
  return notice;
}

async function captureErrorLayout(page, context, notice, width, height, name) {
  await page.setViewportSize({ width, height });
  await notice.scrollIntoViewIfNeeded();
  const message = notice.locator('[role="alert"]');
  const retry = notice.locator('[data-testid$="-write-retry"]');
  const messageBox = await message.boundingBox();
  const retryBox = await retry.boundingBox();
  assert.ok(messageBox && retryBox, "error copy and retry action must have visible layout boxes");
  const viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(viewport.width, width);
  assert.ok(viewport.scrollWidth <= width, "preference failure feedback must not overflow horizontally");
  assert.ok(retryBox.height >= 44, "retry action must retain the 44px touch target");
  const boxesDoNotOverlap = messageBox.x + messageBox.width <= retryBox.x + 1 ||
    retryBox.x + retryBox.width <= messageBox.x + 1 ||
    messageBox.y + messageBox.height <= retryBox.y + 1 ||
    retryBox.y + retryBox.height <= messageBox.y + 1;
  assert.ok(boxesDoNotOverlap,
    "localized error copy must not overlap the retry action at this viewport width");
  const path = context.pathInArtifacts(name);
  await page.screenshot({ path });
  await chmod(path, 0o600);
  return {
    screenshot: name,
    logicalViewport: { width, height },
    deviceScaleFactor: 2,
    documentScrollWidth: viewport.scrollWidth,
    messageBox: { width: messageBox.width, height: messageBox.height },
    retryBox: { width: retryBox.width, height: retryBox.height },
    noOverlap: true,
  };
}

async function connectToSettings(page, gateway, sessionReceipts) {
  await page.goto(`${gateway.baseUrl}/login?returnTo=%2Fmobile%2F`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await page.locator('button[type="submit"]').click();
  await page.locator('[data-testid="welcome-direct-connection"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('[data-testid="welcome-direct-connection"]:visible').click();
  await page.locator('[data-testid="gateway-endpoint"]:visible').fill(gateway.baseUrl);
  await page.locator('[data-testid="gateway-token"]:visible').fill(gateway.authToken);
  await page.locator('[data-testid="gateway-connect"]:visible').click();
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(sessionReceipts.includes(200), "Mobile must pair through this run's authenticated Gateway");
  await page.goto(`${gateway.baseUrl}/mobile/settings`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="settings-home"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('[data-testid="settings-appearance"]:visible').click();
  await page.locator('[data-testid="settings-appearance-screen"]:visible').waitFor({ state: "visible" });
}

async function setInitialPreferences(page) {
  await chooseAppearance(page, "theme", "dark");
  await chooseAppearance(page, "language", "zh-CN");
  await waitForStoredPreferences(page, { theme: "dark", language: "zh-CN", terminalScrollbackLines: 10_000 });
  return readPreferenceProjection(page);
}

async function captureAppearanceFailureMatrix(page, context, prefix, errorIsRequired) {
  const matrix = [];
  const locales = ["zh-CN", "en"];
  const themes = ["light", "dark"];
  const viewports = [{ width: 320, height: 568 }, { width: 390, height: 844 }];
  for (const locale of locales) {
    for (const theme of themes) {
      await chooseAppearance(page, "theme", theme);
      await chooseAppearance(page, "language", locale);
      const errorCount = await page.locator('[data-testid="appearance-preferences-write-error"]:visible').count();
      const retryCount = await page.locator('[data-testid="appearance-preferences-write-retry"]:visible').count();
      if (errorIsRequired) {
        assert.equal(errorCount, 1, "current build must show a localized write-failure message");
        await assertCurrentPreferenceError(page, "appearance-preferences", locale);
      }
      for (const viewport of viewports) {
        const screenshot = `${prefix}-appearance-write-failure-${viewport.width}-${locale}-${theme}.png`;
        const notice = page.locator('[data-testid="appearance-preferences-write-error"]:visible');
        const layout = errorIsRequired
          ? await captureErrorLayout(page, context, notice, viewport.width, viewport.height, screenshot)
          : await captureLooseScreenshot(page, context, viewport.width, viewport.height, screenshot);
        matrix.push({ locale, theme, ...layout,
          visibleWriteError: errorCount > 0,
          retryAvailable: retryCount > 0 });
      }
    }
  }
  return matrix;
}

async function captureLooseScreenshot(page, context, width, height, name) {
  await page.setViewportSize({ width, height });
  const path = context.pathInArtifacts(name);
  await page.screenshot({ path });
  await chmod(path, 0o600);
  return { screenshot: name, logicalViewport: { width, height }, deviceScaleFactor: 2 };
}

async function exerciseBaseline(context, chromium, baselineBuild) {
  if (!baselineBuild) return { status: "not-provided", screenshots: [] };
  let stage = "gateway-start";
  let browserContext;
  let page;
  const screenshots = [];
  const sessionReceipts = [];
  let pageErrorCount = 0;
  try {
    const { gateway } = await makeOwnedGateway(context, "baseline-local-preferences", baselineBuild.webRoot);
    browserContext = await chromium.browser.newContext({
      locale: "zh-CN", colorScheme: "light", deviceScaleFactor: 2, viewport: { width: 390, height: 844 },
    });
    page = await browserContext.newPage();
    page.on("pageerror", () => { pageErrorCount += 1; });
    page.on("response", response => {
      if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/mobile/session")
        sessionReceipts.push(response.status());
    });
    await installPreferenceWriteFault(page);
    stage = "mobile-pair-and-appearance";
    await connectToSettings(page, gateway, sessionReceipts);
    const savedBeforeFailure = await setInitialPreferences(page);
    const unrelatedKeysBefore = await readUnrelatedLocalStorageKeySet(page);
    await page.evaluate(() => { window.__kcoderLocalPreferenceWriteFault.enabled = true; });
    await chooseAppearance(page, "theme", "light");
    await chooseAppearance(page, "language", "en");
    await waitForRejectedWrites(page, 2);
    const duringFailure = await readPreferenceProjection(page);
    assert.ok(sameValues(duringFailure, savedBeforeFailure), "failed baseline writes must leave the saved preference blob unchanged");
    const appearanceErrorCount = await page.locator('[data-testid="appearance-preferences-write-error"]:visible').count();
    const appearanceRetryCount = await page.locator('[data-testid="appearance-preferences-write-retry"]:visible').count();
    stage = "appearance-failure-screenshots";
    const appearanceScreenshots = await captureAppearanceFailureMatrix(page, context, "before", false);
    screenshots.push(...appearanceScreenshots.map(entry => entry.screenshot));
    await waitForRejectedWrites(page, 10);
    assert.ok(sameValues(await readPreferenceProjection(page), savedBeforeFailure),
      "baseline matrix failures must not change the saved preference blob");
    const unrelatedKeysAfter = await readUnrelatedLocalStorageKeySet(page);
    assert.ok(sameLocalStorageKeySet(unrelatedKeysBefore, unrelatedKeysAfter),
      "baseline flow must preserve all non-preference localStorage key names");
    const appearanceRejectedWrites = await page.evaluate(() => window.__kcoderLocalPreferenceWriteFault.rejectedWrites);
    await page.evaluate(() => { window.__kcoderLocalPreferenceWriteFault.enabled = false; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="settings-appearance-screen"]:visible').waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), savedBeforeFailure.theme);
    assert.equal(await page.evaluate(() => document.documentElement.lang), savedBeforeFailure.language);
    const restoredOnReload = await readPreferenceProjection(page);
    assert.ok(sameValues(restoredOnReload, savedBeforeFailure), "baseline reload must restore the last successful save");
    await page.locator('[data-testid="settings-detail-back"]:visible').click();
    await page.locator('[data-testid="settings-home"]:visible').waitFor({ state: "visible" });
    await page.locator('[data-testid="terminal-settings"]:visible').click();
    await page.locator('[data-testid="settings-terminal-screen"]:visible').waitFor({ state: "visible" });
    await page.evaluate(() => { window.__kcoderLocalPreferenceWriteFault.enabled = true; });
    await page.locator('[data-testid="terminal-scrollback-5000"]:visible').click();
    await page.locator('[data-testid="terminal-scrollback-100000"]:visible').click();
    await waitForRejectedWrites(page, 2);
    const terminalErrorCount = await page.locator('[data-testid="terminal-preferences-write-error"]:visible').count();
    const terminalRetryCount = await page.locator('[data-testid="terminal-preferences-write-retry"]:visible').count();
    const scrollback5000Selected = await page.locator('[data-testid="terminal-scrollback-5000"]').getAttribute("aria-checked");
    const scrollback100000Selected = await page.locator('[data-testid="terminal-scrollback-100000"]').getAttribute("aria-checked");
    assert.equal(scrollback5000Selected, "false");
    assert.equal(scrollback100000Selected, "true");
    assert.equal((await readPreferenceProjection(page)).terminalScrollbackLines, savedBeforeFailure.terminalScrollbackLines);
    const terminalRejectedWrites = await page.evaluate(() => window.__kcoderLocalPreferenceWriteFault.rejectedWrites);
    for (const width of [320, 390]) {
      const height = width === 320 ? 568 : 844;
      const name = `before-terminal-write-failure-${width}-${savedBeforeFailure.language}-dark.png`;
      await captureLooseScreenshot(page, context, width, height, name);
      screenshots.push(name);
    }
    await page.evaluate(() => { window.__kcoderLocalPreferenceWriteFault.enabled = false; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="settings-terminal-screen"]:visible').waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.locator('[data-testid="terminal-scrollback-10000"]').getAttribute("aria-checked"), "true");
    return {
      status: "observed",
      savedBeforeFailure,
      savedDuringFailure: duringFailure,
      restoredOnReload,
      appearanceErrorVisible: appearanceErrorCount > 0,
      appearanceRetryAvailable: appearanceRetryCount > 0,
      terminalErrorVisible: terminalErrorCount > 0,
      terminalRetryAvailable: terminalRetryCount > 0,
      appearanceRejectedWrites,
      terminalRejectedWrites,
      rejectedPreferenceWrites: appearanceRejectedWrites + terminalRejectedWrites,
      nonPreferenceStorageKeysPreserved: true,
      nonPreferenceStorageKeyCount: unrelatedKeysBefore.count,
      nonPreferenceStorageKeySetSha256: unrelatedKeysBefore.namesSha256,
      pageErrorCount,
      screenshots,
    };
  } catch (error) {
    return {
      status: "partial",
      failedStage: stage,
      errorClass: error?.name === "TimeoutError" ? "timeout" : error?.name ?? "Error",
      pageErrorCount,
      screenshots,
    };
  } finally {
    await browserContext?.close().catch(() => {});
  }
}

function safeFailureSummary(context, error) {
  const allowedNames = new Set([
    "Error", "TypeError", "RangeError", "AssertionError", "TimeoutError", "AbortError", "AggregateError",
  ]);
  const rawMessage = error instanceof Error ? error.message : String(error ?? "Unknown failure");
  const message = context.redactText(rawMessage)
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]*/g, "[path]")
    .replace(/\s+/g, " ")
    .slice(0, 280);
  return { name: allowedNames.has(error?.name) ? error.name : "OtherError", message };
}

async function safeVisibleCount(page, selector) {
  if (!page) return null;
  try { return await page.locator(selector).count(); }
  catch { return null; }
}

async function captureCurrentFailureScreenshot(page, context, connectionComplete) {
  if (!page || !connectionComplete) return { status: "skipped", reason: "connection-not-complete" };
  let pathname = null;
  try { pathname = new URL(page.url()).pathname; } catch { /* Invalid or closing page. */ }
  if (pathname?.endsWith("/login")) return { status: "skipped", reason: "login-path" };
  const [loginTokenFieldCount, gatewayTokenFieldCount] = await Promise.all([
    safeVisibleCount(page, 'input[name="token"]:visible'),
    safeVisibleCount(page, '[data-testid="gateway-token"]:visible'),
  ]);
  if ((loginTokenFieldCount ?? 0) > 0 || (gatewayTokenFieldCount ?? 0) > 0)
    return { status: "skipped", reason: "connection-credential-field-visible" };
  const name = "current-preferences-failure.png";
  const path = context.pathInArtifacts(name);
  try {
    await page.screenshot({ path, timeout: 5_000 });
    await chmod(path, 0o600);
    return { status: "captured", name };
  } catch (error) {
    await unlink(path).catch(() => {});
    return { status: "failed", errorName: error?.name === "TimeoutError" ? "TimeoutError" : "ScreenshotError" };
  }
}

async function exerciseCurrent(context, chromium, currentBuild, sourceBefore) {
  let stage = "gateway-start";
  let page = null;
  let browserContext = null;
  let connectionComplete = false;
  let pageErrorCount = 0;
  try {
    const { gateway } = await makeOwnedGateway(context, "current-local-preferences", currentBuild.webRoot);
    stage = "browser-context";
    browserContext = await chromium.browser.newContext({
      locale: "zh-CN", colorScheme: "light", deviceScaleFactor: 2, viewport: { width: 390, height: 844 },
    });
    stage = "page-create";
    page = await browserContext.newPage();
    const sessionReceipts = [];
    const rpc = createRpcObserver(page);
    page.on("pageerror", () => { pageErrorCount += 1; });
    page.on("response", response => {
      if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/mobile/session")
        sessionReceipts.push(response.status());
    });
    stage = "install-write-fault";
    await installPreferenceWriteFault(page);
    stage = "gateway-connect";
    await connectToSettings(page, gateway, sessionReceipts);
    connectionComplete = true;
    stage = "seed-preferences";
    const savedBeforeFailure = await setInitialPreferences(page);
    const unrelatedKeysBefore = await readUnrelatedLocalStorageKeySet(page);
    rpc.enable();
    await page.evaluate(() => { window.__kcoderLocalPreferenceWriteFault.enabled = true; });

    stage = "appearance-write-failure";
    await chooseAppearance(page, "theme", "light");
    const firstAppearanceError = await assertCurrentPreferenceError(page, "appearance-preferences", "zh-CN");
    const firstAppearanceErrorCopy = await firstAppearanceError.locator('[role="alert"]').innerText();
    await chooseAppearance(page, "language", "en");
    await assertCurrentPreferenceError(page, "appearance-preferences", "en");
    await waitForRejectedWrites(page, 2);
    assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), "light");
    assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
    assert.ok(sameValues(await readPreferenceProjection(page), savedBeforeFailure),
      "current selection must be immediate in memory while failed storage writes leave the saved blob unchanged");

    stage = "appearance-failure-matrix";
    const appearanceMatrix = await captureAppearanceFailureMatrix(page, context, "after", true);
    const finalAppearance = { theme: "dark", language: "en", terminalScrollbackLines: 10_000 };
    await waitForRejectedWrites(page, 10);
    assert.ok(sameValues(await readPreferenceProjection(page), savedBeforeFailure),
      "all injected failures must leave the previously persisted preferences intact");
    const appearanceRejectedWrites = await page.evaluate(() => window.__kcoderLocalPreferenceWriteFault.rejectedWrites);
    stage = "appearance-retry";
    await page.evaluate(() => { window.__kcoderLocalPreferenceWriteFault.enabled = false; });
    await page.locator('[data-testid="appearance-preferences-write-retry"]:visible').click();
    await waitForStoredPreferences(page, finalAppearance);
    await page.locator('[data-testid="appearance-preferences-write-error"]').waitFor({ state: "hidden", timeout: 10_000 });
    const afterAppearanceRetry = await readPreferenceProjection(page);
    assert.ok(sameValues(afterAppearanceRetry, finalAppearance),
      "Appearance retry must persist the latest theme and language selection");
    await assertLocalStorageProfileKeysPreserved(page, unrelatedKeysBefore);
    const appearanceRetryScreenshot = await captureLooseScreenshot(page, context, 390, 844,
      "after-appearance-write-retry-390-en-dark.png");
    stage = "appearance-reload";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="settings-appearance-screen"]:visible').waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), "dark");
    assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
    await page.locator('[data-testid="appearance-preferences-write-error"]').waitFor({ state: "hidden" });
    assert.ok(sameValues(await readPreferenceProjection(page), finalAppearance));
    const appearanceReloadScreenshot = await captureLooseScreenshot(page, context, 390, 844,
      "after-appearance-reload-390-en-dark.png");

    stage = "open-terminal-settings";
    await page.locator('[data-testid="settings-detail-back"]:visible').click();
    await page.locator('[data-testid="settings-home"]:visible').waitFor({ state: "visible" });
    await page.locator('[data-testid="terminal-settings"]:visible').click();
    await page.locator('[data-testid="settings-terminal-screen"]:visible').waitFor({ state: "visible" });
    await page.evaluate(() => { window.__kcoderLocalPreferenceWriteFault.enabled = true; });
    stage = "terminal-write-failure";
    await page.locator('[data-testid="terminal-scrollback-5000"]:visible').click();
    await assertCurrentPreferenceError(page, "terminal-preferences", "en");
    assert.equal(await page.locator('[data-testid="terminal-scrollback-5000"]').getAttribute("aria-checked"), "true");
    await page.locator('[data-testid="terminal-scrollback-100000"]:visible').click();
    await assertCurrentPreferenceError(page, "terminal-preferences", "en");
    await waitForRejectedWrites(page, 2);
    assert.equal(await page.locator('[data-testid="terminal-scrollback-5000"]').getAttribute("aria-checked"), "false");
    assert.equal(await page.locator('[data-testid="terminal-scrollback-100000"]').getAttribute("aria-checked"), "true");
    assert.equal((await readPreferenceProjection(page)).terminalScrollbackLines, 10_000,
      "terminal choices during the injected failure must not alter the persisted preference value");
    const terminalRejectedWrites = await page.evaluate(() => window.__kcoderLocalPreferenceWriteFault.rejectedWrites);
    stage = "terminal-error-layout";
    const terminalErrorScreenshots = [];
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
      const notice = page.locator('[data-testid="terminal-preferences-write-error"]:visible');
      const name = `after-terminal-write-failure-${viewport.width}-en-dark.png`;
      terminalErrorScreenshots.push(await captureErrorLayout(page, context, notice,
        viewport.width, viewport.height, name));
    }
    stage = "terminal-retry";
    await page.evaluate(() => { window.__kcoderLocalPreferenceWriteFault.enabled = false; });
    await page.locator('[data-testid="terminal-preferences-write-retry"]:visible').click();
    await waitForStoredPreferences(page, {
      theme: "dark", language: "en", terminalScrollbackLines: 100_000,
    });
    await page.locator('[data-testid="terminal-preferences-write-error"]').waitFor({ state: "hidden", timeout: 10_000 });
    const terminalRetryProjection = await readPreferenceProjection(page);
    assert.equal(terminalRetryProjection.terminalScrollbackLines, 100_000,
      "Terminal retry must persist the latest scrollback selection");
    await assertLocalStorageProfileKeysPreserved(page, unrelatedKeysBefore);
    const terminalRetryScreenshot = await captureLooseScreenshot(page, context, 390, 844,
      "after-terminal-write-retry-390-en-dark.png");
    stage = "terminal-reload";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="settings-terminal-screen"]:visible').waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.locator('[data-testid="terminal-scrollback-100000"]').getAttribute("aria-checked"), "true");
    await page.locator('[data-testid="terminal-preferences-write-error"]').waitFor({ state: "hidden" });
    const terminalReloadProjection = await readPreferenceProjection(page);
    assert.equal(terminalReloadProjection.terminalScrollbackLines, 100_000);
    assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), "dark");
    assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
    const terminalReloadScreenshot = await captureLooseScreenshot(page, context, 390, 844,
      "after-terminal-reload-390-en-dark.png");

    stage = "postflight";
    const rpcResult = rpc.result();
    assert.deepEqual(rpcResult.targetWriteMethods, [], "local preference edits must not issue target configuration write RPCs");
    assert.equal(pageErrorCount, 0, "preference fault recovery must not produce browser page errors");
    const currentMobileSourceShaAtEnd = await fingerprintRegularTree(sourceRoot);
    assert.deepEqual(currentMobileSourceShaAtEnd, sourceBefore,
      "Mobile source must remain unchanged during the browser acceptance");
    return {
      status: "passed",
      sessionExchangeOk: true,
      savedBeforeFailure,
      savedDuringAppearanceFailure: savedBeforeFailure,
      afterAppearanceRetry,
      terminalRetryProjection,
      terminalReloadProjection,
      appearanceRejectedWrites,
      terminalRejectedWrites,
      rejectedPreferenceWrites: appearanceRejectedWrites + terminalRejectedWrites,
      preferenceKey: PREFERENCES_KEY,
      unrelatedLocalStorageKeyCount: unrelatedKeysBefore.count,
      unrelatedLocalStorageKeySetSha256: unrelatedKeysBefore.namesSha256,
      unrelatedLocalStorageKeysPreserved: true,
      pageErrorCount,
      settingsFlowRpcMethods: rpcResult.methods,
      targetWriteMethods: rpcResult.targetWriteMethods,
      appearanceMatrix,
      firstAppearanceErrorCopy,
      appearanceRetryScreenshot,
      appearanceReloadScreenshot,
      terminalErrorScreenshots,
      terminalRetryScreenshot,
      terminalReloadScreenshot,
      nativeValidation: false,
      serverConfigurationEditingExercised: false,
      modelRequestIssuedByTest: false,
      currentMobileSourceSha256: currentMobileSourceShaAtEnd.digest,
    };
  } catch (error) {
    const pathname = page
      ? (() => { try { return new URL(page.url()).pathname; } catch { return null; } })()
      : null;
    const visibleErrorRetryCounts = {
      appearanceError: await safeVisibleCount(page, '[data-testid="appearance-preferences-write-error"]:visible'),
      appearanceRetry: await safeVisibleCount(page, '[data-testid="appearance-preferences-write-retry"]:visible'),
      terminalError: await safeVisibleCount(page, '[data-testid="terminal-preferences-write-error"]:visible'),
      terminalRetry: await safeVisibleCount(page, '[data-testid="terminal-preferences-write-retry"]:visible'),
    };
    const preferenceProjection = connectionComplete && page
      ? await readPreferenceProjection(page).catch(() => null)
      : null;
    let browserVersion = null;
    try { browserVersion = chromium.browser.version(); } catch { /* Browser may not have initialized. */ }
    const screenshot = await captureCurrentFailureScreenshot(page, context, connectionComplete)
      .catch(() => ({ status: "failed", errorName: "ScreenshotCaptureError" }));
    const failureSample = {
      schemaVersion: 1,
      stage,
      pathname,
      runtime: { nodeVersion: process.version, browserVersion },
      pageErrorCount,
      visibleErrorRetryCounts,
      preferenceProjection,
      screenshot,
      error: safeFailureSummary(context, error),
    };
    await context.writeArtifactJson("current-preferences-failure-sample.json", failureSample).catch(() => {});
    throw error;
  } finally {
    await browserContext?.close().catch(() => {});
  }
}

async function assertLocalStorageProfileKeysPreserved(page, expectedKeys) {
  const actualKeys = await readUnrelatedLocalStorageKeySet(page);
  assert.ok(sameLocalStorageKeySet(actualKeys, expectedKeys),
    "preference recovery must not remove any other origin localStorage keys");
}

const currentBuild = await inspectMobileWebRoot(currentWebRoot, expectedCurrentManifestSha256);
const currentMobileSourceAtBuild = await fingerprintRegularTree(sourceRoot);
assert.deepEqual(currentMobileSourceAtBuild, currentMobileSourceShaAtStart,
  "Mobile source must remain stable before the manual browser run");
const currentSidecar = JSON.parse(await readFile(resolve(dirname(currentWebRoot), "mobile-source-before.json"), "utf8"));
assert.deepEqual(currentSidecar, currentMobileSourceShaAtStart,
  "current Mobile builder output must bind the exact current source tree");

let baselineBuild = null;
let baselineInputStatus = { status: "not-provided" };
if (baselineWebRoot) {
  try {
    baselineBuild = await inspectMobileWebRoot(baselineWebRoot, BASELINE_MANIFEST_SHA256, BASELINE_SOURCE_SHA256);
    baselineInputStatus = { status: "pinned", ...baselineBuild };
  } catch (error) {
    baselineInputStatus = {
      status: "rejected",
      errorClass: error?.name === "AssertionError" ? "pin-or-input-mismatch" : error?.name ?? "Error",
    };
  }
}

await runE2E(import.meta.url, {
  testId: "mobile-local-preferences-write-feedback-manual-browser",
  tier: "manual-live",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  modelPolicy: "real Mobile Web and owned authenticated Gateway; local preference-key fault injection only; no target configuration write or model request",
}, async context => {
  const chromium = await startChromium(context, {
    label: "local-preferences-chromium",
    noSandbox: true,
    startTimeoutMs: 60_000,
  });
  const baseline = await exerciseBaseline(context, chromium, baselineBuild);
  const current = await exerciseCurrent(context, chromium, currentBuild, currentMobileSourceShaAtStart);
  const evidence = {
    schemaVersion: 1,
    status: current.status === "passed" ? "passed" : "failed",
    currentBuild,
    baselineInput: baselineInputStatus,
    baseline,
    current,
    storageFault: {
      boundary: "Storage.prototype.setItem",
      exactKey: PREFERENCES_KEY,
      failure: "QuotaExceededError",
      nonPreferenceLocalStorageKeyNamesReturned: false,
      nonPreferenceLocalStorageValuesReadByTest: false,
      profileCredentialValuesReadByTest: false,
      localStorageClearCalled: false,
    },
  };
  await context.writeArtifactJson("mobile-local-preferences-feedback-evidence.json", evidence);
  assert.equal(current.status, "passed", "current preference feedback and retry flow must pass");
  return evidence;
});
