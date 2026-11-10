import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import {
  captureMobileExportSourceSnapshot,
  verifyMobileExportSourceSnapshot,
} from "../harness/mobile-export-source-snapshot.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";
import { appRoot, repoRoot, runE2E } from "../harness/run-context.mjs";

const BASE_HEAD = "4d274283cc4f90a97713ec32149fe37a9bbebe03";
const BASE_KCODER_SHA256 = "fbc9ed6e88c1233fed5959c0555e020be55f799f4c8cae7110d6d071493e5835";
const MOBILE_DEPENDENCY_TREE_SHA256 = "78f1560d4e059d203989bc3e799b73e6fa3aa7cc98d0b04c2d22b594e0912a27";
const DEFAULT_BASE_REPO_ROOT = resolve(repoRoot, "../Kunlun-Code-CYX-phone-pairing-before-origin-20261013");
const DEFAULT_DEPENDENCY_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX-mobile-deps-origin-20261013/apps/kcoder-studio/mobile/node_modules";
const execFileAsync = promisify(execFile);
const preferenceKey = "kcoder-studio:mobile-app-preferences:v1";
process.umask(0o077);

await runE2E(
  import.meta.url,
  {
    testId: "mobile-pairing-connection-visual",
    tier: "one-off-acceptance",
    modelPolicy: "paired model-independent Mobile Web connection UI through isolated real Gateways; no Provider request, credential-bearing QR or physical camera claim",
    retainSuccessLogs: true,
  },
  async (context) => {
    const baseRepoRoot = resolve(
      process.env.KCODER_E2E_MOBILE_PAIR_BASE_REPO_ROOT || DEFAULT_BASE_REPO_ROOT,
    );
    const baseMobileRoot = resolve(baseRepoRoot, "apps/kcoder-studio/mobile");
    const afterMobileRoot = resolve(appRoot, "mobile");
    const dependencyRoot = resolve(
      process.env.KCODER_E2E_MOBILE_PAIR_DEPENDENCY_ROOT || DEFAULT_DEPENDENCY_ROOT,
    );
    const kcoderBin = resolve(baseRepoRoot, "target/debug/kcoder");
    const expectedKcoderSha256 = process.env.KCODER_E2E_MOBILE_PAIR_KCODER_SHA256;
    const expectedDependencyTreeSha256 = process.env.KCODER_E2E_MOBILE_PAIR_DEPENDENCY_SHA256;
    assert.equal(expectedKcoderSha256, BASE_KCODER_SHA256,
      "the explicit runtime SHA pin must match the verified base-source KCoder build");
    assert.equal(expectedDependencyTreeSha256, MOBILE_DEPENDENCY_TREE_SHA256,
      "the explicit dependency SHA pin must match the previously verified Mobile dependency tree");

    const [baseHead, baseStatus, baseGatewayStatus, baseRustStatus, afterHead, afterStatus, afterGatewayStatus, afterRustStatus, baseMobileReal, afterMobileReal, dependencyReal, kcoderReal] = await Promise.all([
      gitValue(baseRepoRoot, ["rev-parse", "HEAD"]),
      gitValue(baseRepoRoot, ["status", "--porcelain", "--", "apps/kcoder-studio/mobile", "apps/kcoder-studio/shared"]),
      gitValue(baseRepoRoot, ["status", "--porcelain", "--", "apps/kcoder-studio/dev-server.mjs", "apps/kcoder-studio/gateway"]),
      gitValue(baseRepoRoot, ["status", "--porcelain", "--", "Cargo.toml", "Cargo.lock", ".cargo/config.toml", "build.rs", "crates"]),
      gitValue(repoRoot, ["rev-parse", "HEAD"]),
      gitValue(repoRoot, ["status", "--porcelain", "--", "apps/kcoder-studio/mobile", "apps/kcoder-studio/shared"]),
      gitValue(repoRoot, ["status", "--porcelain", "--", "apps/kcoder-studio/dev-server.mjs", "apps/kcoder-studio/gateway"]),
      gitValue(repoRoot, ["status", "--porcelain", "--", "Cargo.toml", "Cargo.lock", ".cargo/config.toml", "build.rs", "crates"]),
      realpath(baseMobileRoot),
      realpath(afterMobileRoot),
      realpath(dependencyRoot),
      realpath(kcoderBin),
    ]);
    assert.equal(baseHead, BASE_HEAD, "before source must be the clean origin/main 4d274283 base");
    assert.equal(baseStatus, "", "before Mobile and shared source must be clean at the base commit");
    assert.equal(baseGatewayStatus, "", "base Gateway source must be clean at the base commit");
    assert.equal(baseRustStatus, "", "base Rust app-server source and lockfile must be clean at the base commit");
    assert.equal(afterHead, baseHead, "after exporter checkout must share the base Gateway source commit");
    assert.equal(afterGatewayStatus, "", "after-run Gateway source must stay clean and shared with the base");
    assert.equal(afterRustStatus, "", "after-run Rust source and lockfile must stay clean and shared with the base");
    assert.equal(baseMobileReal, baseMobileRoot, "before Mobile source path must not traverse a symlink");
    assert.equal(afterMobileReal, afterMobileRoot, "after Mobile source path must not traverse a symlink");
    assert.equal(dependencyReal, dependencyRoot, "dependency pin must resolve to the selected physical path");
    assert.equal(kcoderReal, kcoderBin, "KCoder executable path must not traverse a symlink");
    assert.match(expectedKcoderSha256 || "", /^[a-f0-9]{64}$/,
      "the base-source Gateway binary SHA-256 must be provided as an explicit run pin");

    const kcoderInfo = await lstat(kcoderBin);
    assert.ok(kcoderInfo.isFile() && !kcoderInfo.isSymbolicLink(), "Gateway KCoder executable must be a regular file");
    const kcoderSha256 = await hashFile(kcoderBin);
    assert.equal(kcoderSha256, expectedKcoderSha256,
      "Gateway KCoder executable must match the separately built base-source binary pin");
    const [cargoVersionResult, rustcVersionResult, kcoderVersionResult] = await Promise.all([
      execFileAsync("cargo", ["--version"], {
        cwd: baseRepoRoot, encoding: "utf8", timeout: 10_000, maxBuffer: 1_024 * 1_024,
      }),
      execFileAsync("rustc", ["--version"], {
        cwd: baseRepoRoot, encoding: "utf8", timeout: 10_000, maxBuffer: 1_024 * 1_024,
      }),
      execFileAsync(kcoderBin, ["--version"], {
        cwd: baseRepoRoot, encoding: "utf8", timeout: 10_000, maxBuffer: 1_024 * 1_024,
      }),
    ]);
    const runtimeProvenance = {
      sourceCommit: baseHead,
      sourceStatus: baseRustStatus,
      gatewaySourceStatus: baseGatewayStatus,
      worktree: baseRepoRoot,
      cargoTargetDirectory: resolve(baseRepoRoot, "target"),
      buildCommand: `CARGO_TARGET_DIR=${resolve(baseRepoRoot, "target")} cargo build --locked -p kcoder_cli --bin kcoder`,
      cargoVersion: cargoVersionResult.stdout.trim(),
      rustcVersion: rustcVersionResult.stdout.trim(),
      cargoLockSha256: await hashFile(resolve(baseRepoRoot, "Cargo.lock")),
      mobilePackageLockSha256: await hashFile(resolve(baseMobileRoot, "package-lock.json")),
      binaryPath: kcoderBin,
      binaryVersion: kcoderVersionResult.stdout.trim(),
      binarySha256: kcoderSha256,
      binarySha256Pin: expectedKcoderSha256,
      sharedByBeforeAndAfterGateways: true,
    };
    assert.match(runtimeProvenance.cargoVersion, /^cargo 1\.96\.1\b/);
    assert.match(runtimeProvenance.rustcVersion, /^rustc 1\.96\.1\b/);
    await context.writeArtifactJson("mobile-pairing-base-runtime-provenance.json", runtimeProvenance);

    const afterMobilePackageLockSha256 = await hashFile(resolve(afterMobileRoot, "package-lock.json"));
    assert.equal(runtimeProvenance.mobilePackageLockSha256, afterMobilePackageLockSha256,
      "before and after Mobile source must use the same npm lockfile");

    const baseSnapshotRoot = context.pathInArtifacts("source-before");
    const afterSnapshotRoot = context.pathInArtifacts("source-after");
    const baseSnapshot = await captureMobileExportSourceSnapshot({
      sourceRoots: mobileRoots(baseMobileRoot),
      snapshotRoot: baseSnapshotRoot,
      layout: "preflight-source-root",
      freezeFiles: true,
    });
    const afterSnapshot = await captureMobileExportSourceSnapshot({
      sourceRoots: mobileRoots(afterMobileRoot),
      snapshotRoot: afterSnapshotRoot,
      layout: "preflight-source-root",
      freezeFiles: true,
    });
    assert.notEqual(afterSnapshot.sourceTreeSha256, baseSnapshot.sourceTreeSha256,
      "after Mobile source must include the frozen L1 pairing changes");

    const baseExport = await exportMobileWeb(context, {
      mobileRoot: baseMobileRoot,
      sourceRoots: mobileRoots(baseMobileRoot),
      dependencyRoot,
      label: "mobile-pairing-before-export",
      outputName: "mobile-pairing-before-web",
      stateNamespace: "mobile-pairing-before-export-state",
      timeoutMs: 10 * 60_000,
      overallTimeoutMs: 45 * 60_000,
    });
    const afterExport = await exportMobileWeb(context, {
      mobileRoot: afterMobileRoot,
      sourceRoots: mobileRoots(afterMobileRoot),
      dependencyRoot,
      label: "mobile-pairing-after-export",
      outputName: "mobile-pairing-after-web",
      stateNamespace: "mobile-pairing-after-export-state",
      timeoutMs: 10 * 60_000,
      overallTimeoutMs: 45 * 60_000,
    });
    assert.equal(baseExport.sourceTreeSha256, baseSnapshot.sourceTreeSha256);
    assert.equal(afterExport.sourceTreeSha256, afterSnapshot.sourceTreeSha256);
    const baseExporterManifest = JSON.parse(await readFile(baseExport.bundleManifestPath, "utf8"));
    const afterExporterManifest = JSON.parse(await readFile(afterExport.bundleManifestPath, "utf8"));
    for (const [name, exported, manifest] of [
      ["baseline", baseExport, baseExporterManifest],
      ["after", afterExport, afterExporterManifest],
    ]) {
      assert.equal(manifest.status, "complete", `${name} Mobile Web export must complete`);
      assert.equal(manifest.dependencyProvenance?.sourceUnchanged, true,
        `${name} dependency source must remain unchanged during export`);
      assert.equal(manifest.dependencyProvenance?.sourceTreeSha256Before, exported.dependencySourceTreeSha256);
      assert.equal(manifest.dependencyProvenance?.sourceTreeSha256After, exported.dependencySourceTreeSha256);
    }
    assert.equal(baseExport.dependencySourceTreeSha256, afterExport.dependencySourceTreeSha256,
      "before and after must use the exact same dependency tree");
    assert.equal(baseExport.dependencySourceTreeSha256, expectedDependencyTreeSha256,
      "before export must match the explicit dependency tree pin");
    assert.equal(afterExport.dependencySourceTreeSha256, expectedDependencyTreeSha256,
      "after export must match the explicit dependency tree pin");
    await verifyMobileExportSourceSnapshot({
      snapshot: baseSnapshot,
      snapshotRoot: baseSnapshotRoot,
      sourceRoots: mobileRoots(baseMobileRoot),
      exported: baseExport,
      exporterManifest: baseExporterManifest,
    });
    await verifyMobileExportSourceSnapshot({
      snapshot: afterSnapshot,
      snapshotRoot: afterSnapshotRoot,
      sourceRoots: mobileRoots(afterMobileRoot),
      exported: afterExport,
      exporterManifest: afterExporterManifest,
    });

    await context.writeArtifactJson("mobile-pairing-source-and-export-provenance.json", {
      schemaVersion: 1,
      evidenceClass: "same RunContext and pinned dependencies; pre-export source snapshots are checked against the exporter's independently copied inputs before real Gateway UI flows",
      before: {
        head: baseHead,
        mobileAndSharedStatus: "clean",
        sourceTreeSha256: baseSnapshot.sourceTreeSha256,
        sourceFileCount: baseSnapshot.fileCount,
        sourceByteCount: baseSnapshot.byteCount,
        exporterManifest: relativeArtifactPath(context, baseExport.bundleManifestPath),
        bundleSha256: baseExport.bundleSha256,
        bundleFileCount: baseExport.bundleFileCount,
        indexHtmlSha256: baseExport.indexHtmlSha256,
      },
      after: {
        head: afterHead,
        mobileAndSharedStatus: afterStatus,
        sourceTreeSha256: afterSnapshot.sourceTreeSha256,
        sourceFileCount: afterSnapshot.fileCount,
        sourceByteCount: afterSnapshot.byteCount,
        exporterManifest: relativeArtifactPath(context, afterExport.bundleManifestPath),
        bundleSha256: afterExport.bundleSha256,
        bundleFileCount: afterExport.bundleFileCount,
        indexHtmlSha256: afterExport.indexHtmlSha256,
      },
      dependencies: {
        selectedRoot: dependencyRoot,
        realRoot: dependencyReal,
        mobilePackageLockSha256: runtimeProvenance.mobilePackageLockSha256,
        treeSha256BeforeExports: baseExport.dependencySourceTreeSha256,
        sourceTreeSha256AfterBeforeExport: baseExport.dependencySourceTreeSha256,
        sourceTreeSha256AfterAfterExport: afterExport.dependencySourceTreeSha256,
      },
      gatewayRuntime: runtimeProvenance,
      viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
      locale: "zh-CN",
      theme: "light",
      physicalCameraExercised: false,
      paidProviderCalled: false,
    });

    const chromium = await startChromium(context, { label: "mobile-pairing-visual-chromium" });
    const beforeWorkspace = await materializeWorkspace(context, "minimal", { instanceId: "pairing-before" });
    const afterWorkspace = await materializeWorkspace(context, "minimal", { instanceId: "pairing-after" });
    assert.equal(beforeWorkspace.sourceDigest, afterWorkspace.sourceDigest,
      "before and after Gateways must use identical generated workspace fixture data");

    const before = await runPairingLane(context, {
      label: "before",
      variant: "base",
      webRoot: baseExport.path,
      workspace: beforeWorkspace.path,
      workspaceSourceDigest: beforeWorkspace.sourceDigest,
      sourceTreeSha256: baseExport.sourceTreeSha256,
      bundleSha256: baseExport.bundleSha256,
      kcoderBin,
      kcoderSha256,
      browser: chromium.browser,
    });
    const after = await runPairingLane(context, {
      label: "after",
      variant: "l1-frozen",
      webRoot: afterExport.path,
      workspace: afterWorkspace.path,
      workspaceSourceDigest: afterWorkspace.sourceDigest,
      sourceTreeSha256: afterExport.sourceTreeSha256,
      bundleSha256: afterExport.bundleSha256,
      kcoderBin,
      kcoderSha256,
      browser: chromium.browser,
    });
    await context.stopOwned("mobile-pairing-visual-chromium");

    assert.equal(before.sessionExchange.status, 200);
    assert.equal(after.sessionExchange.status, 200);
    assert.equal(before.sessionExchange.requestCount, 1);
    assert.equal(after.sessionExchange.requestCount, 1);
    assert.equal(before.workspaceSourceDigest, after.workspaceSourceDigest);
    assert.equal(await hashFile(kcoderBin), expectedKcoderSha256,
      "the shared Gateway runtime binary must remain unchanged through both UI lanes");
    assert.equal(await gitValue(baseRepoRoot, ["rev-parse", "HEAD"]), BASE_HEAD,
      "base Gateway source commit must remain fixed through both UI lanes");
    await context.writeArtifactJson("mobile-pairing-visual-pair.json", {
      schemaVersion: 1,
      result: "passed",
      comparison: "same visible pairing goal, matching 390x844 zh-CN/light browser context, same materialized workspace template and dependency pin; baseline follows the visible Web QR fallback while after uses the promoted paste entry",
      before,
      after,
      gatewayRuntime: runtimeProvenance,
      gatewayRuntimeHashVerifiedAtStartAndEnd: true,
      cleanupEvidence: "RunContext owns both Gateways, Chromium, browser contexts, workspace fixtures and revokes each generated Mobile session before shutdown",
      limitation: "Chromium Mobile Web has no physical camera; this does not verify Android/iOS camera permission, QR decoding or real-phone pairing",
    });
    return {
      pairedGatewaySessionExchange: true,
      beforeBundleSha256: baseExport.bundleSha256,
      afterBundleSha256: afterExport.bundleSha256,
      dependencyTreeSha256: baseExport.dependencySourceTreeSha256,
      beforeSourceTreeSha256: baseSnapshot.sourceTreeSha256,
      afterSourceTreeSha256: afterSnapshot.sourceTreeSha256,
      gatewayRuntimeSha256: kcoderSha256,
      beforeAndAfterSessionExchanges: [before.sessionExchange, after.sessionExchange],
      screenshotFiles: [...before.screenshots, ...after.screenshots],
    };
  },
);

