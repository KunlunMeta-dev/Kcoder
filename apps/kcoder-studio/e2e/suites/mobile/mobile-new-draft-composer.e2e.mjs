import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { setExpoWebDocumentPickerFiles } from "../../harness/mobile-document-picker.mjs";
import {
  buildGatewayMobileWebManifest,
  writeGatewayMobileWebManifest,
} from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const TEST_ID = "mobile-new-draft-composer-first-send-attachments";
const KCODER_BIN = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
const PREFERENCES_KEY = "kcoder-studio:mobile-app-preferences:v1";
const QUICK_PHRASE = {
  id: "first-draft-e2e",
  title: "首条消息检查",
  content: "请先检查当前工作区，再总结图片与附件。",
};
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGOQc1j/Hxn/nmSDgkV2LEPBbzxmomCGYWAAIQWELBgOBgx8LAy8AQMfCwNuAAAEdoRfJr60FQAAAABJRU5ErkJggg==";
const ALPHA_MODEL = "draft-alpha-fixture::mobile-draft-alpha";
const ALPHA_OVERLAY_MODEL = "draft-alpha-fixture::mobile-draft-alpha-overlay";
const BETA_MODEL = "draft-beta-fixture::mobile-draft-beta";
const GAMMA_MODEL = "draft-gamma-fixture::mobile-draft-gamma";
const ASSISTANT_MARKER = "DRAFT_COMPOSER_FIXTURE_REPLY";
const PROMPT_SUFFIX = "\nDRAFT_FIRST_SEND_E2E";
const ATTACHMENT_SIDE_EFFECTS = new Set([
  "attachment/retention/reserve",
  "attachment/retention/read",
  "gateway/attachments/retain",
]);
const RETENTION_UPLOAD_PREFIX = "attachment/retention/upload/";
const MATRIX = [
  { width: 320, height: 640, language: "en", theme: "dark" },
  { width: 390, height: 844, language: "en", theme: "dark" },
  { width: 320, height: 640, language: "en", theme: "light" },
  { width: 390, height: 844, language: "en", theme: "light" },
  { width: 320, height: 640, language: "zh-CN", theme: "dark" },
  { width: 390, height: 844, language: "zh-CN", theme: "dark" },
  { width: 320, height: 640, language: "zh-CN", theme: "light" },
  { width: 390, height: 844, language: "zh-CN", theme: "light" },
];

