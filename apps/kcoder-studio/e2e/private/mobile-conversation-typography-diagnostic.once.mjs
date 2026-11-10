import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../harness/owned-executable-provenance.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import {
  fingerprintRegularFile,
  fingerprintRegularTree,
  fingerprintSharedAssets,
} from "../harness/settings-fingerprints.mjs";

const configuredWebRoot = process.env.KCODER_E2E_SETTINGS_WEB_ROOT;
const buildResultPath = process.env.KCODER_E2E_TYPOGRAPHY_MOBILE_BUILD_RESULT ||
  (configuredWebRoot ? resolve(dirname(configuredWebRoot), "result.json") : null);
const configuredBinary = process.env.KCODER_E2E_KCODER_BIN;
const expectedBinarySha256 = process.env.KCODER_E2E_SETTINGS_KCODER_SHA256;
const preferencesKey = "kcoder-studio:mobile-app-preferences:v1";
const initialPrompt =
  "首段中文 English wraps at 320px.\n\n第二段中文字体验证。\n\n- 列表一\n- 列表二\n\n1. 顺序一\n2. 顺序二\n\n|项|值|\n|---|---|\n|中文|字体|\n\n**粗体中文** `mono_code`";
const assistantMarker = "thinking preview complete";
const expectedFontFiles = [
  {
    path: "fonts/noto-sans-sc/NotoSansSC-Regular.otf",
    sha256: "faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9",
    family: "Noto Sans SC",
    weight: "400",
    acceptedCssWeights: ["400", "normal"],
  },
  {
    path: "fonts/noto-sans-sc/NotoSansSC-Bold.otf",
    sha256: "c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0",
    family: "Noto Sans SC Bold",
    weight: "400",
    acceptedCssWeights: ["400", "normal"],
    sourceStyle: "Bold",
  },
];
const lineHeightByChoice = { compact: 25, snug: 26, normal: 28, relaxed: 31, airy: 35 };
const spacingByChoice = { compact: 8, normal: 12, relaxed: 18 };
const letterSpacingByChoice = { compact: 0, normal: 0.2, relaxed: 0.6 };

assert.ok(
  typeof buildResultPath === "string" && isAbsolute(buildResultPath),
  "set KCODER_E2E_SETTINGS_WEB_ROOT to the absolute Mobile product-build output, or KCODER_E2E_TYPOGRAPHY_MOBILE_BUILD_RESULT to its artifacts/result.json",
);
assert.ok(typeof configuredBinary === "string" && isAbsolute(configuredBinary),
  "KCODER_E2E_KCODER_BIN must identify the selected app-server binary");
assert.match(expectedBinarySha256 ?? "", /^[a-f0-9]{64}$/,
  "KCODER_E2E_SETTINGS_KCODER_SHA256 must pin the selected app-server binary");
assert.ok(Array.from(initialPrompt).length <= 120,
  "the typography fixture must remain intact in the deterministic thinking-preview response");

