import assert from "node:assert/strict";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { runE2E } from "../harness/run-context.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";
import {
  buildGatewayMobileWebManifest,
  writeGatewayMobileWebManifest,
} from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";

process.umask(0o077);

const TARGET_ID = "sessions-fixture-target";
const TARGET_LABEL = "Sessions Fixture Target";
const EXTRA_WORKSPACE_LABEL = "Registered Project Fixture";
const SECRET_MARKERS = {
  catalog: "RAW_DIRECTORY_FAILURE_SECRET_7f3a9c",
  thread: "RAW_THREAD_FAILURE_SECRET_2d8b41",
};
const APPEARANCE_MATRIX = [
  { language: "en", htmlLanguage: "en", theme: "light" },
  { language: "zh-CN", htmlLanguage: "zh-CN", theme: "light" },
  { language: "en", htmlLanguage: "en", theme: "dark" },
  { language: "zh-CN", htmlLanguage: "zh-CN", theme: "dark" },
];
const FAILURE_CASES = [
  { kind: "catalog", slug: "directory-catalog" },
  { kind: "thread", slug: "default-thread-list" },
];

await runE2E(import.meta.url, {
  testId: "mobile-sessions-workspace-failure-model-independent",
  tier: "full-integration",
  modelPolicy: "real current-source Mobile Web Sessions UI on an isolated KCODER_STUDIO_MOCK Gateway; bounded WebSocket directory/thread-list error fixtures; no app-server or model provider",
  retainSuccessEvidence: true,
  evidenceReason: "Sessions must report target-scoped directory failures safely while retaining successful session rows across supported locales and themes",
}, async context => {
  for (const marker of Object.values(SECRET_MARKERS)) context.registerSecret(marker);

  const mobileWeb = await exportMobileWeb(context, {
    label: "mobile-sessions-workspace-failure-current-export",
    outputName: "mobile-sessions-workspace-failure-mobile-web",
    deployMount: true,
  });
  const mobileManifest = await buildGatewayMobileWebManifest(mobileWeb.path, {
    expectedFiles: mobileWeb.bundleFiles,
  });
  await writeGatewayMobileWebManifest(mobileWeb.path, mobileManifest);
  const retainedBundle = context.pathInArtifacts("mobile-web-export");
  await cp(mobileWeb.path, retainedBundle, { recursive: true, errorOnExist: true, force: false });

  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "mobile-sessions-workspace-failure",
  });
  const extraWorkspace = resolve(workspace, "registered-project");
  await mkdir(extraWorkspace, { recursive: true, mode: 0o700 });
  const configDir = context.pathInState("gateway-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("gateway-config/settings.jsonc", {});
  const serversFile = await context.writeStateJson("sessions-fixture-servers.json", [{
    id: TARGET_ID,
    label: TARGET_LABEL,
    runtime: "kcoder",
    transport: "local",
    command: process.execPath,
    workspace,
  }]);
  const gateway = await startGateway(context, {
    label: "mobile-sessions-workspace-failure-gateway",
    auth: true,
    workspace,
    serversFile,
    serversStore: context.pathInState("gateway-servers-store.json"),
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWeb.path,
    },
  });
  const chromium = await startChromium(context, {
    label: "mobile-sessions-workspace-failure-chromium",
  });
  const page = await chromium.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
  });
  let pageErrorCount = 0;
  page.on("pageerror", () => { pageErrorCount += 1; });

  const mountResponse = await page.goto(`${gateway.baseUrl}/mobile/`, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(mountResponse?.status(), 200, "the isolated Gateway must serve the official Mobile Web mount");
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  const profileId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1) ?? "");
  assert.ok(profileId, "the isolated direct connection must create an owned Mobile profile");

  let activeFault = null;
  await page.routeWebSocket("**/rpc*", routed => {
    const urlValue = typeof routed.url === "function" ? routed.url() : routed.url;
    const workspacePath = typeof urlValue === "string" ? new URL(urlValue).searchParams.get("workspace") : null;
    const upstream = routed.connectToServer();
    routed.onMessage(raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      if (!activeFault || typeof frame?.method !== "string") {
        upstream.send(raw);
        return;
      }
      if (frame.method === "runtime.workspaces.list" && activeFault.kind === "catalog") {
        activeFault.catalogFailureRequests += 1;
        activeFault.targetIds.push(typeof frame.params?.deviceId === "string" ? frame.params.deviceId : null);
        routed.send(JSON.stringify({
          jsonrpc: frame.jsonrpc || "2.0",
          id: frame.id,
          error: { code: -32000, message: SECRET_MARKERS.catalog },
        }));
        return;
      }
      if (frame.method === "runtime.workspaces.list" && activeFault.kind === "thread") {
        activeFault.catalogSuccessRequests += 1;
        routed.send(JSON.stringify({
          jsonrpc: frame.jsonrpc || "2.0",
          id: frame.id,
          result: {
            success: true,
            items: [{ workspacePath: extraWorkspace, label: EXTRA_WORKSPACE_LABEL }],
            pinnedTaskIds: [],
            taskOrders: {},
          },
        }));
        return;
      }
      if (frame.method === "thread/list") {
        activeFault.threadListWorkspacePaths.push(workspacePath);
        if (activeFault.kind === "thread" && workspacePath === workspace) {
          activeFault.defaultThreadFailures += 1;
          routed.send(JSON.stringify({
            jsonrpc: frame.jsonrpc || "2.0",
            id: frame.id,
            error: { code: -32000, message: SECRET_MARKERS.thread },
          }));
          return;
        }
        if (activeFault.kind === "thread" && workspacePath === extraWorkspace) {
          activeFault.extraThreadSuccesses += 1;
        }
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => routed.send(raw));
  });

  const evidence = [];
  for (const appearance of APPEARANCE_MATRIX) {
    await setAppearance(page, gateway.baseUrl, appearance);
    for (const failureCase of FAILURE_CASES) {
      const fault = {
        kind: failureCase.kind,
        catalogFailureRequests: 0,
        catalogSuccessRequests: 0,
        defaultThreadFailures: 0,
        extraThreadSuccesses: 0,
        threadListWorkspacePaths: [],
        targetIds: [],
      };
      activeFault = fault;
      const sessionsUrl = `${gateway.baseUrl}/mobile/sessions?profileId=${encodeURIComponent(profileId)}`;
      const response = await page.goto(sessionsUrl, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200, "Sessions deep link must load from the isolated Gateway");

      const noticeTestId = failureCase.kind === "catalog" ? "sessions-load-notice" : "sessions-load-error";
      const notice = page.getByTestId(noticeTestId);
      await notice.waitFor({ state: "visible", timeout: 20_000 });
      await page.getByTestId("sessions-list").waitFor({ state: "visible", timeout: 20_000 });
      const retainedRow = page.getByTestId("session-row-mock-active-session");
      await retainedRow.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await retainedRow.count(), 1, "one successful Gateway mock session must remain visible");
      const noticeText = await notice.innerText();
      assert.ok(noticeText.includes(TARGET_LABEL), "the failure summary must identify the affected target");
      const visibleText = await page.locator("body").innerText();
      const rawErrorMarker = SECRET_MARKERS[failureCase.kind];
      assert.equal(visibleText.includes(rawErrorMarker), false, "raw RPC error detail must never appear in visible page text");
      assert.equal((await page.locator("body").textContent())?.includes(rawErrorMarker) ?? false, false,
        "raw RPC error detail must not be retained in the rendered DOM");
      assert.equal(visibleText.includes(appearance.language === "en" ? "No tasks yet" : "暂无任务"), false,
        "a retained successful row must not be paired with a false empty-list state");

      if (failureCase.kind === "catalog") {
        assert.ok(noticeText.includes(appearance.language === "en" ? "Could not load projects" : "无法读取"),
          "directory catalog errors must use the localized workspace-resolution summary");
        assert.ok((await notice.textContent())?.includes(workspace),
          "directory summary must identify the attempted default directory");
        assert.ok(fault.catalogFailureRequests > 0, "the browser must observe the injected directory catalog failure");
        assert.ok(fault.targetIds.every(targetId => targetId === TARGET_ID), "directory failure must be scoped to the fixture target");
        assert.ok(fault.threadListWorkspacePaths.includes(workspace), "the successful default thread/list request must reach the Gateway mock");
      } else {
        assert.ok(noticeText.includes(appearance.language === "en" ? "session list is incomplete" : "会话列表不完整"),
          "thread/list errors must use the localized partial-list summary");
        assert.ok((await notice.textContent())?.includes(workspace),
          "thread/list summary must identify the affected default directory");
        assert.ok(fault.catalogSuccessRequests > 0, "the browser must observe a registered extra workspace");
        assert.ok(fault.defaultThreadFailures > 0, "the default workspace thread/list failure must be injected");
        assert.ok(fault.extraThreadSuccesses > 0, "the extra workspace thread/list must reach the Gateway mock successfully");
        const rowLabel = await page.getByTestId("session-mock-active-session").getAttribute("aria-label");
        assert.ok(rowLabel?.includes(extraWorkspace), "the retained row must belong to the successful extra workspace");
      }

      const caseEvidence = {
        failureCase: failureCase.kind,
        language: appearance.language,
        theme: appearance.theme,
        noticeTestId,
        noticeVisible: true,
        targetLabelVisible: noticeText.includes(TARGET_LABEL),
        retainedMockSessionVisible: true,
        rawErrorMarkerVisible: false,
        fixtureObservations: {
          catalogFailureRequests: fault.catalogFailureRequests,
          defaultThreadFailures: fault.defaultThreadFailures,
          extraThreadSuccesses: fault.extraThreadSuccesses,
          successfulDefaultThreadListObserved: fault.threadListWorkspacePaths.includes(workspace),
          targetIdsMatch: fault.targetIds.every(targetId => targetId === TARGET_ID),
        },
        screenshots: [],
      };
      for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
        await page.setViewportSize(viewport);
        await notice.waitFor({ state: "visible", timeout: 5_000 });
        await retainedRow.waitFor({ state: "visible", timeout: 5_000 });
        const horizontalOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
        assert.equal(horizontalOverflow, 0, `${viewport.width}px Sessions view must not scroll horizontally`);
        const screenshot = `sessions-${failureCase.slug}-${appearance.language}-${appearance.theme}-${viewport.width}.png`;
        await page.screenshot({ path: context.pathInArtifacts(screenshot), animations: "disabled" });
        caseEvidence.screenshots.push({
          viewport,
          horizontalOverflow,
          screenshot,
        });
      }
      evidence.push(caseEvidence);
      activeFault = null;
    }
  }

  assert.equal(pageErrorCount, 0, "the Mobile Web page must not raise uncaught runtime errors");
  const result = {
    testId: "mobile-sessions-workspace-failure-model-independent",
    officialMobileWebExport: {
      bundleSha256: mobileWeb.bundleSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      sharedAndMobileSourceRoots: mobileWeb.sourceRoots,
      gatewayManifestFileCount: mobileManifest.files.length,
      retainedBundle: "artifacts/mobile-web-export",
    },
    gateway: {
      mode: "KCODER_STUDIO_MOCK=1",
      isolated: true,
      realAppServerSpawned: false,
      modelProviderRequests: 0,
      mobileProfilePairedThroughMountedUI: true,
    },
    targetId: TARGET_ID,
    targetLabel: TARGET_LABEL,
    pageErrors: pageErrorCount,
    cases: evidence,
  };
  await context.writeArtifactJson("mobile-sessions-workspace-failure.json", result);
  return result;
});

async function setAppearance(page, gatewayBaseUrl, { language, htmlLanguage, theme }) {
  await page.goto(`${gatewayBaseUrl}/mobile/settings-appearance`, { waitUntil: "domcontentloaded" });
  const appearance = page.getByTestId("settings-appearance-screen");
  await appearance.waitFor({ state: "visible", timeout: 15_000 });

  await appearance.getByTestId("settings-theme-row").click();
  const themeSheet = page.getByTestId("settings-choice-sheet-theme").locator('[role="dialog"]');
  await themeSheet.waitFor({ state: "visible", timeout: 10_000 });
  await themeSheet.getByTestId(`settings-theme-choice-${theme}`).click();
  await themeSheet.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, theme, { timeout: 10_000 });

  await appearance.getByTestId("settings-language-row").click();
  const languageSheet = page.getByTestId("settings-choice-sheet-language").locator('[role="dialog"]');
  await languageSheet.waitFor({ state: "visible", timeout: 10_000 });
  const languageChoice = language === "en" ? "settings-language-choice-en" : "settings-language-choice-zh-cn";
  await languageSheet.getByTestId(languageChoice).click();
  await languageSheet.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForFunction(expected => document.documentElement.lang === expected, htmlLanguage, { timeout: 10_000 });
}
