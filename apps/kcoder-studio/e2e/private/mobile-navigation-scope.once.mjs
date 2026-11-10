import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve, relative, sep } from "node:path";
import { startApprovalModelFixture } from "../harness/approval-model.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { captureMobileExportSourceSnapshot } from "../harness/mobile-export-source-snapshot.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from "../harness/run-context.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";

const execFileAsync = promisify(execFile);
const BEFORE_SOURCE_ROOT = "/tmp/kcoder-mobile-frozen-6148d89acb9c83e5eede1e93ed00bcb95f5cf31b";
const BEFORE_SOURCE_HEAD = "6148d89acb9c83e5eede1e93ed00bcb95f5cf31b";
const AFTER_SOURCE_HEAD = "1e4d816e9eb3fcf3a7a049d19d68bdae02017952";
const PINNED_KCODER_SHA256 = "7a87160fcf92c32654cfccdb501229c2ee02f6d251c5095be8ba8541e5137d76";
const PREF_KEY = "kcoder-studio:mobile-app-preferences:v1";
const modes = ["--capture-before-ui", "--capture-after-ui", "--capture-after-home-clean", "--smoke-before-ui-reuse"].filter(flag => process.argv.includes(flag));
assert.equal(modes.length, 1, "choose exactly one mode: --capture-before-ui, --capture-after-ui, --capture-after-home-clean, or --smoke-before-ui-reuse");
const mode = modes[0] === "--capture-before-ui" || modes[0] === "--smoke-before-ui-reuse" ? "before" : "after";
const smokeOnly = modes[0] === "--smoke-before-ui-reuse";
const cleanHomeOnly = modes[0] === "--capture-after-home-clean";
process.umask(0o077);