await runE2E(import.meta.url, {
  testId: "mobile-conversation-typography-diagnostic",
  tier: "manual-live",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  modelPolicy: "model-independent Mobile Markdown reading preferences through an owned Gateway and deterministic thinking-preview app-server scenario; no live account or Provider request",
}, async context => {
  let stage = "verify-prebuilt-inputs";
  const webRoot = await verifyPrebuiltInputs(buildResultPath);
  if (configuredWebRoot) assert.equal(resolve(configuredWebRoot), webRoot.path,
    "KCODER_E2E_SETTINGS_WEB_ROOT must match the completed Mobile builder result");
  const sourceFontDigests = Object.fromEntries(expectedFontFiles.map(file => [file.path, file.sha256]));
  const gatewayMobileStaticSourceBefore = await fingerprintRegularFile(resolve(appRoot, "src"), "mobile-web-static.js");

  const configuredBinaryBefore = await hashExecutableFile(configuredBinary);
  assert.equal(configuredBinaryBefore.sha256, expectedBinarySha256,
    "selected app-server binary must match the explicit SHA-256 pin");
  const ownedBinDir = context.pathInState("bin");
  await mkdir(ownedBinDir, { recursive: true, mode: 0o700 });
  const ownedBinary = resolve(ownedBinDir, "kcoder");
  await copyFile(configuredBinary, ownedBinary);
  await chmod(ownedBinary, 0o700);
  const [configuredBinaryAfterCopy, ownedBinaryBefore] = await Promise.all([
    hashExecutableFile(configuredBinary), hashExecutableFile(ownedBinary),
  ]);
  assert.equal(configuredBinaryAfterCopy.sha256, configuredBinaryBefore.sha256);
  assert.equal(ownedBinaryBefore.sha256, configuredBinaryBefore.sha256);

  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(resolve(workspace, "src"), { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(resolve(workspace, "src/typography-preview.txt"), "owned deterministic Markdown preview\n", "utf8");
  await context.writeStateJson("config/settings.json", {});
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Owned Mobile typography diagnostic",
    runtime: "kcoder",
    transport: "local",
    command: ownedBinary,
    workspace,
  }]);
  const gateway = await startGateway(context, {
    label: "mobile-typography-gateway",
    auth: true,
    workspace,
    serversFile,
    kcoderBin: ownedBinary,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_WEB_ROOT: webRoot.path,
      KCODER_STUDIO_MOBILE_WEB_ROOT: webRoot.path,
      KCODER_STUDIO_SCENARIO: "thinking-preview",
    },
  });
  const chromium = await startChromium(context, {
    label: "mobile-typography-chromium",
    noSandbox: true,
    startTimeoutMs: 60_000,
  });
  const browserContext = await chromium.browser.newContext({
    locale: "zh-CN",
    colorScheme: "light",
    deviceScaleFactor: 2,
    viewport: { width: 390, height: 844 },
  });
  context.addCleanup("close Mobile typography Chromium context", () => browserContext.close());
  const page = await browserContext.newPage();
  const cdp = await browserContext.newCDPSession(page);
  context.addCleanup("detach Mobile typography CDP session", () => cdp.detach());
  await Promise.all([cdp.send("DOM.enable"), cdp.send("CSS.enable")]);

  const pageErrors = [];
  const fontRequests = [];
  const fontResponses = [];
  const gatewayPathReloadChecks = [];
  const failureScreenshotPath = context.pathInArtifacts("failure-stage.png");
  const failureStagePath = context.pathInArtifacts("failure-stage.json");
  const successfulTurnStarts = captureTurnStart(page, gateway.wsUrl);
  const baseOrigin = new URL(gateway.baseUrl).origin;
  page.on("pageerror", error => pageErrors.push(String(error.message).slice(0, 240)));
  page.on("console", message => {
    if (message.type() === "error") pageErrors.push(String(message.text()).slice(0, 240));
  });
  page.on("request", request => {
    if (!isFontRequest(request.url(), request.resourceType())) return;
    const url = safeUrl(request.url());
    fontRequests.push({
      origin: url?.origin ?? null,
      path: url?.pathname ?? null,
      resourceType: request.resourceType(),
      sameOrigin: url?.origin === baseOrigin,
    });
  });
  page.on("requestfailed", request => {
    if (!isFontRequest(request.url(), request.resourceType())) return;
    const url = safeUrl(request.url());
    fontResponses.push({
      origin: url?.origin ?? null,
      path: url?.pathname ?? null,
      status: null,
      sha256: null,
      error: String(request.failure()?.errorText ?? "font request failed").slice(0, 120),
    });
  });
  page.on("response", response => {
    const request = response.request();
    if (!isFontRequest(response.url(), request.resourceType())) return;
    const url = safeUrl(response.url());
    if (response.status() !== 200) {
      fontResponses.push({
        origin: url?.origin ?? null,
        path: url?.pathname ?? null,
        status: response.status(),
        sha256: null,
        error: null,
      });
      return;
    }
    void response.body().then(bytes => {
      fontResponses.push({
        origin: url?.origin ?? null,
        path: url?.pathname ?? null,
        status: response.status(),
        size: bytes.length,
        sha256: sha256(bytes),
        error: null,
      });
    }).catch(error => {
      const url = safeUrl(response.url());
      fontResponses.push({
        origin: url?.origin ?? null,
        path: url?.pathname ?? null,
        status: response.status(),
        sha256: null,
        error: String(error?.name ?? "font response read failed"),
      });
    });
  });
  context.addCleanup("retain safe Mobile typography failure stage", async () => {
    if (stage === "complete") return;
    await page.screenshot({ path: failureScreenshotPath, timeout: 10_000 }).catch(() => {});
    await chmod(failureScreenshotPath, 0o600).catch(() => {});
    const visibleTestIds = await page.locator("[data-testid]:visible").evaluateAll(nodes =>
      nodes.map(node => node.getAttribute("data-testid")).filter(Boolean).slice(0, 100),
    ).catch(() => []);
    const assistant = page.getByTestId("message-assistant").filter({ hasText: assistantMarker }).last();
    const readingStyle = await inspectReadingStyle(page, assistant).catch(error => ({ error: error?.name ?? "style inspection failed" }));
    const preferences = await readPreferences(page).catch(() => null);
    await writeFile(failureStagePath, JSON.stringify({
      stage,
      path: safeUrl(page.url())?.pathname ?? null,
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null),
      visibleTestIds,
      preferences,
      readingStyle,
      pageErrors,
      fontRequests,
      fontResponses,
      gatewayMobileStaticSourceDigest: gatewayMobileStaticSourceBefore.digest,
      gatewayPathReloadChecks,
      credentialsIncluded: false,
    }, null, 2), { mode: 0o600 });
  });

  stage = "pair-owned-mobile-gateway";
  await pairMobile(page, gateway);
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  stage = "hard-reload-dotted-profile-home-route";
  const homeUrl = new URL(page.url());
  const homeRouteMatch = homeUrl.pathname.match(/^\/mobile\/h\/([^/]+)\/?$/);
  assert.ok(homeRouteMatch, `paired Mobile must land on its host home route: ${homeUrl.pathname}`);
  const profileId = decodeURIComponent(homeRouteMatch[1]);
  const expectedOriginId = new URL(gateway.baseUrl).origin.replace(/[^A-Za-z0-9._-]/g, "-");
  assert.ok(profileId.startsWith(`${expectedOriginId}-2f-`), "host route profile ID must be derived from this owned 127.0.0.1 Gateway origin");
  assert.ok(profileId.includes("127.0.0.1") && profileId.includes("."), "host route profile ID must retain the dotted loopback address");
  const homeReloadResponse = await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(homeReloadResponse?.status(), 200, "hard-reloading the dotted host route must return HTTP 200");
  const homeContentType = homeReloadResponse?.headers()["content-type"] ?? "";
  assert.match(homeContentType, /^text\/html(?:;|$)/i, "hard-reloading the dotted host route must serve the Mobile HTML shell");
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 45_000 });
  await page.getByTestId("sessions").waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(new URL(page.url()).pathname, homeUrl.pathname, "host-home reload must keep the dotted profile route");
  gatewayPathReloadChecks.push({
    kind: "host-home",
    path: homeUrl.pathname,
    profileIdContainsDottedLoopback: true,
    httpStatus: homeReloadResponse.status(),
    contentType: homeContentType,
    dom: { newWorkspaceVisible: true, sessionsVisible: true },
  });

  stage = "create-deterministic-markdown-turn";
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("new-workspace-prompt").fill(initialPrompt);
  await page.getByTestId("create-workspace").click();
  const assistant = page.getByTestId("message-assistant").filter({ hasText: assistantMarker }).last();
  await assistant.waitFor({ state: "visible", timeout: 60_000 });
  await assistant.getByText("首段中文", { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
  await assistant.getByText("mono_code", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const turnReceipt = await waitFor(
    () => successfulTurnStarts.find(turn => turn.responseOk),
    10_000,
    "successful turn/start receipt from the isolated real app-server",
    50,
    context.abortSignal,
  );
  assert.equal(successfulTurnStarts.length, 1, "the diagnostic sends one and only one deterministic turn");
  assert.ok(turnReceipt.promptContainsTypographyProbe, "the real turn/start frame must carry the Markdown fixture");
  stage = "hard-reload-dotted-profile-task-route";
  const taskUrl = new URL(page.url());
  const taskRouteMatch = taskUrl.pathname.match(/^\/mobile\/h\/([^/]+)\/task\/([^/]+)\/([^/]+)\/?$/);
  assert.ok(taskRouteMatch, `created task must use the Mobile dynamic task route: ${taskUrl.pathname}`);
  assert.equal(decodeURIComponent(taskRouteMatch[1]), profileId, "task route must retain the dotted loopback profile ID");
  assert.equal(decodeURIComponent(taskRouteMatch[2]), turnReceipt.serverId, "task route server segment must match the actual turn target");
  assert.ok(decodeURIComponent(taskRouteMatch[3]), "task route must contain the actual thread segment");
  const taskReloadResponse = await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(taskReloadResponse?.status(), 200, "hard-reloading the task dynamic route must return HTTP 200");
  const taskContentType = taskReloadResponse?.headers()["content-type"] ?? "";
  assert.match(taskContentType, /^text\/html(?:;|$)/i, "hard-reloading the task dynamic route must serve the Mobile HTML shell");
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 45_000 });
  await page.getByTestId("message-assistant").filter({ hasText: assistantMarker }).last().waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(new URL(page.url()).pathname, taskUrl.pathname, "task reload must keep the same profile/server/thread route");
  gatewayPathReloadChecks.push({
    kind: "task",
    path: taskUrl.pathname,
    profileIdContainsDottedLoopback: true,
    serverSegmentMatchesTurnTarget: true,
    threadSegmentPresent: true,
    httpStatus: taskReloadResponse.status(),
    contentType: taskContentType,
    dom: { messageInputVisible: true, assistantFixtureVisible: true },
  });

  stage = "exercise-spacing-preferences-through-settings-ui";
  const preferenceChecks = [];
  const selectionCases = [
    ...Object.keys(lineHeightByChoice).map(value => ({ kind: "line-spacing", value, field: "conversationLineSpacing", metric: "lineHeight" })),
    ...Object.keys(spacingByChoice).map(value => ({ kind: "block-spacing", value, field: "conversationBlockSpacing", metric: "blockGap" })),
    ...Object.keys(letterSpacingByChoice).map(value => ({ kind: "letter-spacing", value, field: "conversationLetterSpacing", metric: "letterSpacing" })),
    { kind: "font-family", value: "system", field: "conversationFontFamily", metric: "system-font" },
    { kind: "font-family", value: "noto-sans-sc", field: "conversationFontFamily", metric: "noto-font" },
  ];
  for (const selection of selectionCases) {
    await enterConversationPreferences(page);
    await selectConversationPreference(page, selection.kind, selection.value, selection.field);
    await leaveSettingsToTask(page);
    const measured = await inspectReadingStyle(page, assistant);
    assertReadingPreference(selection, measured);
    preferenceChecks.push({ ...selection, measured });
  }

  stage = "reload-saved-preferences-and-load-local-fonts";
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 45_000 });
  await page.getByTestId("message-assistant").filter({ hasText: assistantMarker }).last().waitFor({ state: "visible", timeout: 45_000 });
  const persisted = await readPreferences(page);
  assert.equal(persisted.conversationLineSpacing, "airy");
  assert.equal(persisted.conversationBlockSpacing, "relaxed");
  assert.equal(persisted.conversationLetterSpacing, "relaxed");
  assert.equal(persisted.conversationFontFamily, "noto-sans-sc");
  assert.equal(persisted.thinkingCollapsedByDefault, true);
  await waitForLoadedFonts(page);
  await waitFor(() => fontResponses.filter(response => response.status === 200 && response.sha256).length >= expectedFontFiles.length,
    15_000, "two locally served Noto Sans SC OTF responses", 50, context.abortSignal);
  assertFontResponses(fontRequests, fontResponses, baseOrigin, expectedFontFiles);
  const documentFontFaces = await inspectDocumentFonts(page);
  assertDocumentFontFaces(documentFontFaces);

  stage = "exercise-language-theme-and-responsive-layout-matrix";
  const observations = [];
  for (const language of ["zh-CN", "en"]) {
    for (const theme of ["light", "dark"]) {
      for (const width of [320, 390]) {
        stage = `matrix-${language}-${theme}-${width}-settings`;
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: theme });
        await setAppearanceThroughSettings(page, language, theme);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 45_000 });
        const activeAssistant = page.getByTestId("message-assistant").filter({ hasText: assistantMarker }).last();
        await activeAssistant.waitFor({ state: "visible", timeout: 45_000 });
        await page.waitForFunction(expected => document.documentElement.lang === expected, language, { timeout: 15_000 });
        await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, theme, { timeout: 15_000 });
        assert.deepEqual(await readPreferences(page), {
          ...persisted,
          language,
          theme,
        }, "actual Appearance Settings choices must survive a full task-page reload");
        await waitForLoadedFonts(page);
        const currentBody = markdownBody(activeAssistant);
        await currentBody.waitFor({ state: "visible", timeout: 15_000 });
        const layout = await inspectMarkdownLayout(currentBody, {
          width,
          language,
          theme,
          expectedLineHeight: lineHeightByChoice.airy,
          expectedBlockGap: spacingByChoice.relaxed,
          expectedLetterSpacing: letterSpacingByChoice.relaxed,
        });
        const cjkFontEvidence = await assertPlatformCjkFonts(cdp);
        assertSegmentGeometryGap(layout.segmentChildren, spacingByChoice.relaxed,
          `${width}px ${language}/${theme} collapsed processing card`);
        assert.equal(await hasHorizontalOverflow(page), false,
          `${width}px ${language}/${theme} conversation must not overflow horizontally`);

        const group = activeAssistant.locator('[data-testid^="ordered-message-processing-"]:not([data-testid$="-toggle"]):not([data-testid$="-details"])');
        assert.equal(await group.count(), 1, "the deterministic thinking preview must render one processing card");
        const groupId = await group.getAttribute("data-testid");
        const groupToggle = activeAssistant.getByTestId(`${groupId}-toggle`);
        assert.equal(await groupToggle.getAttribute("aria-expanded"), "false",
          "the processing card must start collapsed under the saved default preference");
        const details = activeAssistant.getByTestId(`${groupId}-details`);
        assert.equal(await details.count(), 0, "collapsed processing content must not be mounted");
        const collapsedScreenshot = `typography-${language}-${theme}-${width}-collapsed.png`;
        await saveScreenshot(context, activeAssistant, collapsedScreenshot);

        stage = `matrix-${language}-${theme}-${width}-expanded-thinking`;
        await groupToggle.click();
        assert.equal(await groupToggle.getAttribute("aria-expanded"), "true");
        await details.waitFor({ state: "visible", timeout: 10_000 });
        const thoughtToggle = details.locator('[data-testid^="ordered-message-segment-thinking-"][data-testid$="-toggle"]');
        assert.equal(await thoughtToggle.count(), 1, "expanded processing card must contain the actual thinking disclosure");
        assert.equal(await thoughtToggle.getAttribute("aria-expanded"), "false");
        await thoughtToggle.click();
        assert.equal(await thoughtToggle.getAttribute("aria-expanded"), "true");
        const thought = details.locator('[data-testid^="ordered-message-segment-thinking-"]:not([data-testid$="-toggle"]):not([data-testid$="-content"])');
        const thoughtBody = thought.getByTestId("conversation-markdown-body");
        await thoughtBody.waitFor({ state: "visible", timeout: 10_000 });
        const thoughtStyle = await inspectParagraphTextStyle(thoughtBody.locator('[data-testid="conversation-markdown-paragraph"]').first());
        assert.equal(thoughtStyle.lineHeight, `${lineHeightByChoice.airy}px`);
        assert.equal(thoughtStyle.letterSpacing, `${letterSpacingByChoice.relaxed}px`);
        assert.match(thoughtStyle.fontFamily, /Noto Sans SC/i);
        assert.equal(await hasHorizontalOverflow(page), false,
          `${width}px ${language}/${theme} expanded thinking must not overflow horizontally`);
        const expandedSegmentChildren = await inspectSegmentChildren(activeAssistant);
        assertSegmentGeometryGap(expandedSegmentChildren, spacingByChoice.relaxed,
          `${width}px ${language}/${theme} expanded processing card`);
        const expandedScreenshot = `typography-${language}-${theme}-${width}-expanded.png`;
        await saveScreenshot(context, activeAssistant, expandedScreenshot);
        observations.push({
          width,
          language,
          theme,
          layout,
          collapsed: { ariaExpanded: "false", detailsMounted: false, screenshot: collapsedScreenshot },
          expanded: { processingExpanded: true, thinkingExpanded: true, thoughtStyle, screenshot: expandedScreenshot },
          cjkFontEvidence,
        });
        await groupToggle.click();
        assert.equal(await groupToggle.getAttribute("aria-expanded"), "false");
      }
    }
  }
  assert.equal(observations.length, 8, "all 320/390 × zh/en × light/dark combinations must be observed");

  stage = "restore-default-reading-layout-and-capture-reference";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await enterConversationPreferences(page);
  for (const [kind, value, field] of [
    ["line-spacing", "normal", "conversationLineSpacing"],
    ["block-spacing", "normal", "conversationBlockSpacing"],
    ["letter-spacing", "normal", "conversationLetterSpacing"],
    ["font-family", "noto-sans-sc", "conversationFontFamily"],
  ]) {
    await selectConversationPreference(page, kind, value, field);
  }
  await leaveSettingsToTask(page);
  await setAppearanceThroughSettings(page, "zh-CN", "light");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 45_000 });
  const defaultAssistant = page.getByTestId("message-assistant").filter({ hasText: assistantMarker }).last();
  await defaultAssistant.waitFor({ state: "visible", timeout: 45_000 });
  await waitForLoadedFonts(page);
  const defaultPreferences = await readPreferences(page);
  assert.deepEqual({
    conversationLineSpacing: defaultPreferences.conversationLineSpacing,
    conversationBlockSpacing: defaultPreferences.conversationBlockSpacing,
    conversationLetterSpacing: defaultPreferences.conversationLetterSpacing,
    conversationFontFamily: defaultPreferences.conversationFontFamily,
    language: defaultPreferences.language,
    theme: defaultPreferences.theme,
  }, {
    conversationLineSpacing: "normal",
    conversationBlockSpacing: "normal",
    conversationLetterSpacing: "normal",
    conversationFontFamily: "noto-sans-sc",
    language: "zh-CN",
    theme: "light",
  }, "default-reading reference preferences must be saved through real Settings controls and survive reload");
  const defaultLayout = await inspectMarkdownLayout(markdownBody(defaultAssistant), {
    width: 390,
    language: "zh-CN",
    theme: "light",
    expectedLineHeight: lineHeightByChoice.normal,
    expectedBlockGap: spacingByChoice.normal,
    expectedLetterSpacing: letterSpacingByChoice.normal,
  });
  const defaultCjkFontEvidence = await assertPlatformCjkFonts(cdp);
  assertSegmentGeometryGap(defaultLayout.segmentChildren, spacingByChoice.normal,
    "390px zh-CN/light default collapsed processing card");
  const defaultScreenshot = "default-reading-390-zh-light.png";
  await saveScreenshot(context, defaultAssistant, defaultScreenshot);

  const lateFontRecovery = await verifyLateFontRecovery({
    page,
    cdp,
    context,
    baseOrigin,
    expectedFontFiles,
    fontResponses,
    abortSignal: context.abortSignal,
    setStage: value => { stage = value; },
  });

  stage = "verify-fonts-provenance-and-owned-runtime";
  assertFontResponses(fontRequests, fontResponses, baseOrigin, expectedFontFiles);
  assert.deepEqual(pageErrors, [], "Mobile typography run must not emit page or console errors");
  const ownedAppServerProcesses = await findOwnedExecutableProcesses({
    pgid: gateway.child.pid,
    executablePath: ownedBinaryBefore.path,
  });
  assert.ok(ownedAppServerProcesses.some(process => process.sha256 === ownedBinaryBefore.sha256),
    "owned Gateway process group must contain the pinned app-server binary");
  const [configuredBinaryAtEnd, ownedBinaryAtEnd] = await Promise.all([
    hashExecutableFile(configuredBinary), hashExecutableFile(ownedBinary),
  ]);
  assert.equal(configuredBinaryAtEnd.sha256, configuredBinaryBefore.sha256);
  assert.equal(ownedBinaryAtEnd.sha256, ownedBinaryBefore.sha256);
  await verifyPrebuiltInputs(buildResultPath, webRoot.path);
  const gatewayMobileStaticSourceAfter = await fingerprintRegularFile(resolve(appRoot, "src"), "mobile-web-static.js");
  assert.deepEqual(gatewayMobileStaticSourceAfter, gatewayMobileStaticSourceBefore,
    "Gateway Mobile static route source must remain frozen throughout the browser run");

  const result = {
    schemaVersion: 1,
    modelBoundary: "deterministic thinking-preview response from the owned local app-server; no live account or Provider/model request",
    scenario: "thinking-preview",
    providerRequest: false,
    initialTurnReceipt: {
      count: successfulTurnStarts.length,
      method: "turn/start",
      serverId: turnReceipt.serverId,
      channel: "runtime",
      promptHasTypographyFixture: turnReceipt.promptContainsTypographyProbe,
      responseOk: turnReceipt.responseOk,
    },
    prebuiltMobile: webRoot.provenance,
    gatewayMobileStaticSource: gatewayMobileStaticSourceBefore,
    gatewayPathReloadChecks,
    sourceFonts: expectedFontFiles.map(file => ({ ...file })),
    sourceFontDigests,
    servedFontRequests: fontRequests,
    servedFontResponses: fontResponses,
    documentFontFaces,
    savedPreferenceChecks: preferenceChecks,
    persistedPreferencesAfterReload: {
      conversationLineSpacing: persisted.conversationLineSpacing,
      conversationBlockSpacing: persisted.conversationBlockSpacing,
      conversationLetterSpacing: persisted.conversationLetterSpacing,
      conversationFontFamily: persisted.conversationFontFamily,
      thinkingCollapsedByDefault: persisted.thinkingCollapsedByDefault,
    },
    defaultReadingReference: {
      screenshot: defaultScreenshot,
      preferences: defaultPreferences,
      layout: defaultLayout,
      cjkFontEvidence: defaultCjkFontEvidence,
      dimensions: { width: 390, language: "zh-CN", theme: "light" },
    },
    lateFontRecovery,
    matrix: { widths: [320, 390], languages: ["zh-CN", "en"], themes: ["light", "dark"], combinationCount: observations.length },
    observations,
    binary: {
      ownedPathRelativeToRun: "state/bin/kcoder",
      sha256: ownedBinaryBefore.sha256,
      processGroupId: gateway.child.pid,
      matchingOwnedProcessCount: ownedAppServerProcesses.length,
    },
    pageErrors,
    externalFontRequests: fontRequests.filter(request => !request.sameOrigin),
    nativeValidation: false,
    frozenDependencyIntegration: false,
    credentialsIncluded: false,
  };
  await context.writeArtifactJson("mobile-conversation-typography-result.json", result);
  stage = "complete";
  return result;
});

