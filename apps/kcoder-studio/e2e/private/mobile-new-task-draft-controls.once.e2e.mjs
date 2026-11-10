import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { inspectMobileWebExportSourceIdentity, restoreMobileWebExportArchive } from "../harness/mobile-web-export-archive.mjs";
import { buildGatewayMobileWebManifest, MOBILE_WEB_BASE_TOKEN, writeGatewayMobileWebManifest } from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { appRoot, repoRoot, runE2E } from "../harness/run-context.mjs";

const deliveryHead = "5f49da119ed80744692d2b081063f30b1bd19243";
const baselineRun = "20261014-075257.797Z";
const baselineManifestSha256 = "dba3e9c17191fc482b5b6767340ec55a40402c7a36405b808791d3344ddbc55a";
const baselineMobileSourceSha256 = "d861acf8fd1aa2e5c3178e32e3b0c879e9e8f5212e96d784c1faa618c1caad0e";
const baselineRoot = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/private/mobile-current-product-build.once.mjs", baselineRun, "artifacts/mobile-web");
const baselineProvenancePath = resolve(repoRoot, "target/packages/kcoder-studio-mobile/20261014-commit-5f49da11-mobile-web/provenance.json");
const reusedRun = "20261014-111435.673Z";
const reusedArtifacts = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/private/mobile-new-task-draft-controls.once.e2e.mjs", reusedRun, "artifacts");
const reusedExportManifestPath = resolve(reusedArtifacts, "mobile-web-export-new-task-draft-controls-mobile-web-manifest.json");
const reusedExportManifestSha256 = "746604830f28f548c1ba8314e15b1e740306caaa92c08048b7a4583f23b7642f";
const reusedArchivePath = resolve(reusedArtifacts, "new-task-draft-controls-export-archive/mobile-web-bundle.archive.json");
const reusedArchiveSha256 = "0dc27ffa9c1a192df65fe4763115f71f8dddad8efca5767e6960c588786de3e0";
const currentMobileSourceSha256 = "733569fafc85988e3b054e0a7114c06fc2e940d8d71c61b876b46aef1d07bdf1";
const currentBundleSha256 = "1052206ccd25c87802d3faab88b31b453858389e17a041b693a5fd703463d153";
const baselineProvenance = JSON.parse(await readFile(baselineProvenancePath, "utf8"));
const baselineManifestBytes = await readFile(resolve(baselineRoot, "kcoder-mobile-web.json"));
assert.equal(createHash("sha256").update(baselineManifestBytes).digest("hex"), baselineManifestSha256);
assert.equal(baselineProvenance.deliveryCommit, deliveryHead);
assert.equal(baselineProvenance.mobileSrcMatchesDeliveryCommit, true);
assert.equal(baselineProvenance.mobileSrcSha256, baselineMobileSourceSha256);
assert.equal(baselineProvenance.builderRun, baselineRun);
assert.equal(baselineProvenance.mobileManifestSha256, baselineManifestSha256);
const baselineManifest = JSON.parse(baselineManifestBytes);
assert.equal(baselineManifest.files.length, 48);
for (const entry of baselineManifest.files) {
  const file = resolve(baselineRoot, entry.path);
  assert.ok(file.startsWith(`${baselineRoot}${sep}`));
  const bytes = await readFile(file);
  assert.equal(bytes.length, entry.size, `pinned baseline size changed: ${entry.path}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `pinned baseline hash changed: ${entry.path}`);
}
const reusedExportManifestBytes = await readFile(reusedExportManifestPath);
assert.equal(createHash("sha256").update(reusedExportManifestBytes).digest("hex"), reusedExportManifestSha256);
const reusedExportManifest = JSON.parse(reusedExportManifestBytes);
assert.equal(reusedExportManifest.status, "complete");
assert.equal(reusedExportManifest.sourceTreeSha256, currentMobileSourceSha256);
assert.equal(reusedExportManifest.bundleSha256, currentBundleSha256);
assert.equal(reusedExportManifest.bundleFileCount, 48);
const reusedArchiveBytes = await readFile(reusedArchivePath);
assert.equal(createHash("sha256").update(reusedArchiveBytes).digest("hex"), reusedArchiveSha256);
const reusedArchive = JSON.parse(reusedArchiveBytes);
assert.equal(reusedArchive.sourceIdentity.sourceTreeSha256, currentMobileSourceSha256);
assert.equal(reusedArchive.origin.exportManifestSha256, reusedExportManifestSha256);
assert.equal(reusedArchive.bundle.bundleSha256, currentBundleSha256);

const configuredBinary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
await runE2E(import.meta.url, {
  testId: "mobile-new-task-draft-controls-real-web",
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "model-independent authenticated Mobile Web mount; reuses a verified current-source archive; no send/create or Provider inference",
}, async context => {
  assert.equal(context.gitCommit, deliveryHead, "baseline and current review must use the pinned source HEAD");
  const sourceIdentity = await inspectMobileWebExportSourceIdentity({
    sourceRoots: [
      { name: "mobile", path: resolve(appRoot, "mobile"), destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(appRoot, "shared"), destination: "apps/kcoder-studio/shared" },
    ],
  });
  assert.equal(sourceIdentity.sourceTreeSha256, currentMobileSourceSha256,
    "current Mobile/Shared source must still match the archive's frozen source tree");
  assert.deepEqual(sourceIdentity, reusedArchive.sourceIdentity,
    "current Mobile/Shared roots must exactly match the source identity bound into the reused archive");
  const mobileWeb = await restoreMobileWebExportArchive(context, {
    archivePath: reusedArchivePath,
    expectedArchiveSha256: reusedArchiveSha256,
    sourceIdentity,
    outputName: "new-task-draft-controls-mobile-web-restored",
  });
  const currentGatewayManifest = await buildGatewayMobileWebManifest(mobileWeb.path, { expectedFiles: mobileWeb.bundleFiles });
  await writeGatewayMobileWebManifest(mobileWeb.path, currentGatewayManifest);
  const currentManifestBytes = await readFile(resolve(mobileWeb.path, "kcoder-mobile-web.json"));
  const currentManifestSha256 = createHash("sha256").update(currentManifestBytes).digest("hex");

  const baselineWorkspace = context.pathInState("baseline-local-workspace");
  const currentWorkspace = context.pathInState("current-local-workspace");
  await Promise.all([
    mkdir(baselineWorkspace, { recursive: true }),
    mkdir(currentWorkspace, { recursive: true }),
  ]);
  const baselineGateway = await startGateway(context, {
    auth: true,
    label: "new-task-controls-baseline-gateway",
    workspace: baselineWorkspace,
    kcoderBin: configuredBinary,
    env: { KCODER_STUDIO_WEB_ROOT: "", KCODER_STUDIO_MOBILE_WEB_ROOT: baselineRoot },
  });
  const currentGateway = await startGateway(context, {
    auth: true,
    label: "new-task-controls-current-gateway",
    workspace: currentWorkspace,
    kcoderBin: configuredBinary,
    env: { KCODER_STUDIO_WEB_ROOT: "", KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWeb.path },
  });
  const baselineEntry = await verifyMountedEntry(context, baselineGateway, baselineRoot, baselineManifest.files, baselineManifestSha256, "baseline-mobile-entry.json");
  const currentEntry = await verifyMountedEntry(context, currentGateway, mobileWeb.path, currentGatewayManifest.files, currentManifestSha256, "current-mobile-entry.json");

  const chromium = await startChromium(context, { label: "new-task-controls-owned-chromium", startTimeoutMs: 60_000 });
  const pageErrors = [];
  const consoleErrors = [];
  const baselineContext = await chromium.browser.newContext({
    locale: "zh-CN", colorScheme: "light", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  context.addCleanup("close baseline mobile browser context", () => baselineContext.close());
  const baselinePage = await baselineContext.newPage();
  observePage(baselinePage, pageErrors, consoleErrors);
  await connectFromLogin(baselinePage, baselineGateway);
  await enterNewFromHome(baselinePage);
  await assertLocaleAndTheme(baselinePage, "zh-CN", "light");
  const baselineControl = baselinePage.locator('[data-testid="new-task-advanced"]:visible');
  assert.equal(await baselineControl.getAttribute("aria-label"), "高级会话选项");
  assert.equal(await baselineControl.innerText(), "高级选项", "pinned old UI must expose its original text control");
  assert.equal(await baselineControl.locator("svg").count(), 0, "pinned old control must be text only");
  const baselineDraftPrompt = baselinePage.locator('[data-testid="new-task-draft"]:visible').getByTestId("message-input");
  await baselineDraftPrompt.fill("保留的草稿");
  assert.equal(await baselineDraftPrompt.inputValue(), "保留的草稿");
  assert.ok((await baselinePage.locator("body").innerText()).includes("发送第一条消息时创建会话；开始后可添加附件。权限沿用目标默认设置。"));
  await baselinePage.screenshot({ path: context.pathInArtifacts("before-draft-controls-390-zh-CN-light.png"), animations: "disabled" });

  const cases = [];
  for (const locale of ["zh-CN", "en"]) {
    for (const colorScheme of ["light", "dark"]) {
      const browserContext = await chromium.browser.newContext({
        locale, colorScheme, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      });
      context.addCleanup(`close ${locale}-${colorScheme} mobile context`, () => browserContext.close());
      const page = await browserContext.newPage();
      observePage(page, pageErrors, consoleErrors);
      await connectFromLogin(page, currentGateway);
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await enterNewFromHome(page);
        await assertLocaleAndTheme(page, locale, colorScheme);
        const advancedButton = page.locator('[data-testid="new-task-advanced"]:visible');
        const advancedLabel = locale === "zh-CN" ? "高级会话选项" : "Advanced conversation options";
        const backLabel = locale === "zh-CN" ? "返回对话" : "Back to conversation";
        assert.equal(await advancedButton.getAttribute("aria-label"), advancedLabel);
        assert.equal(await advancedButton.innerText(), "", "icon control must not retain its former text label");
        assert.equal(await advancedButton.locator("svg").count(), 1, "draft control must render its Lucide icon");
        const bounds = await advancedButton.boundingBox();
        assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, `advanced hit target is too small at ${width}px: ${JSON.stringify(bounds)}`);
        const draftText = locale === "zh-CN" ? "保留的草稿" : "Keep this draft";
        const draftPrompt = page.locator('[data-testid="new-task-draft"]:visible').getByTestId("message-input");
        await draftPrompt.fill(draftText);
        const note = locale === "zh-CN"
          ? "发送第一条消息时创建会话；开始后可添加附件。权限沿用目标默认设置。"
          : "The first message creates this conversation. Attachments are available after it starts. Permissions follow the target default.";
        assert.equal((await page.locator("body").innerText()).includes(note), false, "draft-first-send note must not be visible");
        if (locale === "zh-CN" && colorScheme === "light" && width === 390) {
          await page.screenshot({ path: context.pathInArtifacts("after-draft-controls-390-zh-CN-light.png"), animations: "disabled" });
        }

        await advancedButton.click();
        await page.locator('[data-testid="server-option-local"]:visible').waitFor({ state: "visible", timeout: 15_000 });
        assert.equal(await advancedButton.getAttribute("aria-label"), backLabel);
        assert.equal(await advancedButton.locator("svg").count(), 1, "advanced control must show the close icon");
        const advancedPrompt = page.locator('[data-testid="new-workspace-prompt"]:visible');
        assert.equal(await advancedPrompt.inputValue(), draftText, "opening advanced options must retain the unsent prompt");
        const visual = await page.evaluate(() => ({
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          lang: document.documentElement.lang,
          theme: document.documentElement.style.getPropertyValue("--mobile-color-scheme"),
        }));
        assert.equal(visual.viewportWidth, width);
        assert.equal(visual.documentWidth, width, `route must not overflow horizontally at ${width}px`);
        assert.equal(visual.lang, locale === "zh-CN" ? "zh-CN" : "en");
        assert.equal(visual.theme, colorScheme);
        if (locale === "zh-CN" && colorScheme === "light" && width === 390) {
          await page.screenshot({ path: context.pathInArtifacts("after-advanced-controls-390-zh-CN-light.png"), animations: "disabled" });
        }

        await advancedButton.click();
        const returnedDraft = page.locator('[data-testid="new-task-draft"]:visible');
        await returnedDraft.waitFor({ state: "visible", timeout: 15_000 });
        assert.equal(await advancedButton.getAttribute("aria-label"), advancedLabel);
        assert.equal(await returnedDraft.getByTestId("message-input").inputValue(), draftText, "returning to draft must retain the unsent prompt");
        assert.equal((await page.locator("body").innerText()).includes(note), false, "removed note must remain absent after returning to draft");
        cases.push({ locale, colorScheme, width, advancedLabel, backLabel, hitTarget: { width: bounds.width, height: bounds.height }, visual });
        await page.goBack({ waitUntil: "domcontentloaded" });
        await page.locator('[data-testid="new-workspace-local"]:visible').waitFor({ state: "visible", timeout: 15_000 });
      }
    }
  }
  assert.equal(cases.length, 8);
  assert.deepEqual(pageErrors, [], "Mobile routes must not emit page errors");
  assert.deepEqual(consoleErrors, [], "Mobile routes must not emit browser console errors");
  await context.writeArtifactJson("mobile-new-task-draft-controls-evidence.json", {
    baseline: { deliveryCommit: baselineProvenance.deliveryCommit, mobileSourceSha256: baselineProvenance.mobileSrcSha256, manifestSha256: baselineManifestSha256, mountedEntry: baselineEntry },
    current: { sourceHead: context.gitCommit, sourceTreeSha256: mobileWeb.sourceTreeSha256, bundleSha256: mobileWeb.bundleSha256, bundleFileCount: mobileWeb.bundleFileCount, exportManifestSha256: reusedExportManifestSha256, bundleArchiveSha256: reusedArchiveSha256, bundleArchivePath: reusedArchivePath, mountedEntry: currentEntry },
    screenshots: { baselineAndCurrentDraftInput: "保留的草稿", inputFocusedInBoth: true, platform: "Mobile Web in isolated Chromium" },
    cases,
    workflow: ["Gateway login", "Mobile direct pairing", "Home plus route", "advanced icon opens and X returns", "unsent prompt retained"],
    noSendOrCreate: true,
    noProviderOrModelRequest: true,
    pageErrors,
    consoleErrors,
    secretsInArtifacts: false,
  });
  return { cases: cases.length, baselineCommit: baselineProvenance.deliveryCommit, currentCommit: context.gitCommit, sentOrCreated: false };
});

async function connectFromLogin(page, gateway) {
  const loginUrl = new URL("/login?returnTo=%2Fmobile%2F", gateway.baseUrl).href;
  const response = await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  assert.equal(new URL(page.url()).pathname, "/login");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForURL(url => url.pathname === "/mobile/", { timeout: 15_000 }),
    page.locator("form button").click(),
  ]);
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace-local").waitFor({ state: "visible", timeout: 30_000 });
}

async function enterNewFromHome(page) {
  await page.locator('[data-testid="new-workspace-local"]:visible').click();
  await page.waitForURL(url => url.pathname.endsWith("/new"), { timeout: 15_000 });
  await page.locator('[data-testid="new-task-draft"]:visible').waitFor({ state: "visible", timeout: 30_000 });
}

async function assertLocaleAndTheme(page, locale, colorScheme) {
  await page.waitForFunction(expected => document.documentElement.lang === expected, locale === "zh-CN" ? "zh-CN" : "en", { timeout: 10_000 });
  await page.waitForFunction(expected => document.documentElement.style.getPropertyValue("--mobile-color-scheme") === expected, colorScheme, { timeout: 10_000 });
}

async function verifyMountedEntry(context, gateway, root, files, gatewayManifestSha256, artifactName) {
  const entry = files.find(file => file.path.startsWith("_expo/static/js/web/entry-") && file.path.endsWith(".js"));
  assert.ok(entry, "Mobile Web bundle must include its Expo entry chunk");
  const exportedBytes = await readFile(resolve(root, entry.path));
  assert.equal(createHash("sha256").update(exportedBytes).digest("hex"), entry.sha256);
  const expectedMountedBytes = Buffer.from(exportedBytes.toString("utf8").replaceAll(MOBILE_WEB_BASE_TOKEN, "/mobile"));
  const expectedMountedSha256 = createHash("sha256").update(expectedMountedBytes).digest("hex");
  const response = await fetch(new URL(`/mobile/${entry.path}`, gateway.baseUrl), { signal: AbortSignal.timeout(10_000) });
  const servedBytes = Buffer.from(await response.arrayBuffer());
  const servedSha256 = createHash("sha256").update(servedBytes).digest("hex");
  assert.equal(response.status, 200);
  assert.equal(servedSha256, expectedMountedSha256, "Gateway must serve the mount-transformed pinned/current entry");
  const evidence = { path: entry.path, status: response.status, exportSha256: entry.sha256, servedSha256, matchesDeployTransform: true, gatewayManifestSha256 };
  await context.writeArtifactJson(artifactName, evidence);
  return evidence;
}

function observePage(page, pageErrors, consoleErrors) {
  page.on("pageerror", () => pageErrors.push({ route: new URL(page.url()).pathname }));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push({ route: new URL(page.url()).pathname }); });
}