await runE2E(import.meta.url, {
  testId: "mobile-navigation-scope",
  tier: "one-off-acceptance",
  modelPolicy: "paired Mobile Web navigation and capability evidence through an isolated Gateway, real local app-server and one bounded local model fixture turn; no live Provider request",
  retainSuccessLogs: true,
}, async context => {
  const source = await resolveFrozenSource(mode);
  const reusedBundleRoot = process.env.KCODER_E2E_MOBILE_NAV_REUSE_BUNDLE_ROOT;
  const dependencyRootInput = resolve(
    process.env.KCODER_E2E_MOBILE_NAV_DEPENDENCY_ROOT || resolve(appRoot, "mobile/node_modules"),
  );
  const dependencyRoot = reusedBundleRoot ? dependencyRootInput : await realpath(dependencyRootInput);
  const snapshotRoot = context.pathInArtifacts(`${mode}-source-snapshot`);
  const mobileRoot = resolve(snapshotRoot, "apps/kcoder-studio/mobile");
  const sharedRoot = resolve(snapshotRoot, "apps/kcoder-studio/shared");
  const sourceSnapshot = await captureMobileExportSourceSnapshot({
    sourceRoots: [
      { name: "mobile", path: resolve(source.root, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(source.root, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
    ],
    snapshotRoot,
    layout: "preflight-source-root",
    freezeFiles: true,
  });
  assert.equal(sourceSnapshot.fileCount > 0, true);

  const beforeProvenancePath = mode === "after" ? process.env.KCODER_E2E_MOBILE_NAV_BEFORE_PROVENANCE : undefined;
  let beforeProvenance = null;
  if (mode === "after") {
    assert.ok(beforeProvenancePath && resolve(beforeProvenancePath) === beforeProvenancePath,
      "set KCODER_E2E_MOBILE_NAV_BEFORE_PROVENANCE to the successful BEFORE export provenance JSON");
    beforeProvenance = JSON.parse(await readFile(beforeProvenancePath, "utf8"));
    assert.equal(beforeProvenance.schemaVersion, 1);
    assert.equal(beforeProvenance.mode, "before");
    assert.equal(beforeProvenance.completed, true);
    assert.equal(beforeProvenance.sourceHead, BEFORE_SOURCE_HEAD);
    assert.match(beforeProvenance.dependencyTreeSha256 ?? "", /^[a-f0-9]{64}$/);
  }

  let exported;
  let bundleSource;
  let exporterManifestPath;
  if (reusedBundleRoot) {
    const reuseManifestPath = process.env.KCODER_E2E_MOBILE_NAV_REUSE_EXPORT_MANIFEST;
    assert.ok(resolve(reusedBundleRoot) === reusedBundleRoot && reuseManifestPath && resolve(reuseManifestPath) === reuseManifestPath,
      "bundle reuse requires absolute bundle and exporter manifest paths");
    const prior = JSON.parse(await readFile(reuseManifestPath, "utf8"));
    assert.equal(prior.status, "complete", "reused Mobile Web export must have completed successfully");
    assert.equal(prior.sourceTreeSha256, sourceSnapshot.sourceTreeSha256,
      "reused Mobile Web bundle must match this run's frozen Mobile source snapshot");
    assert.equal(dependencyRoot, prior.dependencyProvenance?.sourceRoot,
      "reused bundle must retain the original dependency pin path recorded by its export manifest");
    assert.equal(await hashRegularTree(reusedBundleRoot), prior.bundleSha256,
      "reused Mobile Web bundle bytes must match the exporter manifest");
    const dependencySourceTreeSha256 = prior.dependencyProvenance?.sourceTreeSha256Before;
    const dependencyTreeSha256After = prior.dependencyProvenance?.sourceTreeSha256After;
    assert.match(dependencySourceTreeSha256 ?? "", /^[a-f0-9]{64}$/, "reused export must include dependency provenance");
    assert.equal(dependencyTreeSha256After, dependencySourceTreeSha256,
      "reused export must prove the physical dependency tree was unchanged during export");
    if (beforeProvenance) {
      assert.equal(dependencySourceTreeSha256, beforeProvenance.dependencyTreeSha256,
        "reused AFTER bundle must match the BEFORE physical Mobile dependency tree");
    }
    exported = {
      sourceTreeSha256: prior.sourceTreeSha256,
      dependencySourceTreeSha256,
      dependencyTreeSha256After,
      buildInputTreeSha256: prior.buildInputTreeSha256,
      bundleSha256: prior.bundleSha256,
      bundleFileCount: prior.bundleFileCount,
      indexHtmlSha256: prior.indexHtmlSha256,
    };
    bundleSource = reusedBundleRoot;
    exporterManifestPath = reuseManifestPath;
  } else {
    let previousProgressPhase = "";
    exported = await exportMobileWeb(context, {
      mobileRoot,
      sourceRoots: [
        { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
        { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
      ],
      dependencyRoot,
      label: `mobile-navigation-${mode}-export`,
      outputName: `mobile-navigation-${mode}-web`,
      timeoutMs: 10 * 60_000,
      overallTimeoutMs: 45 * 60_000,
      onProgress: progress => {
        const phase = progress.phase ?? progress.event ?? "progress";
        if (phase !== previousProgressPhase) console.log(`[mobile-web:${mode}] ${phase}`);
        previousProgressPhase = phase;
      },
    });
    bundleSource = exported.path;
    exporterManifestPath = exported.bundleManifestPath;
  }
  assert.equal(exported.sourceTreeSha256, sourceSnapshot.sourceTreeSha256,
    "Mobile exporter source must match the retained frozen source snapshot");
  if (beforeProvenance) {
    assert.equal(exported.dependencySourceTreeSha256, beforeProvenance.dependencyTreeSha256,
      "BEFORE and AFTER must use the same physically copied Mobile dependency tree");
  }
  const retainedBundle = context.pathInArtifacts(`${mode}-mobile-web`);
  await copyRegularTree(bundleSource, retainedBundle);
  assert.equal(await hashRegularTree(retainedBundle), exported.bundleSha256,
    "retained bundle must match the Mobile exporter bundle manifest");

  const binarySource = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "../Kunlun-Code-CYX/target/debug/kcoder"));
  assert.equal(await requireExecutable(binarySource, "KCoder CLI app-server"), binarySource);
  const binaryInfo = await lstat(binarySource);
  assert.ok(binaryInfo.isFile() && !binaryInfo.isSymbolicLink(), "KCoder CLI source must be a regular non-symlink file");
  const binarySha256 = await hashFile(binarySource);
  assert.equal(binarySha256, PINNED_KCODER_SHA256, "backend binary differs from the pinned local app-server");
  const ownedBinary = context.pathInState("mobile-navigation-kcoder");
  await copyFile(binarySource, ownedBinary, constants.COPYFILE_EXCL);
  await chmod(ownedBinary, 0o500);
  assert.equal(await hashFile(ownedBinary), binarySha256, "RunContext-owned app-server copy changed bytes");

  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: `mobile-nav-${mode}`,
  });
  const configDir = context.pathInState("mobile-navigation-config");
  await mkdir(configDir, { recursive: false, mode: 0o700 });
  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    textOnlyResponse: "MOBILE_NAV_LOCAL_FIXTURE_REPLY",
  });
  const settingsFile = await context.writeStateJson("mobile-navigation-runtime-settings.json", {
    active_provider: "mobile-navigation-fixture",
    permission_mode: "yolo",
    providers: {
      "mobile-navigation-fixture": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "mobile-navigation-fixture",
        context_window_tokens: 128000,
        output_headroom_tokens: 8192,
        max_output_tokens: 8192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("mobile-navigation-config/settings.json", {});
  await context.writeStateJson("mobile-navigation-config/credentials.json", {
    "mobile-navigation-fixture": { type: "api", key: "deterministic-local" },
  });
  const missingChromium = resolve(context.stateDir, "mobile-navigation-missing-chromium");
  const serverConfigs = [
    {
      id: "browser-available",
      label: "Browser Available",
      transport: "local",
      command: ownedBinary,
      workspace,
      settingsFile,
      chromiumNoSandbox: true,
    },
  ];
  if (!cleanHomeOnly) {
    serverConfigs.push(
      {
        id: "browser-missing",
        label: "Browser Missing",
        transport: "local",
        command: ownedBinary,
        workspace,
        settingsFile,
        chromiumBin: missingChromium,
        chromiumNoSandbox: true,
      },
      {
        id: "offline",
        label: "Offline Target",
        transport: "local",
        command: "/usr/bin/false",
        workspace,
        settingsFile,
      },
    );
  }
  const serversFile = await context.writeStateJson("mobile-navigation-servers.json", serverConfigs);
  const gateway = await startGateway(context, {
    auth: true,
    label: `mobile-navigation-${mode}-gateway`,
    workspace,
    serversFile,
    kcoderBin: ownedBinary,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_WEB_ROOT: retainedBundle,
    },
  });
  const chromium = await startChromium(context, { label: `mobile-navigation-${mode}-chromium` });
  const browserContext = await chromium.browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  context.addCleanup(`close owned Mobile ${mode} browser context`, () => browserContext.close());
  const page = await browserContext.newPage();
  const diagnostics = [];
  const statusSnapshots = [];
  const browserRpcMethods = [];
  page.on("pageerror", error => diagnostics.push(context.redactText(`pageerror: ${error.message}`)));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push(context.redactText(`console: ${message.text()}`));
  });
  page.on("response", async response => {
    if (!response.url().includes("/api/servers/status")) return;
    try {
      const payload = await response.json();
      if (!Array.isArray(payload?.statuses)) return;
      statusSnapshots.push(summarizeStatuses(payload.statuses));
    } catch { /* Non-JSON or aborted response is not a usable status observation. */ }
  });
  page.on("websocket", socket => {
    socket.on("framesent", frame => {
      for (const message of parseFrames(frame.payload)) {
        if (typeof message?.method === "string" && message.method.startsWith("browser/"))
          browserRpcMethods.push(message.method);
      }
    });
  });
  await installPreferences(page, { language: "zh-CN", theme: "light" });
  await connectMobile(page, gateway);
  const statuses = await waitFor(
    () => statusSnapshots.find(rows => (cleanHomeOnly ? ["browser-available"] : ["browser-available", "browser-missing", "offline"])
      .every(id => rows.some(row => row.id === id))),
    45_000,
    cleanHomeOnly ? "real Gateway /api/servers/status for the isolated online local target" : "real Gateway /api/servers/status for all isolated local targets",
  );
  assertStatus(statuses, "browser-available", "online", true);
  if (!cleanHomeOnly) {
    assertStatus(statuses, "browser-missing", "online", false);
    assertStatus(statuses, "offline", "offline", null);
  }

  if (smokeOnly) {
    const profileId = profileIdFromUrl(page.url());
    assert.ok(profileId, "Home must identify the Gateway profile");
    await capture(page, context, "nav-home-smoke-before-390-zh-light.png");
    await page.getByTestId("new-workspace").click();
    const newUrl = new URL(page.url());
    assert.equal(newUrl.pathname, "/new");
    assert.equal(newUrl.searchParams.get("profileId"), profileId,
      "Home New conversation navigation must preserve the active profile identity");
    await visibleByLabel(page, "返回").click();
    await waitForHome(page);
    await openHostDetails(page, "browser-available", "zh-CN");
    await assertCapabilityText(page, "可用", "zh-CN");
    await capture(page, context, "nav-host-smoke-before-390-zh-light.png");
    const result = {
      schemaVersion: 1,
      mode,
      completed: true,
      sourceHead: source.head,
      sourceRoot: source.root,
      sourceTreeSha256: sourceSnapshot.sourceTreeSha256,
      sourceFileCount: sourceSnapshot.fileCount,
      dependencyRoot,
      dependencyTreeSha256: exported.dependencySourceTreeSha256,
      dependencyTreeSha256After: exported.dependencyTreeSha256After ?? null,
      bundleSha256: exported.bundleSha256,
      bundleFileCount: exported.bundleFileCount,
      indexHtmlSha256: exported.indexHtmlSha256,
      retainedBundle,
      exporterManifestPath,
      appServerSha256: binarySha256,
      targetStatusEvidence: statuses,
      navigation: { profileId, newTaskRoute: sanitizeRoute(newUrl), hostServerId: "browser-available" },
      screenshotFiles: ["nav-home-smoke-before-390-zh-light.png", "nav-host-smoke-before-390-zh-light.png"],
      evidenceClass: "real isolated KCoder Studio Gateway and Rust app-server with owned Chromium; 390px zh-CN light Mobile Web smoke; not Android/iOS device evidence",
    };
    await context.writeArtifactJson("mobile-navigation-scope-provenance.json", result);
    return result;
  }

  const createdTask = await createAndRenameRealTask(page, model, mode, workspace);
  if (cleanHomeOnly) {
    await waitForHome(page);
    assert.equal(await page.getByText("Offline Target", { exact: true }).count(), 0,
      "clean Home capture must not include an intentionally offline fixture target");
    assert.equal(await page.getByText(/connection refused|connection.*disconnected|连接已断开/i).count(), 0,
      "clean Home capture must not include a fixture connection error");
    await capture(page, context, "nav-home-clean-390-zh-light.png");
    assert.equal(model.requests.length, 1, "only one deterministic loopback model fixture turn may run");
    assert.equal(browserRpcMethods.includes("browser/start"), false,
      "clean Home capture must not start a target browser session");
    assert.equal(diagnostics.filter(entry => entry.startsWith("pageerror:")).length, 0,
      "Mobile Web clean Home capture must not raise uncaught browser errors");
    const result = {
      schemaVersion: 1,
      mode: "after-home-clean",
      completed: true,
      sourceHead: source.head,
      sourceRoot: source.root,
      sourceTreeSha256: sourceSnapshot.sourceTreeSha256,
      sourceFileCount: sourceSnapshot.fileCount,
      sourceByteCount: sourceSnapshot.byteCount,
      dependencyRoot,
      dependencyPinReusedFromExportManifest: true,
      mobileWebExportReused: true,
      dependencyTreeSha256: exported.dependencySourceTreeSha256,
      dependencyTreeSha256After: exported.dependencyTreeSha256After ?? null,
      buildInputTreeSha256: exported.buildInputTreeSha256,
      bundleSha256: exported.bundleSha256,
      bundleFileCount: exported.bundleFileCount,
      indexHtmlSha256: exported.indexHtmlSha256,
      retainedBundle,
      exporterManifestPath,
      appServerSha256: binarySha256,
      targetStatusEvidence: statuses,
      createdTask,
      modelFixtureRequestCount: model.requests.length,
      browserRpcMethods,
      screenshotFiles: ["nav-home-clean-390-zh-light.png"],
      browserDiagnostics: diagnostics,
      evidenceClass: "isolated after-source Mobile Web Home capture reusing a verified export and its stable dependency provenance; real Gateway/app-server and owned Chromium; one deterministic local fixture turn; no offline target in the Home presentation fixture; not Android/iOS device evidence",
    };
    await context.writeArtifactJson("mobile-navigation-scope-provenance.json", result);
    return result;
  }

  await capture(page, context, "nav-home-390-zh-light.png");
  const drawer390 = await openDrawer(page, "zh-CN");
  if (mode === "before") {
    const disabledAction = drawer390.locator('[aria-disabled="true"]:visible').filter({ hasText: "Schedules · 即将支持" });
    await disabledAction.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await disabledAction.count(), 1,
      "the BEFORE Schedules placeholder must be inside a visibly disabled Pressable");
    const routeBefore = page.url();
    await disabledAction.click({ force: true });
    assert.equal(page.url(), routeBefore, "tapping the disabled BEFORE schedule placeholder must not navigate");
  } else {
    assert.equal(await drawer390.getByText(/Schedules · Coming soon|Schedules · 即将支持/).count(), 0,
      "AFTER drawer must not render the Schedules placeholder");
  }
  await capture(page, context, "nav-drawer-390-zh-light.png");
  await drawer390.getByText("添加项目", { exact: true }).click();
  const openProject390 = visibleTestId(page, "open-project-route");
  await openProject390.waitFor({ state: "visible", timeout: 15_000 });
  if (mode === "before") {
    await openProject390.getByText("从 GitHub 克隆", { exact: true }).click();
    const error = openProject390.getByTestId("open-project-error");
    await error.filter({ hasText: "TODO" }).waitFor({ state: "visible", timeout: 10_000 });
    assert.match(await error.innerText(), /TODO.*GitHub.*RPC/);
  } else {
    assert.equal(await openProject390.getByText(/Clone from GitHub|从 GitHub 克隆/).count(), 0,
      "AFTER Open Project must remove the GitHub TODO choice");
    await assertOpenProjectChoices(openProject390, "zh-CN");
  }
  await capture(page, context, "nav-open-project-390-zh-light.png");
    await visibleByLabel(page, "返回").click();
  await waitForHome(page);

  await openHostDetails(page, "browser-available", "zh-CN");
  await assertCapabilityText(page, "可用", "zh-CN");
  const lightHostBackground = await hostDetailsBackground(page);
  await capture(page, context, "nav-host-available-390-zh-light.png");
  await returnHomeFromHost(page, "zh-CN");

  await openBrowserSettings(page, "browser-available", "zh-CN");
  await visibleTestId(page, "settings-browser-target").filter({ hasText: "Browser Available" }).waitFor({ state: "visible" });
  await visibleTestId(page, "settings-browser-open").waitFor({ state: "visible" });
  await waitFor(() => visibleTestId(page, "settings-browser-open").isEnabled(), 30_000,
    "available browser target preflight and open control");
  await capture(page, context, "nav-browser-available-390-zh-light.png");
  await returnHomeFromSettings(page);

  await setVariant(page, { width: 320, language: "en", theme: "dark" });
  await capture(page, context, "nav-home-320-en-dark.png");
  await openHostDetails(page, "browser-missing", "en");
  await assertCapabilityText(page, mode === "before" ? "Available" : "Not provided", "en");
  const darkHostBackground = await hostDetailsBackground(page);
  assert.notEqual(darkHostBackground, lightHostBackground,
    "320px English/dark preferences must change the rendered Host Details background from the initial light theme");
  await capture(page, context, "nav-host-browser-missing-320-en-dark.png");
  await returnHomeFromHost(page, "en");
  await openBrowserSettings(page, "browser-missing", "en");
  await visibleTestId(page, "settings-browser-target").filter({ hasText: "Browser Missing" }).waitFor({ state: "visible" });
  await visibleTestId(page, "settings-browser-unsupported").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await visibleTestId(page, "settings-browser-open").isEnabled(), false,
    "browser settings must use the actual unsupported target capability");
  await capture(page, context, "nav-browser-unavailable-320-en-dark.png");
  await returnHomeFromSettings(page);
  const drawer320 = await openDrawer(page, "en");
  await capture(page, context, "nav-drawer-320-en-dark.png");
  await drawer320.getByText("Add project", { exact: true }).click();
  const openProject320 = visibleTestId(page, "open-project-route");
  await openProject320.waitFor({ state: "visible", timeout: 15_000 });
  if (mode === "before") {
    await openProject320.getByText("Clone from GitHub", { exact: true }).click();
    await openProject320.getByTestId("open-project-error").filter({ hasText: "TODO" }).waitFor({ state: "visible", timeout: 10_000 });
  } else {
    assert.equal(await openProject320.getByText(/Clone from GitHub|从 GitHub 克隆/).count(), 0);
    await assertOpenProjectChoices(openProject320, "en");
  }
  await capture(page, context, "nav-open-project-320-en-dark.png");
  await visibleByLabel(page, "Back").click();
  await waitForHome(page);

  await setVariant(page, { width: 320, language: "zh-CN", theme: "dark" });
  await openHostDetails(page, "offline", "zh-CN");
  await assertCapabilityText(page, mode === "before" ? "可用" : "未确认", "zh-CN");
  await capture(page, context, "nav-host-offline-320-zh-dark.png");
  await returnHomeFromHost(page, "zh-CN");

  assert.equal(model.requests.length, 1, "only one deterministic loopback model fixture turn may run");
  assert.equal(browserRpcMethods.includes("browser/start"), false,
    "navigation and Browser settings acceptance must not start a target browser session");
  assert.equal(diagnostics.filter(entry => entry.startsWith("pageerror:")).length, 0,
    "Mobile Web navigation must not raise uncaught browser errors");

  const result = {
    schemaVersion: 1,
    mode,
    completed: true,
    sourceHead: source.head,
    sourceRoot: source.root,
    sourceTreeSha256: sourceSnapshot.sourceTreeSha256,
    sourceFileCount: sourceSnapshot.fileCount,
    sourceByteCount: sourceSnapshot.byteCount,
    dependencyRoot,
    dependencyTreeSha256: exported.dependencySourceTreeSha256,
    dependencyTreeSha256After: exported.dependencyTreeSha256After ?? null,
    buildInputTreeSha256: exported.buildInputTreeSha256,
    bundleSha256: exported.bundleSha256,
    bundleFileCount: exported.bundleFileCount,
    indexHtmlSha256: exported.indexHtmlSha256,
    retainedBundle,
    exporterManifestPath,
    appServerSha256: binarySha256,
    targetStatusEvidence: statuses,
    createdTask,
    modelFixtureRequestCount: model.requests.length,
    browserRpcMethods,
    screenshotFiles: [
      "nav-home-390-zh-light.png",
      "nav-drawer-390-zh-light.png",
      "nav-open-project-390-zh-light.png",
      "nav-host-available-390-zh-light.png",
      "nav-browser-available-390-zh-light.png",
      "nav-home-320-en-dark.png",
      "nav-host-browser-missing-320-en-dark.png",
      "nav-browser-unavailable-320-en-dark.png",
      "nav-drawer-320-en-dark.png",
      "nav-open-project-320-en-dark.png",
      "nav-host-offline-320-zh-dark.png",
    ],
    browserDiagnostics: diagnostics,
    evidenceClass: "real isolated KCoder Studio Gateway and Rust app-server with owned Chromium; one deterministic local fixture turn; Web screenshots are not Android/iOS device evidence",
  };
  await context.writeArtifactJson("mobile-navigation-scope-provenance.json", result);
  return result;
});