await runE2E(
  import.meta.url,
  {
    testId: TEST_ID,
    tier: "full-integration",
    modelPolicy: "real Mobile Web, Gateway, Rust app-server and RPC across the global, Home project, and TaskScreen Drawer New Draft entry points; deterministic local Provider fixture; no scenario frames, user credentials, real Provider, or paid model calls",
    retainSuccessEvidence: true,
    retainSuccessLogs: true,
    evidenceReason: "Verify workspace-scoped model defaults, all three real New Draft entry paths, unsent exit behavior, first-send configuration, and attachment delivery through Gateway RPC acknowledgments",
  },
  async (context) => {
    const currentNodeMajor = Number(process.versions.node.split(".", 1)[0]);
    assert.equal(currentNodeMajor, 22, "this registered Mobile E2E requires Node 22");

    let stage = "workspace-fixtures";
    let pairingComplete = false;
    let preSendSideEffects = null;
    let exportPhase;
    let page = null;
    const diagnostics = { pageErrors: [], consoleErrors: [] };
    const screenshots = [];
    const rpc = createRpcObserver();
    const mobileWeb = await exportMobileWeb(context, {
      label: "mobile-new-draft-composer-export",
      outputName: "mobile-new-draft-composer-mobile-web",
      dependencyRoot: process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT || undefined,
      scratchBaseDirectory: "/tmp",
      deployMount: true,
      timeoutMs: 10 * 60 * 1000,
      onProgress: progress => {
        const next = progress.phase ?? progress.event;
        if (next !== exportPhase) {
          console.log(`[new-draft-composer] ${next}`);
          exportPhase = next;
        }
      },
    });
    const mobileManifest = await buildGatewayMobileWebManifest(mobileWeb.path, {
      expectedFiles: mobileWeb.bundleFiles,
    });
    await writeGatewayMobileWebManifest(mobileWeb.path, mobileManifest);
    const mobileManifestBytes = await readFile(resolve(mobileWeb.path, "kcoder-mobile-web.json"));

    const alphaWorkspace = await materializeWorkspace(context, "minimal", { instanceId: "new-draft-shared-workspace" });
    const alphaOverlayWorkspace = await materializeWorkspace(context, "minimal", { instanceId: "new-draft-alpha-overlay-workspace" });
    const betaWorkspace = await materializeWorkspace(context, "minimal", { instanceId: "new-draft-beta-workspace" });
    const alphaOverlaySettingsDir = resolve(alphaOverlayWorkspace.path, ".kcoder");
    await mkdir(alphaOverlaySettingsDir, { recursive: true, mode: 0o700 });
    const alphaOverlaySettingsPath = resolve(alphaOverlaySettingsDir, "settings.json");
    await writeFile(alphaOverlaySettingsPath, `${JSON.stringify({ model: "mobile-draft-alpha-overlay" }, null, 2)}\n`, { mode: 0o600 });
    const configDir = context.pathInState("config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const fixture = await startApprovalModelFixture(context, {
      textOnly: true,
      textOnlyResponse: ASSISTANT_MARKER,
    });
    const targetDefinitions = [
      { id: "alpha", label: "Alpha Target", workspace: alphaWorkspace.path, providerId: "draft-alpha-fixture", model: "mobile-draft-alpha", overlayModel: "mobile-draft-alpha-overlay" },
      { id: "beta", label: "Beta Target", workspace: betaWorkspace.path, providerId: "draft-beta-fixture", model: "mobile-draft-beta" },
      { id: "gamma", label: "Gamma Target", workspace: alphaWorkspace.path, providerId: "draft-gamma-fixture", model: "mobile-draft-gamma" },
    ];
    const servers = [];
    for (const target of targetDefinitions) {
      const settingsFile = await context.writeStateJson(`${target.id}-settings.json`, {
        active_provider: target.providerId,
        providers: {
          [target.providerId]: providerFixture(fixture.baseUrl, target.model, target.overlayModel),
        },
      });
      servers.push({
        id: target.id,
        label: target.label,
        transport: "local",
        command: KCODER_BIN,
        workspace: target.workspace,
        settingsFile,
      });
    }
    const serversFile = await context.writeStateJson("servers.json", servers);
    await context.writeStateJson("config/settings.json", {});
    const configCredentialFile = context.pathInState("config/credentials.json");
    await assert.rejects(access(configCredentialFile), (error) => error?.code === "ENOENT",
      "the isolated KCoder config must not contain a model credentials file");
    const backendBefore = await hashExecutableFile(KCODER_BIN);
    const suiteSourceSha256 = sha256(await readFile(new URL(import.meta.url)));
    const serverConfigSha256 = sha256(await readFile(serversFile));
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-new-draft-composer-gateway",
      workspace: alphaWorkspace.path,
      serversFile,
      kcoderBin: KCODER_BIN,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_TRAINING_MODE: "true",
        KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWeb.path,
      },
    });
    const previousUmask = process.umask(0o077);
    let chromium;
    try {
      chromium = await startChromium(context, {
        label: "mobile-new-draft-composer-chromium",
        noSandbox: true,
        startTimeoutMs: 60_000,
      });
    } finally {
      process.umask(previousUmask);
    }
    page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(({ key, phrase }) => {
      localStorage.setItem(key, JSON.stringify({
        language: "zh-CN",
        theme: "light",
        quickPhrases: [phrase],
      }));
    }, { key: PREFERENCES_KEY, phrase: QUICK_PHRASE });
    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.name || "Error"));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.consoleErrors.push("console error");
    });
    page.on("websocket", (socket) => rpc.observe(socket));

    try {
      stage = "welcome-manual-pairing";
      const welcome = await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      assert.equal(welcome?.status(), 200, "the isolated Gateway must serve its mounted Mobile Web entry");
      assert.equal(new URL(page.url()).pathname, "/mobile/", "pairing must start on the mounted Mobile Web Welcome screen");
      await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
      await page.getByTestId("welcome-direct-connection").click();
      await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
      await page.getByTestId("gateway-token").fill(gateway.authToken);
      const sessionResponsePromise = page.waitForResponse((response) => {
        let responseUrl;
        try { responseUrl = new URL(response.url()); } catch { return false; }
        return response.request().method() === "POST"
          && responseUrl.origin === new URL(gateway.baseUrl).origin
          && responseUrl.pathname === "/api/mobile/session";
      }, { timeout: 30_000 });
      await page.getByTestId("gateway-connect").click();
      await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
      const sessionResponse = await sessionResponsePromise;
      assert.equal(sessionResponse.status(), 200,
        "the actual Welcome pairing flow must return the authenticated Mobile session used for the owned fixture setup");
      const sessionPayload = await sessionResponse.json();
      const accessToken = sessionPayload?.accessToken;
      const rpcToken = sessionPayload?.rpcToken;
      assert.equal(typeof accessToken === "string" && accessToken.length > 0, true,
        "the paired Mobile session must provide its scoped bearer access token");
      assert.equal(typeof rpcToken === "string" && rpcToken.length > 0, true,
        "the paired Mobile session must provide its scoped runtime RPC token");
      context.registerSecret(accessToken);
      context.registerSecret(rpcToken);
      pairingComplete = true;
      const profileId = profileIdFromUrl(page.url());

      stage = "register-owned-alpha-overlay-workspace-and-model-default";
      const alphaOverlayRegistration = await registerAlphaOverlayWorkspace(context, gateway, {
        accessToken,
        rpcToken,
        workspacePath: alphaOverlayWorkspace.path,
      });

      stage = "reload-home-after-owned-alpha-overlay-registration";
      const alphaWorkspaceListResponsesBeforeReload = rpc.responses.filter(response =>
        response.method === "runtime.workspaces.list" && response.serverId === "alpha").length;
      const homeReload = await page.reload({ waitUntil: "domcontentloaded" });
      assert.equal(homeReload?.status(), 200, "the paired Mobile Home must survive a normal browser reload");
      await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(profileIdFromUrl(page.url()), profileId,
        "reloading after owned fixture registration must preserve the actual Welcome-paired profile");
      await waitFor(() => rpc.responses.filter(response => response.method === "runtime.workspaces.list"
        && response.serverId === "alpha").slice(alphaWorkspaceListResponsesBeforeReload)
        .some(response => response.success && response.result?.items?.some(item => item.workspacePath === alphaOverlayWorkspace.path)),
      30_000, "the reloaded Home to independently read the registered Alpha overlay workspace");
      const homeAlphaWorkspaceCatalog = rpc.responses.filter(response => response.method === "runtime.workspaces.list"
        && response.serverId === "alpha").slice(alphaWorkspaceListResponsesBeforeReload)
        .find(response => response.success
          && response.result?.items?.some(item => item.workspacePath === alphaOverlayWorkspace.path));
      assert.ok(homeAlphaWorkspaceCatalog?.result?.items?.some(item => item.workspacePath === alphaOverlayWorkspace.path),
        "the reloaded Home catalog must publish the exact registered overlay workspace to the real UI");

      stage = "target-isolation-alpha-beta-gamma";
      await page.getByTestId("new-workspace").click();
      await waitForDraft(page);
      await chooseProject(page, "alpha", alphaWorkspace.path);
      await assertTargetCatalog(page, rpc, "alpha", alphaWorkspace.path, ALPHA_MODEL, [BETA_MODEL, GAMMA_MODEL], ALPHA_MODEL);
      await chooseProject(page, "beta", betaWorkspace.path);
      await assertTargetCatalog(page, rpc, "beta", betaWorkspace.path, BETA_MODEL,
        [ALPHA_MODEL, ALPHA_OVERLAY_MODEL, GAMMA_MODEL], BETA_MODEL);
      await chooseProject(page, "gamma", alphaWorkspace.path);
      await assertTargetCatalog(page, rpc, "gamma", alphaWorkspace.path, GAMMA_MODEL,
        [ALPHA_MODEL, ALPHA_OVERLAY_MODEL, BETA_MODEL], GAMMA_MODEL);
      await chooseProject(page, "alpha", alphaWorkspace.path);
      await assertTargetCatalog(page, rpc, "alpha", alphaWorkspace.path, ALPHA_MODEL,
        [BETA_MODEL, GAMMA_MODEL], ALPHA_MODEL);
      await chooseProject(page, "alpha", alphaOverlayWorkspace.path);
      await assertTargetCatalog(page, rpc, "alpha", alphaOverlayWorkspace.path, ALPHA_OVERLAY_MODEL,
        [BETA_MODEL, GAMMA_MODEL], ALPHA_OVERLAY_MODEL);
      await chooseProject(page, "alpha", alphaWorkspace.path);
      await assertTargetCatalog(page, rpc, "alpha", alphaWorkspace.path, ALPHA_MODEL, [BETA_MODEL, GAMMA_MODEL], ALPHA_MODEL);
      assert.equal(rpc.sideEffectRequests().length, 0,
        "opening the draft and switching target/workspace must not create a thread, start a turn, or retain/upload attachments");

      stage = "viewport-locale-theme-project-picker-screenshots";
      let currentLanguage = "zh-CN";
      await backToHome(page, currentLanguage);
      for (let index = 0; index < MATRIX.length; index += 1) {
        const viewport = MATRIX[index];
        await setAppearanceFromHome(page, currentLanguage, viewport.language, viewport.theme);
        currentLanguage = viewport.language;
        await page.getByTestId("new-workspace").click();
        await waitForDraft(page);
        await chooseProject(page, "alpha", alphaWorkspace.path);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await assertRenderedPreferences(page, viewport.language, viewport.theme);
        await assertNoHorizontalOverflow(page, `draft ${viewport.width}px ${viewport.language} ${viewport.theme}`);
        const suffix = `${viewport.width}-${localeSlug(viewport.language)}-${viewport.theme}`;
        await captureScreenshot(page, context, screenshots, `new-draft-${suffix}.png`, viewport);
        await openProjectPicker(page);
        await assertProjectOptions(page, [
          ["alpha", alphaWorkspace.path],
          ["alpha", alphaOverlayWorkspace.path],
          ["beta", betaWorkspace.path],
          ["gamma", alphaWorkspace.path],
        ]);
        await assertNoHorizontalOverflow(page, `project picker ${viewport.width}px ${viewport.language} ${viewport.theme}`);
        await captureScreenshot(page, context, screenshots, `project-picker-${suffix}.png`, viewport);
        await closeProjectPicker(page, viewport.language);
        if (index < MATRIX.length - 1) await backToHome(page, currentLanguage);
      }
      assert.equal(screenshots.filter((shot) => shot.name.startsWith("new-draft-")).length, 8,
        "the source run must retain all eight requested New Draft layout screenshots");
      assert.equal(screenshots.filter((shot) => shot.name.startsWith("project-picker-")).length, 8,
        "the source run must retain project picker screenshots for the full viewport/locale/theme matrix");

      stage = "model-effort-and-permission-selection";
      const selectedViewport = { width: 390, height: 844, language: "zh-CN", theme: "light" };
      await chooseModelAndEffort(page, ALPHA_MODEL, "high", async () => {
        await captureScreenshot(page, context, screenshots, "model-effort-selection-390-zh-cn-light.png", selectedViewport);
      });
      await choosePermissionMode(page, "accept_edits", "zh-CN", async () => {
        await captureScreenshot(page, context, screenshots, "permission-selection-390-zh-cn-light.png", selectedViewport);
      });
      assert.equal(rpc.sideEffectRequests().length, 0,
        "model, reasoning effort, and write-capable permission selection must not create a thread before Send");

      stage = "expanded-quick-phrase-insertion";
      const initialDraft = await visibleDraftRoot(page);
      const input = initialDraft.getByTestId("message-input");
      await input.waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await page.getByTestId("composer-quick-phrases").count(), 0,
        "quick phrases must stay hidden while the composer is collapsed");
      await input.click();
      const quickPhrasesButton = page.getByTestId("composer-quick-phrases");
      await quickPhrasesButton.waitFor({ state: "visible", timeout: 10_000 });
      await quickPhrasesButton.click();
      const quickPhrasePicker = page.getByTestId("quick-phrases-picker");
      await quickPhrasePicker.waitFor({ state: "visible", timeout: 10_000 });
      await quickPhrasePicker.getByTestId(`quick-phrase-use-${QUICK_PHRASE.id}`).click();
      await quickPhrasePicker.waitFor({ state: "hidden", timeout: 10_000 });
      assert.equal(await input.inputValue(), QUICK_PHRASE.content,
        "choosing a quick phrase must insert text into the expanded composer");
      assert.equal(rpc.sideEffectRequests().length, 0,
        "quick phrase insertion must never send or create a thread");

      stage = "local-text-image-preview-removal-before-send";
      await addDocumentFile(page, {
        name: "remove-before-send.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("temporary staged text attachment", "utf8"),
      });
      const draftPreview = page.getByTestId("draft-local-attachment-preview");
      const temporaryPreview = draftPreview.getByText("remove-before-send.txt", { exact: true });
      await temporaryPreview.waitFor({ state: "visible", timeout: 15_000 });
      await page.getByTestId(`composer-remove-attachment-${encodeURIComponent("remove-before-send.txt")}`).click();
      await temporaryPreview.waitFor({ state: "detached", timeout: 15_000 });
      assert.equal(rpc.sideEffectRequests().length, 0,
        "selecting and removing a local text file before Send must not call thread, turn, or retention RPCs");

      await addDocumentFile(page, {
        name: "first-send-note.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("retained first-turn text attachment", "utf8"),
      });
      await addDocumentFile(page, {
        name: "first-send-image.png",
        mimeType: "image/png",
        buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
      });
      const imagePreview = page.getByTestId(`composer-image-attachment-${encodeURIComponent("first-send-image.png")}`);
      await imagePreview.waitFor({ state: "visible", timeout: 15_000 });
      await imagePreview.click();
      const lightbox = page.getByTestId("draft-attachment-lightbox");
      await lightbox.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await lightbox.getAttribute("role"), "dialog",
        "the local draft image preview must expose its explicit inner lightbox dialog");
      const lightboxImage = lightbox.getByTestId("draft-attachment-lightbox-image");
      await lightboxImage.waitFor({ state: "visible", timeout: 10_000 });
      const lightboxImageIsImg = await lightboxImage.evaluate(element => element.tagName.toLowerCase() === "img");
      const decodedImage = lightboxImageIsImg ? lightboxImage : lightboxImage.locator("img");
      await decodedImage.waitFor({ state: "visible", timeout: 10_000 });
      await waitFor(async () => decodedImage.evaluate(image => image instanceof HTMLImageElement
        && image.complete && image.naturalWidth > 0),
      10_000, "the staged PNG image element to finish decoding in the local preview");
      assert.ok(await decodedImage.evaluate(image => image instanceof HTMLImageElement && image.naturalWidth > 0),
        "the staged PNG must decode as a real local image in the preview lightbox");
      await lightbox.getByLabel("关闭附件预览", { exact: true }).click();
      await lightbox.waitFor({ state: "hidden", timeout: 10_000 });
      assert.equal(await page.getByTestId(`composer-remove-attachment-${encodeURIComponent("first-send-image.png")}`).count(), 1,
        "the image must have a local remove action before Send");
      assert.equal(await page.getByTestId(`composer-remove-attachment-${encodeURIComponent("first-send-note.txt")}`).count(), 1,
        "the text attachment must have a local remove action before Send");
      assert.equal(rpc.sideEffectRequests().length, 0,
        "local image preview and text/image staging must not upload or create a thread before Send");
      assert.equal(fixture.requests.length, 0, "staging local attachments must not invoke the local Provider fixture");
      await input.fill(`${QUICK_PHRASE.content}${PROMPT_SUFFIX}`);
      await assertRenderedPreferences(page, "zh-CN", "light");
      await captureScreenshot(page, context, screenshots, "local-attachments-preview-before-send.png", {
        width: 390,
        height: 844,
        language: "zh-CN",
        theme: "light",
      });

      preSendSideEffects = rpc.sideEffectSummary();
      assert.deepEqual(preSendSideEffects.counts, {
        threadStarts: 0,
        turnStarts: 0,
        attachmentRpcMethods: 0,
        attachmentRetentionCalls: 0,
        v1RetentionUploads: 0,
      }, "all side-effect RPC counts must be zero before the actual Send action");
      const draftUrl = new URL(page.url());
      assert.equal(draftUrl.pathname, "/mobile/new",
        "the first message must be sent from New Draft, before a task route exists");
      assert.equal(draftUrl.searchParams.get("profileId"), profileId,
        "the first-send draft must remain scoped to the manually paired Gateway profile");

      stage = "first-send-and-real-rpc-acknowledgments";
      await input.fill(`${QUICK_PHRASE.content}${PROMPT_SUFFIX}`);
      await initialDraft.getByTestId("send-message").click();
      await page.locator('[data-testid="message-user"]:visible').filter({ hasText: "DRAFT_FIRST_SEND_E2E" }).waitFor({ state: "visible", timeout: 30_000 });
      await page.locator('[data-testid="message-assistant"]:visible').filter({ hasText: ASSISTANT_MARKER }).waitFor({ state: "visible", timeout: 60_000 });
      await page.getByTestId(`message-image-attachment-${encodeURIComponent("first-send-image.png")}`).waitFor({ state: "visible", timeout: 30_000 });
      await waitFor(() => rpc.successfulResponses("thread/start").length === 1
        && rpc.successfulResponses("turn/start").length === 1
        && rpc.successfulResponses("attachment/save").length === 2
        && rpc.successfulResponses("gateway/attachments/retain").length === 1,
      30_000, "the first thread, legacy attachment-save, scoped-retain, and initial-turn ACKs");

      const dispatch = rpc.assertInitialDispatch({
        targetId: "alpha",
        cwd: alphaWorkspace.path,
        model: ALPHA_MODEL,
        reasoningEffort: "high",
        permissionMode: "accept_edits",
        expectedAttachments: [
          { filename: "first-send-note.txt", mimeType: "text/plain", bytes: Buffer.from("retained first-turn text attachment", "utf8") },
          { filename: "first-send-image.png", mimeType: "image/png", bytes: Buffer.from(TINY_PNG_BASE64, "base64") },
        ],
      });
      assert.equal(fixture.requests.length, 1,
        "the deterministic local Provider fixture must receive exactly the one initial turn");
      assert.equal(fixture.requests[0]?.model, "mobile-draft-alpha",
        "the local Provider fixture must receive the explicitly selected alpha model");
      assertProviderReceivedFirstTurnTextAndImage(fixture.requests[0], Buffer.from(TINY_PNG_BASE64, "base64"));
      await waitForWritableComposer(page, "first attachment turn");
      assert.equal(await page.locator('[data-testid="send-message"]:visible').count(), 1,
        "the created task must return to a composer after the assistant fixture response");

      stage = "home-project-plus-unsent-draft-exit-has-no-session-side-effects";
      await taskBackToHome(page, "zh-CN");
      const beforeUnsentExit = rpc.sideEffectSummary().counts;
      const providerRequestsBeforeUnsentExit = fixture.requests.length;
      const homeOverlayPlus = await findProjectPlus(page, "home", "alpha", alphaOverlayWorkspace.path);
      await homeOverlayPlus.click();
      await waitForDraft(page);
      await assertTargetCatalog(page, rpc, "alpha", alphaOverlayWorkspace.path, ALPHA_OVERLAY_MODEL,
        [BETA_MODEL, GAMMA_MODEL], ALPHA_OVERLAY_MODEL);
      await assertDefaultProjectDraft(page, { profileId, targetId: "alpha", cwd: alphaOverlayWorkspace.path, language: "zh-CN" });
      await assertRenderedPreferences(page, "zh-CN", "light");
      await captureScreenshot(page, context, screenshots, "home-project-plus-overlay-unsent-draft-390-zh-cn-light.png", {
        width: 390, height: 844, language: "zh-CN", theme: "light",
      });
      assert.deepEqual(rpc.sideEffectSummary().counts, beforeUnsentExit,
        "opening the real Home project Plus route must not create a thread, turn, or attachment mutation before Send");
      assert.equal(fixture.requests.length, providerRequestsBeforeUnsentExit,
        "opening and leaving an unsent Home project draft must not invoke the local Provider fixture");
      await backToHome(page, "zh-CN");
      assert.deepEqual(rpc.sideEffectSummary().counts, beforeUnsentExit,
        "leaving the empty Home project draft must not create a session or any other conversation side effect");

      stage = "home-project-plus-default-cwd-real-thread-and-turn";
      const homeOverlayPlusForSend = await findProjectPlus(page, "home", "alpha", alphaOverlayWorkspace.path);
      await homeOverlayPlusForSend.click();
      await waitForDraft(page);
      await assertTargetCatalog(page, rpc, "alpha", alphaOverlayWorkspace.path, ALPHA_OVERLAY_MODEL,
        [BETA_MODEL, GAMMA_MODEL], ALPHA_OVERLAY_MODEL);
      await assertDefaultProjectDraft(page, { profileId, targetId: "alpha", cwd: alphaOverlayWorkspace.path, language: "zh-CN" });
      await assertRenderedPreferences(page, "zh-CN", "light");
      await captureScreenshot(page, context, screenshots, "home-project-plus-overlay-default-draft-390-zh-cn-light.png", {
        width: 390, height: 844, language: "zh-CN", theme: "light",
      });
      const homePlusCreation = await sendDefaultProjectDraft(page, rpc, fixture, {
        profileId,
        targetId: "alpha",
        cwd: alphaOverlayWorkspace.path,
        expectedModel: ALPHA_OVERLAY_MODEL,
        providerModel: "mobile-draft-alpha-overlay",
        marker: "DRAFT_HOME_PROJECT_PLUS_E2E",
        label: "Home project Plus",
      });

      stage = "task-screen-drawer-project-plus-default-cwd-real-thread-and-turn";
      const taskHeader = page.locator('[data-testid="task-header"]:visible');
      await waitFor(async () => await taskHeader.count() === 1,
        15_000, "the unique visible TaskScreen header before opening its Drawer");
      const openTaskList = taskHeader.getByRole("button", { name: "打开任务列表", exact: true });
      await openTaskList.waitFor({ state: "visible", timeout: 15_000 });
      await openTaskList.click();
      const taskDrawer = page.locator('[data-testid="mobile-drawer"]:visible');
      await taskDrawer.waitFor({ state: "visible", timeout: 15_000 });
      const drawerOverlayPlus = await findProjectPlus(page, "drawer", "alpha", alphaOverlayWorkspace.path);
      assert.equal(await drawerOverlayPlus.isEnabled(), true,
        "the real TaskScreen Drawer must expose an enabled Plus for the registered non-root workspace");
      await drawerOverlayPlus.click();
      await waitForDraft(page);
      await assertTargetCatalog(page, rpc, "alpha", alphaOverlayWorkspace.path, ALPHA_OVERLAY_MODEL,
        [BETA_MODEL, GAMMA_MODEL], ALPHA_OVERLAY_MODEL);
      await assertDefaultProjectDraft(page, { profileId, targetId: "alpha", cwd: alphaOverlayWorkspace.path, language: "zh-CN" });
      await assertRenderedPreferences(page, "zh-CN", "light");
      await captureScreenshot(page, context, screenshots, "task-drawer-project-plus-overlay-default-draft-390-zh-cn-light.png", {
        width: 390, height: 844, language: "zh-CN", theme: "light",
      });
      const drawerPlusCreation = await sendDefaultProjectDraft(page, rpc, fixture, {
        profileId,
        targetId: "alpha",
        cwd: alphaOverlayWorkspace.path,
        expectedModel: ALPHA_OVERLAY_MODEL,
        providerModel: "mobile-draft-alpha-overlay",
        marker: "DRAFT_DRAWER_PROJECT_PLUS_E2E",
        label: "TaskScreen Drawer project Plus",
      });

      assert.deepEqual(diagnostics.pageErrors, [], "the real Mobile Web flow must not emit page errors");
      assert.deepEqual(diagnostics.consoleErrors, [], "the real Mobile Web flow must not emit browser console errors");

      stage = "source-and-runtime-provenance";
      const backendProcesses = await findOwnedExecutableProcesses({
        pgid: gateway.child.pid,
        executablePath: KCODER_BIN,
      });
      const matchingBackendProcesses = backendProcesses.filter(process => process.sha256 === backendBefore.sha256);
      const backendAfter = await hashExecutableFile(KCODER_BIN);
      assert.deepEqual(backendAfter, backendBefore,
        "the configured Rust app-server executable must remain byte-identical during the test");
      assert.ok(matchingBackendProcesses.length > 0,
        "the owned Gateway process group must contain the configured Rust app-server binary");
      const rpcEvidence = rpc.evidence();
      const evidence = {
        schemaVersion: 1,
        testId: TEST_ID,
        stage: "passed",
        runtime: {
          node: process.version,
          nodeMajor: currentNodeMajor,
          configDirectoryRunRelative: relative(context.runRoot, configDir),
          configSettingsSha256: sha256(await readFile(context.pathInState("config/settings.json"))),
          credentialsFileAbsent: true,
          profileId,
          gatewayPairing: "actual mounted Mobile Web Welcome direct-connection form",
          gatewayServerConfigSha256: serverConfigSha256,
          chromiumNoSandbox: chromium.noSandbox,
        },
        mobileWeb: {
          sourceTreeSha256: mobileWeb.sourceTreeSha256,
          dependencySourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
          bundleSha256: mobileWeb.bundleSha256,
          bundleFileCount: mobileWeb.bundleFileCount,
          gatewayManifestSha256: sha256(mobileManifestBytes),
          gatewayManifestResourceCount: mobileManifest.files.length,
        },
        suiteSourceSha256,
        backend: {
          configuredBefore: backendBefore,
          configuredAfter: backendAfter,
          ownedProcesses: matchingBackendProcesses,
        },
        fixture: {
          type: "deterministic local Provider endpoint",
          endpointHost: "127.0.0.1",
          providerAuthentication: "none",
          userCredentialsUsed: false,
          paidCalls: 0,
          realProvider: false,
          modelUnderstandingClaimed: false,
          firstTurnTextAndImageReceived: true,
          requests: fixture.requests.length,
          selectedProviderModel: fixture.requests[0]?.model,
        },
        targetIsolation: {
          profileId,
          alpha: { serverId: "alpha", cwd: alphaWorkspace.path, model: ALPHA_MODEL },
          alphaOverlay: { serverId: "alpha", cwd: alphaOverlayWorkspace.path, model: ALPHA_OVERLAY_MODEL },
          beta: { serverId: "beta", cwd: betaWorkspace.path, model: BETA_MODEL },
          gamma: { serverId: "gamma", cwd: alphaWorkspace.path, model: GAMMA_MODEL },
          sameCwdDifferentServerWasDistinct: true,
          preSendThreadStarts: 0,
          preSendTurnStarts: 0,
        },
        registeredOverlayWorkspace: alphaOverlayRegistration,
        projectPlusCreation: {
          home: homePlusCreation,
          taskScreenDrawer: drawerPlusCreation,
          exitedUnsentHomeDraftWithoutSideEffects: true,
          eachDraftUsedTheExactOverlayTargetAndCwd: true,
          defaultPermissionWasPreserved: true,
          modelWasConfirmedByProviderFixture: true,
        },
        screenshots,
        quickPhrase: {
          phraseId: QUICK_PHRASE.id,
          visibleOnlyWhenExpanded: true,
          insertedWithoutSending: true,
        },
        localAttachments: {
          removedBeforeSend: "remove-before-send.txt",
          selectedForInitialTurn: ["first-send-note.txt", "first-send-image.png"],
          imagePreviewOpenedLocally: true,
          noUploadOrThreadBeforeSend: true,
        },
        firstSend: dispatch,
        rpc: { ...rpcEvidence, preSendSideEffects },
        diagnostics,
        explicitCoverageLimits: [
          "unknown/lost thread-start or turn-start ACK reconciliation is not exercised here",
          "send failure recovery and late stale response isolation are not exercised here",
          "native Android/iOS document and camera pickers are not exercised by Mobile Web",
          "the deterministic fixture validates delivery and UI/protocol only; it does not prove image understanding",
        ],
      };
      await context.writeArtifactJson("mobile-new-draft-composer-evidence.json", evidence);
      return {
        profilePairedThroughMobileWelcome: true,
        projectTargetIsolation: true,
        samePathAcrossTargetsIsolated: true,
        screenshotCount: screenshots.length,
        localPreviewRemovalAndFirstSendAttachmentDelivery: true,
        firstThreadStarts: dispatch.threadStartCount,
        firstTurnStarts: dispatch.turnStartCount,
        additionalHomeProjectPlusCreation: homePlusCreation.threadId,
        additionalTaskScreenDrawerProjectPlusCreation: drawerPlusCreation.threadId,
        unsentHomeProjectDraftExitedWithoutCreatingThread: true,
        totalBrowserThreadStarts: rpc.successfulResponses("thread/start").length,
        totalBrowserTurnStarts: rpc.successfulResponses("turn/start").length,
        attachmentSaveAcknowledgements: dispatch.attachmentSaveAckCount,
        threadScopedAttachmentRetentionAcknowledged: dispatch.threadScopedRetentionAck,
        modelIndependentFixture: true,
        paidCalls: 0,
      };
    } catch (error) {
      await context.writeArtifactJson("failure-stage-evidence.json", {
        failedStage: stage,
        errorName: error instanceof Error ? error.name : "Error",
        error: context.redactText(error instanceof Error ? error.message : String(error)),
        pairingComplete,
        rpc: rpc.evidence(),
        preSendSideEffects,
        diagnostics,
        screenshots,
      }).catch(() => {});
      if (pairingComplete && page) {
        const failureScreenshot = context.pathInCase("system-chromium", "mobile-new-draft-composer", `failure-${slug(stage)}.png`);
        await mkdir(dirname(failureScreenshot), { recursive: true }).catch(() => {});
        await page.screenshot({ path: failureScreenshot, animations: "disabled" }).catch(() => {});
      }
      throw error;
    } finally {
      await page?.close().catch(() => {});
    }
  },
);