async function verifyPrebuiltInputs(resultPath, expectedOutputPath = null) {
  const parsedResult = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(parsedResult.status, "passed", "Mobile product build must have passed");
  assert.equal(parsedResult.testId, "mobile-current-product-build-diagnostic");
  assert.deepEqual(parsedResult.cleanupErrors, [], "Mobile product build cleanup must be clean");
  const result = parsedResult.result;
  assert.ok(result && typeof result.output === "string");
  const output = resolve(result.output);
  assert.equal(await realpath(output), output, "prebuilt Mobile Web root must be canonical");
  if (expectedOutputPath) assert.equal(output, expectedOutputPath, "prebuilt Mobile build output path must not change during the browser diagnostic");
  const artifacts = dirname(resultPath);
  const webRoot = { path: output, manifestSha256: result.manifestSha256, provenance: null };
  const manifestPath = resolve(output, "kcoder-mobile-web.json");
  const manifestBytes = await readFile(manifestPath);
  assert.equal(sha256(manifestBytes), result.manifestSha256, "Mobile Web manifest must match the completed builder result");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.baseToken, "/__kcoder_mobile_mount_v1__");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  assert.ok(manifest.files.some(file => file.path === "index.html"));
  const paths = new Set();
  let totalBytes = 0;
  for (const file of manifest.files) {
    assert.ok(safeRelativePath(file.path), `invalid Mobile Web manifest entry ${String(file.path)}`);
    assert.ok(!paths.has(file.path), `duplicate Mobile Web resource ${file.path}`);
    paths.add(file.path);
    assert.match(file.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 32 * 1024 * 1024);
    const path = resolve(output, file.path);
    assert.ok(path.startsWith(`${output}${sep}`));
    let cursor = output;
    for (const part of file.path.split("/")) {
      cursor = resolve(cursor, part);
      const info = await lstat(cursor);
      assert.ok(!info.isSymbolicLink(), `Mobile Web resource cannot contain symlinks: ${file.path}`);
    }
    const info = await lstat(path);
    assert.ok(info.isFile() && info.size === file.size, `Mobile Web resource size mismatch: ${file.path}`);
    assert.equal(sha256(await readFile(path)), file.sha256, `Mobile Web resource digest mismatch: ${file.path}`);
    totalBytes += file.size;
  }
  assert.ok(totalBytes <= 256 * 1024 * 1024, "Mobile Web output exceeds the existing export resource limit");

  const mobileBefore = JSON.parse(await readFile(resolve(artifacts, "mobile-source-before.json"), "utf8"));
  const mobileAfter = JSON.parse(await readFile(resolve(artifacts, "mobile-source-after.json"), "utf8"));
  assert.deepEqual(mobileAfter, mobileBefore, "Mobile source must remain unchanged throughout the product build");
  const currentMobile = await fingerprintRegularTree(resolve(appRoot, "mobile/src"));
  assert.deepEqual(currentMobile, mobileBefore, "current Mobile source must match the build's before/after fingerprint");
  for (const path of [
    "features/conversation/markdown-reading-rules.tsx",
    "features/conversation/conversation-fonts.ts",
    "components/settings/ConversationPreferencesSettings.tsx",
    "features/task/taskStyles.ts",
  ]) {
    assert.ok(mobileBefore.entries.some(entry => entry.path === path), `Mobile build source pin must include ${path}`);
  }

  const sharedBefore = JSON.parse(await readFile(resolve(artifacts, "shared-source-before.json"), "utf8"));
  const sharedAfter = JSON.parse(await readFile(resolve(artifacts, "shared-source-after.json"), "utf8"));
  assert.deepEqual(sharedAfter, sharedBefore, "shared generated contracts must remain unchanged during the Mobile build");
  assert.equal(result.sharedSourceDigest, sharedBefore.digest);
  const assetsBefore = JSON.parse(await readFile(resolve(artifacts, "shared-assets-before.json"), "utf8"));
  const assetsAfter = JSON.parse(await readFile(resolve(artifacts, "shared-assets-after.json"), "utf8"));
  assert.deepEqual(assetsAfter, assetsBefore, "shared assets must remain unchanged during the Mobile build");
  const currentAssets = await fingerprintSharedAssets(resolve(appRoot, "shared/assets"));
  assert.deepEqual(currentAssets, assetsBefore, "current shared asset tree must match the prebuilt source snapshot");
  assert.equal(result.sharedAssetsDigest, assetsBefore.digest);
  assert.equal(result.notoSansScFontSourceDigest, assetsBefore.notoSansSc.digest);
  assert.ok(Array.isArray(result.notoSansScFontSourceFiles) &&
    result.notoSansScFontSourceFiles.length >= expectedFontFiles.length);

  const sharedBeforeReading = JSON.parse(await readFile(resolve(artifacts, "shared-reading-contract-before.json"), "utf8"));
  const sharedAfterReading = JSON.parse(await readFile(resolve(artifacts, "shared-reading-contract-after.json"), "utf8"));
  assert.deepEqual(sharedAfterReading, sharedBeforeReading, "shared reading contract must remain unchanged during Mobile build");
  const currentReading = await fingerprintRegularFile(resolve(appRoot, "shared"), "conversationReading.ts");
  assert.deepEqual(currentReading, sharedBeforeReading, "current conversation reading contract must match the build snapshot");
  assert.equal(result.sharedReadingContractDigest, sharedBeforeReading.digest);

  const sourcesText = await readFile(resolve(appRoot, "shared/assets/fonts/noto-sans-sc/SOURCES.md"), "utf8");
  assert.match(sourcesText, /Sans2\.004/);
  assert.match(sourcesText, /523d033d6cb47f4a80c58a35753646f5c3608a78/);
  for (const font of expectedFontFiles) {
    const sourceEntry = assetsBefore.entries.find(entry => entry.path === font.path);
    assert.ok(sourceEntry, `shared asset fingerprint must include ${font.path}`);
    assert.equal(sourceEntry.sha256, font.sha256, `${font.path} must match its pinned official source record`);
    assert.match(sourcesText, new RegExp(font.sha256));
    assert.ok(manifest.files.some(file => file.sha256 === font.sha256), `${font.path} must be included in the exported Mobile Web manifest`);
  }
  assert.equal(result.frozenDependencyIntegration, false,
    "normal installed-dependency Mobile Web build is not frozen-dependency integration validation");

  webRoot.provenance = {
    buildResultPath: relative(repoRoot, resultPath).split(sep).join("/"),
    outputRelativeToBuildArtifacts: relative(artifacts, output).split(sep).join("/"),
    manifestSha256: result.manifestSha256,
    mobileSourceDigest: mobileBefore.digest,
    sharedGeneratedDigest: sharedBefore.digest,
    sharedAssetsDigest: assetsBefore.digest,
    notoSansScFontSourceDigest: assetsBefore.notoSansSc.digest,
    notoSansScFontSourceFiles: assetsBefore.notoSansSc.entries,
    sharedReadingContractDigest: sharedBeforeReading.digest,
    frozenDependencyIntegration: false,
  };
  return webRoot;
}

