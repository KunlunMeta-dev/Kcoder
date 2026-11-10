import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { relative, resolve, sep } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../harness/run-context.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";

process.umask(0o077);
const execFile = promisify(execFileCallback);
const BASELINE = "1e4d816e9eb3fcf3a7a049d19d68bdae02017952";
const PREFERENCES_KEY = "kcoder-studio:mobile-app-preferences:v1";
const MOBILE_SOURCE = resolve(appRoot, "mobile");
const SHARED_SOURCE = resolve(appRoot, "shared");
const DEPENDENCIES = resolve(MOBILE_SOURCE, "node_modules");

await runE2E(import.meta.url, {
  testId: "mobile-model-capabilities-visual-diff",
  tier: "one-off-acceptance",
  retainSuccessLogs: true,
  modelPolicy: "paired baseline/current Mobile Web capture with one pinned Rust app-server binary, identical read-only fixture inputs and dependency source; no Provider or model call and no form submission",
}, async context => {
  assert.ok(process.env.KCODER_E2E_KCODER_BIN, "focused visual acceptance requires the pinned app-server binary path");
  assert.ok(process.env.KCODER_E2E_KCODER_SHA256, "focused visual acceptance requires the pinned app-server binary SHA-256");
  const head = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(head.stdout.trim(), BASELINE, "focused visual acceptance must use the declared baseline commit as HEAD");

  const baselineRoot = context.pathInState("baseline-source");
  const baselineArchive = context.pathInState("baseline-source.tar");
  await mkdir(baselineRoot, { recursive: false, mode: 0o700 });
  const archive = await execFile("git", ["archive", BASELINE, "apps/kcoder-studio/mobile", "apps/kcoder-studio/shared"], {
    cwd: repoRoot,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  await writeFile(baselineArchive, archive.stdout, { flag: "wx", mode: 0o600 });
  await execFile("tar", ["-xf", baselineArchive, "-C", baselineRoot], { maxBuffer: 8 * 1024 * 1024 });

  const before = await exportMobileWeb(context, {
    mobileRoot: resolve(baselineRoot, "apps/kcoder-studio/mobile"),
    sourceRoots: [
      { name: "mobile", path: resolve(baselineRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(baselineRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
    ],
    dependencyRoot: DEPENDENCIES,
    label: "model-capabilities-before-export",
    outputName: "model-capabilities-before-web",
    stateNamespace: "model-capabilities-before-export-state",
    timeoutMs: 10 * 60_000,
    overallTimeoutMs: 45 * 60_000,
  });
  const after = await exportMobileWeb(context, {
    mobileRoot: MOBILE_SOURCE,
    sourceRoots: [
      { name: "mobile", path: MOBILE_SOURCE, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: SHARED_SOURCE, destination: "apps/kcoder-studio/shared" },
    ],
    dependencyRoot: DEPENDENCIES,
    label: "model-capabilities-after-export",
    outputName: "model-capabilities-after-web",
    stateNamespace: "model-capabilities-after-export-state",
    timeoutMs: 10 * 60_000,
    overallTimeoutMs: 45 * 60_000,
  });

  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN);
  const workspace = context.pathInState("model-capabilities-workspace");
  const configDir = context.pathInState("model-capabilities-config");
  await mkdir(workspace, { recursive: false, mode: 0o700 });
  await mkdir(configDir, { recursive: false, mode: 0o700 });
  await writeFile(resolve(workspace, "README.md"), "# Mobile model capabilities visual fixture\n", { flag: "wx", mode: 0o600 });
  const targetSettings = await context.writeStateJson("target-settings.json", { providers: {} });
  const gatewaySettings = await context.writeStateJson("model-capabilities-config/settings.json", {});
  const gatewayCredentials = await context.writeStateJson("model-capabilities-config/credentials.json", {});
  const serversFile = await context.writeStateJson("model-capabilities-servers.json", [{
    id: "local",
    label: "Visual fixture",
    transport: "local",
    command: binary,
    workspace,
    settingsFile: targetSettings,
  }]);
  const sourceInputsHash = async () => {
    const bytes = await Promise.all([targetSettings, serversFile, gatewaySettings, gatewayCredentials].map(path => readFile(path)));
    return createHash("sha256").update(Buffer.concat(bytes)).digest("hex");
  };
  const stableFixtureHash = await sourceInputsHash();
  const binaryDigest = createHash("sha256").update(await readFile(binary)).digest("hex");
  assert.equal(binaryDigest, process.env.KCODER_E2E_KCODER_SHA256, "app-server binary must match the pinned base-source digest");

  const chromium = await startChromium(context, {
    label: "model-capabilities-mobile-web-chromium",
    startTimeoutMs: 60_000,
  });
  const errors = [];
  const browserDiagnostics = { pageErrors: [], consoleTypes: [], requests: [], responses: [] };
  const capture = async ({ webRoot, label, expectedCollapsed }) => {
    const gateway = await startGateway(context, {
      label: `model-capabilities-${label}-gateway`,
      auth: true,
      workspace,
      serversFile,
      kcoderBin: binary,
      env: {
        KCODER_CONFIG_DIR: configDir,
        XDG_CONFIG_HOME: configDir,
        KCODER_STUDIO_WEB_ROOT: webRoot,
        KCODER_STUDIO_MOBILE_WEB_ROOT: webRoot,
      },
    });
    const browserContext = await chromium.browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await browserContext.newPage();
    page.on("pageerror", error => {
      errors.push(`${label}: ${error.message}`);
      browserDiagnostics.pageErrors.push({ capture: label, name: error.name || "Error" });
    });
    page.on("console", message => browserDiagnostics.consoleTypes.push({ capture: label, type: message.type() }));
    page.on("request", request => {
      const url = new URL(request.url());
      browserDiagnostics.requests.push({ capture: label, method: request.method(), path: url.pathname });
    });
    page.on("response", response => {
      const url = new URL(response.url());
      browserDiagnostics.responses.push({ capture: label, status: response.status(), path: url.pathname });
    });
    await page.addInitScript(({ key }) => {
      localStorage.setItem(key, JSON.stringify({
        language: "zh-CN",
        theme: "light",
        terminalScrollbackLines: 10_000,
        conversationFontScale: "normal",
        conversationLineSpacing: "normal",
        conversationBlockSpacing: "normal",
        conversationLetterSpacing: "normal",
        conversationFontFamily: "noto-sans-sc",
        thinkingCollapsedByDefault: true,
        toolsCollapsedByDefault: true,
        quickPhrases: [],
      }));
    }, { key: PREFERENCES_KEY });

    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
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

    const debugPageState = async () => page.evaluate(() => ({
      pathname: location.pathname,
      title: document.title,
      visibleText: (document.body.innerText || "").slice(0, 2_000),
      visibleControls: [...document.querySelectorAll('button,[role="button"],[aria-label]')]
        .filter(node => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(0, 80)
        .map(node => ({
          tag: node.tagName,
          role: node.getAttribute("role"),
          label: node.getAttribute("aria-label"),
          testID: node.getAttribute("data-testid"),
          text: (node.innerText || "").trim().slice(0, 80),
        })),
    }));
    const writeFailureDiagnostics = async (stage) => {
      const pageState = await debugPageState();
      await page.screenshot({ path: context.pathInArtifacts(`failure-${label}-${stage}.png`), fullPage: true, animations: "disabled" });
      await context.writeArtifactJson(`failure-${label}-${stage}.json`, {
        stage,
        urlPath: pageState.pathname,
        title: pageState.title,
        visibleText: pageState.visibleText,
        visibleControls: pageState.visibleControls,
        diagnostics: browserDiagnostics,
      });
      return pageState;
    };
    try {
      await page.getByLabel("任务导航", { exact: true }).click();
      await page.getByTestId("mobile-drawer").waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("mobile-drawer").getByLabel("设置", { exact: true }).click();
    } catch (failure) {
      await writeFailureDiagnostics("settings-navigation");
      throw failure;
    }
    await page.getByTestId("settings-home").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("settings-section-models_services").click();
    await page.getByTestId("models-provider-new").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("models-provider-new").click();
    await page.getByTestId("models-provider-form").waitFor({ state: "visible" });

    const observations = [{ width: 390, height: 844, language: "zh-CN", theme: "light" }];
    try {
      assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
      assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), "light");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
        "390px zh-CN light must not overflow the viewport");
      const currentToggle = page.getByTestId("models-provider-capabilities-toggle");
      let focusedControl;
      if (expectedCollapsed) {
        await currentToggle.waitFor({ state: "visible" });
        assert.equal(await currentToggle.getAttribute("aria-expanded"), "false");
        assert.equal(await page.getByTestId("models-provider-capability-tools").count(), 0);
        focusedControl = currentToggle;
      } else {
        assert.equal(await currentToggle.count(), 0, "baseline does not have the disclosure control");
        focusedControl = page.getByTestId("models-provider-capability-tools");
        await focusedControl.waitFor({ state: "visible" });
      }
      await page.getByTestId("models-provider-context-window").waitFor({ state: "visible" });
      await page.getByTestId("models-provider-max-output").waitFor({ state: "visible" });
      await focusedControl.scrollIntoViewIfNeeded();
      const focusedBounds = await focusedControl.boundingBox();
      assert.ok(focusedBounds, "capability control must have a browser box after scrolling");
      assert.ok(focusedBounds.y >= 0 && focusedBounds.y + focusedBounds.height <= 844,
        "capability control must be inside the focused screenshot viewport");
      const path = context.pathInArtifacts(`model-capabilities-${label}-390x844-zh-CN-light.png`);
      await page.screenshot({ path, fullPage: false, animations: "disabled" });
      await chmod(path, 0o600);
      return { observations, url: page.url(), focusedBounds, viewport: { width: 390, height: 844 } };
    } catch (failure) {
      await writeFailureDiagnostics("provider-form");
      throw failure;
    } finally {
      try {
        await browserContext.close();
      } finally {
        await context.stopOwned(`model-capabilities-${label}-gateway`);
      }
    }
  };

  const oldCapture = await capture({ webRoot: before.path, label: "before", expectedCollapsed: false });
  assert.equal(await sourceInputsHash(), stableFixtureHash, "before-source visual pass must leave shared fixture data unchanged");
  const newCapture = await capture({ webRoot: after.path, label: "after", expectedCollapsed: true });
  assert.equal(await sourceInputsHash(), stableFixtureHash, "new-source visual pass must leave the same fixture data unchanged");
  assert.deepEqual(errors, []);
  assert.equal(before.dependencySourceTreeSha256, after.dependencySourceTreeSha256,
    "baseline and current Mobile Web exports must use the same dependency source tree");
  assert.equal(before.dependencyRoot, after.dependencyRoot,
    "baseline and current Mobile Web exports must use the same dependency input path");
  assert.ok(before.dependencySourceTreeSha256, "Mobile Web dependency source hash must be recorded");
  assert.notEqual(after.sourceTreeSha256, before.sourceTreeSha256, "after screenshot must identify the changed Mobile source tree");
  const beforeScreenshotPath = context.pathInArtifacts("model-capabilities-before-390x844-zh-CN-light.png");
  const afterScreenshotPath = context.pathInArtifacts("model-capabilities-after-390x844-zh-CN-light.png");
  const beforeScreenshotSha256 = createHash("sha256").update(await readFile(beforeScreenshotPath)).digest("hex");
  const afterScreenshotSha256 = createHash("sha256").update(await readFile(afterScreenshotPath)).digest("hex");
  await context.writeArtifactJson("visual-source-provenance.json", {
    before: {
      runContext: relative(repoRoot, context.runRoot).split(sep).join("/"),
      mobileSourceSha256: before.sourceTreeSha256,
      bundleSha256: before.bundleSha256,
      dependencySourceTreeSha256: before.dependencySourceTreeSha256,
      screenshotArtifact: "artifacts/model-capabilities-before-390x844-zh-CN-light.png",
      screenshotSha256: beforeScreenshotSha256,
    },
    after: {
      runContext: relative(repoRoot, context.runRoot).split(sep).join("/"),
      mobileSourceSha256: after.sourceTreeSha256,
      bundleSha256: after.bundleSha256,
      dependencySourceTreeSha256: after.dependencySourceTreeSha256,
      screenshotArtifact: "artifacts/model-capabilities-after-390x844-zh-CN-light.png",
      screenshotSha256: afterScreenshotSha256,
    },
  });
  return {
    baselineCommit: BASELINE,
    appServerBinary: binary,
    appServerBinarySha256: binaryDigest,
    oldMobileSourceSha256: before.sourceTreeSha256,
    newMobileSourceSha256: after.sourceTreeSha256,
    oldBundleSha256: before.bundleSha256,
    newBundleSha256: after.bundleSha256,
    dependencySourceTreeSha256: before.dependencySourceTreeSha256,
    beforeScreenshotSha256,
    afterScreenshotSha256,
    stableFixtureHash,
    oldCapture,
    newCapture,
    errors,
    providerRequestIssued: false,
    modelRequestIssued: false,
    providerFormSubmissionIssued: false,
    nativeValidation: false,
  };
});