function providerFixture(endpoint, defaultModel, overlayModel) {
  const configuration = {
    api_format: "openai_chat_completions",
    authentication: { mode: "none" },
    endpoint,
    default_model: defaultModel,
    capabilities: { reasoning: true, vision: true },
    reasoning_effort: "medium",
    reasoning_policy: { mode: "optional", efforts: ["none", "low", "medium", "high"] },
    context_window_tokens: 128000,
    output_headroom_tokens: 8192,
    max_output_tokens: 2048,
    request_timeout_secs: 30,
    no_proxy: true,
    max_retries: 0,
    discover_models: false,
    extra_body: {},
  };
  if (overlayModel) {
    configuration.models = {
      [defaultModel]: providerModelFixture("medium"),
      [overlayModel]: providerModelFixture("high"),
    };
  }
  return configuration;
}

function providerModelFixture(defaultReasoningEffort) {
  return {
    context_window_tokens: 128000,
    output_headroom_tokens: 8192,
    max_output_tokens: 2048,
    capabilities: { reasoning: true, vision: true },
    reasoning_effort: defaultReasoningEffort,
    reasoning_policy: { mode: "optional", efforts: ["none", "low", "medium", "high"] },
    extra_body: {},
  };
}

async function registerAlphaOverlayWorkspace(context, gateway, { accessToken, rpcToken, workspacePath }) {
  const rpc = await openRpc(gatewayRpcUrl(gateway, "alpha", rpcToken), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  try {
    const clientRequestId = `new-draft-overlay-${randomUUID()}`;
    const opened = await rpc.request("runtime.workspaces.open", {
      deviceId: "alpha",
      runtime: "kcoder",
      clientRequestId,
      workspacePath,
      label: "Alpha Overlay Project",
    });
    assert.equal(opened.success, true,
      "the real app-server must accept the owned second-project registration");
    assert.equal(opened.accepted, true);
    assert.equal(opened.workspacePath, workspacePath,
      "the registration ACK must bind the exact second workspace used by both Plus entry points");
    const receipt = await rpc.request("runtime.workspaces.operation/read", { clientRequestId });
    assert.equal(receipt.receipt?.status, "ready",
      "the app-server must provide a durable readback for the exact workspace registration request");
    assert.equal(receipt.receipt?.workspacePath, workspacePath,
      "the durable workspace receipt must bind the exact owned overlay path");

    const catalog = await rpc.request("runtime.workspaces.list", { deviceId: "alpha" });
    assert.equal(catalog.success, true, "the independent runtime workspace listing must succeed after the open receipt");
    const registered = catalog.items?.find(item => item.workspacePath === workspacePath);
    assert.ok(registered, "the exact second workspace must be independently visible in the app-server registry");
    assert.equal(registered.available, true, "the second project fixture must resolve to its owned directory");

    const rootModels = await rpc.request("runtime.models.list", {});
    assertCatalogDefault(rootModels, ALPHA_MODEL, "Alpha target root workspace");
    assert.equal(rootModels.data.some(model => model.id === ALPHA_OVERLAY_MODEL && model.isDefault === true), false,
      "the target root must not inherit the second workspace's model override");

    const overlayUrl = new URL(gatewayRpcUrl(gateway, "alpha", rpcToken));
    overlayUrl.searchParams.set("workspace", workspacePath);
    const overlayRpc = await openRpc(overlayUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    let overlayModels;
    try {
      await initializeRpc(overlayRpc, "mobile-new-draft-overlay-model-readback");
      overlayModels = await overlayRpc.request("runtime.models.list", {});
    } finally {
      await closeRpcAndWait(overlayRpc, "overlay workspace model-catalog readback RPC");
    }
    assertCatalogDefault(overlayModels, ALPHA_OVERLAY_MODEL, "Alpha overlay workspace");
    const overlayModel = overlayModels.data.find(model => model.id === ALPHA_OVERLAY_MODEL);
    assert.equal(overlayModel.defaultReasoningEffort, "high",
      "the real workspace-scoped model catalog must preserve its configured default reasoning effort");
    return {
      registration: {
        method: "runtime.workspaces.open",
        receiptStatus: receipt.receipt.status,
        workspacePath: opened.workspacePath,
        registeredAvailable: registered.available,
      },
      rootCatalog: summarizeModelCatalog(rootModels),
      overlayCatalog: summarizeModelCatalog(overlayModels),
      source: "authenticated RPC session captured from the actual Welcome pairing response",
      workspaceSettingsFile: relative(context.runRoot, resolve(workspacePath, ".kcoder", "settings.json")),
    };
  } finally {
    await closeRpcAndWait(rpc, "alpha overlay workspace registration RPC");
  }
}

function assertCatalogDefault(catalog, expectedModelId, label) {
  assert.ok(Array.isArray(catalog?.data), `${label} must return a model catalog array`);
  const defaults = catalog.data.filter(model => model.isDefault === true).map(model => model.id);
  assert.deepEqual(defaults, [expectedModelId], `${label} must select exactly ${expectedModelId} as its real default`);
}

function summarizeModelCatalog(catalog) {
  const models = Array.isArray(catalog?.data) ? catalog.data : [];
  return {
    modelIds: models.map(model => model.id).filter(Boolean),
    defaultModelIds: models.filter(model => model.isDefault === true).map(model => model.id).filter(Boolean),
    defaultReasoningEfforts: models.filter(model => model.isDefault === true).map(model => model.defaultReasoningEffort ?? null),
  };
}

function createRpcObserver() {
  const requests = [];
  const responses = [];
  let sequence = 0;
  let nextSocketIndex = 0;

  return {
    observe(socket) {
      // Request IDs restart per GatewayRpcClient socket; ACKs must stay socket-scoped.
      const socketPending = new Map();
      const socketIndex = ++nextSocketIndex;
      let serverId = null;
      let workspacePath = null;
      try {
        const rpcUrl = new URL(socket.url());
        serverId = rpcUrl.searchParams.get("server");
        workspacePath = rpcUrl.searchParams.get("workspace");
      } catch {
        serverId = null;
        workspacePath = null;
      }
      socket.on("framesent", event => {
        const message = parseRpcFrame(event.payload);
        if (!message?.method) return;
        const request = {
          sequence: ++sequence,
          id: message.id ?? null,
          method: message.method,
          serverId,
          workspacePath,
          socketIndex,
          params: message.params ?? {},
        };
        requests.push(request);
        if (message.id !== undefined) socketPending.set(message.id, request);
      });
      socket.on("framereceived", event => {
        const message = parseRpcFrame(event.payload);
        if (!message || message.id === undefined) return;
        const request = socketPending.get(message.id);
        if (!request) return;
        const response = {
          sequence: ++sequence,
          id: message.id,
          method: request.method,
          serverId: request.serverId,
          workspacePath: request.workspacePath,
          socketIndex: request.socketIndex,
          success: message.error === undefined && message.result !== undefined,
          errorCode: message.error?.code ?? null,
          result: message.result,
        };
        responses.push(response);
        socketPending.delete(message.id);
      });
    },
    requests,
    responses,
    sideEffectRequests() {
      return requests.filter(isComposerSideEffect);
    },
    sideEffectSummary() {
      const sideEffects = this.sideEffectRequests();
      return {
        counts: {
          threadStarts: sideEffects.filter(request => request.method === "thread/start").length,
          turnStarts: sideEffects.filter(request => request.method === "turn/start").length,
          attachmentRpcMethods: sideEffects.filter(request => request.method.startsWith("attachment/")).length,
          attachmentRetentionCalls: sideEffects.filter(request => ATTACHMENT_SIDE_EFFECTS.has(request.method)).length,
          v1RetentionUploads: sideEffects.filter(request => request.method.startsWith(RETENTION_UPLOAD_PREFIX)).length,
        },
        methods: sideEffects.map(request => ({ method: request.method, serverId: request.serverId, socketIndex: request.socketIndex, sequence: request.sequence })),
      };
    },
    successfulResponses(method) {
      return responses.filter(response => response.method === method && response.success);
    },
    assertInitialDispatch(expected) {
      const threadRequests = requests.filter(request => request.method === "thread/start");
      const turnRequests = requests.filter(request => request.method === "turn/start");
      const threadResponses = this.successfulResponses("thread/start");
      const turnResponses = this.successfulResponses("turn/start");
      const attachmentSaveRequests = requests.filter(request => request.method === "attachment/save");
      const attachmentSaveResponses = this.successfulResponses("attachment/save");
      const retainRequests = requests.filter(request => request.method === "gateway/attachments/retain");
      const retainResponses = this.successfulResponses("gateway/attachments/retain");
      const v1RetentionRequests = requests.filter(request => request.method.startsWith("attachment/retention/"));
      assert.equal(threadRequests.length, 1, "the actual first Send must dispatch exactly one thread/start");
      assert.equal(threadResponses.length, 1, "thread/start must have one genuine successful JSON-RPC response");
      assert.equal(turnRequests.length, 1, "the actual first Send must dispatch exactly one turn/start");
      assert.equal(turnResponses.length, 1, "turn/start must have one genuine successful JSON-RPC response");
      assert.equal(attachmentSaveRequests.length, expected.expectedAttachments.length,
        "the first Send must upload each selected local file once with the real attachment/save RPC");
      assert.equal(attachmentSaveResponses.length, expected.expectedAttachments.length,
        "each real attachment/save request must receive a successful JSON-RPC ACK");
      assert.equal(retainRequests.length, 1,
        "the first Send must bind all uploaded paths to the new thread in one Gateway retain request");
      assert.equal(retainResponses.length, 1,
        "the thread-scoped Gateway attachment retain request must receive a real ACK");
      assert.equal(v1RetentionRequests.length, 0,
        "the first-send flow must not claim that the unavailable V1 retained-upload protocol was negotiated");
      assert.equal(requests.some(request => request.method.startsWith("attachment/upload/")), false,
        "these small selected files must use the direct attachment/save protocol");

      const threadRequest = threadRequests[0];
      const threadResponse = threadResponses[0];
      const turnRequest = turnRequests[0];
      const turnResponse = turnResponses[0];
      const retainRequest = retainRequests[0];
      const retainResponse = retainResponses[0];
      const params = turnRequest.params;
      const createSocketIndex = threadRequest.socketIndex;
      assert.equal(threadRequest.serverId, expected.targetId, "thread/start must use the selected target RPC connection");
      assert.equal(threadRequest.params.cwd, expected.cwd, "thread/start must use the selected exact workspace path");
      assert.equal(threadRequest.params.model, expected.model, "thread/start must bind the selected provider-qualified model");
      assert.ok(threadRequest.params.clientRequestId, "thread/start must carry a stable creation request ID");
      assert.equal(threadResponse.result?.thread?.cwd, expected.cwd,
        "the thread/start ACK must return the exact selected cwd");
      assert.ok(threadResponse.result?.thread?.id, "thread/start ACK must return an authoritative thread ID");
      assert.equal(params.threadId, threadResponse.result.thread.id,
        "turn/start must target the exact thread returned by thread/start");
      assert.equal(params.clientMessageId, `${threadRequest.params.clientRequestId}-initial-turn`,
        "the initial turn must use the stable client message ID derived from the creation request");
      assert.equal(params.model, expected.model, "turn/start must retain the explicit provider-qualified model");
      assert.equal(params.reasoningEffort, expected.reasoningEffort, "turn/start must retain the selected reasoning effort");
      assert.equal(params.permissionMode, expected.permissionMode,
        "turn/start must carry the explicitly selected write-capable permission mode");
      assert.ok(params.input?.some(item => item.type === "text" && item.text.includes(QUICK_PHRASE.content)
        && item.text.includes("DRAFT_FIRST_SEND_E2E")),
      "turn/start must bind the inserted quick phrase and the final user text to the first message");
      assert.equal(retainRequest.serverId, expected.targetId, "the Gateway retention binding must stay on the selected target connection");
      assert.equal(retainRequest.socketIndex, createSocketIndex,
        "thread creation, file uploads, retention binding, and initial turn must use the same create-client socket owner");
      assert.equal(retainRequest.params.threadId, threadResponse.result.thread.id,
        "the Gateway retention binding must be scoped to the authoritative first thread");
      assert.equal(retainResponse.socketIndex, createSocketIndex,
        "the thread-scoped retention ACK must return on the same create-client socket");
      assert.equal(retainResponse.result?.retained, true,
        "the Gateway must ACK the scoped attachment retention operation");
      assert.equal(params.retention, undefined,
        "the first turn must use the standard path-based attachment manifest, not a fabricated V1 receipt payload");

      const uploads = expected.expectedAttachments.map(attachment => {
        const matchingRequests = attachmentSaveRequests.filter(request => request.params.filename === attachment.filename);
        assert.equal(matchingRequests.length, 1,
          "each selected attachment filename must have exactly one direct upload request");
        const request = matchingRequests[0];
        const response = attachmentSaveResponses.find(candidate => candidate.socketIndex === request.socketIndex
          && candidate.id === request.id && candidate.method === request.method);
        assert.ok(response, "each attachment/save request must match its ACK by socket owner and request ID");
        const encoded = request.params.content_base64;
        const decoded = typeof encoded === "string" ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
        assert.equal(decoded.equals(attachment.bytes), true,
          "the real attachment/save input must contain the exact selected local file bytes");
        assert.equal(request.socketIndex, createSocketIndex,
          "the attachment upload must stay on the same client that created the thread");
        assert.equal(request.serverId, expected.targetId, "the attachment upload must use the selected target");
        assert.ok(response.sequence > request.sequence, "attachment/save ACK must follow its request");
        const path = response.result?.path;
        assert.equal(typeof path === "string" && path.length > 0, true,
          "attachment/save ACK must return the server path used by the initial turn");
        assert.ok(response.sequence > threadResponse.sequence,
          "the attachment may upload only after thread/start returns an authoritative thread ID");
        return { attachment, request, response, path };
      });
      const uploadPaths = uploads.map(upload => upload.path);
      assert.equal(new Set(uploadPaths).size, expected.expectedAttachments.length,
        "each selected file must receive its own unique server attachment path");
      assert.equal(retainRequest.sequence > Math.max(...uploads.map(upload => upload.response.sequence)), true,
        "all attachment/save ACKs must arrive before the thread-scoped retention request");
      assert.equal(retainResponse.sequence > retainRequest.sequence, true,
        "the Gateway retention ACK must follow its request");
      const retainedPaths = retainRequest.params.paths;
      const retainedAckPaths = retainResponse.result?.paths;
      assert.equal(Array.isArray(retainedPaths), true, "the Gateway retention request must include exact uploaded paths");
      assert.equal(Array.isArray(retainedAckPaths), true, "the Gateway retention ACK must return its bound paths");
      const pathsMatch = values => Array.isArray(values)
        && values.length === uploadPaths.length
        && uploadPaths.every(path => values.includes(path));
      assert.equal(pathsMatch(retainedPaths), true,
        "the Gateway retention request must bind exactly the paths returned by the upload ACKs");
      assert.equal(pathsMatch(retainedAckPaths), true,
        "the Gateway retention ACK must cover exactly the paths returned by the upload ACKs");
      assert.ok(turnRequest.sequence > retainResponse.sequence,
        "the initial turn may dispatch only after all upload and thread-scoped retention ACKs");
      assert.equal(turnRequest.serverId, expected.targetId, "turn/start must use the selected target RPC connection");
      assert.equal(turnRequest.socketIndex, createSocketIndex,
        "the initial turn must use the same client that created and retained the attachments");
      assert.equal(turnResponse.socketIndex, createSocketIndex,
        "turn/start ACK must return on the same create-client socket owner");
      assert.ok(turnResponse.sequence > turnRequest.sequence,
        "the turn acceptance must be observed as a real JSON-RPC response");
      const turnText = params.input.filter(item => item?.type === "text").map(item => String(item.text ?? "")).join("\n");
      const attachmentManifest = parseTurnAttachmentManifest(turnText);
      assert.equal(attachmentManifest.length, expected.expectedAttachments.length,
        "the initial turn text must carry one standard attachment manifest row for every selected local file");
      const manifestMatches = uploads.every(({ attachment, path, request }) => attachmentManifest.some(item =>
        item.filename === attachment.filename
          && item.mimeType === attachment.mimeType
          && item.fileSize === attachment.bytes.length
          && item.path === path
          && request.params.filename === item.filename));
      assert.equal(manifestMatches, true,
        "the standard kcoder_attachments manifest must reference the exact upload ACK paths, filenames, MIME types, and sizes");

      return {
        targetId: threadRequest.serverId,
        cwd: threadRequest.params.cwd,
        threadStartCount: threadRequests.length,
        threadId: threadResponse.result.thread.id,
        creationClientRequestId: threadRequest.params.clientRequestId,
        turnStartCount: turnRequests.length,
        clientMessageId: params.clientMessageId,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        permissionMode: params.permissionMode,
        inputTextLength: params.input.filter(item => item.type === "text").reduce((sum, item) => sum + item.text.length, 0),
        attachmentSaveAckCount: attachmentSaveResponses.length,
        attachments: uploads.map(({ attachment, response }) => ({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          fileSize: attachment.bytes.length,
          uploadAck: Boolean(response.result?.path),
        })),
        legacyAttachmentManifestRows: attachmentManifest.length,
        allUploadsAfterThreadAckBeforeTurnStart: true,
        threadStartAck: true,
        turnStartAck: true,
        threadScopedRetentionAck: true,
      };
    },
    evidence() {
      return {
        requestCount: requests.length,
        responseCount: responses.length,
        requests: requests.map(request => summarizeRequest(request)),
        responses: responses.map(response => summarizeResponse(response)),
        sideEffectsObservedDuringRun: this.sideEffectSummary(),
      };
    },
  };
}

function isComposerSideEffect(request) {
  return request.method === "thread/start"
    || request.method === "turn/start"
    || request.method.startsWith("attachment/")
    || ATTACHMENT_SIDE_EFFECTS.has(request.method)
    || request.method.startsWith(RETENTION_UPLOAD_PREFIX);
}

function summarizeRequest(request) {
  const summary = {
    sequence: request.sequence,
    id: request.id,
    method: request.method,
    serverId: request.serverId,
    socketIndex: request.socketIndex,
  };
  if (request.method === "runtime.models.list") {
    summary.cwd = request.workspacePath ?? request.params.workspacePath ?? request.params.cwd ?? null;
  }
  if (request.method === "thread/start") {
    summary.cwd = request.params.cwd ?? null;
    summary.model = request.params.model ?? null;
    summary.clientRequestId = request.params.clientRequestId ?? null;
  }
  if (request.method === "attachment/save") {
    summary.filename = request.params.filename ?? null;
    summary.contentBytes = typeof request.params.content_base64 === "string"
      ? Buffer.from(request.params.content_base64, "base64").length
      : 0;
  }
  if (request.method === "gateway/attachments/retain") {
    summary.threadId = request.params.threadId ?? null;
    summary.pathCount = Array.isArray(request.params.paths) ? request.params.paths.length : 0;
  }
  if (request.method.startsWith(RETENTION_UPLOAD_PREFIX)) {
    summary.retentionUploadParamsPresent = true;
  }
  if (request.method === "turn/start") {
    const params = request.params;
    summary.threadId = params.threadId ?? null;
    summary.clientMessageId = params.clientMessageId ?? null;
    summary.model = params.model ?? null;
    summary.reasoningEffort = params.reasoningEffort ?? null;
    summary.permissionMode = params.permissionMode ?? null;
    summary.inputTextLength = Array.isArray(params.input)
      ? params.input.filter(item => item?.type === "text").reduce((sum, item) => sum + String(item.text ?? "").length, 0)
      : 0;
    const text = Array.isArray(params.input)
      ? params.input.filter(item => item?.type === "text").map(item => String(item.text ?? "")).join("\n")
      : "";
    summary.attachmentManifest = parseTurnAttachmentManifest(text).map(({ filename, mimeType, fileSize, path }) => ({
      filename,
      mimeType,
      fileSize,
      pathPresent: typeof path === "string" && path.length > 0,
    }));
  }
  return summary;
}

function summarizeResponse(response) {
  const summary = {
    sequence: response.sequence,
    id: response.id,
    method: response.method,
    serverId: response.serverId,
    socketIndex: response.socketIndex,
    success: response.success,
    errorCode: response.errorCode,
  };
  if (response.method === "initialize") {
    const result = asRecord(response.result);
    const capabilities = asRecord(result?.capabilities);
    const experimental = summarizeExperimentalFlags(capabilities?.experimental);
    const hasAdmission = Boolean(result && Object.prototype.hasOwnProperty.call(result, "attachmentUploadAdmission"));
    summary.experimentalFlags = experimental.flags;
    summary.experimentalFlagsPresent = experimental.present;
    summary.experimentalFlagsSchemaValid = experimental.schemaValid;
    summary.attachmentAdmissionPresent = hasAdmission;
    summary.attachmentAdmissionValidity = summarizeAttachmentAdmission(result?.attachmentUploadAdmission);
  }
  if (response.method === "runtime.models.list") {
    const models = responseModels(response);
    summary.modelIds = models.map(model => model.id).filter(Boolean);
    summary.defaultModelIds = models.filter(model => model.isDefault === true).map(model => model.id).filter(Boolean);
    summary.defaultReasoningEfforts = models.filter(model => model.isDefault === true)
      .map(model => model.defaultReasoningEffort ?? model.configuration?.reasoningEffort ?? null);
    summary.cwd = response.workspacePath;
  }
  if (response.method === "thread/start") {
    summary.threadId = response.result?.thread?.id ?? null;
    summary.cwd = response.result?.thread?.cwd ?? null;
  }
  if (response.method === "attachment/save") {
    summary.pathPresent = typeof response.result?.path === "string" && response.result.path.length > 0;
  }
  if (response.method === "gateway/attachments/retain") {
    summary.retained = response.result?.retained === true;
    summary.pathCount = Array.isArray(response.result?.paths) ? response.result.paths.length : 0;
  }
  if (response.method === "turn/start") {
    summary.receiptStatus = response.result?.receipt?.status ?? null;
    summary.turnId = response.result?.turn?.id ?? response.result?.turnId ?? null;
  }
  return summary;
}

function parseTurnAttachmentManifest(text) {
  const block = /<kcoder_attachments version="1">\s*([\s\S]*?)\s*<\/kcoder_attachments>/.exec(text)?.[1];
  if (!block) return [];
  return block.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function assertProviderReceivedFirstTurnTextAndImage(body, expectedImageBytes) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const userMessage = messages.filter(message => message?.role === "user").at(-1);
  const content = Array.isArray(userMessage?.content) ? userMessage.content : [];
  assert.equal(content.some(item => item?.type === "text"
    && String(item.text ?? "").includes(QUICK_PHRASE.content)
    && String(item.text ?? "").includes("DRAFT_FIRST_SEND_E2E")), true,
  "the deterministic Provider request must receive the first-turn user text");
  const image = content.find(item => item?.type === "image_url");
  const dataUrl = image?.image_url?.url;
  const prefix = "data:image/png;base64,";
  assert.equal(typeof dataUrl === "string" && dataUrl.startsWith(prefix), true,
    "the deterministic Provider request must receive the selected PNG as an image_url data URL");
  const decoded = typeof dataUrl === "string" ? Buffer.from(dataUrl.slice(prefix.length), "base64") : Buffer.alloc(0);
  assert.equal(decoded.equals(expectedImageBytes), true,
    "the Provider image_url must contain the exact first-send image bytes");
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function summarizeExperimentalFlags(value) {
  const flagsRecord = asRecord(value);
  if (!flagsRecord) return { present: value !== undefined && value !== null, schemaValid: false, flags: {} };
  const entries = Object.entries(flagsRecord);
  const flags = {};
  let schemaValid = entries.length <= 128;
  for (const [name, enabled] of entries.slice(0, 128)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) || typeof enabled !== "boolean") {
      schemaValid = false;
      continue;
    }
    flags[name] = enabled;
  }
  return { present: true, schemaValid, flags };
}

function summarizeAttachmentAdmission(value) {
  const admission = asRecord(value);
  if (!admission) {
    return {
      isObject: false,
      exactFields: false,
      versionValid: false,
      rootNamespaceValid: false,
      admissionEpochValid: false,
      schemaValid: false,
    };
  }
  const allowedFields = ["admissionEpoch", "rootNamespace", "version"];
  const fields = Object.keys(admission).sort();
  const exactFields = fields.length === allowedFields.length
    && fields.every((field, index) => field === allowedFields[index]);
  const rootNamespace = admission.rootNamespace;
  const rootNamespaceValid = typeof rootNamespace === "string"
    && rootNamespace.length > 0 && rootNamespace.length <= 256
    && /^[a-zA-Z0-9_-]+$/.test(rootNamespace);
  const admissionEpochValid = Number.isSafeInteger(admission.admissionEpoch) && admission.admissionEpoch >= 1;
  const versionValid = admission.version === 1;
  return {
    isObject: true,
    exactFields,
    versionValid,
    rootNamespaceValid,
    admissionEpochValid,
    schemaValid: exactFields && versionValid && rootNamespaceValid && admissionEpochValid,
  };
}

function parseRpcFrame(payload) {
  try {
    return JSON.parse(typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"));
  } catch {
    return null;
  }
}

async function waitForDraft(page) {
  const draft = await visibleDraftRoot(page);
  await draft.getByTestId("message-input").waitFor({ state: "visible", timeout: 15_000 });
  await draft.getByTestId("draft-context-project").waitFor({ state: "visible", timeout: 15_000 });
}

async function visibleDraftRoot(page) {
  const draft = page.locator('[data-testid="new-task-draft"]:visible');
  await waitFor(async () => await draft.count() === 1,
    30_000, "the unique visible New Draft route root");
  return draft;
}

function visibleTaskHeader(page) {
  return page.locator('[data-testid="task-header"]:visible');
}

async function taskBackToHome(page, language) {
  const label = language === "en" ? "Back" : "返回";
  const header = visibleTaskHeader(page);
  await waitFor(async () => await header.count() === 1,
    15_000, "the unique visible TaskScreen header before returning Home");
  const button = header.getByLabel(label, { exact: true });
  await button.waitFor({ state: "visible", timeout: 15_000 });
  await button.click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 20_000 });
}