async function pairMobile(page, gateway) {
  const response = await page.goto(`${gateway.baseUrl}/login?returnTo=%2Fmobile%2F`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "Mobile login page must come from this diagnostic's owned Gateway");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function enterConversationPreferences(page) {
  const direct = page.locator('[aria-label="设置"]:visible, [aria-label="Settings"]:visible');
  const directCount = await direct.count();
  if (directCount === 1) {
    await direct.click();
  } else {
    assert.equal(directCount, 0, "active task must expose zero or one direct Settings button");
    const menu = page.locator('[aria-label="打开任务列表"]:visible, [aria-label="Open task list"]:visible, [aria-label="打开导航"]:visible, [aria-label="Open navigation"]:visible');
    assert.equal(await menu.count(), 1, "active task must expose one navigation menu button");
    await menu.click();
    const drawerSettings = page.locator('[aria-label="设置"]:visible, [aria-label="Settings"]:visible');
    assert.equal(await drawerSettings.count(), 1, "active navigation drawer must expose one Settings button");
    await drawerSettings.click();
  }
  await visibleTestId(page, "settings-home").waitFor({ state: "visible", timeout: 30_000 });
  await visibleTestId(page, "settings-section-conversation_preferences").click();
  await visibleTestId(page, "settings-section-screen").waitFor({ state: "visible", timeout: 15_000 });
  await visibleTestId(page, "conversation-preferences-settings").waitFor({ state: "visible", timeout: 15_000 });
}

async function selectConversationPreference(page, kind, value, field) {
  await visibleTestId(page, `conversation-${kind}-row`).click();
  const sheet = visibleTestId(page, `conversation-${kind}-sheet`);
  await sheet.waitFor({ state: "visible", timeout: 10_000 });
  const option = visibleTestId(page, `conversation-${kind}-choice-${value}`);
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
  await sheet.waitFor({ state: "hidden", timeout: 10_000 });
  await waitForPreference(page, { [field]: value });
}

async function leaveSettingsToTask(page) {
  await visibleTestId(page, "settings-detail-back").click();
  await visibleTestId(page, "settings-home").waitFor({ state: "visible", timeout: 15_000 });
  await visibleTestId(page, "settings-detail-back").click();
  await visibleTestId(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
}

async function setAppearanceThroughSettings(page, language, theme) {
  const direct = page.locator('[aria-label="设置"]:visible, [aria-label="Settings"]:visible');
  if (await direct.count() === 1) await direct.click();
  else {
    assert.equal(await direct.count(), 0);
    const menu = page.locator('[aria-label="打开任务列表"]:visible, [aria-label="Open task list"]:visible, [aria-label="打开导航"]:visible, [aria-label="Open navigation"]:visible');
    assert.equal(await menu.count(), 1);
    await menu.click();
    await page.locator('[aria-label="设置"]:visible, [aria-label="Settings"]:visible').click();
  }
  await visibleTestId(page, "settings-home").waitFor({ state: "visible", timeout: 30_000 });
  await visibleTestId(page, "settings-appearance").click();
  await visibleTestId(page, "settings-appearance-screen").waitFor({ state: "visible", timeout: 15_000 });
  for (const [kind, value] of [["language", language], ["theme", theme]]) {
    await visibleTestId(page, `settings-${kind}-row`).click();
    const sheet = visibleTestId(page, `settings-choice-sheet-${kind}`);
    await sheet.waitFor({ state: "visible", timeout: 10_000 });
    const optionValue = kind === "language" ? value.toLowerCase() === "zh-cn" ? "zh-cn" : value : value;
    const option = visibleTestId(page, `settings-${kind}-choice-${optionValue}`);
    await option.waitFor({ state: "visible", timeout: 10_000 });
    await option.click();
    await sheet.waitFor({ state: "hidden", timeout: 10_000 });
    await waitForPreference(page, { [kind]: value });
  }
  await page.waitForFunction(expected => document.documentElement.lang === expected, language, { timeout: 15_000 });
  await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, theme, { timeout: 15_000 });
  await visibleTestId(page, "settings-detail-back").click();
  await visibleTestId(page, "settings-home").waitFor({ state: "visible", timeout: 15_000 });
  await visibleTestId(page, "settings-detail-back").click();
  await visibleTestId(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
}

async function verifyLateFontRecovery({
  page,
  cdp,
  context,
  baseOrigin,
  expectedFontFiles,
  fontResponses,
  abortSignal,
  setStage,
}) {
  setStage("verify-seven-second-late-font-recovery");
  const taskUrl = page.url();
  const responseStartIndex = fontResponses.length;
  const intercepted = [];
  const routeTasks = [];
  const mainDocumentRequests = [];
  let openFontGate;
  let gateReleased = false;
  const fontGate = new Promise(resolveGate => { openFontGate = resolveGate; });
  const routeHandler = async route => {
    const url = safeUrl(route.request().url());
    const record = {
      origin: url?.origin ?? null,
      path: url?.pathname ?? null,
      interceptedAt: Date.now(),
      releasedAt: null,
    };
    intercepted.push(record);
    const task = (async () => {
      await fontGate;
      record.releasedAt = Date.now();
      await route.continue();
    })();
    routeTasks.push(task);
    await task;
  };
  const documentRequestListener = request => {
    if (!request.isNavigationRequest() || request.resourceType() !== "document" || request.frame() !== page.mainFrame()) return;
    mainDocumentRequests.push({ path: safeUrl(request.url())?.pathname ?? null, at: Date.now() });
  };
  const releaseGate = () => {
    if (gateReleased) return;
    gateReleased = true;
    openFontGate();
  };

  await page.route("**/*.otf", routeHandler);
  page.on("request", documentRequestListener);
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 45_000 });
    const assistant = page.getByTestId("message-assistant").filter({ hasText: assistantMarker }).last();
    await assistant.waitFor({ state: "visible", timeout: 45_000 });
    const initialDocumentRequestCount = mainDocumentRequests.length;
    await waitFor(() => intercepted.length >= expectedFontFiles.length,
      15_000, "two actual local OTF requests intercepted by the delay gate", 50, abortSignal);
    assert.ok(intercepted.every(request => request.origin === baseOrigin &&
      expectedFontFiles.some(file => request.path?.includes(file.path.split("/").at(-1).replace(/\.otf$/, "")))),
    `only the two same-origin pinned Noto fonts may enter the delay gate: ${JSON.stringify(intercepted)}`);
    const observedFontKinds = new Set(intercepted.map(request =>
      request.path?.includes("NotoSansSC-Regular") ? "Regular" : request.path?.includes("NotoSansSC-Bold") ? "Bold" : "unknown",
    ));
    assert.deepEqual([...observedFontKinds].sort(), ["Bold", "Regular"]);

    const firstInterceptAt = Math.min(...intercepted.map(request => request.interceptedAt));
    await new Promise(resolveDelay => setTimeout(resolveDelay, 7_000));
    const holdDurationMs = Date.now() - firstInterceptAt;
    assert.ok(holdDurationMs >= 7_000, `real font requests must remain gated for at least 7000ms, observed ${holdDurationMs}`);
    await enterConversationPreferences(page);
    const fallback = visibleTestId(page, "conversation-font-fallback");
    await fallback.waitFor({ state: "visible", timeout: 10_000 });
    const fallbackText = await fallback.innerText();
    const timeoutFontFaces = await inspectDocumentFonts(page);
    const documentRequestCountBeforeRelease = mainDocumentRequests.length;

    releaseGate();
    await Promise.allSettled(routeTasks);
    await fallback.waitFor({ state: "hidden", timeout: 30_000 });
    await waitForLoadedFonts(page);
    await leaveSettingsToTask(page);
    const recoveredAssistant = page.getByTestId("message-assistant").filter({ hasText: assistantMarker }).last();
    await recoveredAssistant.waitFor({ state: "visible", timeout: 20_000 });
    const recoveredFontFaces = await inspectDocumentFonts(page);
    assertDocumentFontFaces(recoveredFontFaces);
    const recoveredCjkFonts = await assertPlatformCjkFonts(cdp);
    await waitFor(() => {
      const responses = fontResponses.slice(responseStartIndex);
      return expectedFontFiles.every(file => responses.some(response => response.sha256 === file.sha256));
    }, 20_000, "real response bodies for both delayed Noto Sans SC font requests", 50, abortSignal);
    assert.equal(mainDocumentRequests.length, documentRequestCountBeforeRelease,
      "late fonts must recover live styles without a new main-document request or refresh");
    assert.equal(page.url(), taskUrl, "font recovery must leave the Mobile route unchanged");
    const screenshot = "late-font-recovered-no-refresh.png";
    await saveScreenshot(context, recoveredAssistant, screenshot);
    return {
      injectedDelayMs: 7_000,
      actualHoldDurationMs: holdDurationMs,
      requestCount: intercepted.length,
      requests: intercepted.map(({ origin, path, interceptedAt, releasedAt }) => ({
        origin,
        path,
        heldForMs: releasedAt - interceptedAt,
      })),
      fallbackVisibleBeforeRelease: true,
      fallbackText,
      fallbackClearedAfterRecovery: true,
      timeoutFontFaces,
      recoveredFontFaces,
      recoveredCjkFonts,
      initialMainDocumentRequestCount: initialDocumentRequestCount,
      mainDocumentRequestsAfterRelease: mainDocumentRequests.length - documentRequestCountBeforeRelease,
      screenshotAfter: screenshot,
      routeUnchanged: true,
      pageReloadAfterRelease: false,
    };
  } finally {
    releaseGate();
    await Promise.allSettled(routeTasks);
    await page.unroute("**/*.otf", routeHandler).catch(() => {});
    page.off("request", documentRequestListener);
  }
}