async function runPairingLane(context, {
  label,
  variant,
  webRoot,
  workspace,
  workspaceSourceDigest,
  sourceTreeSha256,
  bundleSha256,
  kcoderBin,
  kcoderSha256,
  browser,
}) {
  const gatewayLabel = `mobile-pairing-${label}-gateway`;
  const gateway = await startGateway(context, {
    auth: true,
    label: gatewayLabel,
    workspace,
    kcoderBin,
    env: { KCODER_STUDIO_WEB_ROOT: webRoot },
  });
  const browserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  context.addCleanup(`close mobile pairing ${label} browser context`, () => browserContext.close());
  await browserContext.addInitScript((key) => {
    if (localStorage.getItem(key) === null) {
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
    }
  }, preferenceKey);
  const page = await browserContext.newPage();
  const diagnostics = [];
  const externalQrRequests = [];
  const sessionExchangeRequests = [];
  const sessionExchangeResponses = [];
  const writeSessionExchangeEvidence = async (outcome) => {
    const response = sessionExchangeResponses.at(-1);
    await writeFile(
      context.pathInArtifacts(`mobile-pairing-${label}-session-exchange.json`),
      `${JSON.stringify({
        method: "POST",
        path: "/api/mobile/session",
        requestCount: sessionExchangeRequests.length,
        responses: sessionExchangeResponses,
        status: response?.status ?? null,
        outcome,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  };
  page.on("pageerror", (error) => diagnostics.push(`pageerror:${error.name || "Error"}`));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`console:${message.type()}`);
  });
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (request.method() === "POST" && requestUrl.origin === gateway.baseUrl && requestUrl.pathname === "/api/mobile/session") {
      sessionExchangeRequests.push({ method: "POST", path: "/api/mobile/session" });
    }
    if (/jsqr|jsdelivr|unpkg|worker/i.test(requestUrl.hostname + requestUrl.pathname)) {
      externalQrRequests.push(`${requestUrl.origin}${requestUrl.pathname}`);
    }
  });
  page.on("response", (response) => {
    const responseUrl = new URL(response.url());
    if (response.request().method() === "POST" && responseUrl.origin === gateway.baseUrl && responseUrl.pathname === "/api/mobile/session") {
      sessionExchangeResponses.push({ method: "POST", path: "/api/mobile/session", status: response.status() });
    }
  });
  page.on("requestfailed", (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin === gateway.baseUrl && requestUrl.pathname === "/api/mobile/session") {
      diagnostics.push("mobile-session-request-failed");
    }
  });

  let sessionAccessToken = null;
  let sessionRevoked = false;
  await authenticateWebShell(page, gateway);
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-paste-pairing-link").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByText("欢迎使用 KCoder Studio", { exact: true }).count(), 1,
    `${label} welcome must be rendered in Simplified Chinese`);
  assert.equal(await page.locator('input[name="token"]').count(), 0,
    `${label} welcome screenshot must not show the Gateway access token field`);
  assert.equal(await page.getByTestId("pair-link-input").count(), 0,
    `${label} welcome screenshot must not show pairing credentials`);
  const welcomeBody = await page.locator("body").innerText();
  assert.equal(welcomeBody.includes(gateway.authToken), false,
    `${label} welcome UI must not display the Gateway access token`);
  const welcomeScreenshot = `mobile-pairing-${label}-welcome-390x844-zh-light.png`;
  await page.screenshot({ path: context.pathInArtifacts(welcomeScreenshot), animations: "disabled" });

  let fallbackScreenshot = null;
  if (variant === "base") {
    assert.equal(await page.getByTestId("welcome-scan-qr").count(), 1,
      "base Web welcome must expose the old QR-scan action");
    await page.getByTestId("welcome-scan-qr").click();
    await page.getByTestId("pairing-web-paste-link").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("当前浏览器无法使用摄像头扫码", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByTestId("pairing-camera").count(), 0,
      "Web baseline must not present a fake camera view");
    fallbackScreenshot = `mobile-pairing-${label}-web-camera-fallback-390x844-zh-light.png`;
    await page.screenshot({ path: context.pathInArtifacts(fallbackScreenshot), animations: "disabled" });
    await page.getByTestId("pairing-web-paste-link").click();
    const visibleWelcomePastePairing = page.locator('[data-testid="welcome-paste-pairing-link"]:visible');
    await visibleWelcomePastePairing.first().waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await visibleWelcomePastePairing.count(), 1,
      "baseline fallback must return to one visible Welcome pairing action");
    assert.equal(await page.getByTestId("pair-link-input").count(), 0,
      "baseline Web fallback returns to Welcome and requires a second pairing action");
    await visibleWelcomePastePairing.click();
  } else {
    assert.equal(variant, "l1-frozen");
    assert.equal(await page.getByTestId("welcome-scan-qr").count(), 0,
      "L1 Web welcome must hide the unavailable QR-scan action");
    await page.getByTestId("welcome-paste-pairing-link").click();
  }

  const pairingInput = page.getByTestId("pair-link-input");
  await pairingInput.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await pairingInput.inputValue(), "", `${label} pairing form must be blank before the generated link is entered`);
  const formScreenshot = `mobile-pairing-${label}-empty-link-form-390x844-zh-light.png`;
  await page.screenshot({ path: context.pathInArtifacts(formScreenshot), animations: "disabled" });

  if (variant === "l1-frozen") {
    await page.getByLabel("关闭").click();
    await pairingInput.waitFor({ state: "detached", timeout: 10_000 });
    await page.goto(`${gateway.baseUrl}/pair-scan`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("pairing-web-paste-link").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("pairing-web-paste-link").click();
    await pairingInput.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForURL((url) => !url.searchParams.has("connectMode"), { timeout: 10_000 });
    assert.equal(new URL(page.url()).searchParams.has("connectMode"), false,
      "L1 Web fallback must open pairing and consume its one-shot route parameter");
  }

  const pairingLink = new URL("kcoder-studio://connect");
  pairingLink.searchParams.set("gateway", gateway.baseUrl);
  pairingLink.searchParams.set("token", gateway.authToken);
  const pairingLinkText = pairingLink.toString();
  context.registerSecret(pairingLinkText);
  await pairingInput.fill(pairingLinkText);
  const visibleModalContainers = page.locator('[aria-modal="true"]:visible');
  assert.equal(await visibleModalContainers.count(), 1,
    `${label} pairing form must be inside exactly one visible modal container`);
  const pairingModal = visibleModalContainers.filter({ has: pairingInput });
  assert.equal(await pairingModal.count(), 1,
    `${label} pairing form must be inside one visible modal container`);
  assert.equal(await pairingModal.isVisible(), true,
    `${label} pairing modal container must be visible`);
  assert.equal(await pairingModal.getByTestId("pair-link-input").count(), 1,
    `${label} visible pairing modal must contain exactly one pairing input`);
  const pairConnectButton = pairingModal.getByRole("button", { name: "连接", exact: true });
  assert.equal(await pairConnectButton.count(), 1,
    `${label} pairing modal must expose one Connect action in the selected locale`);
  const pairResponsePromise = page.waitForResponse((response) => {
    const responseUrl = new URL(response.url());
    return response.request().method() === "POST" && responseUrl.origin === gateway.baseUrl &&
      responseUrl.pathname === "/api/mobile/session";
  }, { timeout: 30_000 });
  let pairResponse;
  try {
    await pairConnectButton.click();
    pairResponse = await pairResponsePromise;
  } catch (error) {
    await writeSessionExchangeEvidence("no-matching-response");
    throw error;
  }
  const sessionStatus = pairResponse.status();
  await writeSessionExchangeEvidence("response-observed");
  assert.equal(sessionStatus, 200, `${label} valid run-owned pairing link must exchange a real Gateway Mobile session`);
  assert.equal(sessionExchangeRequests.length, 1, `${label} pairing action must issue exactly one session exchange`);
  const sessionPayload = await pairResponse.json();
  for (const key of ["accessToken", "refreshToken", "rpcToken"]) {
    const credential = sessionPayload?.[key];
    if (typeof credential === "string" && credential.length >= 8) context.registerSecret(credential);
  }
  sessionAccessToken = sessionPayload?.accessToken;
  assert.equal(typeof sessionAccessToken, "string", `${label} Mobile session must return an access token`);
  assert.equal(typeof sessionPayload?.expiresAt, "number", `${label} Mobile session must return an expiry`);
  context.addCleanup(`revoke mobile pairing ${label} session`, async () => {
    if (sessionRevoked) return;
    const response = await fetch(`${gateway.baseUrl}/api/mobile/session`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${sessionAccessToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 204, `${label} run-owned Mobile session must be revoked before Gateway shutdown`);
    sessionRevoked = true;
  });
  await page.waitForURL((url) => /^\/h\/[^/]+\/?$/.test(url.pathname), { timeout: 30_000 });
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  const finalUrl = new URL(page.url());
  const connectedBody = await page.locator("body").innerText();
  const addressBarClean = !finalUrl.searchParams.has("token") && !finalUrl.href.includes(gateway.authToken) &&
    !connectedBody.includes(gateway.authToken) && !connectedBody.includes(sessionAccessToken) &&
    !(await page.locator('[data-testid="pair-link-input"]').count());
  assert.equal(addressBarClean, true, `${label} connected screen and URL must not expose pairing credentials`);
  const homeScreenshot = `mobile-pairing-${label}-connected-home-390x844-zh-light.png`;
  await page.screenshot({ path: context.pathInArtifacts(homeScreenshot), animations: "disabled" });
  const screenshotHashes = {};
  for (const screenshot of [welcomeScreenshot, fallbackScreenshot, formScreenshot, homeScreenshot].filter(Boolean)) {
    screenshotHashes[screenshot] = await hashFile(context.pathInArtifacts(screenshot));
  }
  assert.deepEqual(externalQrRequests, [], `${label} Web pairing UI must not load an external QR worker`);
  assert.deepEqual(diagnostics, [], `${label} Mobile Web pairing flow must have no browser diagnostics`);

  const revokeResponse = await fetch(`${gateway.baseUrl}/api/mobile/session`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${sessionAccessToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(revokeResponse.status, 204, `${label} generated Mobile session must be revoked`);
  sessionRevoked = true;
  await browserContext.close();
  await context.stopOwned(gatewayLabel);

  const result = {
    variant,
    sourceAndBundle: {
      mobileWebRoot: webRoot,
      sourceTreeSha256,
      bundleSha256,
    },
    gatewayRuntimeSha256: kcoderSha256,
    viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
    locale: "zh-CN",
    theme: "light",
    workspaceSourceDigest,
    visibleEntryState: variant === "base"
      ? { oldQrScanAction: true, manualPairingLinkAction: true, oldCameraFallbackSeen: true }
      : { oldQrScanAction: false, manualPairingLinkAction: true },
    sessionExchange: { method: "POST", path: "/api/mobile/session", status: sessionStatus, requestCount: sessionExchangeRequests.length },
    connectedProfileHome: true,
    addressBarAndRenderedContentExcludeCredentials: addressBarClean,
    sessionRevoked: sessionRevoked,
    screenshots: [welcomeScreenshot, fallbackScreenshot, formScreenshot, homeScreenshot]
      .filter(Boolean)
      .map((path) => ({ path, sha256: screenshotHashes[path] })),
    externalQrRequests,
    browserDiagnostics: diagnostics,
  };
  await context.writeArtifactJson(`mobile-pairing-${label}-evidence.json`, result);
  return result;
}

async function authenticateWebShell(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "owned Gateway login page must return HTTP 200");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}

function mobileRoots(mobileRoot) {
  return [
    { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(mobileRoot, "../shared"), destination: "apps/kcoder-studio/shared" },
  ];
}

async function gitValue(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

async function hashFile(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveHash(hash.digest("hex")));
  });
}

function relativeArtifactPath(context, path) {
  assert.ok(path.startsWith(`${context.runRoot}/`), "export manifest must belong to the current RunContext");
  return path.slice(context.runRoot.length + 1);
}