async function findProjectPlus(page, surface, targetId, cwd) {
  const idPrefix = surface === "home" ? "new-workspace" : "drawer-new-workspace";
  const surfaceRoot = surface === "drawer"
    ? page.locator('[data-testid="mobile-drawer"]:visible')
    : page;
  const candidates = surfaceRoot.locator(`[data-testid^="${idPrefix}-${targetId}-"]:visible`);
  await waitFor(async () => {
    const count = await candidates.count();
    let matches = 0;
    for (let index = 0; index < count; index += 1) {
      const label = await candidates.nth(index).getAttribute("aria-label");
      if (typeof label === "string" && label.includes(cwd)) matches += 1;
    }
    return matches === 1;
  }, 30_000, `${surface} project Plus for the exact owned workspace ${cwd}`);
  const count = await candidates.count();
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const label = await candidate.getAttribute("aria-label");
    if (typeof label === "string" && label.includes(cwd)) matches.push(candidate);
  }
  assert.equal(matches.length, 1,
    `${surface} must expose one Plus action for the exact target and project path`);
  assert.equal(await matches[0].isEnabled(), true,
    `${surface} Plus for ${cwd} must be enabled on the owned online target`);
  return matches[0];
}

async function assertDefaultProjectDraft(page, { profileId, targetId, cwd, language }) {
  const draft = await visibleDraftRoot(page);
  const url = new URL(page.url());
  assert.equal(url.pathname, "/mobile/new", "each project Plus must open the ordinary mounted New Draft route");
  assert.equal(url.searchParams.get("profileId"), profileId,
    "the project Plus draft must keep the manually paired Gateway profile");
  assert.equal(url.searchParams.get("serverId"), targetId,
    "the project Plus route must bind the exact target in its normal route parameters");
  assert.equal(url.searchParams.get("cwd"), cwd,
    "the project Plus route must bind the exact selected workspace path");
  const contextLabel = await draft.getByTestId("draft-context-project").getAttribute("aria-label");
  assert.ok(contextLabel?.includes(cwd), "the visible draft context must identify the exact workspace path");
  const modelSelector = draft.getByTestId("draft-model-selector");
  await modelSelector.waitFor({ state: "visible", timeout: 15_000 });
  const expectedDefaultModelLabel = language === "en" ? "Follow target default" : "跟随目标默认";
  await waitFor(async () => (await modelSelector.innerText()).includes(expectedDefaultModelLabel),
    15_000, "the New Draft composer to leave model selection on the target's server default");
  const permissionSelector = draft.getByTestId("draft-permission-selector");
  await permissionSelector.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await permissionSelector.getAttribute("aria-label"),
    language === "en" ? "Permissions: server default" : "权限：服务器默认",
    "the project Plus draft must retain the real target default permission mode");
  const input = draft.getByTestId("message-input");
  assert.equal(await input.inputValue(), "", "a new project Plus draft must not inherit another screen's text");
  assert.equal(await draft.getByTestId("send-message").isEnabled(), false,
    "an empty project Plus draft must remain unsendable until the user enters a message");
}