function markdownBody(assistant) {
  return assistant.getByTestId("conversation-markdown-body").filter({ hasText: "首段中文" });
}

async function inspectReadingStyle(page, assistant) {
  const body = markdownBody(assistant);
  await body.waitFor({ state: "visible", timeout: 15_000 });
  return body.evaluate(node => {
    const bodyStyle = getComputedStyle(node);
    const paragraph = node.querySelector('[data-testid="conversation-markdown-paragraph"]');
    const segment = node.closest('[data-testid="assistant-ordered-segments"]');
    const nodes = paragraph ? [paragraph, ...paragraph.querySelectorAll("*")] : [];
    const textLeaf = nodes.find(element => [...element.childNodes].some(child =>
      child.nodeType === Node.TEXT_NODE && child.textContent?.trim().length,
    ));
    if (!textLeaf) throw new Error("Markdown paragraph has no actual rendered Text leaf");
    const paragraphStyle = getComputedStyle(textLeaf);
    const segmentStyle = segment ? getComputedStyle(segment) : null;
    return {
      lineHeight: paragraphStyle.lineHeight,
      letterSpacing: paragraphStyle.letterSpacing,
      fontFamily: paragraphStyle.fontFamily,
      textLeafTag: textLeaf.tagName,
      blockGap: bodyStyle.gap,
      segmentGap: segmentStyle?.gap ?? null,
    };
  });
}