async function resolveFrozenSource(selectedMode) {
  if (selectedMode === "before") {
    const identity = await verifySourceRoot(BEFORE_SOURCE_ROOT, BEFORE_SOURCE_HEAD);
    return identity;
  }
  const root = process.env.KCODER_E2E_MOBILE_NAV_SOURCE_ROOT;
  const expectedHead = process.env.KCODER_E2E_MOBILE_NAV_SOURCE_HEAD;
  assert.ok(root && resolve(root) === root, "set KCODER_E2E_MOBILE_NAV_SOURCE_ROOT to the frozen AFTER source checkout");
  assert.equal(expectedHead, AFTER_SOURCE_HEAD, "AFTER source HEAD must be the root-approved commit 1e4d816e9eb3fc3a7f4a049d19d68bdae02017952");
  return await verifySourceRoot(root, expectedHead);
}

async function verifySourceRoot(root, expectedHead) {
  const { stdout: head } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  assert.equal(head.trim(), expectedHead, "source checkout HEAD does not match the required frozen commit");
  const { stdout: scopedChanges } = await execFileAsync("git", ["-C", root, "status", "--porcelain=v1", "--", "apps/kcoder-studio/mobile", "apps/kcoder-studio/shared"]);
  assert.equal(scopedChanges.trim(), "", "Mobile and Studio shared source must be clean at capture time");
  return { root, head: head.trim() };
}