async function sendDefaultProjectDraft(page, rpc, fixture, { profileId, targetId, cwd, expectedModel, providerModel, marker, label }) {
  const draft = await visibleDraftRoot(page);
  const before = rpc.sideEffectSummary().counts;
  const threadCount = rpc.successfulResponses("thread/start").length;
  const turnCount = rpc.successfulResponses("turn/start").length;
  const providerCount = fixture.requests.length;
  const visibleAssistant = page.locator('[data-testid="message-assistant"]:visible').filter({ hasText: ASSISTANT_MARKER });
  const assistantCount = await visibleAssistant.count();
  const lastObservedSequence = Math.max(0, ...rpc.requests.map(request => request.sequence), ...rpc.responses.map(response => response.sequence));
  const input = draft.getByTestId("message-input");
  await input.fill(marker);
  assert.deepEqual(rpc.sideEffectSummary().counts, before,
    `${label} text entry must not create a thread or turn before Send`);
  assert.equal(fixture.requests.length, providerCount,
    `${label} text entry must not invoke the Provider before Send`);
  const route = new URL(page.url());
  assert.equal(route.searchParams.get("profileId"), profileId);
  assert.equal(route.searchParams.get("serverId"), targetId);
  assert.equal(route.searchParams.get("cwd"), cwd);
  await draft.getByTestId("send-message").click();
  await page.locator('[data-testid="message-user"]:visible').filter({ hasText: marker }).waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(() => rpc.successfulResponses("thread/start").length === threadCount + 1
    && rpc.successfulResponses("turn/start").length === turnCount + 1,
  30_000, `${label} real thread/start and turn/start ACKs`);
  await waitFor(() => fixture.requests.length === providerCount + 1,
    60_000, `${label} deterministic local Provider request`);

  const threadRequest = rpc.requests.filter(request => request.method === "thread/start"
    && request.sequence > lastObservedSequence).at(-1);
  assert.ok(threadRequest, `${label} must dispatch one browser-owned thread/start request`);
  assert.equal(threadRequest.serverId, targetId, `${label} must create on the exact selected target`);
  assert.equal(threadRequest.params.cwd, cwd, `${label} thread/start must use the exact selected cwd`);
  assert.equal(threadRequest.params.model, undefined,
    `${label} must use the configured workspace default without converting it into an explicit model override`);
  assert.ok(threadRequest.params.clientRequestId, `${label} must retain the stable creation request identity`);
  const threadAck = rpc.responses.find(response => response.method === "thread/start"
    && response.socketIndex === threadRequest.socketIndex && response.id === threadRequest.id);
  assert.ok(threadAck?.success, `${label} must receive the real successful thread/start ACK on the same socket`);
  const threadId = threadAck.result?.thread?.id;
  assert.ok(threadId, `${label} ACK must return the authoritative thread ID`);
  assert.equal(threadAck.result?.thread?.cwd, cwd, `${label} ACK must confirm the exact workspace path`);
  const turnRequest = rpc.requests.filter(request => request.method === "turn/start"
    && request.params.threadId === threadId).at(-1);
  assert.ok(turnRequest, `${label} must dispatch an initial turn to the newly acknowledged thread`);
  assert.equal(turnRequest.serverId, targetId);
  assert.equal(turnRequest.socketIndex, threadRequest.socketIndex,
    `${label} first turn must use its creation client owner`);
  assert.equal(turnRequest.params.model, expectedModel,
    `${label} first turn must resolve the exact default model from the workspace-scoped catalog`);
  assert.equal(turnRequest.params.permissionMode, undefined,
    `${label} initial turn must leave permissionMode absent so the real server default applies`);
  assert.ok(turnRequest.params.input?.some(item => item.type === "text" && String(item.text ?? "").includes(marker)),
    `${label} initial turn must contain the exact user-entered marker`);
  const turnAck = rpc.responses.find(response => response.method === "turn/start"
    && response.socketIndex === turnRequest.socketIndex && response.id === turnRequest.id);
  assert.ok(turnAck?.success, `${label} must receive the real successful turn/start ACK`);
  assert.equal(turnAck.socketIndex, threadRequest.socketIndex);
  assert.equal(rpc.sideEffectSummary().counts.attachmentRpcMethods, before.attachmentRpcMethods,
    `${label} text-only creation must not upload or retain attachments`);
  assert.equal(rpc.sideEffectSummary().counts.attachmentRetentionCalls, before.attachmentRetentionCalls);

  await waitFor(async () => await visibleAssistant.count() > assistantCount,
    60_000, `${label} assistant response from the deterministic Provider fixture`);
  await waitForWritableComposer(page, label);
  const providerRequest = fixture.requests.at(-1);
  assert.equal(providerRequest?.model, providerModel,
    `${label} actual Provider request must use the configured workspace-default model`);
  assertProviderReceivedText(providerRequest, marker);
  return {
    entry: label,
    targetId,
    cwd,
    threadId,
    creationRequestId: threadRequest.params.clientRequestId,
    threadStartAck: true,
    turnStartAck: true,
    model: expectedModel,
    providerModel: providerRequest.model,
    defaultPermissionModePreserved: turnRequest.params.permissionMode === undefined,
    providerResponseObserved: true,
  };
}