async function inspectParagraphTextStyle(paragraph) {
  return paragraph.evaluate(node => {
    const nodes = [node, ...node.querySelectorAll("*")];
    const textLeaf = nodes.find(element => [...element.childNodes].some(child =>
      child.nodeType === Node.TEXT_NODE && child.textContent?.trim().length,
    ));
    if (!textLeaf) throw new Error("Markdown paragraph has no actual rendered Text leaf");
    const style = getComputedStyle(textLeaf);
    return {
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      fontFamily: style.fontFamily,
      textLeafTag: textLeaf.tagName,
    };
  });
}

function assertReadingPreference(selection, measured) {
  if (selection.metric === "lineHeight") {
    assert.equal(measured.lineHeight, `${lineHeightByChoice[selection.value]}px`,
      `selected line-spacing ${selection.value} must change actual Markdown line height`);
  } else if (selection.metric === "blockGap") {
    assert.equal(measured.blockGap, `${spacingByChoice[selection.value]}px`,
      `selected block-spacing ${selection.value} must change the Markdown block gap`);
    assert.equal(measured.segmentGap, `${spacingByChoice[selection.value]}px`,
      `selected block-spacing ${selection.value} must also space the thinking card from assistant text`);
  } else if (selection.metric === "letterSpacing") {
    const observed = numericCssLetterSpacing(measured.letterSpacing);
    const expected = letterSpacingByChoice[selection.value];
    assert.ok(Math.abs(observed - expected) <= 0.001,
      `selected letter-spacing ${selection.value} must apply ${expected}px to actual Markdown Text; CSSOM reported ${measured.letterSpacing}`);
  } else if (selection.metric === "system-font") {
    assert.doesNotMatch(measured.fontFamily, /Noto Sans SC/i,
      "system font selection must remove the Noto Sans SC family override");
  } else {
    assert.match(measured.fontFamily, /Noto Sans SC/i,
      "Noto Sans SC selection must apply its actual family to Markdown text");
  }
}