async function installPreferences(page, { language, theme }) {
  const value = preferencesValue(language, theme);
  await page.addInitScript(({ key, seedKey, preferences }) => {
    if (sessionStorage.getItem(seedKey) === "1") return;
    localStorage.setItem(key, preferences);
    sessionStorage.setItem(seedKey, "1");
  }, { key: PREF_KEY, seedKey: `${PREF_KEY}:e2e-seed`, preferences: value });
}

function preferencesValue(language, theme) {
  return JSON.stringify({
    language,
    theme,
    terminalScrollbackLines: 10_000,
    conversationFontScale: "normal",
    conversationLineSpacing: "normal",
    conversationBlockSpacing: "normal",
    conversationLetterSpacing: "normal",
    conversationFontFamily: "noto-sans-sc",
    thinkingCollapsedByDefault: true,
    toolsCollapsedByDefault: true,
    quickPhrases: [],
  });
}

async function connectMobile(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await waitForHome(page);
}

async function createAndRenameRealTask(page, model, mode, workspace) {
  const homeProfileId = profileIdFromUrl(page.url());
  assert.ok(homeProfileId, "Gateway connection must route into a concrete Mobile profile");
  const newConversationLabel = mode === "before" ? "在此项目新建任务" : "在此工作区新建对话";
  const browserTargetWorkspace = visibleTestId(page, "toggle-server-browser-available").first().locator("..");
  const newConversationAction = browserTargetWorkspace.getByText(newConversationLabel, { exact: true });
  await newConversationAction.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await newConversationAction.count(), 1,
    `the ${mode.toUpperCase()} new conversation action must be scoped to browser-available's workspace group`);
  await newConversationAction.click();
  await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 30_000 });
  const newRoute = new URL(page.url());
  assert.equal(newRoute.searchParams.get("profileId"), homeProfileId);
  assert.equal(newRoute.searchParams.get("serverId"), "browser-available");
  assert.equal(newRoute.searchParams.get("cwd"), workspace,
    "Home New conversation navigation must preserve the selected browser-available workspace path");
  await page.getByTestId("message-input").fill("MOBILE_NAV_CREATE_RENAME_FIXTURE");
  await page.getByTestId("send-message").click();
  await page.getByText("MOBILE_NAV_LOCAL_FIXTURE_REPLY", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await waitFor(() => model.requests.length === 1, 30_000, "single local model fixture turn");
  const identity = taskIdentityFromUrl(page.url());
  assert.equal(identity.profileId, homeProfileId);
  assert.equal(identity.serverId, "browser-available");
  assert.ok(identity.threadId, "real app-server thread route must provide a thread ID");

  await visibleByLabel(page, "打开任务列表").click();
  await visibleTestId(page, "mobile-drawer").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId(`drawer-thread-actions-${identity.threadId}`).click();
  await page.getByTestId("thread-rename-input").fill("手机导航验收任务");
  await page.getByTestId("thread-rename-save").click();
  const drawerThread = page.getByTestId(`drawer-thread-${identity.threadId}`);
  await drawerThread.waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(async () => (await drawerThread.innerText()).includes("手机导航验收任务"), 30_000,
    "renamed thread title in the exact drawer row identified by threadId");
  const renameSheet = page.getByRole("dialog");
  await renameSheet.getByLabel("关闭", { exact: true }).click();
  await renameSheet.waitFor({ state: "hidden", timeout: 10_000 });
  await visibleByLabel(page, "主页").click();
  await waitForHome(page);
  const browserWorkspace = visibleTestId(page, "toggle-server-browser-available").first().locator("..");
  const homeThread = browserWorkspace.getByTestId(`thread-${identity.threadId}`);
  await homeThread.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await homeThread.innerText(), /手机导航验收任务/,
    "the renamed title must appear in the Home workspace group for browser-available and the created threadId");
  return { ...identity, title: "手机导航验收任务", newTaskRoute: sanitizeRoute(newRoute), homeRoute: sanitizeRoute(new URL(page.url())) };
}