async function waitForWritableComposer(page, label) {
  const header = visibleTaskHeader(page);
  const inputs = page.locator('[data-testid="message-input"]:visible');
  const sends = page.locator('[data-testid="send-message"]:visible');
  await waitFor(async () => await header.count() === 1 && await inputs.count() === 1
    && await inputs.first().isEnabled() && await inputs.first().isEditable() && await sends.count() === 1,
    30_000, `${label} turn completion to restore the writable conversation composer`);
  assert.equal(await sends.first().isEnabled(), false,
    `${label} empty post-response composer must remain disabled until the user enters text`);
}

function assertProviderReceivedText(body, marker) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const userMessage = messages.filter(message => message?.role === "user").at(-1);
  const content = userMessage?.content;
  const userText = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter(item => item?.type === "text").map(item => String(item.text ?? "")).join("\n")
      : "";
  assert.equal(userText.includes(marker), true,
    "the deterministic local Provider request must receive the exact project-entry user text");
}

async function chooseProject(page, targetId, cwd) {
  const draft = await visibleDraftRoot(page);
  const projectButton = draft.getByTestId("draft-context-project");
  await projectButton.click();
  const modal = page.locator('[data-testid="draft-context-project-modal"]:visible');
  const inner = modal.locator('[role="dialog"]');
  await inner.waitFor({ state: "visible", timeout: 10_000 });
  const option = inner.getByTestId(projectOptionId(targetId, cwd));
  await option.waitFor({ state: "visible", timeout: 20_000 });
  await option.click();
  await inner.waitFor({ state: "hidden", timeout: 10_000 });
  await waitFor(async () => {
    const label = await projectButton.getAttribute("aria-label");
    return typeof label === "string" && label.includes(cwd);
  }, 30_000, `Draft context to select ${targetId} at the exact workspace path`);
  await projectButton.click();
  const selectedModal = page.locator('[data-testid="draft-context-project-modal"]:visible');
  const selectedInner = selectedModal.locator('[role="dialog"]');
  await selectedInner.waitFor({ state: "visible", timeout: 10_000 });
  const selectedOption = selectedInner.getByTestId(projectOptionId(targetId, cwd));
  await selectedOption.waitFor({ state: "visible", timeout: 15_000 });
  await waitFor(async () => await selectedOption.getAttribute("aria-pressed") === "true",
    30_000, `Draft context picker to confirm ${targetId} owns the exact selected path ${cwd}`);
  await selectedInner.getByTestId("draft-context-close").click();
  await selectedInner.waitFor({ state: "hidden", timeout: 10_000 });
}