function numericCssLetterSpacing(value) {
  if (value === "normal") return 0;
  const pixels = Number.parseFloat(value);
  assert.ok(Number.isFinite(pixels), `letter-spacing must be a CSS pixel value or normal, received ${String(value)}`);
  return pixels;
}

async function inspectMarkdownLayout(body, expected) {
  const layout = await body.evaluate((node, expectedProps) => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
    };
    const testId = element => element.getAttribute("data-testid");
    const paragraph = node.querySelector('[data-testid="conversation-markdown-paragraph"]');
    const textNodes = paragraph ? [paragraph, ...paragraph.querySelectorAll("*")] : [];
    const textLeaf = textNodes.find(element => [...element.childNodes].some(child =>
      child.nodeType === Node.TEXT_NODE && child.textContent?.trim().length,
    ));
    if (!textLeaf) throw new Error("Markdown paragraph has no actual rendered Text leaf");
    const paragraphStyle = getComputedStyle(textLeaf);
    const bodyStyle = getComputedStyle(node);
    const blocks = [...node.children].map(element => ({ id: testId(element), ...rect(element) }));
    const lists = ["bullet-list", "ordered-list"].map(name => {
      const list = node.querySelector(`[data-testid="conversation-markdown-${name}"]`);
      return list ? {
        kind: name,
        bounds: rect(list),
        items: [...list.querySelectorAll('[data-testid="conversation-markdown-list-item"]')].map(rect),
      } : null;
    });
    const table = node.querySelector('[data-testid="conversation-markdown-table"]');
    const tableRows = table ? [...table.querySelectorAll('[data-testid="conversation-markdown-table-row"]')].map(row => ({
      bounds: rect(row),
      cells: [...row.querySelectorAll('[data-testid="conversation-markdown-table-cell"]')].map(rect),
    })) : [];
    const code = node.querySelector('[data-testid="conversation-markdown-inline-code"]');
    const codeStyle = code ? getComputedStyle(code) : null;
    const segment = node.closest('[data-testid="assistant-ordered-segments"]');
    const segmentChildren = segment ? [...segment.children].map(element => ({ id: testId(element), ...rect(element) })) : [];
    const segmentGap = segment ? getComputedStyle(segment).gap : null;
    return {
      body: rect(node),
      bodyGap: bodyStyle.gap,
      lineHeight: paragraphStyle.lineHeight,
      letterSpacing: paragraphStyle.letterSpacing,
      fontFamily: paragraphStyle.fontFamily,
      textLeafTag: textLeaf.tagName,
      children: blocks,
      lists,
      table: table ? rect(table) : null,
      tableRows,
      inlineCode: code ? {
        text: code.textContent,
        fontFamily: codeStyle.fontFamily,
        letterSpacing: codeStyle.letterSpacing,
        bounds: rect(code),
      } : null,
      segmentGap,
      segmentChildren,
      rootScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      expected: expectedProps,
    };
  }, expected);
  assert.equal(layout.lineHeight, `${expected.expectedLineHeight}px`);
  const observedLetterSpacing = numericCssLetterSpacing(layout.letterSpacing);
  assert.ok(Math.abs(observedLetterSpacing - expected.expectedLetterSpacing) <= 0.001,
    `Markdown Text must use ${expected.expectedLetterSpacing}px letter spacing, CSSOM reported ${layout.letterSpacing}`);
  assert.equal(layout.bodyGap, `${expected.expectedBlockGap}px`);
  assert.equal(layout.segmentGap, `${expected.expectedBlockGap}px`);
  assert.match(layout.fontFamily, /Noto Sans SC/i);
  assert.ok(layout.children.length >= 6, "Markdown body must retain separate paragraph/list/table blocks");
  assert.ok(layout.children.every(block => block.height > 0 && block.left >= layout.body.left - 1 && block.right <= layout.body.right + 1),
    "Markdown blocks must be visible and stay inside the reading body width");
  for (let index = 1; index < layout.children.length; index += 1) {
    assert.ok(layout.children[index].top >= layout.children[index - 1].bottom - 1,
      "separate Markdown paragraphs, lists, and tables must not overlap");
    const measuredGap = layout.children[index].top - layout.children[index - 1].bottom;
    assert.ok(Math.abs(measuredGap - expected.expectedBlockGap) <= 1,
      `adjacent Markdown blocks must use one ${expected.expectedBlockGap}px gap, observed ${measuredGap}px`);
  }
  assert.equal(layout.lists.length, 2);
  assert.deepEqual(layout.lists.map(list => list.kind), ["bullet-list", "ordered-list"]);
  assert.deepEqual(layout.lists.map(list => list.items.length), [2, 2]);
  for (const list of layout.lists) {
    for (let index = 1; index < list.items.length; index += 1) {
      assert.ok(list.items[index].top >= list.items[index - 1].bottom - 1,
        `${list.kind} list items must not overlap`);
    }
  }
  assert.ok(layout.table && layout.table.width > 0);
  assert.equal(layout.tableRows.length, 2, "Markdown table must retain a header row and a body row");
  for (const row of layout.tableRows) {
    assert.equal(row.cells.length, 2, "each Markdown table row must retain both cells");
    for (let index = 1; index < row.cells.length; index += 1) {
      assert.ok(row.cells[index].left >= row.cells[index - 1].right - 1,
        "table cells must remain side-by-side without horizontal overlap");
    }
  }
  assert.ok(layout.tableRows[1].bounds.top >= layout.tableRows[0].bounds.bottom - 1,
    "Markdown table rows must not overlap vertically");
  assert.ok(layout.inlineCode && layout.inlineCode.text === "mono_code");
  assert.match(layout.inlineCode.fontFamily.toLowerCase(), /monospace/,
    "inline code must preserve a monospace family when the reading font changes");
  assert.equal(numericCssLetterSpacing(layout.inlineCode.letterSpacing), 0,
    "inline code must keep neutral letter spacing (CSSOM may serialize zero as normal)");
  assert.equal(layout.rootScrollWidth > layout.innerWidth, false,
    `${expected.width}px Mobile page must not have horizontal overflow`);
  return layout;
}

async function inspectSegmentChildren(assistant) {
  return assistant.locator('[data-testid="assistant-ordered-segments"]').evaluate(segment =>
    [...segment.children].map(element => {
      const box = element.getBoundingClientRect();
      return {
        id: element.getAttribute("data-testid"),
        top: box.top,
        bottom: box.bottom,
        height: box.height,
      };
    }),
  );
}

function assertSegmentGeometryGap(children, expectedGap, label) {
  const visibleChildren = children.filter(child => child.height > 0);
  const processingIndex = visibleChildren.findIndex(child => child.id?.startsWith("ordered-message-processing-"));
  const responseBodyIndex = visibleChildren.findIndex(child => child.id?.startsWith("ordered-message-segment-text-"));
  assert.ok(processingIndex >= 0 && responseBodyIndex >= 0,
    `${label} must expose both the processing card and assistant response segment`);
  assert.equal(responseBodyIndex, processingIndex + 1,
    `${label} processing card and response body must be adjacent transcript segments`);
  const measuredGap = visibleChildren[responseBodyIndex].top - visibleChildren[processingIndex].bottom;
  assert.ok(Math.abs(measuredGap - expectedGap) <= 1,
    `${label} must have one ${expectedGap}px card-to-body gap, observed ${measuredGap}px`);
}