async function openDrawer(page, language) {
  const navigationLabel = language === "zh-CN" ? "任务导航" : "Task navigation";
  await visibleByLabel(page, navigationLabel).click();
  const drawer = visibleTestId(page, "mobile-drawer").first();
  await drawer.waitFor({ state: "visible", timeout: 15_000 });
  return drawer;
}

function visibleByLabel(page, label) {
  return page.locator(`[aria-label=${JSON.stringify(label)}]:visible`);
}

function visibleTestId(page, testId) {
  return page.locator(`[data-testid=${JSON.stringify(testId)}]:visible`);
}

async function openHostDetails(page, serverId, language) {
  await visibleByLabel(page, language === "zh-CN" ? "设置" : "Settings").click();
  await visibleTestId(page, "settings-home").first().waitFor({ state: "visible", timeout: 15_000 });
  await visibleTestId(page, "settings-manage-connections").click();
  const row = visibleTestId(page, `settings-host-${serverId}`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await visibleTestId(page, "host-details-route").waitFor({ state: "visible", timeout: 15_000 });
}

async function assertCapabilityText(page, expectedText, language) {
  const hostDetails = visibleTestId(page, "host-details-route");
  assert.equal(await hostDetails.count(), 1, "exactly one Host Details route must be visible");
  const testIdStatus = hostDetails.getByTestId("host-capability-browser-status");
  let status;
  if (await testIdStatus.count()) {
    status = (await testIdStatus.innerText()).trim();
  } else {
    const browserLabel = language === "zh-CN" ? "浏览器" : "Browser";
    const statusTokens = language === "zh-CN" ? ["可用", "未提供", "未确认"] : ["Available", "Not provided", "Unknown"];
    const browserLabelLocator = hostDetails.getByText(browserLabel, { exact: true });
    assert.ok(await browserLabelLocator.count(), `Host Details must render the exact ${browserLabel} capability label`);
    status = await browserLabelLocator.first().evaluate((label, options) => {
      let ancestor = label.parentElement;
      while (ancestor && ancestor !== document.body) {
        const text = (ancestor.innerText || ancestor.textContent || "").replace(/\s+/g, " ").trim();
        if (text.includes(options.browserLabel)) {
          const found = options.statusTokens.find(token => text.includes(token));
          if (found) return found;
        }
        ancestor = ancestor.parentElement;
      }
      return null;
    }, { browserLabel, statusTokens });
  }
  assert.equal(status, expectedText,
    `Host capability status should be ${expectedText}; received ${status}`);
}

async function hostDetailsBackground(page) {
  const host = visibleTestId(page, "host-details-route");
  await host.waitFor({ state: "visible", timeout: 15_000 });
  const background = await host.evaluate(element => getComputedStyle(element).backgroundColor);
  assert.match(background, /^rgb\(/, "Host Details must render a concrete theme background color");
  return background;
}

async function assertOpenProjectChoices(route, language) {
  const choices = language === "zh-CN"
    ? ["选择现有目录", "新建目录", "新建 Git worktree"]
    : ["Select existing directory", "Create directory", "Create Git worktree"];
  for (const label of choices) {
    const option = route.getByText(label, { exact: true });
    assert.equal(await option.count(), 1, `Open Project must retain the ${label} operation`);
    await option.waitFor({ state: "visible", timeout: 10_000 });
  }
}

async function returnHomeFromHost(page, language) {
  const back = language === "zh-CN" ? "返回" : "Back";
  await visibleByLabel(page, back).click();
  await visibleTestId(page, "settings-detail-back").first().click();
  await visibleTestId(page, "settings-detail-back").first().click();
  await waitForHome(page);
}

async function openBrowserSettings(page, targetId, language) {
  await visibleByLabel(page, language === "zh-CN" ? "设置" : "Settings").click();
  await visibleTestId(page, "settings-home").first().waitFor({ state: "visible", timeout: 15_000 });
  await visibleTestId(page, "settings-section-browser").click();
  await visibleTestId(page, "settings-section-screen").waitFor({ state: "visible", timeout: 15_000 });
  const selector = visibleTestId(page, "settings-runtime-target-selector");
  await selector.click();
  await visibleTestId(page, `settings-runtime-target-option-${targetId}`).click();
  await visibleTestId(page, "settings-browser-target").waitFor({ state: "visible", timeout: 30_000 });
}

async function returnHomeFromSettings(page) {
  await visibleTestId(page, "settings-detail-back").first().click();
  await visibleTestId(page, "settings-detail-back").first().click();
  await waitForHome(page);
}

async function setVariant(page, { width, language, theme }) {
  await page.setViewportSize({ width, height: 844 });
  const value = preferencesValue(language, theme);
  await page.evaluate(({ key, preferences }) => localStorage.setItem(key, preferences), {
    key: PREF_KEY,
    preferences: value,
  });
  const persisted = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), PREF_KEY);
  assert.equal(persisted?.language, language);
  assert.equal(persisted?.theme, theme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForHome(page);
}

async function waitForHome(page) {
  await page.locator('[data-testid="new-workspace"]:visible').first().waitFor({ state: "visible", timeout: 30_000 });
}

async function capture(page, context, fileName, beforeCapture) {
  if (beforeCapture) await beforeCapture();
  await page.evaluate(async () => { await document.fonts?.ready; });
  await page.screenshot({ path: context.pathInArtifacts(fileName), animations: "disabled" });
}

function profileIdFromUrl(value) {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[0] === "h" ? decodeURIComponent(parts[1] ?? "") : url.searchParams.get("profileId");
}

function taskIdentityFromUrl(value) {
  const parts = new URL(value).pathname.split("/").filter(Boolean);
  const taskIndex = parts.indexOf("task");
  assert.ok(taskIndex >= 0 && parts[taskIndex + 1] && parts[taskIndex + 2], "expected a real Mobile task route");
  return {
    profileId: decodeURIComponent(parts[1] ?? ""),
    serverId: decodeURIComponent(parts[taskIndex + 1]),
    threadId: decodeURIComponent(parts[taskIndex + 2]),
  };
}

function sanitizeRoute(url) {
  return { pathname: url.pathname, searchParams: Object.fromEntries(url.searchParams.entries()) };
}

function summarizeStatuses(statuses) {
  return statuses.map(item => ({
    id: item.id,
    status: item.status,
    browserSessions: item.capabilities?.experimental?.browserSessions ?? null,
    capabilitiesPresent: Boolean(item.capabilities?.experimental),
    latencyMs: Number.isFinite(item.latencyMs) ? item.latencyMs : null,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function assertStatus(statuses, id, expectedStatus, expectedCapability) {
  const row = statuses.find(item => item.id === id);
  assert.ok(row, `status response must contain ${id}`);
  assert.equal(row.status, expectedStatus, `${id} status must come from live Gateway health probing`);
  assert.equal(row.browserSessions, expectedCapability,
    `${id} browserSessions must come from the current app-server initialize response`);
}

function parseFrames(payload) {
  try {
    const value = JSON.parse(String(payload));
    return Array.isArray(value) ? value : [value];
  } catch { return []; }
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function hashRegularTree(root) {
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "bundle must be a physical directory");
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), "bundle must not contain symlinks");
      if (info.isDirectory()) await visit(path);
      else {
        assert.ok(info.isFile(), "bundle must contain only regular files");
        const bytes = await readFile(path);
        files.push({ path: relative(root, path).split(sep).join("/"), size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

async function copyRegularTree(sourceRoot, destinationRoot) {
  const rootInfo = await lstat(sourceRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "bundle source must be a physical directory");
  await mkdir(destinationRoot, { mode: 0o700 });
  async function visit(sourceDirectory, destinationDirectory) {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = resolve(sourceDirectory, entry.name);
      const destinationPath = resolve(destinationDirectory, entry.name);
      const info = await lstat(sourcePath);
      assert.ok(!info.isSymbolicLink(), "bundle source must not contain symlinks");
      if (info.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        await visit(sourcePath, destinationPath);
      } else {
        assert.ok(info.isFile(), "bundle source must contain only regular files");
        await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      }
    }
  }
  await visit(sourceRoot, destinationRoot);
}