async function assertTargetCatalog(page, rpc, targetId, cwd, expectedModel, forbiddenModels, expectedDefaultModel) {
  await waitFor(() => rpc.responses.some(response => response.method === "runtime.models.list"
    && response.serverId === targetId && response.workspacePath === cwd && response.success
    && responseModelIds(response).includes(expectedModel)),
  30_000, `${targetId} model catalog for the exact selected cwd to contain ${expectedModel}`);
  const modelResponse = rpc.responses.filter(response => response.method === "runtime.models.list"
    && response.serverId === targetId && response.workspacePath === cwd && response.success).at(-1);
  const ids = responseModelIds(modelResponse);
  assert.ok(ids.includes(expectedModel), `${targetId} catalog must contain ${expectedModel}`);
  assert.equal(modelResponse.workspacePath, cwd,
    `${targetId} catalog response must belong to the exact selected workspace, not another cwd on the same target`);
  const defaults = responseModels(modelResponse).filter(model => model.isDefault === true).map(model => model.id);
  assert.deepEqual(defaults, [expectedDefaultModel],
    `${targetId} at ${cwd} must expose exactly its configured workspace-default model`);
  if (expectedDefaultModel === ALPHA_OVERLAY_MODEL) {
    const overlay = responseModels(modelResponse).find(model => model.id === ALPHA_OVERLAY_MODEL);
    assert.equal(overlay?.defaultReasoningEffort, "high",
      "the overlay workspace's model configuration must preserve its actual configured default reasoning effort");
  }
  for (const forbidden of forbiddenModels) {
    assert.equal(ids.includes(forbidden), false,
      `${targetId} catalog must not reuse model ${forbidden} from another target sharing this Mobile profile`);
  }
  const draft = await visibleDraftRoot(page);
  const contextLabel = await draft.getByTestId("draft-context-project").getAttribute("aria-label");
  assert.ok(contextLabel?.includes(cwd), `${targetId} must be selected at its exact expected project path`);
  const modelSheet = await openModelSheet(page);
  const expectedOption = modelSheet.getByTestId(modelOptionId(expectedModel));
  await expectedOption.waitFor({ state: "visible", timeout: 15_000 });
  for (const forbidden of forbiddenModels) {
    assert.equal(await modelSheet.getByTestId(modelOptionId(forbidden)).count(), 0,
      `${targetId} visible model choices must exclude foreign target model ${forbidden}`);
  }
  await closeModelSheet(modelSheet);
  return { serverId: targetId, cwd, workspacePathLabel: contextLabel, modelIds: ids, defaultModelIds: defaults };
}