async function assertPlatformCjkFonts(cdp) {
  const regularFonts = await platformFontsForMarkdown(cdp);
  assert.ok(regularFonts.some(font => /Noto Sans SC/i.test(font.familyName) && font.isCustomFont && font.glyphCount > 0),
    `Chromium must report locally loaded Noto Sans SC actually painting a pure-CJK paragraph: ${JSON.stringify(regularFonts)}`);

  const selector = '[data-testid="conversation-markdown-body"] *';
  const expectedText = "粗体中文";
  const expression = textLeafExpression(selector, expectedText);
  await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const styleResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => { const node = ${expression}; return node ? getComputedStyle(node).fontFamily : null; })()`,
    returnByValue: true,
  });
  assert.match(styleResult.result.value ?? "", /Noto Sans SC Bold/i,
    "the rendered strong CJK leaf must select the separately registered Bold family");
  const boldFonts = await platformFontsForTextLeaf(cdp, selector, expectedText, "strong CJK Markdown Text leaf");
  assert.ok(boldFonts.some(font => /Noto Sans SC/i.test(font.familyName) &&
    font.postScriptName === "NotoSansSC-Bold" && font.isCustomFont && font.glyphCount > 0),
    `Chromium must report the locally loaded Bold OTF actually painting the strong CJK leaf: ${JSON.stringify(boldFonts)}`);
  return { regularCjk: regularFonts, boldCjk: boldFonts, boldCssFamily: styleResult.result.value };
}

async function platformFontsForMarkdown(cdp) {
  return platformFontsForTextLeaf(
    cdp,
    '[data-testid="conversation-markdown-paragraph"]',
    "第二段中文字体验证。",
    "pure-CJK Markdown paragraph",
  );
}

async function platformFontsForTextLeaf(cdp, selector, text, label) {
  await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: textLeafExpression(selector, text),
    returnByValue: false,
  });
  assert.ok(result.objectId, `the ${label} must exist as an actual rendered Text leaf`);
  try {
    const { nodeId } = await cdp.send("DOM.requestNode", { objectId: result.objectId });
    const response = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return response.fonts.map(font => ({
      familyName: font.familyName,
      postScriptName: font.postScriptName,
      isCustomFont: font.isCustomFont,
      glyphCount: font.glyphCount,
    }));
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
  }
}

function textLeafExpression(selector, expectedText) {
  return `(() => {
    const expected = ${JSON.stringify(expectedText)};
    const containers = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter(node => node.textContent?.trim() === expected);
    for (const container of containers) {
      const candidates = [container, ...container.querySelectorAll("*")];
      const leaf = candidates.find(node => [...node.childNodes].some(child =>
        child.nodeType === Node.TEXT_NODE && child.textContent?.trim() === expected,
      ));
      if (leaf) return leaf;
    }
    return null;
  })()`;
}

async function waitForLoadedFonts(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const faces = [...document.fonts];
    return faces.some(face => face.family.replaceAll('"', "") === "Noto Sans SC" && face.status === "loaded") &&
      faces.some(face => face.family.replaceAll('"', "") === "Noto Sans SC Bold" && face.status === "loaded") &&
      document.fonts.check('17px "Noto Sans SC"', "中文阅读") &&
      document.fonts.check('17px "Noto Sans SC Bold"', "粗体中文");
  }, null, { timeout: 30_000 });
}

async function inspectDocumentFonts(page) {
  return page.evaluate(() => [...document.fonts].map(face => ({
    family: face.family.replaceAll('"', ""),
    status: face.status,
    weight: face.weight,
  })).filter(face => face.family.startsWith("Noto Sans SC")));
}

function assertDocumentFontFaces(faces) {
  for (const expected of expectedFontFiles) {
    assert.ok(faces.some(face => face.family === expected.family && face.status === "loaded" && expected.acceptedCssWeights.includes(face.weight)),
      `document.fonts must have the loaded ${expected.family} face with a normal/400 CSS weight: ${JSON.stringify(faces)}`);
  }
}

function assertFontResponses(requests, responses, expectedOrigin, fonts) {
  assert.ok(requests.length >= fonts.length, "both local font resources must make real browser requests");
  assert.ok(requests.every(request => request.sameOrigin && request.origin === expectedOrigin),
    `all font requests must stay on the owned Gateway origin: ${JSON.stringify(requests)}`);
  assert.ok(responses.every(response => response.origin === expectedOrigin &&
    (response.status === 200 ? Boolean(response.sha256) : response.status === 304 && response.error === null)),
    `all font responses must be successful same-origin resources: ${JSON.stringify(responses)}`);
  for (const expected of fonts) {
    assert.ok(requests.some(request => request.path?.endsWith(expected.path.split("/").at(-1)) || request.resourceType === "font"),
      `browser must request ${expected.family}`);
    assert.ok(responses.some(response => response.status === 200 && response.sha256 === expected.sha256),
      `served ${expected.family} bytes must match the pinned source SHA`);
  }
  const responseDigests = new Set(responses.filter(response => response.status === 200).map(response => response.sha256));
  assert.deepEqual([...responseDigests].sort(), fonts.map(font => font.sha256).sort(),
    "browser must load exactly the pinned Regular and Bold font files");
}

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth);
}

async function saveScreenshot(context, locator, name) {
  const path = context.pathInArtifacts(name);
  await locator.screenshot({ path, timeout: 15_000, animations: "disabled" });
  await chmod(path, 0o600);
}

async function readPreferences(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), preferencesKey);
}

async function waitForPreference(page, expected) {
  await page.waitForFunction(({ key, expected: values }) => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null");
      return Object.entries(values).every(([field, value]) => stored?.[field] === value);
    } catch {
      return false;
    }
  }, { key: preferencesKey, expected }, { timeout: 15_000 });
}

function visibleTestId(page, testId) {
  return page.locator(`[data-testid=${JSON.stringify(testId)}]:visible`);
}

function captureTurnStart(page, gatewayWebSocketPrefix) {
  const records = [];
  page.on("websocket", socket => {
    let route;
    try {
      const url = new URL(socket.url());
      const gateway = new URL(gatewayWebSocketPrefix);
      route = { serverId: url.searchParams.get("server"), channel: url.searchParams.get("channel") };
      if (url.origin !== gateway.origin || url.pathname !== "/rpc" || route.serverId !== "local" || route.channel !== "runtime") return;
    } catch {
      return;
    }
    const pending = new Map();
    socket.on("framesent", ({ payload }) => {
      for (const frame of parseJsonMessages(payload)) {
        if (frame?.method !== "turn/start" || frame.id === undefined) continue;
        const input = Array.isArray(frame.params?.input)
          ? frame.params.input.filter(item => item?.type === "text").map(item => item.text ?? "").join("\n")
          : "";
        const record = {
          ...route,
          promptContainsTypographyProbe: input.includes("首段中文") && input.includes("|中文|字体|") && input.includes("mono_code"),
          responseOk: false,
        };
        records.push(record);
        pending.set(String(frame.id), record);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      for (const frame of parseJsonMessages(payload)) {
        if (frame?.id === undefined || (!Object.hasOwn(frame, "result") && !Object.hasOwn(frame, "error"))) continue;
        const record = pending.get(String(frame.id));
        if (!record) continue;
        pending.delete(String(frame.id));
        record.responseOk = !frame.error && Object.hasOwn(frame, "result");
      }
    });
  });
  return records;
}

function parseJsonMessages(payload) {
  try {
    const frame = JSON.parse(typeof payload === "string" ? payload : String(payload ?? ""));
    return Array.isArray(frame) ? frame : [frame];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

function isFontRequest(rawUrl, resourceType) {
  return resourceType === "font" || /\.(?:otf|ttf|woff2?)(?:[?#]|$)/i.test(rawUrl);
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return { origin: url.origin, pathname: url.pathname };
  } catch {
    return null;
  }
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !value.startsWith("/") && !/[\\\x00-\x20\x7f%?#]/.test(value) &&
    value.split("/").every(part => part && part !== "." && part !== ".." &&
      (!part.startsWith(".") || value === "_expo/.routes.json"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