function responseModelIds(response) {
  return responseModels(response).map(model => model.id).filter(Boolean);
}

function responseModels(response) {
  if (!response) return [];
  const models = response.result?.data ?? response.result?.models ?? [];
  return Array.isArray(models) ? models.filter(model => model && typeof model === "object") : [];
}

function projectOptionId(serverId, cwd) {
  return `draft-context-project-option-${encodeURIComponent(serverId)}-${encodeURIComponent(cwd)}`;
}

function modelOptionId(modelId) {
  return `new-model-option-${encodeURIComponent(modelId)}`;
}

async function openModelSheet(page) {
  const draft = await visibleDraftRoot(page);
  await draft.getByTestId("draft-model-selector").click();
  const inner = page.locator('[data-testid="new-task-model-sheet-content"]:visible');
  await inner.waitFor({ state: "visible", timeout: 10_000 });
  return inner;
}

async function closeModelSheet(modelSheet) {
  const close = modelSheet.getByLabel("关闭", { exact: true });
  await close.click();
  await modelSheet.waitFor({ state: "hidden", timeout: 10_000 });
}

async function chooseModelAndEffort(page, modelId, effort, captureSelection) {
  let sheet = await openModelSheet(page);
  const modelOption = sheet.getByTestId(modelOptionId(modelId));
  await modelOption.waitFor({ state: "visible", timeout: 20_000 });
  await modelOption.click();
  await sheet.waitFor({ state: "hidden", timeout: 10_000 });
  sheet = await openModelSheet(page);
  const effortOption = sheet.getByTestId(`new-reasoning-option-${effort}`);
  await effortOption.waitFor({ state: "visible", timeout: 10_000 });
  await effortOption.click();
  assert.equal(await effortOption.getAttribute("aria-checked"), "true",
    `the New Draft model sheet must select reasoning effort ${effort}`);
  if (captureSelection) await captureSelection();
  await closeModelSheet(sheet);
}

async function choosePermissionMode(page, permissionMode, language, captureSelection) {
  const draft = await visibleDraftRoot(page);
  const trigger = draft.getByTestId("draft-permission-selector");
  await trigger.waitFor({ state: "visible", timeout: 20_000 });
  await trigger.click();
  const modal = page.locator('[data-testid="permission-mode-sheet"]:visible');
  const inner = modal.locator('[role="dialog"]');
  await inner.waitFor({ state: "visible", timeout: 10_000 });
  const option = inner.getByTestId(`permission-mode-${permissionMode}`);
  await option.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await option.isEnabled(), true,
    "write-capable permission modes must be selectable on a live non-preview target");
  await option.click();
  await inner.waitFor({ state: "hidden", timeout: 10_000 });
  const accessibleMode = language === "en" ? "Accept edits" : "自动接受编辑";
  await waitFor(async () => (await trigger.getAttribute("aria-label"))?.includes(accessibleMode),
    10_000, `the permission selector to show ${permissionMode}`);
  await trigger.click();
  const selectedModal = page.locator('[data-testid="permission-mode-sheet"]:visible');
  const selectedInner = selectedModal.locator('[role="dialog"]');
  await selectedInner.waitFor({ state: "visible", timeout: 10_000 });
  const selectedOption = selectedInner.getByTestId(`permission-mode-${permissionMode}`);
  await selectedOption.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await selectedOption.getAttribute("aria-checked"), "true",
    `the real permission selector must retain ${permissionMode} for the first turn`);
  if (captureSelection) await captureSelection();
  await selectedInner.getByTestId("permission-mode-close").click();
  await selectedInner.waitFor({ state: "hidden", timeout: 10_000 });
}

async function openProjectPicker(page) {
  const draft = await visibleDraftRoot(page);
  await draft.getByTestId("draft-context-project").click();
  const modal = page.locator('[data-testid="draft-context-project-modal"]:visible');
  const inner = modal.locator('[role="dialog"]');
  await inner.waitFor({ state: "visible", timeout: 10_000 });
  return inner;
}

async function assertProjectOptions(page, targets) {
  const inner = page.locator('[data-testid="draft-context-project-modal"]:visible').locator('[role="dialog"]');
  assert.equal(await inner.count(), 1,
    "project selection must be scoped to exactly one current inner sheet rather than its native Modal wrapper");
  for (const [serverId, cwd] of targets) {
    const option = inner.getByTestId(projectOptionId(serverId, cwd));
    await option.waitFor({ state: "visible", timeout: 15_000 });
  }
  const alphaWorkspace = targets.find(([serverId]) => serverId === "alpha")?.[1];
  const gammaWorkspace = targets.find(([serverId]) => serverId === "gamma")?.[1];
  assert.ok(alphaWorkspace, "project options must include the Alpha root workspace");
  assert.ok(gammaWorkspace, "project options must include the Gamma root workspace");
  const alpha = inner.getByTestId(projectOptionId("alpha", alphaWorkspace));
  const gamma = inner.getByTestId(projectOptionId("gamma", gammaWorkspace));
  assert.equal(await alpha.getAttribute("aria-pressed"), "true",
    "the same workspace path must be selected for Alpha by its target-scoped project identity");
  assert.equal(await gamma.getAttribute("aria-pressed"), "false",
    "the same path on Gamma must remain a separate unselected project option");
}

async function closeProjectPicker(page, language) {
  const inner = page.locator('[data-testid="draft-context-project-modal"]:visible').locator('[role="dialog"]');
  const close = inner.getByTestId("draft-context-close");
  assert.equal(await close.getAttribute("aria-label"), language === "en" ? "Close choices" : "关闭选项");
  await close.click();
  await inner.waitFor({ state: "hidden", timeout: 10_000 });
}

async function setAppearanceFromHome(page, currentLanguage, targetLanguage, theme) {
  const settingsLabel = currentLanguage === "en" ? "Settings" : "设置";
  const settingsTrigger = page.getByLabel(settingsLabel, { exact: true });
  await settingsTrigger.waitFor({ state: "visible", timeout: 15_000 });
  await settingsTrigger.click();
  const settings = page.getByTestId("settings-home");
  await settings.waitFor({ state: "visible", timeout: 15_000 });
  await settings.getByTestId("settings-appearance").click();
  const appearance = page.getByTestId("settings-appearance-screen");
  await appearance.waitFor({ state: "visible", timeout: 15_000 });

  await appearance.getByTestId("settings-theme-row").click();
  const themeModal = page.getByTestId("settings-choice-sheet-theme");
  const themeSheet = themeModal.locator('[role="dialog"]');
  await themeSheet.waitFor({ state: "visible", timeout: 10_000 });
  await themeSheet.getByTestId(`settings-theme-choice-${theme}`).click();
  await themeSheet.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, theme, { timeout: 10_000 });

  await appearance.getByTestId("settings-language-row").click();
  const languageModal = page.getByTestId("settings-choice-sheet-language");
  const languageSheet = languageModal.locator('[role="dialog"]');
  await languageSheet.waitFor({ state: "visible", timeout: 10_000 });
  const languageOption = targetLanguage === "en" ? "settings-language-choice-en" : "settings-language-choice-zh-cn";
  await languageSheet.getByTestId(languageOption).click();
  await languageSheet.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForFunction(expected => document.documentElement.lang === expected,
    targetLanguage === "en" ? "en" : "zh-CN", { timeout: 10_000 });

  await appearance.getByTestId("settings-detail-back").click();
  await settings.waitFor({ state: "visible", timeout: 15_000 });
  await settings.getByTestId("settings-detail-back").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 15_000 });
  await assertRenderedPreferences(page, targetLanguage, theme);
}

async function assertRenderedPreferences(page, language, theme) {
  await page.waitForFunction(({ expectedLanguage, expectedTheme }) =>
    document.documentElement.lang === expectedLanguage
      && document.documentElement.style.colorScheme === expectedTheme,
  { expectedLanguage: language === "en" ? "en" : "zh-CN", expectedTheme: theme }, { timeout: 10_000 });
}

async function backToHome(page, language) {
  const backLabel = language === "en" ? "Back" : "返回";
  const back = page.locator(`[aria-label="${backLabel}"]:visible`);
  await back.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await back.count(), 1, "New Draft must expose one visible back action to its paired profile Home");
  await back.click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 15_000 });
}

async function addDocumentFile(page, file) {
  await page.getByTestId("composer-attachment").click();
  const modal = page.getByTestId("draft-attachment-sheet");
  const inner = modal.locator('[role="dialog"]');
  await inner.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await inner.getByText("选择文件", { exact: true }).count(), 1,
    "the attachment sheet must expose one localized file-selection action");
  const pickerEvidence = await setExpoWebDocumentPickerFiles(page, file);
  assert.equal(pickerEvidence.filechooserObserved, true,
    "the selected file must pass through the actual Expo Web DocumentPicker filechooser");
  assert.deepEqual(pickerEvidence.selectedFiles.map(({ name, type }) => ({ name, type })), [
    { name: file.name, type: file.mimeType },
  ], "Expo's change event must contain the exact selected local file and MIME type");
  await inner.waitFor({ state: "hidden", timeout: 10_000 });
  const preview = file.mimeType.startsWith("image/")
    ? page.getByTestId(`composer-image-attachment-${encodeURIComponent(file.name)}`)
    : page.getByTestId("draft-local-attachment-preview").getByText(file.name, { exact: true });
  await preview.waitFor({ state: "visible", timeout: 15_000 });
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `${label} must fit without horizontal page overflow; found ${dimensions.scrollWidth}px content in ${dimensions.clientWidth}px viewport`);
}

async function captureScreenshot(page, context, screenshots, name, viewport) {
  const screenshotPath = context.pathInCase("system-chromium", "mobile-new-draft-composer", name);
  await mkdir(dirname(screenshotPath), { recursive: true });
  const bytes = await page.screenshot({ path: screenshotPath, animations: "disabled" });
  screenshots.push({
    name,
    runRelativePath: relative(context.runRoot, screenshotPath),
    sha256: sha256(bytes),
    width: viewport.width,
    height: viewport.height,
    language: viewport.language,
    theme: viewport.theme,
  });
}

function profileIdFromUrl(value) {
  const path = new URL(value).pathname.split("/").filter(Boolean);
  const segment = path.indexOf("h");
  const profileId = decodeURIComponent(path[segment + 1] ?? "");
  assert.ok(profileId, "the paired Mobile Home and New Draft routes must stay inside their Gateway profile");
  return profileId;
}

function localeSlug(language) {
  return language === "en" ? "en" : "zh-cn";
}

function slug(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "stage";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
