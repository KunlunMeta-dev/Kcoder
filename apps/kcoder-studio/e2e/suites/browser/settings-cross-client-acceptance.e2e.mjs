import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { brokerOwnershipDiagnosticGatewayOptions, parseBrokerOwnershipObserverLog } from "../../harness/broker-ownership-observer.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { login } from "../../harness/http.mjs";
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { fingerprintRegularTree, fingerprintRendererSource } from "../../harness/settings-fingerprints.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const MOBILE_PREFERENCES_KEY = "kcoder-studio:mobile-app-preferences:v1";
const SETTINGS_SOURCE = "settings-cross-client-acceptance";
const TARGET_A = "settings-a";
const TARGET_B = "settings-b";
const PROVIDER_ID = "settings-fixture";
const SETTINGS_HOME_ROW_IDS = [
  "settings-manage-connections",
  "settings-section-models_services",
  "settings-section-execution_permissions",
  "settings-appearance",
  "settings-section-conversation_preferences",
  "settings-section-quick_phrases",
  "settings-section-custom_instructions",
  "settings-section-tool_configuration",
  "settings-section-plugins_skills",
  "settings-section-usage",
  "settings-section-storage_cache",
  "terminal-settings",
  "diagnostics-settings",
  "settings-about",
];
let targetRpcSequence = 0;

// This uses the root-provided product exports and real target binary. It is a
// manual prebuilt diagnostic; it does not certify frozen dependency integration.
await runE2E(import.meta.url, {
  testId: "settings-mobile-desktop-cross-client-prebuilt-acceptance",
  tier: "manual-live",
  modelPolicy: "authenticated Mobile Web and desktop Web with real local CLI app-server RPC; loopback-only provider fixture; no live account or model",
  prebuiltManualDiagnostic: true,
  frozenDependencyIntegration: false,
  retainSuccessLogs: true,
  cleanupTimeoutMs: 45_000,
}, async context => {
  const pins = await verifyPrebuiltInputs(context);
  const binary = await requireExecutable(pins.kcBin, "pinned KCoder CLI app-server");
  const brokerDiagnosticOptions = brokerOwnershipDiagnosticGatewayOptions();
  let gateway;
  let brokerOwnershipDiagnostic = null;
  if (brokerDiagnosticOptions) {
    const brokerObserverPath = resolve(appRoot, "e2e/harness/broker-ownership-observer.mjs");
    let brokerObserverSourceSha256 = null;
    let brokerObserverSourceReadError = null;
    try {
      brokerObserverSourceSha256 = sha256(await readFile(brokerObserverPath));
    } catch (error) {
      brokerObserverSourceReadError = error instanceof Error ? error.name : "Error";
    }
    brokerOwnershipDiagnostic = {
      schemaVersion: 1,
      evidenceClass: "instrumented-broker-ownership-diagnostic",
      stage: "target-restart-not-reached",
      observerSource: {
        startupSha256: brokerObserverSourceSha256,
        startupReadError: brokerObserverSourceReadError,
        cleanupSha256: null,
        unchanged: null,
      },
      targetGeneration: { serverId: TARGET_A, processIdBeforeRestart: null, processIdAfterRestart: null },
      beforeResources: null,
      restartOutcome: { state: "not-attempted" },
    };
    context.addCleanup("persist broker ownership observer diagnostic", async () => {
      const stderr = gateway?.stderrDiagnostics?.snapshot() ?? null;
      let brokerObserverSourceAtCleanup = null;
      let brokerObserverSourceCleanupReadError = null;
      try {
        brokerObserverSourceAtCleanup = sha256(await readFile(brokerObserverPath));
      } catch (error) {
        brokerObserverSourceCleanupReadError = error instanceof Error ? error.name : "Error";
      }
      const observer = parseBrokerOwnershipObserverLog(stderr?.text ?? "", stderr ? null : "owned-stderr-capture-unavailable");
      if (stderr) {
        const { text, ...captureMetadata } = stderr;
        observer.stderrCapture = captureMetadata;
        if (!stderr.complete) observer.incompleteReasons.push(...stderr.incompleteReasons);
      }
      const observerSourceUnchanged = brokerObserverSourceSha256 !== null
        && brokerObserverSourceAtCleanup !== null
        && brokerObserverSourceSha256 === brokerObserverSourceAtCleanup;
      brokerOwnershipDiagnostic.observerSource.cleanupSha256 = brokerObserverSourceAtCleanup;
      brokerOwnershipDiagnostic.observerSource.cleanupReadError = brokerObserverSourceCleanupReadError;
      brokerOwnershipDiagnostic.observerSource.unchanged = observerSourceUnchanged;
      observer.sourceBinding = brokerOwnershipDiagnostic.observerSource;
      if (brokerObserverSourceSha256 === null) observer.incompleteReasons.push("observer-source-startup-hash-unavailable");
      if (brokerObserverSourceAtCleanup === null) observer.incompleteReasons.push("observer-source-cleanup-hash-unavailable");
      if (brokerObserverSourceSha256 !== null && brokerObserverSourceAtCleanup !== null && !observerSourceUnchanged) {
        observer.incompleteReasons.push("observer-source-changed-during-run");
      }
      observer.complete = observer.incompleteReasons.length === 0;
      brokerOwnershipDiagnostic.observer = observer;
      brokerOwnershipDiagnostic.evidenceComplete = observer.complete;
      brokerOwnershipDiagnostic.incompleteReasons = observer.incompleteReasons;
      await context.writeArtifactJsonInternal("broker-ownership-diagnostic.json", brokerOwnershipDiagnostic);
    });
  }

  const { path: workspaceA } = await materializeWorkspace(context, "minimal", { instanceId: "settings-a" });
  const { path: workspaceB } = await materializeWorkspace(context, "minimal", { instanceId: "settings-b" });

  const modelOk = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: "OK" });
  const modelUnauthorized = await startApprovalModelFixture(context, {
    textOnly: true,
    httpErrorPrompt: "Reply only OK.",
    httpErrorStatus: 401,
    httpErrorCode: "invalid_api_key",
  });
  const modelRateLimited = await startApprovalModelFixture(context, {
    textOnly: true,
    httpErrorPrompt: "Reply only OK.",
    httpErrorStatus: 429,
    httpErrorCode: "rate_limit_error",
  });
  let holdLateReply = true;
  let releaseLateReply = false;
  const modelLate = await startApprovalModelFixture(context, {
    responseSteps: () => [
      { ready: () => !holdLateReply || releaseLateReply, delta: { role: "assistant", content: "LATE_OK" } },
      { finishReason: "stop" },
    ],
  });
  const isolatedConfig = context.pathInState("gateway-config");
  await mkdir(isolatedConfig, { recursive: true, mode: 0o700 });
  const targetA = await createTarget(context, {
    id: TARGET_A,
    binary,
    workspace: workspaceA,
    providerId: PROVIDER_ID,
    model: "settings-model-before",
    endpoint: modelOk.baseUrl,
    secret: `e2e-settings-${context.seed}-target-a`,
  });
  const targetB = await createTarget(context, {
    id: TARGET_B,
    binary,
    workspace: workspaceB,
    providerId: "settings-b-fixture",
    model: "settings-model-b-only",
    endpoint: modelOk.baseUrl,
    secret: `e2e-settings-${context.seed}-target-b`,
  });
  context.registerSecret(targetA.secret);
  context.registerSecret(targetB.secret);
  const settingsFileA = targetA.userSettingsFile;
  const settingsFileB = targetB.userSettingsFile;
  await context.writeArtifactJson("target-config-authorities.json", {
    targets: [targetA, targetB].map(target => ({
      id: target.id,
      workspace: target.workspace,
      command: target.command,
      configDir: target.configDir,
      userSettingsFile: target.userSettingsFile,
      credentialsFile: target.credentialsFile,
      emptyOverlayFile: target.overlayFile,
      binarySha256: target.binarySha256,
      providerProfile: target.profile,
      userConfigDirIsolated: true,
    })),
  });

  const chromiumBin = process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium";
  const chromiumNoSandbox = process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";
  const serversFile = await context.writeStateJson("servers.json", [
    {
      id: TARGET_A,
      label: "Settings Target A",
      runtime: "kcoder",
      transport: "local",
      command: targetA.command,
      workspace: workspaceA,
      settingsFile: targetA.overlayFile,
      profile: targetA.profile,
      chromiumBin,
      chromiumNoSandbox,
    },
    {
      id: TARGET_B,
      label: "Settings Target B",
      runtime: "kcoder",
      transport: "local",
      command: targetB.command,
      workspace: workspaceB,
      settingsFile: targetB.overlayFile,
      profile: targetB.profile,
      chromiumBin,
      chromiumNoSandbox,
    },
  ]);
  gateway = await startGateway(context, {
    ...brokerDiagnosticOptions,
    label: "settings-acceptance-gateway",
    auth: true,
    workspace: workspaceA,
    serversFile,
    kcoderBin: binary,
    env: {
      KCODER_CONFIG_DIR: isolatedConfig,
      KCODER_STUDIO_WEB_ROOT: pins.rendererRoot,
      KCODER_STUDIO_MOBILE_WEB_ROOT: pins.mobileRoot,
      KCODER_CHROMIUM_BIN: chromiumBin,
      KCODER_CHROMIUM_NO_SANDBOX: chromiumNoSandbox ? "1" : "0",
      ...brokerDiagnosticOptions?.env,
    },
  });
  const cookie = await login(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  const gatewayToken = await waitForGatewayRpcToken(context, gateway, {
    headers: { cookie },
    expectedToken: "cookie-auth",
  });

  const chromium = await startChromium(context, {
    label: "settings-acceptance-chromium",
    noSandbox: chromiumNoSandbox,
    startTimeoutMs: 60_000,
  });
  const mobileContext = await chromium.browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
    colorScheme: "light",
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const desktopContext = await chromium.browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: "zh-CN",
    colorScheme: "light",
  });
  context.addCleanup("close settings browser contexts", async () => {
    await Promise.allSettled([mobileContext.close(), desktopContext.close()]);
  });

  const mobile = await mobileContext.newPage();
  const desktop = await desktopContext.newPage();
  const uiErrors = [];
  const mobileRpcMethods = [];
  const desktopRpcMethods = [];
  const mobileRpcReceipts = [];
  const desktopRpcReceipts = [];
  observePage(mobile, "mobile", uiErrors, mobileRpcMethods, mobileRpcReceipts);
  observePage(desktop, "desktop", uiErrors, desktopRpcMethods, desktopRpcReceipts);
  const pairingResponses = [];
  mobile.on("response", response => {
    if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/mobile/session") {
      pairingResponses.push(response.status());
    }
  });

  await pairMobile(mobile, gateway);
  const profileId = mobileProfileId(mobile.url());
  assert.ok(profileId, `paired Mobile Web route must identify its owned profile: ${safeUrl(mobile.url())}`);
  assert.ok(pairingResponses.includes(200), "Mobile Web must pair through authenticated Gateway session exchange");
  await loginDesktop(desktop, gateway);
  const mobileSettingsHomeScreenshots = await captureMobileSettingsHomeMatrix(mobile, context, gateway);

  // The Mobile provider editor writes to target A through the selected-target
  // context. A second desktop Web client edits the same provider through the
  // existing Gateway target page. The real CLI settings files are the oracle.
  await openMobileSection(mobile, "models_services");
  await selectMobileTarget(mobile, TARGET_A);
  const targetListA = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_A, async (rpc, initialized) => {
    const list = await rpc.request("runtime.providers.list", {});
    return { initialized, list };
  });
  assert.equal(targetListA.list.supportsIndependentProbe, true, "the real target must expose provider probe support");
  assert.equal(targetListA.list.supportsOptimisticConcurrency, true, "the real target must expose provider revision checks");
  assert.ok(targetListA.initialized.capabilities?.experimental?.toolProfilesV1, "target A must advertise toolProfilesV1");
  assert.ok(targetListA.initialized.capabilities?.experimental?.executionDefaultsV1, "target A must advertise executionDefaultsV1");

  await mobile.locator('[data-testid^="models-provider-edit-"]:visible').filter({ hasText: "settings-model-before" }).click();
  await visibleTestId(mobile, "models-provider-form").waitFor({ state: "visible", timeout: 15_000 });
  await visibleTestId(mobile, "models-provider-endpoint").fill(modelOk.baseUrl);
  await visibleTestId(mobile, "models-provider-model").fill("settings-model-v1");
  await visibleTestId(mobile, "models-provider-context-window").fill("32000");
  await visibleTestId(mobile, "models-provider-max-output").fill("2048");
  assert.equal(modelOk.requests.length, 0, "saving an independently probeable provider must not call the HTTP endpoint");
  await visibleTestId(mobile, "models-provider-save").click();
  const mobileProviderRow = mobile.locator(`[data-testid^="models-provider-edit-"]:visible`).filter({ hasText: "settings-model-v1" });
  await mobileProviderRow.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(modelOk.requests.length, 0, "provider save stays offline until the explicit probe button is pressed");
  await mobileProviderRow.click();
  const successfulProbeReceiptCount = () => mobileRpcReceipts.filter(receipt => receipt.method === "runtime.providers.probe"
    && receipt.targetId === TARGET_A
    && receipt.channel === "runtime"
    && receipt.hasResult
    && !receipt.hasError).length;
  const successfulProbeReceiptsBefore = successfulProbeReceiptCount();
  await visibleTestId(mobile, "models-provider-test").click();
  await visibleTestId(mobile, "models-provider-test-result").filter({ hasText: /成功|success/i }).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(modelOk.requests.length, 1, "explicit provider probe must issue one loopback HTTP/SSE request");
  await context.writeArtifactJson("mobile-provider-probe-receipt-wait.json", {
    stage: "ui-success-waiting-for-rpc-receipt",
    targetId: TARGET_A,
    channel: "runtime",
    method: "runtime.providers.probe",
    fixtureHttpRequests: modelOk.requests.length,
    uiSuccessVisible: true,
    successfulRpcReceipts: successfulProbeReceiptCount(),
    errorRpcReceipts: mobileRpcReceipts.filter(receipt => receipt.method === "runtime.providers.probe"
      && receipt.targetId === TARGET_A
      && receipt.channel === "runtime"
      && receipt.hasError).length,
  });
  await waitFor(
    () => successfulProbeReceiptCount() > successfulProbeReceiptsBefore,
    15_000,
    "successful target A runtime-channel provider-probe JSON-RPC receipt to return",
  );
  await context.writeArtifactJson("mobile-provider-probe-rpc.json", {
    stage: "receipt-observed",
    targetId: TARGET_A,
    channel: "runtime",
    method: "runtime.providers.probe",
    fixtureHttpRequests: modelOk.requests.length,
    uiSuccessVisible: true,
    successfulRpcReceipts: successfulProbeReceiptCount(),
  });
  const providerAfterMobileWrite = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_A, rpc =>
    rpc.request("runtime.providers.list", {}));
  assert.ok(providerAfterMobileWrite.profiles.some(item => item.id === PROVIDER_ID && item.model === "settings-model-v1"));
  assert.equal(JSON.stringify(providerAfterMobileWrite).includes(gateway.authToken), false, "target provider list must not echo Gateway credentials");

  await desktop.goto(`${gateway.baseUrl}/settings/personal/models`, { waitUntil: "domcontentloaded" });
  await desktop.getByTestId("kcoder-provider-settings-page").waitFor({ state: "visible", timeout: 30_000 });
  const desktopProviderTarget = desktop.getByTestId("provider-target");
  const desktopProviderTargetSelection = await selectOptionIfNeeded(
    desktopProviderTarget,
    TARGET_A,
    "Desktop provider target",
  );
  const desktopProviderRow = desktop.locator('[data-testid^="provider-edit-"]').filter({ hasText: "settings-model-v1" });
  try {
    await desktopProviderRow.waitFor({ state: "visible", timeout: 30_000 });
  } catch (error) {
    const visibleTestIds = await desktop.locator("[data-testid]:visible").evaluateAll(nodes =>
      nodes.map(node => node.getAttribute("data-testid")).filter(Boolean),
    ).catch(() => []);
    await Promise.allSettled([
      context.writeArtifactJson("desktop-provider-row-timeout.json", {
        url: safeUrl(desktop.url()),
        selectedTarget: await desktopProviderTarget.inputValue().catch(() => null),
        targetSelection: desktopProviderTargetSelection,
        expectedRow: "settings-model-v1",
        visibleTestIds,
      }),
      desktop.screenshot({ path: context.pathInArtifacts("desktop-provider-row-timeout.png"), animations: "disabled" }),
    ]);
    throw error;
  }
  await desktopProviderRow.click();
  await desktop.getByTestId("provider-model").fill("settings-model-from-desktop");
  await desktop.getByTestId("provider-save").click();
  await desktop.locator('[data-testid^="provider-edit-"]').filter({ hasText: "settings-model-from-desktop" }).waitFor({ state: "visible", timeout: 30_000 });
  const providerAfterDesktopWrite = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_A, rpc =>
    rpc.request("runtime.providers.list", {}));
  assert.ok(providerAfterDesktopWrite.profiles.some(item => item.id === PROVIDER_ID && item.model === "settings-model-from-desktop"));
  assert.equal(modelOk.requests.length, 1, "editing provider configuration must not probe implicitly");

  await openMobileSection(mobile, "models_services");
  await selectMobileTarget(mobile, TARGET_A);
  await mobile.locator('[data-testid^="models-provider-edit-"]:visible').filter({ hasText: "settings-model-from-desktop" }).waitFor({ state: "visible", timeout: 30_000 });
  await mobile.locator('[data-testid^="models-provider-edit-"]:visible').filter({ hasText: "settings-model-from-desktop" }).click();
  await visibleTestId(mobile, "models-provider-endpoint").fill(modelUnauthorized.baseUrl);
  await visibleTestId(mobile, "models-provider-save").click();
  await mobile.locator('[data-testid^="models-provider-edit-"]:visible').filter({ hasText: "settings-model-from-desktop" }).waitFor({ state: "visible", timeout: 20_000 });
  await mobile.locator('[data-testid^="models-provider-edit-"]:visible').filter({ hasText: "settings-model-from-desktop" }).click();
  await visibleTestId(mobile, "models-provider-test").click();
  await visibleTestId(mobile, "models-provider-test-result").filter({ hasText: /401|认证|authentication|unauthorized/i }).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(modelUnauthorized.requests.length, 1, "401 classification must come from a real loopback response");

  await visibleTestId(mobile, "models-provider-endpoint").fill(modelRateLimited.baseUrl);
  await visibleTestId(mobile, "models-provider-save").click();
  await mobile.locator('[data-testid^="models-provider-edit-"]:visible').filter({ hasText: "settings-model-from-desktop" }).waitFor({ state: "visible", timeout: 20_000 });
  await mobile.locator('[data-testid^="models-provider-edit-"]:visible').filter({ hasText: "settings-model-from-desktop" }).click();
  await visibleTestId(mobile, "models-provider-test").click();
  await visibleTestId(mobile, "models-provider-test-result").filter({ hasText: /429|rate|速率限制/i }).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(modelRateLimited.requests.length, 1, "429 classification must come from a real loopback response");

  await visibleTestId(mobile, "models-provider-endpoint").fill(modelLate.baseUrl);
  await visibleTestId(mobile, "models-provider-save").click();
  await mobile.locator('[data-testid^="models-provider-edit-"]:visible').filter({ hasText: "settings-model-from-desktop" }).waitFor({ state: "visible", timeout: 20_000 });
  await mobile.locator('[data-testid^="models-provider-edit-"]:visible').filter({ hasText: "settings-model-from-desktop" }).click();
  const probeRequestsBeforeLate = mobileRpcMethods.filter(method => method === "runtime.providers.probe").length;
  await visibleTestId(mobile, "models-provider-test").click();
  await waitFor(
    () => modelLate.requests.length === 1
      && mobileRpcMethods.filter(method => method === "runtime.providers.probe").length === probeRequestsBeforeLate + 1,
    15_000,
    "held local provider probe reached its fixture and was sent over the target RPC channel",
  );
  const pendingResultBeforeSwitch = await visibleTestId(mobile, "models-provider-test-result").count();
  assert.equal(pendingResultBeforeSwitch, 0, "a held target A probe cannot render a result before completion");
  assert.equal(modelLate.requestOutcomes[0]?.closed, false, "the late-probe fixture must still be holding its HTTP response before target switch");
  const settingsWritesBeforeLateProbe = mobileRpcMethods.filter(isTargetSettingsWrite).length;
  const targetBSettingsBeforeLateProbe = await readFile(settingsFileB, "utf8");
  await selectMobileTarget(mobile, TARGET_B);
  await visibleTestId(mobile, "models-target-name").filter({ hasText: "Settings Target B" }).waitFor({ state: "visible", timeout: 30_000 });
  const outcomeAtSwitch = { ...modelLate.requestOutcomes[0] };
  if (!outcomeAtSwitch.closed) {
    releaseLateReply = true;
    holdLateReply = false;
  }
  await waitFor(
    () => modelLate.requestOutcomes[0]?.closed === true,
    15_000,
    "the old target's held provider HTTP request to finish or abort after the switch",
  );
  const lateProbeOutcome = { ...modelLate.requestOutcomes[0] };
  assert.equal(lateProbeOutcome.closed, true, "the old target fixture must expose a terminal HTTP outcome");
  assert.equal(await mobile.getByTestId("models-provider-test-result").count(), 0, "late target A reply must not appear under target B");
  assert.equal(await mobile.getByTestId("models-provider-error").count(), 0, "late target A failure must not appear under target B");
  assert.equal(await mobile.getByTestId("models-provider-notice").count(), 0, "late target A success must not appear under target B");
  const providerListB = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_B, rpc =>
    rpc.request("runtime.providers.list", {}));
  assert.equal(providerListB.profiles.some(item => item.id === PROVIDER_ID), false, "target A provider settings must not leak to target B");
  assert.equal(await readFile(settingsFileB, "utf8"), targetBSettingsBeforeLateProbe,
    "a late target A probe must not write target B's independent settings file");
  assert.equal(mobileRpcMethods.filter(isTargetSettingsWrite).length, settingsWritesBeforeLateProbe,
    "switching targets while a probe is pending must issue no target-settings write");
  await context.writeArtifactJson("late-probe-observation.json", {
    fixtureRequests: modelLate.requests.length,
    fixtureHttpOutcome: lateProbeOutcome.aborted ? "aborted" : "completed",
    fixtureOutcomeAtSwitch: outcomeAtSwitch.closed
      ? (outcomeAtSwitch.aborted ? "aborted-by-switch-observation" : "completed-by-switch-observation")
      : "held-at-switch",
    released: releaseLateReply,
    lateMobileRpcReceiptExpected: false,
    pendingResultBeforeSwitch,
  });

  // Device-local preferences and quick phrases persist in Mobile Web storage,
  // stay out of target RPC writes, and are exercised in the actual composer.
  const rpcWritesBeforeLocalPreferences = mobileRpcMethods.filter(isTargetSettingsWrite).length;
  await openMobileSection(mobile, "conversation_preferences");
  await visibleTestId(mobile, "conversation-font-scale-row").click();
  await visibleTestId(mobile, "conversation-font-scale-choice-large").click();
  await visibleTestId(mobile, "conversation-line-spacing-row").click();
  await visibleTestId(mobile, "conversation-line-spacing-choice-relaxed").click();
  const conversationSwitchStates = {
    thinking: await toggleConversationPreference(mobile, "conversation-thinking-default-collapsed", "thinkingCollapsedByDefault"),
    tools: await toggleConversationPreference(mobile, "conversation-tools-default-collapsed", "toolsCollapsedByDefault"),
  };
  await mobile.waitForFunction(({ key, thinking, tools }) => {
    try {
      const preferences = JSON.parse(localStorage.getItem(key) ?? "null");
      return preferences?.conversationFontScale === "large"
        && preferences?.conversationLineSpacing === "relaxed"
        && preferences?.thinkingCollapsedByDefault === thinking
        && preferences?.toolsCollapsedByDefault === tools;
    } catch {
      return false;
    }
  }, {
    key: MOBILE_PREFERENCES_KEY,
    thinking: conversationSwitchStates.thinking.after,
    tools: conversationSwitchStates.tools.after,
  }, { timeout: 10_000 });
  await mobile.reload({ waitUntil: "domcontentloaded" });
  await openMobileSection(mobile, "conversation_preferences");
  await waitForConversationPreferenceState(
    mobile,
    "conversation-thinking-default-collapsed",
    "thinkingCollapsedByDefault",
    conversationSwitchStates.thinking.after,
    "thinking preference outer aria, native input, and storage state after reload",
  );
  await waitForConversationPreferenceState(
    mobile,
    "conversation-tools-default-collapsed",
    "toolsCollapsedByDefault",
    conversationSwitchStates.tools.after,
    "tools preference outer aria, native input, and storage state after reload",
  );
  await visibleTestId(mobile, "conversation-font-scale-row").click();
  await visibleTestId(mobile, "conversation-font-scale-sheet").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await visibleTestId(mobile, "conversation-font-scale-choice-large").getAttribute("aria-checked"), "true");
  await visibleTestId(mobile, "conversation-font-scale-sheet").getByTestId("settings-choice-cancel").click();
  await visibleTestId(mobile, "conversation-line-spacing-row").click();
  await visibleTestId(mobile, "conversation-line-spacing-sheet").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await visibleTestId(mobile, "conversation-line-spacing-choice-relaxed").getAttribute("aria-checked"), "true");
  await visibleTestId(mobile, "conversation-line-spacing-sheet").getByTestId("settings-choice-cancel").click();
  assert.equal(await visibleTestId(mobile, "conversation-thinking-default-collapsed").getAttribute("aria-checked"), String(conversationSwitchStates.thinking.after));
  assert.equal(await visibleTestId(mobile, "conversation-tools-default-collapsed").getAttribute("aria-checked"), String(conversationSwitchStates.tools.after));
  assert.equal(await visibleTestId(mobile, "conversation-thinking-default-collapsed").locator('input[role="switch"]').isChecked(), conversationSwitchStates.thinking.after);
  assert.equal(await visibleTestId(mobile, "conversation-tools-default-collapsed").locator('input[role="switch"]').isChecked(), conversationSwitchStates.tools.after);
  assert.equal(mobileRpcMethods.filter(isTargetSettingsWrite).length, rpcWritesBeforeLocalPreferences,
    "device-local reading preferences must not write settings to a runtime target");

  await openMobileSection(mobile, "quick_phrases");
  await visibleTestId(mobile, "quick-phrase-add").click();
  await visibleTestId(mobile, "quick-phrase-title-input").fill("Acceptance phrase");
  await visibleTestId(mobile, "quick-phrase-content-input").fill("SETTINGS_PHRASE_DRAFT_ONLY");
  await visibleTestId(mobile, "quick-phrase-save").click();
  const phraseCard = mobile.locator('[data-testid^="quick-phrase-card-"]:visible').filter({ hasText: "Acceptance phrase" });
  await phraseCard.waitFor({ state: "visible", timeout: 15_000 });
  const phraseId = await phraseCard.getAttribute("data-testid").then(value => value?.slice("quick-phrase-card-".length));
  assert.ok(phraseId, "saved local phrase must have a stable device-local id");
  const retainedPhraseCard = visibleTestId(mobile, `quick-phrase-card-${phraseId}`);
  await visibleTestId(mobile, `quick-phrase-edit-${phraseId}`).click();
  await visibleTestId(mobile, "quick-phrase-editor").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await visibleTestId(mobile, "quick-phrase-title-input").inputValue(), "Acceptance phrase");
  assert.equal(await visibleTestId(mobile, "quick-phrase-content-input").inputValue(), "SETTINGS_PHRASE_DRAFT_ONLY");
  await visibleTestId(mobile, "quick-phrase-title-input").fill("Acceptance phrase edited");
  await visibleTestId(mobile, "quick-phrase-save").click();
  await visibleTestId(mobile, "quick-phrase-editor").waitFor({ state: "hidden", timeout: 15_000 });
  await retainedPhraseCard.filter({ hasText: "Acceptance phrase edited" }).waitFor({ state: "visible", timeout: 10_000 });

  await visibleTestId(mobile, "quick-phrase-add").click();
  await visibleTestId(mobile, "quick-phrase-title-input").fill("Acceptance phrase to delete");
  await visibleTestId(mobile, "quick-phrase-content-input").fill("SETTINGS_PHRASE_DELETE_ONLY");
  await visibleTestId(mobile, "quick-phrase-save").click();
  const deletionCard = mobile.locator('[data-testid^="quick-phrase-card-"]:visible').filter({ hasText: "Acceptance phrase to delete" });
  await deletionCard.waitFor({ state: "visible", timeout: 15_000 });
  const deletionPhraseId = await deletionCard.getAttribute("data-testid").then(value => value?.slice("quick-phrase-card-".length));
  assert.ok(deletionPhraseId, "temporary local phrase must have a stable device-local id");
  await visibleTestId(mobile, `quick-phrase-delete-${deletionPhraseId}`).click();
  await mobile.getByTestId(`quick-phrase-card-${deletionPhraseId}`).waitFor({ state: "detached", timeout: 15_000 });
  await mobile.waitForFunction(({ key, retainedId, deletedId }) => {
    try {
      const phrases = JSON.parse(localStorage.getItem(key) ?? "null")?.quickPhrases;
      const retained = Array.isArray(phrases) ? phrases.find(phrase => phrase.id === retainedId) : null;
      return retained?.title === "Acceptance phrase edited"
        && retained.content === "SETTINGS_PHRASE_DRAFT_ONLY"
        && !phrases.some(phrase => phrase.id === deletedId);
    } catch {
      return false;
    }
  }, { key: MOBILE_PREFERENCES_KEY, retainedId: phraseId, deletedId: deletionPhraseId }, { timeout: 10_000 });
  assert.equal(mobileRpcMethods.filter(isTargetSettingsWrite).length, rpcWritesBeforeLocalPreferences,
    "quick-phrase create, edit, and delete must remain device-local");
  const quickPhraseCrud = { created: true, edited: true, temporaryPhraseDeleted: true, composerPhraseRetained: true };
  const composerThread = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_A, async rpc => {
    const started = await rpc.request("thread/start", { cwd: workspaceA, model: `${PROVIDER_ID}::settings-model-from-desktop` });
    return { thread: started.thread };
  });
  assert.ok(composerThread.thread?.id, "real app-server thread/start must provide the Mobile composer owner");
  const taskUrl = `${gateway.baseUrl}/h/${encodeURIComponent(profileId)}/task/${encodeURIComponent(TARGET_A)}/${encodeURIComponent(composerThread.thread.id)}?cwd=${encodeURIComponent(workspaceA)}`;
  const mobileTaskUrl = taskUrl.replace(`${gateway.baseUrl}/h/`, `${gateway.baseUrl}/mobile/h/`);
  await mobile.goto(mobileTaskUrl, { waitUntil: "domcontentloaded" });
  const composerInput = visibleTestId(mobile, "message-input");
  await composerInput.waitFor({ state: "visible", timeout: 30_000 });
  await composerInput.click();
  await mobile.waitForFunction(() => {
    const input = document.querySelector('[data-testid="message-input"]');
    return input && document.activeElement === input;
  }, null, { timeout: 10_000 });
  const composerQuickPhrases = visibleTestId(mobile, "composer-quick-phrases");
  await composerQuickPhrases.waitFor({ state: "visible", timeout: 10_000 });
  await composerQuickPhrases.click();
  await visibleTestId(mobile, `quick-phrase-use-${phraseId}`).click();
  assert.equal(await visibleTestId(mobile, "message-input").inputValue(), "SETTINGS_PHRASE_DRAFT_ONLY");
  assert.equal(await visibleTestId(mobile, "send-message").isVisible(), true);
  assert.equal(await visibleTestId(mobile, "send-message").isDisabled(), false);
  assert.equal(mobileRpcMethods.filter(method => method === "turn/start").length, 0,
    "selecting a quick phrase changes the real composer draft and never sends a turn");

  // Permission defaults and custom instructions are target settings: save from
  // Mobile, read and update from Desktop, verify target isolation, and read after
  // a process restart. Thread inheritance semantics are separately owned by the
  // app-server Engine regressions.
  const targetBSettingsBeforePermissionWrites = await readFile(settingsFileB, "utf8");
  await openMobileSection(mobile, "execution_permissions");
  await selectMobileTarget(mobile, TARGET_A);
  const mobileExecutionSaveResultsBefore = successfulExecutionDefaultsReceiptCount(
    mobileRpcReceipts,
    "settings/execution-defaults/save",
  );
  await setExecutionDefault(mobile, "accept_edits");
  await waitFor(
    () => successfulExecutionDefaultsReceiptCount(mobileRpcReceipts, "settings/execution-defaults/save") > mobileExecutionSaveResultsBefore,
    20_000,
    "Mobile target A execution-defaults save to receive its successful runtime RPC result",
  );
  await waitFor(
    async () => await settingsFileHasPermissionMode(settingsFileA, "accept_edits"),
    20_000,
    "Mobile target A permission default to be committed to its settings file",
  );
  const executionA = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_A, rpc =>
    rpc.request("settings/execution-defaults/read", {}));
  assert.equal(executionA.persistedPermissionMode, "accept_edits");
  assert.equal(executionA.effectivePermissionMode, "accept_edits");
  const executionB = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_B, rpc =>
    rpc.request("settings/execution-defaults/read", {}));
  assert.notEqual(executionB.persistedPermissionMode, "accept_edits", "target A permission default must not mutate target B");

  const desktopExecutionReadsBefore = successfulExecutionDefaultsReceiptCount(
    desktopRpcReceipts,
    "settings/execution-defaults/read",
  );
  await desktop.goto(`${gateway.baseUrl}/settings/execution-defaults`, { waitUntil: "domcontentloaded" });
  await desktop.getByTestId("execution-defaults-settings-page").waitFor({ state: "visible", timeout: 30_000 });
  const desktopExecutionTarget = desktop.getByTestId("execution-settings-target-select");
  const desktopExecutionTargetSelection = await selectOptionIfNeeded(
    desktopExecutionTarget,
    TARGET_A,
    "Desktop execution-defaults target",
  );
  await waitFor(
    () => successfulExecutionDefaultsReceiptCount(desktopRpcReceipts, "settings/execution-defaults/read") > desktopExecutionReadsBefore,
    20_000,
    "Desktop target A execution-defaults page to receive a successful runtime read result",
  );
  const desktopPermissionSelect = desktop.getByTestId("execution-default-permission-select");
  await waitFor(async () => await desktopPermissionSelect.inputValue() === "accept_edits", 20_000,
    "Desktop UI to display Mobile's committed target A permission mode");
  const desktopReadMode = await desktopPermissionSelect.inputValue();
  const desktopMobileModeLabel = (await desktopPermissionSelect.locator("option:checked").innerText()).trim();
  assert.ok(desktopMobileModeLabel.length > 0, "Desktop permission control must visibly label Mobile's committed mode");

  const desktopPermissionSelection = await selectOptionIfNeeded(
    desktopPermissionSelect,
    "dont_ask",
    "Desktop execution-defaults permission mode",
  );
  assert.equal(desktopPermissionSelection.before, "accept_edits");
  assert.equal(desktopPermissionSelection.changed, true, "Desktop must change the persisted target mode before saving");
  const desktopExecutionSavesBefore = successfulExecutionDefaultsReceiptCount(
    desktopRpcReceipts,
    "settings/execution-defaults/save",
  );
  const desktopPermissionSave = desktop.getByTestId("execution-default-permission-save");
  await waitFor(async () => await desktopPermissionSave.isEnabled(), 20_000,
    "Desktop permission save control to enable after a real mode change");
  await desktopPermissionSave.click();
  await desktop.getByTestId("execution-defaults-saved").waitFor({ state: "visible", timeout: 20_000 });
  await waitFor(
    () => successfulExecutionDefaultsReceiptCount(desktopRpcReceipts, "settings/execution-defaults/save") > desktopExecutionSavesBefore,
    20_000,
    "Desktop target A execution-defaults save to receive its successful runtime RPC result",
  );
  await waitFor(
    async () => await settingsFileHasPermissionMode(settingsFileA, "dont_ask"),
    20_000,
    "Desktop target A permission default to be committed to its settings file",
  );
  assert.equal(await readFile(settingsFileB, "utf8"), targetBSettingsBeforePermissionWrites,
    "Mobile and Desktop target A permission writes must leave target B's settings file unchanged");

  const mobileExecutionReadsBeforeDesktopWrite = successfulExecutionDefaultsReceiptCount(
    mobileRpcReceipts,
    "settings/execution-defaults/read",
  );
  await openMobileSection(mobile, "models_services");
  await openMobileSection(mobile, "execution_permissions");
  await selectMobileTarget(mobile, TARGET_A);
  await waitFor(
    () => successfulExecutionDefaultsReceiptCount(mobileRpcReceipts, "settings/execution-defaults/read") > mobileExecutionReadsBeforeDesktopWrite,
    20_000,
    "Mobile target A execution-defaults page re-entry to receive a fresh runtime read result",
  );
  const mobileExecutionModeRow = visibleTestId(mobile, "execution-defaults-permission-mode");
  const mobileExecutionPersisted = visibleTestId(mobile, "execution-defaults-persisted");
  await mobileExecutionModeRow.waitFor({ state: "visible", timeout: 20_000 });
  await mobileExecutionModeRow.click();
  await visibleTestId(mobile, "execution-defaults-choice-sheet").waitFor({ state: "visible", timeout: 10_000 });
  const mobileDontAskModeLabel = (await visibleTestId(mobile, "execution-defaults-option-dont_ask").innerText()).trim();
  assert.ok(mobileDontAskModeLabel.length > 0, "Mobile must expose the current localized label for the saved permission mode");
  await visibleTestId(mobile, "settings-choice-cancel").click();
  await visibleTestId(mobile, "execution-defaults-choice-sheet").waitFor({ state: "hidden", timeout: 10_000 });
  await waitFor(
    async () => (await mobileExecutionModeRow.innerText()).includes(mobileDontAskModeLabel)
      && (await mobileExecutionPersisted.innerText()).includes(mobileDontAskModeLabel),
    20_000,
    "Mobile UI to display Desktop's saved target A permission mode and persisted value",
  );
  assert.equal(await settingsFileHasPermissionMode(settingsFileA, "dont_ask"), true);
  assert.equal(await readFile(settingsFileB, "utf8"), targetBSettingsBeforePermissionWrites,
    "Mobile's fresh read of Desktop's target A write must not alter target B's settings file");
  const executionDefaultsCrossClient = {
    mobileInitialMode: executionA.persistedPermissionMode,
    mobileSaveSuccessfulReceiptDelta: successfulExecutionDefaultsReceiptCount(mobileRpcReceipts, "settings/execution-defaults/save")
      - mobileExecutionSaveResultsBefore,
    desktopTargetSelection: desktopExecutionTargetSelection,
    desktopReadMode,
    desktopReadVisibleLabel: desktopMobileModeLabel,
    desktopSaveSelection: desktopPermissionSelection,
    desktopReadSuccessfulReceiptDelta: successfulExecutionDefaultsReceiptCount(desktopRpcReceipts, "settings/execution-defaults/read")
      - desktopExecutionReadsBefore,
    desktopSaveSuccessfulReceiptDelta: successfulExecutionDefaultsReceiptCount(desktopRpcReceipts, "settings/execution-defaults/save")
      - desktopExecutionSavesBefore,
    mobileFreshReadSuccessfulReceiptDelta: successfulExecutionDefaultsReceiptCount(mobileRpcReceipts, "settings/execution-defaults/read")
      - mobileExecutionReadsBeforeDesktopWrite,
    mobileFinalMode: "dont_ask",
    mobileFinalVisibleLabel: mobileDontAskModeLabel,
    targetAFileMode: "dont_ask",
    targetBSettingsFileUnchanged: true,
  };

  await openMobileSection(mobile, "custom_instructions");
  await selectMobileTarget(mobile, TARGET_A);
  await saveMobileInstructions(mobile, "SETTINGS_TARGET_A_INSTRUCTIONS");
  const instructionsA = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_A, async rpc => {
    return rpc.request("runtime.context.get", {});
  });
  assert.match(JSON.stringify(instructionsA), /SETTINGS_TARGET_A_INSTRUCTIONS/);

  const desktopContextGetResultsBefore = desktopRpcReceipts.filter(receipt =>
    receipt.method === "runtime.context.get" && receipt.hasResult).length;
  await desktop.goto(`${gateway.baseUrl}/settings/personal/context`, { waitUntil: "domcontentloaded" });
  await desktop.getByTestId("context-settings-page").waitFor({ state: "visible", timeout: 30_000 });
  const desktopContextTarget = desktop.getByTestId("context-runtime-target-select");
  const desktopContextTargetSelection = await selectOptionIfNeeded(
    desktopContextTarget,
    TARGET_A,
    "Desktop context target",
  );
  await waitFor(
    () => desktopRpcReceipts.filter(receipt => receipt.method === "runtime.context.get" && receipt.hasResult).length > desktopContextGetResultsBefore,
    20_000,
    "Desktop Context Settings to receive a successful runtime.context.get result",
  );
  const desktopInstructionsInput = desktop.getByTestId("context-studio-instructions-textarea");
  await desktopInstructionsInput.waitFor({ state: "visible", timeout: 20_000 });
  await waitFor(
    async () => (await desktopInstructionsInput.inputValue()).includes("SETTINGS_TARGET_A_INSTRUCTIONS"),
    20_000,
    "Desktop Web to read Mobile's saved target instructions",
  );
  const desktopInstructionsValue = "SETTINGS_TARGET_A_INSTRUCTIONS\nSETTINGS_DESKTOP_WRITTEN_INSTRUCTIONS";
  await desktopInstructionsInput.fill(desktopInstructionsValue);
  const desktopInstructionSave = desktop.getByTestId("context-studio-instructions-save-button");
  const desktopContextUpdatesBeforeSave = desktopRpcMethods.filter(method => method === "runtime.context.update").length;
  const desktopContextUpdateResultsBeforeSave = desktopRpcReceipts.filter(receipt =>
    receipt.method === "runtime.context.update" && receipt.hasResult).length;
  await desktopInstructionSave.click();
  await waitFor(
    async () => (await desktopInstructionSave.innerText()).includes("已保存") && await desktopInstructionSave.isDisabled(),
    20_000,
    "Desktop Web custom instructions save receipt",
  );
  await waitFor(
    () => desktopRpcMethods.filter(method => method === "runtime.context.update").length > desktopContextUpdatesBeforeSave
      && desktopRpcReceipts.filter(receipt => receipt.method === "runtime.context.update" && receipt.hasResult).length > desktopContextUpdateResultsBeforeSave,
    20_000,
    "Desktop Context Settings to send runtime.context.update and receive its successful result",
  );
  const desktopContextSettingsWire = {
    targetSelection: desktopContextTargetSelection,
    contextGetSuccessfulResultsBefore: desktopContextGetResultsBefore,
    contextGetSuccessfulResultsAfter: desktopRpcReceipts.filter(receipt =>
      receipt.method === "runtime.context.get" && receipt.hasResult).length,
    contextUpdateRequestsBeforeSave: desktopContextUpdatesBeforeSave,
    contextUpdateRequestsAfterSave: desktopRpcMethods.filter(method => method === "runtime.context.update").length,
    contextUpdateSuccessfulResultsBeforeSave: desktopContextUpdateResultsBeforeSave,
    contextUpdateSuccessfulResultsAfterSave: desktopRpcReceipts.filter(receipt =>
      receipt.method === "runtime.context.update" && receipt.hasResult).length,
  };
  await context.writeArtifactJson("desktop-context-settings-wire.json", desktopContextSettingsWire);

  await openMobileSection(mobile, "models_services");
  await openMobileSection(mobile, "custom_instructions");
  await selectMobileTarget(mobile, TARGET_A);
  await waitFor(
    async () => await visibleTestId(mobile, "custom-instructions-input").inputValue() === desktopInstructionsValue,
    20_000,
    "Mobile to display Desktop Web's saved target instructions",
  );
  assert.ok(mobileRpcMethods.includes("runtime.context.get"), "Mobile must load instructions through runtime.context.get");
  assert.ok(mobileRpcMethods.includes("runtime.context.update"), "Mobile must save instructions through runtime.context.update");

  const instructionsB = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_B, async rpc => {
    return rpc.request("runtime.context.get", {});
  });
  assert.equal(JSON.stringify(instructionsB).includes("SETTINGS_TARGET_A_INSTRUCTIONS"), false,
    "target A instructions must not appear in target B");

  // Lose a real successful settings ACK at the browser WebSocket boundary for
  // each client. The target file and each client's subsequent runtime.context.get
  // are the oracles; no RPC result is fabricated and neither UI may resend.
  const targetBSettingsBeforeUnknownWrites = await readFile(settingsFileB, "utf8");
  const targetBInstructions = settingsInstructionsFromText(targetBSettingsBeforeUnknownWrites);
  const desktopUnknownInstructions = `${desktopInstructionsValue}\nSETTINGS_DESKTOP_UNKNOWN_WRITE`;
  const desktopRecoveryPage = await desktopContext.newPage();
  const desktopFaultErrors = [];
  observeFaultPage(desktopRecoveryPage, "desktop-unknown-write", desktopFaultErrors);
  const desktopRecoveryRpcReceipts = observeFaultPageRpc(desktopRecoveryPage, {
    [TARGET_B]: targetBInstructions,
  });
  const desktopWriteFault = await installCommittedContextWriteAckDrop(
    desktopRecoveryPage,
    TARGET_A,
    desktopUnknownInstructions,
    { holdRecoveryReadResultsAfterAck: true },
  );
  const desktopRecoveryStage = { value: "login" };
  try {
    await loginDesktop(desktopRecoveryPage, gateway);
    await desktopRecoveryPage.goto(`${gateway.baseUrl}/settings/execution-defaults`, { waitUntil: "domcontentloaded" });
    await desktopRecoveryPage.getByTestId("execution-defaults-settings-page").waitFor({ state: "visible", timeout: 30_000 });
    await selectOptionIfNeeded(
      desktopRecoveryPage.getByTestId("execution-settings-target-select"),
      TARGET_A,
      "Desktop recovery target",
    );
    const desktopRecoveryEditor = desktopRecoveryPage.getByTestId("target-custom-instructions-editor");
    await desktopRecoveryEditor.waitFor({ state: "visible", timeout: 20_000 });
    await waitFor(
      async () => await desktopRecoveryEditor.inputValue() === desktopInstructionsValue,
      20_000,
      "Desktop target settings page to load the current target A instruction baseline",
    );
    desktopRecoveryStage.value = "submit-target-a-write";
    await desktopRecoveryEditor.fill(desktopUnknownInstructions);
    await desktopRecoveryPage.getByTestId("target-custom-instructions-save").click();
    await waitFor(() => desktopWriteFault.ackDropped, 20_000, "actual Desktop instruction write ACK to be dropped after server success");
    await waitFor(
      async () => await settingsFileHasInstructions(settingsFileA, desktopUnknownInstructions),
      15_000,
      "Desktop unknown-outcome write to be committed in target A's real settings file",
    );
    await waitFor(
      () => desktopWriteFault.recoveryReadResultsDropped > 0,
      20_000,
      "Desktop's real successful target A read result to be dropped after the lost write ACK",
    );
    const desktopUnknown = desktopRecoveryPage.getByTestId("target-custom-instructions-outcome-unknown");
    const desktopCheckCurrent = desktopRecoveryPage.getByTestId("target-custom-instructions-check-current");
    await waitFor(
      async () => await desktopUnknown.isVisible() && await desktopCheckCurrent.isVisible(),
      20_000,
      "Desktop A unknown state and read-only control after the read result is lost",
    );

    desktopRecoveryStage.value = "switch-to-target-b";
    const desktopTargetSelector = desktopRecoveryPage.getByTestId("execution-settings-target-select");
    const targetBReadBaseline = successfulContextReadCount(desktopRecoveryRpcReceipts, TARGET_B);
    const targetBMatchingReadBaseline = successfulContextReadMatchingExpectedValueCount(desktopRecoveryRpcReceipts, TARGET_B);
    const toB = await selectOptionIfNeeded(desktopTargetSelector, TARGET_B, "Desktop recovery target B");
    assert.equal(toB.changed, true, "Desktop recovery must switch from target A to target B");
    await waitFor(
      () => successfulContextReadCount(desktopRecoveryRpcReceipts, TARGET_B) > targetBReadBaseline,
      20_000,
      "Desktop to receive a real successful target B runtime.context.get result",
    );
    await waitFor(
      () => successfulContextReadMatchingExpectedValueCount(desktopRecoveryRpcReceipts, TARGET_B) > targetBMatchingReadBaseline,
      20_000,
      "Desktop target B get receipt to contain B's actual saved instruction value",
    );
    await waitFor(
      async () => await desktopRecoveryEditor.inputValue() === targetBInstructions,
      20_000,
      "Desktop target B editor to show target B's own saved instruction value",
    );
    assert.equal(await readFile(settingsFileB, "utf8"), targetBSettingsBeforeUnknownWrites,
      "Desktop target switching must leave target B's settings file unchanged");

    desktopRecoveryStage.value = "return-to-target-a-with-read-held";
    const targetAReadDropsBeforeReturn = desktopWriteFault.recoveryReadResultsDropped;
    const toA = await selectOptionIfNeeded(desktopTargetSelector, TARGET_A, "Desktop recovery target A return");
    assert.equal(toA.changed, true, "Desktop recovery must return from target B to target A");
    await waitFor(
      () => desktopWriteFault.recoveryReadResultsDropped > targetAReadDropsBeforeReturn,
      20_000,
      "Desktop return to A to receive and lose a fresh real successful runtime.context.get result",
    );
    await waitFor(
      async () => await desktopUnknown.isVisible() && await desktopCheckCurrent.isVisible(),
      20_000,
      "Desktop A unknown state and read-only control after returning with the read gate closed",
    );
    assert.equal(await desktopRecoveryEditor.inputValue(), desktopUnknownInstructions,
      "Desktop must retain target A's unknown-write draft while target B is selected");

    desktopRecoveryStage.value = "release-and-read-only-reconcile";
    const desktopForwardedReadBaseline = desktopWriteFault.successfulReadsAfterDrop;
    desktopWriteFault.releaseRecoveryReads();
    await desktopCheckCurrent.click();
    await waitFor(
      () => desktopWriteFault.successfulReadsAfterDrop > desktopForwardedReadBaseline,
      20_000,
      "Desktop explicit read-only check to receive a fresh successful target A runtime.context.get result",
    );
    await waitFor(
      async () => await desktopRecoveryEditor.inputValue() === desktopUnknownInstructions
        && await desktopRecoveryPage.getByTestId("target-custom-instructions-saved").count() > 0,
      20_000,
      "Desktop UI to reconcile the committed instruction value without a second write",
    );
    assert.equal(desktopWriteFault.writeRequests, 1, "Desktop recovery must not replay an uncertain settings write");
    assert.equal(desktopWriteFault.matchingInstructionsWriteRequests, 1,
      "Desktop must send exactly one write with the submitted A value");
    assert.ok(desktopWriteFault.recoveryReadResultsDropped >= 2,
      "Desktop must drop the post-write read and a separate A read after the A-to-B-to-A switch");
    assert.equal(desktopWriteFault.recoveryReadsReleased, true);
    assert.equal(desktopWriteFault.droppedReadResultMatchedExpectedInstructions, true,
      "Desktop must drop a real target A read response containing the committed value");
    assert.equal(desktopWriteFault.forwardedReadResultMatchedExpectedInstructions, true,
      "Desktop read-only recovery must forward a real target A read response containing the committed value");
    await desktopRecoveryPage.close();
  } catch (error) {
    await captureFaultPageFailure(context, desktopRecoveryPage, "desktop-unknown-write", desktopRecoveryStage.value, error);
    throw error;
  }

  const desktopContextUnknownInstructions = `${desktopUnknownInstructions}\nSETTINGS_DESKTOP_CONTEXT_UNKNOWN_WRITE`;
  const desktopContextRecoveryPage = await desktopContext.newPage();
  const desktopContextFaultErrors = [];
  observeFaultPage(desktopContextRecoveryPage, "desktop-context-unknown-write", desktopContextFaultErrors);
  const desktopContextWriteFault = await installCommittedContextWriteAckDrop(
    desktopContextRecoveryPage,
    TARGET_A,
    desktopContextUnknownInstructions,
  );
  await loginDesktop(desktopContextRecoveryPage, gateway);
  await desktopContextRecoveryPage.goto(`${gateway.baseUrl}/settings/personal/context`, { waitUntil: "domcontentloaded" });
  await desktopContextRecoveryPage.getByTestId("context-settings-page").waitFor({ state: "visible", timeout: 30_000 });
  const desktopContextRecoveryTargetSelection = await selectOptionIfNeeded(
    desktopContextRecoveryPage.getByTestId("context-runtime-target-select"),
    TARGET_A,
    "Desktop Context recovery target",
  );
  const desktopContextRecoveryEditor = desktopContextRecoveryPage.getByTestId("context-studio-instructions-textarea");
  await desktopContextRecoveryEditor.waitFor({ state: "visible", timeout: 20_000 });
  await waitFor(
    async () => await desktopContextRecoveryEditor.inputValue() === desktopUnknownInstructions,
    20_000,
    "legacy Desktop Context Settings to load the current target A instruction baseline",
  );
  const desktopContextReadCountBeforeFault = desktopContextWriteFault.successfulReadsAfterDrop;
  await desktopContextRecoveryEditor.fill(desktopContextUnknownInstructions);
  await desktopContextRecoveryPage.getByTestId("context-studio-instructions-save-button").click();
  await waitFor(() => desktopContextWriteFault.ackDropped, 20_000,
    "actual legacy Desktop Context Settings write ACK to be dropped after server success");
  await waitFor(
    async () => await settingsFileHasInstructions(settingsFileA, desktopContextUnknownInstructions),
    15_000,
    "legacy Desktop Context Settings unknown-outcome write to be committed in target A's real settings file",
  );
  await waitFor(
    async () => await desktopContextRecoveryPage.getByTestId("context-studio-instructions-outcome-unknown").count() > 0
      || await desktopContextRecoveryPage.getByTestId("context-studio-instructions-saved").count() > 0,
    20_000,
    "legacy Desktop Context Settings recovery state after the lost ACK",
  );
  if (await desktopContextRecoveryPage.getByTestId("context-studio-instructions-outcome-unknown").count()) {
    const checkCurrent = desktopContextRecoveryPage.getByTestId("context-studio-instructions-check-current");
    const recoveryReadFinished = await waitForReadOrVisibleControl(
      () => desktopContextWriteFault.successfulReadsAfterDrop,
      desktopContextReadCountBeforeFault,
      checkCurrent,
      15_000,
      "legacy Desktop Context Settings automatic readback to finish or expose its read-only check control",
    );
    if (!recoveryReadFinished) await checkCurrent.click();
  }
  await waitFor(
    () => desktopContextWriteFault.successfulReadsAfterDrop > desktopContextReadCountBeforeFault,
    20_000,
    "legacy Desktop Context Settings to receive a fresh successful target A runtime.context.get result",
  );
  await waitFor(
    async () => await desktopContextRecoveryEditor.inputValue() === desktopContextUnknownInstructions
      && await desktopContextRecoveryPage.getByTestId("context-studio-instructions-saved").count() > 0,
    20_000,
    "legacy Desktop Context Settings to reconcile the committed instruction value without a second write",
  );
  assert.equal(desktopContextWriteFault.writeRequests, 1,
    "legacy Desktop Context Settings recovery must not replay an uncertain settings write");
  await desktopContextRecoveryPage.close();

  const mobileUnknownInstructions = `${desktopContextUnknownInstructions}\nSETTINGS_MOBILE_UNKNOWN_WRITE`;
  const mobileRecoveryPage = await mobileContext.newPage();
  const mobileFaultErrors = [];
  observeFaultPage(mobileRecoveryPage, "mobile-unknown-write", mobileFaultErrors);
  const mobileRecoveryRpcReceipts = observeFaultPageRpc(mobileRecoveryPage, {
    [TARGET_B]: targetBInstructions,
  });
  const mobileWriteFault = await installCommittedContextWriteAckDrop(
    mobileRecoveryPage,
    TARGET_A,
    mobileUnknownInstructions,
    { holdRecoveryReadResultsAfterAck: true },
  );
  const mobileRecoveryStage = { value: "load-settings" };
  let mobileDraftValueVisibleBeforeReadRecovery = null;
  try {
    const mobileSettingsResponse = await mobileRecoveryPage.goto(`${gateway.baseUrl}/mobile/settings`, { waitUntil: "domcontentloaded" });
    assert.equal(mobileSettingsResponse?.status(), 200, "Mobile recovery page must reload from the owned authenticated Gateway");
    await visibleTestId(mobileRecoveryPage, "settings-home").waitFor({ state: "visible", timeout: 30_000 });
    await openMobileSection(mobileRecoveryPage, "custom_instructions");
    await selectMobileTarget(mobileRecoveryPage, TARGET_A);
    const mobileRecoveryEditor = visibleTestId(mobileRecoveryPage, "custom-instructions-input");
    await mobileRecoveryEditor.waitFor({ state: "visible", timeout: 20_000 });
    await waitFor(
      async () => await mobileRecoveryEditor.inputValue() === desktopContextUnknownInstructions,
      20_000,
      "Mobile target settings page to load Desktop Context's committed instruction value",
    );
    mobileRecoveryStage.value = "submit-target-a-write";
    await mobileRecoveryEditor.fill(mobileUnknownInstructions);
    await visibleTestId(mobileRecoveryPage, "custom-instructions-save").click();
    await waitFor(() => mobileWriteFault.ackDropped, 20_000, "actual Mobile instruction write ACK to be dropped after server success");
    await waitFor(
      async () => await settingsFileHasInstructions(settingsFileA, mobileUnknownInstructions),
      15_000,
      "Mobile unknown-outcome write to be committed in target A's real settings file",
    );
    const mobileUnknown = visibleTestId(mobileRecoveryPage, "custom-instructions-outcome-unknown");
    const mobileCheckCurrent = visibleTestId(mobileRecoveryPage, "custom-instructions-retry");
    const mobileTargetReconnect = visibleTestId(mobileRecoveryPage, "settings-runtime-retry");
    await waitFor(
      async () => await mobileUnknown.isVisible() && await mobileTargetReconnect.isVisible(),
      20_000,
      "Mobile unknown state and target reconnect control after the lost write ACK",
    );
    await mobileTargetReconnect.click();
    await waitFor(
      () => mobileWriteFault.recoveryReadResultsDropped > 0,
      20_000,
      "Mobile's real successful target A read result to be dropped after the lost write ACK",
    );
    await waitFor(
      async () => await mobileUnknown.isVisible()
        && ((await mobileTargetReconnect.count()) > 0 || await mobileCheckCurrent.isVisible()),
      20_000,
      "Mobile A unknown state and an available reconnect/read-only control after the read result is lost",
    );

    mobileRecoveryStage.value = "switch-to-target-b";
    const targetBReadBaseline = successfulContextReadCount(mobileRecoveryRpcReceipts, TARGET_B);
    const targetBMatchingReadBaseline = successfulContextReadMatchingExpectedValueCount(mobileRecoveryRpcReceipts, TARGET_B);
    await selectMobileTarget(mobileRecoveryPage, TARGET_B);
    await waitFor(
      () => successfulContextReadCount(mobileRecoveryRpcReceipts, TARGET_B) > targetBReadBaseline,
      20_000,
      "Mobile to receive a real successful target B runtime.context.get result",
    );
    await waitFor(
      () => successfulContextReadMatchingExpectedValueCount(mobileRecoveryRpcReceipts, TARGET_B) > targetBMatchingReadBaseline,
      20_000,
      "Mobile target B get receipt to contain B's actual saved instruction value",
    );
    await waitFor(
      async () => await mobileRecoveryEditor.inputValue() === targetBInstructions,
      20_000,
      "Mobile target B editor to show target B's own saved instruction value",
    );
    assert.equal(await readFile(settingsFileB, "utf8"), targetBSettingsBeforeUnknownWrites,
      "Mobile target switching must leave target B's settings file unchanged");

    mobileRecoveryStage.value = "return-to-target-a-with-read-held";
    const targetAReadDropsBeforeReturn = mobileWriteFault.recoveryReadResultsDropped;
    await selectMobileTarget(mobileRecoveryPage, TARGET_A);
    await waitFor(
      () => mobileWriteFault.recoveryReadResultsDropped > targetAReadDropsBeforeReturn,
      20_000,
      "Mobile return to A to receive and lose a fresh real successful runtime.context.get result",
    );
    await waitFor(
      async () => await mobileUnknown.isVisible()
        && ((await mobileTargetReconnect.count()) > 0 || await mobileCheckCurrent.isVisible()),
      20_000,
      "Mobile A unknown state and an available reconnect/read-only control after returning while its read result is dropped",
    );
    mobileDraftValueVisibleBeforeReadRecovery = await mobileRecoveryEditor.isVisible()
      && (await mobileRecoveryEditor.inputValue()) === mobileUnknownInstructions;

    mobileRecoveryStage.value = "release-and-read-only-reconcile";
    const mobileForwardedReadBaseline = mobileWriteFault.successfulReadsAfterDrop;
    mobileWriteFault.releaseRecoveryReads();
    await waitFor(
      async () => await mobileTargetReconnect.isVisible() || await mobileCheckCurrent.isVisible(),
      20_000,
      "Mobile reconnect or field read-only control to appear after the dropped read result closes target A",
    );
    if (await mobileTargetReconnect.isVisible()) {
      await mobileTargetReconnect.click();
    } else {
      await mobileCheckCurrent.click();
    }
    await waitFor(
      () => mobileWriteFault.successfulReadsAfterDrop > mobileForwardedReadBaseline,
      20_000,
      "Mobile explicit read-only check to receive a fresh successful target A runtime.context.get result",
    );
    await waitFor(
      async () => await mobileRecoveryEditor.inputValue() === mobileUnknownInstructions
        && await visibleTestId(mobileRecoveryPage, "custom-instructions-saved").count() > 0,
      20_000,
      "Mobile UI to reconcile the committed instruction value without a second write",
    );
    assert.equal(mobileWriteFault.writeRequests, 1, "Mobile recovery must not replay an uncertain settings write");
    assert.equal(mobileWriteFault.matchingInstructionsWriteRequests, 1,
      "Mobile must send exactly one write with the submitted A value");
    assert.ok(mobileWriteFault.recoveryReadResultsDropped >= 2,
      "Mobile must drop the post-write read and a separate A read after the A-to-B-to-A switch");
    assert.equal(mobileWriteFault.recoveryReadsReleased, true);
    assert.equal(mobileWriteFault.droppedReadResultMatchedExpectedInstructions, true,
      "Mobile must drop a real target A read response containing the committed value");
    assert.equal(mobileWriteFault.forwardedReadResultMatchedExpectedInstructions, true,
      "Mobile read-only recovery must forward a real target A read response containing the committed value");
    await mobileRecoveryPage.close();
  } catch (error) {
    await captureFaultPageFailure(context, mobileRecoveryPage, "mobile-unknown-write", mobileRecoveryStage.value, error);
    throw error;
  }
  const allowedFaultConnectionConsoleErrors = assertNoUnexpectedFaultPageErrors([
    ...desktopFaultErrors,
    ...desktopContextFaultErrors,
    ...mobileFaultErrors,
  ]);
  assert.equal(typeof mobileDraftValueVisibleBeforeReadRecovery, "boolean",
    "Mobile draft visibility before read recovery must come from an observed editor value");
  for (const [client, fault] of [
    ["Desktop Execution Defaults", desktopWriteFault],
    ["Desktop Context Settings", desktopContextWriteFault],
    ["Mobile", mobileWriteFault],
  ]) {
    assert.ok(fault.targetAConnections > 0, `${client} fault injection must route its actual target A /rpc connection`);
    assert.equal(fault.serverSuccessResponseObserved, true, `${client} fault injection must observe the real successful server write response`);
    assert.equal(fault.ackDropped, true, `${client} must lose the actual successful write ACK`);
    assert.equal(fault.successfulReadsAfterDrop > 0, true, `${client} must receive a fresh successful runtime.context.get result after the dropped ACK`);
  }
  assert.equal(await readFile(settingsFileB, "utf8"), targetBSettingsBeforeUnknownWrites,
    "Desktop and Mobile unknown-outcome writes must remain isolated to target A");
  const finalInstructionsForReload = mobileUnknownInstructions;

  // Tool profiles, service-owned usage and extensions are loaded from the
  // selected target. Unsupported capabilities remain an explicit UI state.
  await openMobileSection(mobile, "tool_configuration");
  await selectMobileTarget(mobile, TARGET_A);
  await visibleTestId(mobile, "tool-profile-option-nano").click();
  await visibleTestId(mobile, "tool-profile-save").click();
  await visibleTestId(mobile, "tool-profile-saved").waitFor({ state: "visible", timeout: 20_000 });
  const toolSettingsA = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_A, async rpc => {
    return rpc.request("settings/tools/read", {});
  });
  assert.equal(toolSettingsA.profile, "nano");
  const successfulDesktopToolReads = () => desktopRpcReceipts.filter(receipt =>
    receipt.method === "settings/tools/read"
      && receipt.targetId === TARGET_A
      && receipt.hasResult).length;
  const desktopToolReadResultsBefore = successfulDesktopToolReads();
  await desktop.goto(`${gateway.baseUrl}/settings/personal/context`, { waitUntil: "domcontentloaded" });
  await desktop.getByTestId("context-settings-page").waitFor({ state: "visible", timeout: 30_000 });
  const desktopToolTargetSelection = await selectOptionIfNeeded(
    desktop.getByTestId("context-runtime-target-select"),
    TARGET_A,
    "Desktop tool-profile target",
  );
  await waitFor(
    () => successfulDesktopToolReads() > desktopToolReadResultsBefore,
    20_000,
    "Desktop tool-profile settings to receive a successful settings/tools/read result for target A",
  );
  await desktop.getByTestId("tool-profile-settings").waitFor({ state: "visible", timeout: 20_000 });
  const desktopToolSelect = desktop.getByTestId("tool-profile-select");
  await waitFor(async () => await desktopToolSelect.isEnabled(), 20_000,
    "Desktop tool-profile control to enable after the successful target settings read");
  assert.equal(await desktopToolSelect.isEnabled(), true, "target capability must leave the desktop tool-profile control available");
  await desktopToolSelect.selectOption("core");
  await desktop.getByTestId("tool-profile-save").click();
  await desktop.getByRole("status").filter({ hasText: /已保存|saved/i }).waitFor({ state: "visible", timeout: 20_000 });
  const toolSettingsAfterDesktopWrite = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_A, async rpc =>
    rpc.request("settings/tools/read", {}));
  assert.equal(toolSettingsAfterDesktopWrite.profile, "core", "desktop Web tool-profile write must reach target A");

  await openMobileSection(mobile, "usage");
  await selectMobileTarget(mobile, TARGET_A);
  const usageA = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_A, async rpc => {
    try { return { ok: true, value: await rpc.request("usage/stats", {}) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  if (usageA.ok) {
    const usageNode = visibleTestId(mobile, "usage-summary");
    if (usageA.value.history === null) {
      await visibleTestId(mobile, "usage-empty").waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await usageNode.count(), 0, "null usage history must remain no-data, never zero totals");
    } else {
      assert.ok(Array.isArray(usageA.value.history.days), "usage history must preserve service-returned day records");
      await usageNode.waitFor({ state: "visible", timeout: 15_000 });
    }
    assert.equal(JSON.stringify(usageA.value).toLowerCase().includes("cost"), false, "service usage contract has no cost estimate");
  } else {
    await visibleTestId(mobile, "usage-error").waitFor({ state: "visible", timeout: 15_000 });
    assert.match(usageA.error, /explicit user profile/i);
    assert.equal(await mobile.getByTestId("usage-summary").count(), 0, "usage error must not be rendered as zero totals");
  }

  await openMobileSection(mobile, "plugins_skills");
  await selectMobileTarget(mobile, TARGET_A);
  await visibleTestId(mobile, "settings-extensions-plugins").waitFor({ state: "visible", timeout: 20_000 });
  await visibleTestId(mobile, "settings-extensions-skills").waitFor({ state: "visible", timeout: 20_000 });
  const extensionInventory = await withTargetRpc(context, gateway, cookie, gatewayToken, TARGET_A, async (rpc, initialized) => {
    const plugins = await rpc.request("plugin/list", { all: true });
    const capabilities = initialized.capabilities;
    const skills = capabilities.experimental?.skillActivationV1
      ? await rpc.request("skills/list", { includeDisabled: true })
      : null;
    return { plugins, skills, capabilities: capabilities.experimental };
  });
  assert.equal(extensionInventory.plugins.plugins.length, 0,
    "this isolated target must not receive or install real plugins as test fixtures");
  if (extensionInventory.capabilities.skillActivationV1) assert.ok(extensionInventory.skills);
  else await visibleTestId(mobile, "settings-extensions-skills-unsupported").waitFor({ state: "visible", timeout: 10_000 });

  const browserRpcCountBeforeRemovedRoute = mobileRpcMethods.filter(method => method.startsWith("browser/")).length;
  await openMobileSection(mobile, "browser");
  await visibleTestId(mobile, "settings-section-screen").getByText(/settings section is unavailable|此设置分区不可用/i).waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await visibleTestId(mobile, "settings-browser-open").count(), 0,
    "Mobile Settings must not expose a standalone Browser session screen");
  assert.equal(mobileRpcMethods.filter(method => method.startsWith("browser/")).length, browserRpcCountBeforeRemovedRoute,
    "the removed Settings route must not open a browser connection");

  // Cache cleanup is an explicit Web confirmation and clears only owned
  // rebuildable catalogs. Keep a second real composer page mounted with an
  // unsent draft; it must survive while the paired Gateway remains selected.
  const taskContext = await mobileContext.newPage();
  observePage(taskContext, "mobile-composer", uiErrors, mobileRpcMethods, mobileRpcReceipts);
  await taskContext.goto(mobileTaskUrl, { waitUntil: "domcontentloaded" });
  await visibleTestId(taskContext, "message-input").waitFor({ state: "visible", timeout: 30_000 });
  const unsentDraft = "CACHE_CLEAR_KEEP_COMPOSER_DRAFT";
  await visibleTestId(taskContext, "message-input").fill(unsentDraft);
  const targetSettingsBeforeCacheClear = await readFile(settingsFileA, "utf8");
  await openMobileSection(mobile, "storage_cache");
  await visibleTestId(mobile, "settings-storage-usage").waitFor({ state: "visible", timeout: 15_000 });
  const storageApi = await mobile.evaluate(async () => {
    if (!navigator.storage?.estimate) return { supported: false };
    const value = await navigator.storage.estimate();
    return { supported: true, usage: value.usage ?? null, quota: value.quota ?? null };
  });
  const storageText = await visibleTestId(mobile, "settings-storage-usage").innerText();
  if (!storageApi.supported) assert.match(storageText, /不支持|不可用|unavailable|unsupported/i);
  else if (storageApi.usage === undefined || storageApi.usage === null) assert.match(storageText, /不可测|无数据|unavailable|no measurement/i);
  const confirmDialogPromise = mobile.waitForEvent("dialog");
  const cacheClearClick = visibleTestId(mobile, "settings-storage-cache-clear").click();
  const cacheDialog = await confirmDialogPromise;
  assert.equal(cacheDialog.type(), "confirm", "Mobile Web cache cleanup must use the platform's native Web confirmation");
  await cacheDialog.accept();
  await cacheClearClick;
  await visibleTestId(mobile, "settings-storage-cache-status").waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await visibleTestId(taskContext, "message-input").inputValue(), unsentDraft,
    "catalog cache cleanup must preserve a mounted unsent paired draft");
  assert.equal(await taskContext.url().includes(`/mobile/h/${encodeURIComponent(profileId)}/task/${TARGET_A}/`), true, "the owned paired target remains mounted after cache cleanup");
  assert.equal(await readFile(settingsFileA, "utf8"), targetSettingsBeforeCacheClear,
    "device cache cleanup must not mutate target settings files");

  // A full reload must retain the paired profile and be able to complete a
  // fresh authenticated target read. The draft assertion above intentionally
  // stays on the separate mounted composer page.
  const contextReadsBeforeReload = mobileRpcReceipts.filter(receipt =>
    receipt.method === "runtime.context.get" && receipt.hasResult).length;
  await mobile.reload({ waitUntil: "domcontentloaded" });
  await visibleTestId(mobile, "settings-section-screen").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(new URL(mobile.url()).origin, gateway.baseUrl,
    "cache cleanup reload must remain on the owned authenticated Gateway origin");
  await openMobileSection(mobile, "custom_instructions");
  await selectMobileTarget(mobile, TARGET_A);
  await waitFor(
    async () => await visibleTestId(mobile, "custom-instructions-input").inputValue() === finalInstructionsForReload,
    20_000,
    "post-cache-reload authenticated Mobile target read",
  );
  await waitFor(
    () => mobileRpcReceipts.filter(receipt => receipt.method === "runtime.context.get" && receipt.hasResult).length > contextReadsBeforeReload,
    15_000,
    "fresh runtime.context.get result after cache cleanup and full page reload",
  );

  // A sole direct CLI connection performs the restart after both web clients
  // close their owned target clients; then it verifies the actual new process
  // reads the committed setting file. No browser client is force-disconnected.
  await Promise.all([mobileContext.close(), desktopContext.close()]);
  const restartEvidence = await restartTargetAndRead(context, gateway, cookie, gatewayToken, TARGET_A, brokerOwnershipDiagnostic);
  assert.ok(restartEvidence.before.processId > 0);
  assert.ok(restartEvidence.after.processId > 0);
  assert.notEqual(restartEvidence.after.processId, restartEvidence.before.processId, "settings must be read by a fresh target process");
  assert.equal(restartEvidence.execution.persistedPermissionMode, "dont_ask");
  const persistedA = JSON.parse(await readFile(settingsFileA, "utf8"));
  assert.equal(persistedA.permission_mode, "dont_ask");
  assert.equal(persistedA.providers[PROVIDER_ID].default_model, "settings-model-from-desktop");
  assert.match(JSON.stringify(persistedA), /SETTINGS_TARGET_A_INSTRUCTIONS/);
  const persistedB = JSON.parse(await readFile(settingsFileB, "utf8"));
  assert.equal(persistedB.permission_mode, undefined);
  assert.equal(persistedB.providers?.[PROVIDER_ID], undefined);
  assert.equal(JSON.stringify(persistedB).includes("SETTINGS_TARGET_A_INSTRUCTIONS"), false);
  assert.deepEqual(uiErrors, [], "Mobile and desktop Web settings pages must not emit browser errors");

  const result = {
    evidenceLevel: "manual prebuilt real Mobile Web + desktop Web + authenticated Gateway + real target CLI app-server",
    prebuiltManualDiagnostic: true,
    frozenDependencyIntegration: false,
    liveModelOrProviderAccountUsed: false,
    mobilePairingStatus: pairingResponses,
    mobileSettingsHomeScreenshots,
    provider: {
      mobileWriteVisibleInDesktop: true,
      desktopWriteVisibleInMobile: true,
      desktopTargetSelection: desktopProviderTargetSelection,
      explicitLoopbackProbeRequests: modelOk.requests.length + modelUnauthorized.requests.length + modelRateLimited.requests.length + modelLate.requests.length,
      lateProbeAfterTargetSwitch: lateProbeOutcome.aborted ? "aborted" : "completed",
      errorResponses: { unauthorized: modelUnauthorized.requests.length, rateLimited: modelRateLimited.requests.length },
      lateReplyReleasedAfterTargetSwitch: releaseLateReply,
      targetBIsolation: true,
    },
    executionDefaultsRestart: { before: restartEvidence.before, after: restartEvidence.after, mode: restartEvidence.execution.persistedPermissionMode },
    executionDefaultsCrossClient,
    customInstructionsTargetIsolation: true,
    desktopContextSettingsWire,
    customInstructionsUnknownWriteRecovery: {
      writeMethod: "runtime.context.update",
      recoveryReadMethod: "runtime.context.get",
      desktop: {
        targetRpcConnections: desktopWriteFault.targetAConnections,
        serverSuccessResponseObserved: desktopWriteFault.serverSuccessResponseObserved,
        ackDropped: desktopWriteFault.ackDropped,
        writeRequests: desktopWriteFault.writeRequests,
        recoveryReadResultsDropped: desktopWriteFault.recoveryReadResultsDropped,
        serverSuccessfulReadsAfterDrop: desktopWriteFault.serverSuccessfulReadsAfterDrop,
        successfulReadsAfterDrop: desktopWriteFault.successfulReadsAfterDrop,
        successfulTargetBReads: successfulContextReadCount(desktopRecoveryRpcReceipts, TARGET_B),
        targetBReadMatchedExpectedValue: successfulContextReadMatchingExpectedValueCount(desktopRecoveryRpcReceipts, TARGET_B) > 0,
        targetSwitchRecovery: {
          switchedAtoBtoA: true,
          aReturnReadResultDropped: true,
          unknownStateVisibleOnReturn: true,
          draftValueVisibleBeforeReadRecovery: true,
        },
        readResultMatchedCommittedValue: desktopWriteFault.droppedReadResultMatchedExpectedInstructions
          && desktopWriteFault.forwardedReadResultMatchedExpectedInstructions,
        recoveryReadsReleased: desktopWriteFault.recoveryReadsReleased,
      },
      desktopContext: {
        targetSelection: desktopContextRecoveryTargetSelection,
        targetRpcConnections: desktopContextWriteFault.targetAConnections,
        serverSuccessResponseObserved: desktopContextWriteFault.serverSuccessResponseObserved,
        ackDropped: desktopContextWriteFault.ackDropped,
        writeRequests: desktopContextWriteFault.writeRequests,
        successfulReadsAfterDrop: desktopContextWriteFault.successfulReadsAfterDrop,
      },
      mobile: {
        targetRpcConnections: mobileWriteFault.targetAConnections,
        serverSuccessResponseObserved: mobileWriteFault.serverSuccessResponseObserved,
        ackDropped: mobileWriteFault.ackDropped,
        writeRequests: mobileWriteFault.writeRequests,
        recoveryReadResultsDropped: mobileWriteFault.recoveryReadResultsDropped,
        serverSuccessfulReadsAfterDrop: mobileWriteFault.serverSuccessfulReadsAfterDrop,
        successfulReadsAfterDrop: mobileWriteFault.successfulReadsAfterDrop,
        successfulTargetBReads: successfulContextReadCount(mobileRecoveryRpcReceipts, TARGET_B),
        targetBReadMatchedExpectedValue: successfulContextReadMatchingExpectedValueCount(mobileRecoveryRpcReceipts, TARGET_B) > 0,
        targetSwitchRecovery: {
          switchedAtoBtoA: true,
          aReturnReadResultDropped: true,
          unknownStateVisibleOnReturn: true,
          draftValueVisibleBeforeReadRecovery: mobileDraftValueVisibleBeforeReadRecovery,
        },
        readResultMatchedCommittedValue: mobileWriteFault.droppedReadResultMatchedExpectedInstructions
          && mobileWriteFault.forwardedReadResultMatchedExpectedInstructions,
        recoveryReadsReleased: mobileWriteFault.recoveryReadsReleased,
      },
      targetBFileUnchanged: true,
      allowedFaultConnectionConsoleErrors,
    },
    toolProfileTargetRpc: toolSettingsA.profile,
    desktopToolProfileRead: {
      targetSelection: desktopToolTargetSelection,
      successfulReadsBefore: desktopToolReadResultsBefore,
      successfulReadsAfter: successfulDesktopToolReads(),
    },
    usageState: usageA.ok ? (usageA.value.history === null ? "service-null-history" : "service-history") : "service-error-no-zero-summary",
    extensions: { pluginCount: extensionInventory.plugins.plugins.length, skillCapability: extensionInventory.capabilities.skillActivationV1 === true },
    browser: { settingsEntryAbsent: true, removedDeepLinkUnavailable: true, browserRpcCountUnchanged: true },
    devicePreferencesPersistedAfterReload: true,
    conversationPreferenceSwitches: conversationSwitchStates,
    quickPhraseCrud,
    quickPhraseVisibleInComposer: true,
    quickPhraseSendIssued: false,
    cacheClearPreservedDraftAndPairing: true,
    cacheClearPostReloadAuthRead: {
      method: "runtime.context.get",
      resultReceived: mobileRpcReceipts.filter(receipt => receipt.method === "runtime.context.get" && receipt.hasResult).length > contextReadsBeforeReload,
      target: TARGET_A,
    },
    targetEnginePermissionInheritance: "not asserted here; app-server Engine regression owns effective new-thread/resume semantics",
    uiErrors,
    mobileRpcMethods: [...new Set(mobileRpcMethods)].sort(),
    desktopRpcMethods: [...new Set(desktopRpcMethods)].sort(),
    pins,
  };
  await context.writeArtifactJson("settings-cross-client-acceptance.json", result);
  return result;
});

async function verifyPrebuiltInputs(context) {
  const mobileRoot = requireAbsoluteEnv("KCODER_E2E_SETTINGS_WEB_ROOT");
  const rendererRoot = requireAbsoluteEnv("KCODER_E2E_RENDERER_ROOT");
  const kcBin = requireAbsoluteEnv("KCODER_E2E_KCODER_BIN");
  const expectedMobileManifest = requireShaEnv("KCODER_E2E_SETTINGS_MOBILE_MANIFEST_SHA256");
  const expectedRendererTree = requireShaEnv("KCODER_E2E_SETTINGS_RENDERER_TREE_SHA256");
  const expectedRendererSource = requireShaEnv("KCODER_E2E_SETTINGS_RENDERER_SOURCE_SHA256");
  const expectedSharedSource = requireShaEnv("KCODER_E2E_SETTINGS_SHARED_SOURCE_SHA256");
  const expectedKcoder = requireShaEnv("KCODER_E2E_SETTINGS_KCODER_SHA256");
  for (const [path, label, kind] of [
    [mobileRoot, "Mobile Web root", "directory"],
    [rendererRoot, "desktop Renderer root", "directory"],
    [kcBin, "KCoder binary", "file"],
  ]) await assertCanonicalPath(path, label, kind);

  const manifestPath = resolve(mobileRoot, "kcoder-mobile-web.json");
  const manifestBytes = await readFile(manifestPath);
  const mobileManifestSha256 = sha256(manifestBytes);
  assert.equal(mobileManifestSha256, expectedMobileManifest, "Mobile Web manifest must match the frozen export digest");
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.version, 1, "Mobile Web export manifest version must be supported");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, "Mobile Web export must inventory all served files");
  const manifestPaths = new Set();
  for (const entry of manifest.files) {
    assert.ok(entry && typeof entry.path === "string" && !entry.path.startsWith("/") && !entry.path.split(/[\\/]/).includes(".."));
    assert.ok(!manifestPaths.has(entry.path), `duplicate Mobile Web manifest path ${entry.path}`);
    manifestPaths.add(entry.path);
    const bytes = await readFile(resolve(mobileRoot, entry.path));
    assert.equal(bytes.length, entry.size, `Mobile Web size changed for ${entry.path}`);
    assert.equal(sha256(bytes), entry.sha256, `Mobile Web content changed for ${entry.path}`);
  }
  assert.ok(manifestPaths.has("index.html"), "Mobile Web export must include index.html");

  const sourceBefore = JSON.parse(await readFile(resolve(dirname(mobileRoot), "mobile-source-before.json"), "utf8"));
  const sourceAfter = JSON.parse(await waitFor(async () => {
    try { return await readFile(resolve(dirname(mobileRoot), "mobile-source-after.json"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, 60_000, "Mobile source-after provenance from the product build", 500, context.abortSignal));
  const mobileSharedSourceBefore = JSON.parse(await readFile(resolve(dirname(mobileRoot), "shared-source-before.json"), "utf8"));
  const mobileSharedSourceAfter = JSON.parse(await waitFor(async () => {
    try { return await readFile(resolve(dirname(mobileRoot), "shared-source-after.json"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, 60_000, "shared source-after provenance from the Mobile product build", 500, context.abortSignal));
  assert.deepEqual(sourceAfter, sourceBefore, "Mobile source must remain unchanged across the owner build");
  assert.deepEqual(mobileSharedSourceAfter, mobileSharedSourceBefore, "shared generated source must remain unchanged across the Mobile build");
  const currentMobileSourceTree = await fingerprintRegularTree(resolve(appRoot, "mobile", "src"));
  assert.deepEqual(sourceBefore, currentMobileSourceTree, "current Mobile src files must exactly match the owner build source inventory");

  const rendererSourceBeforePath = resolve(dirname(rendererRoot), "renderer-source-before.json");
  const rendererAssetsPath = resolve(dirname(rendererRoot), "renderer-assets.json");
  const rendererSourceBefore = JSON.parse(await readFile(rendererSourceBeforePath, "utf8"));
  const rendererSourceAfter = JSON.parse(await waitFor(async () => {
    try { return await readFile(resolve(dirname(rendererRoot), "renderer-source-after.json"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, 60_000, "Renderer source-after provenance from the product build", 500, context.abortSignal));
  const rendererSharedSourceBefore = JSON.parse(await readFile(resolve(dirname(rendererRoot), "shared-source-before.json"), "utf8"));
  const rendererSharedSourceAfter = JSON.parse(await waitFor(async () => {
    try { return await readFile(resolve(dirname(rendererRoot), "shared-source-after.json"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, 60_000, "shared source-after provenance from the Renderer product build", 500, context.abortSignal));
  const rendererAssets = JSON.parse(await readFile(rendererAssetsPath, "utf8"));
  assert.deepEqual(rendererSourceAfter, rendererSourceBefore, "Renderer source must remain unchanged across the owner build");
  assert.deepEqual(rendererSharedSourceAfter, rendererSharedSourceBefore, "shared generated source must remain unchanged across the Renderer build");
  assert.deepEqual(rendererSharedSourceBefore, mobileSharedSourceBefore, "Mobile and Renderer builders must pin the same shared generated source");
  assert.equal(rendererSourceBefore.digest, expectedRendererSource, "Renderer source pin must match the owner's pre-build inventory");
  assert.equal(rendererAssets.digest, expectedRendererTree, "Renderer asset pin must match the owner's built asset inventory");

  const rendererInventory = await fingerprintRegularTree(rendererRoot);
  assert.deepEqual(rendererInventory, rendererAssets, "prebuilt desktop Renderer tree must match the owner build asset inventory");
  const rendererTreeSha256 = rendererInventory.digest;
  assert.equal(rendererTreeSha256, expectedRendererTree, "prebuilt desktop Renderer tree must match the frozen tree digest");
  const rendererSource = await fingerprintRendererSource(resolve(appRoot, "renderer"));
  assert.deepEqual(rendererSource, rendererSourceBefore, "current Renderer build inputs must match the owner build source inventory");
  const rendererSourceSha256 = rendererSource.digest;
  assert.equal(rendererSourceSha256, expectedRendererSource, "current Renderer source must match the build-time source pin");
  const sharedSource = await fingerprintRegularTree(resolve(appRoot, "shared", "generated"));
  assert.deepEqual(sharedSource, mobileSharedSourceBefore, "current shared generated source must exactly match both build-time inventories");
  assert.equal(sharedSource.digest, expectedSharedSource, "current shared generated source must match the frozen source pin");
  const kcBinSha256 = sha256(await readFile(kcBin));
  assert.equal(kcBinSha256, expectedKcoder, "target CLI binary must match the frozen SHA-256");

  const pins = {
    mobileRoot,
    mobileManifestSha256,
    mobileSourceSha256: sourceBefore.digest,
    rendererRoot,
    rendererTreeSha256,
    rendererSourceSha256,
    sharedSourceSha256: sharedSource.digest,
    kcBin,
    kcBinSha256,
    prebuiltManualDiagnostic: true,
    frozenDependencyIntegration: false,
  };
  await context.writeArtifactJson("prebuilt-provenance.json", pins);
  return pins;
}

async function assertCanonicalPath(candidate, label, kind) {
  const info = await lstat(candidate);
  assert.ok(!info.isSymbolicLink(), `${label} cannot be a symbolic link`);
  assert.equal(kind === "directory" ? info.isDirectory() : info.isFile(), true, `${label} must be a ${kind}`);
  assert.equal(await realpath(candidate), candidate, `${label} must use its canonical absolute path`);
}

function requireAbsoluteEnv(name) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), `UNMET_PREREQUISITE: set ${name} to an absolute frozen path`);
  return resolve(value);
}

function requireShaEnv(name) {
  const value = process.env[name];
  assert.match(value || "", /^[a-f0-9]{64}$/i, `UNMET_PREREQUISITE: set ${name} to the frozen SHA-256`);
  return value.toLowerCase();
}

async function createTarget(context, { id, binary, workspace, providerId, model, endpoint, secret }) {
  const configDir = context.pathInState(`${id}-user-config`);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const userSettingsFile = await context.writeStateJson(`${id}-user-config/settings.json`, {
    active_provider: providerId,
    max_retries: 0,
    providers: {
      [providerId]: {
        api_format: "openai_chat_completions",
        endpoint,
        default_model: model,
        context_window_tokens: 32_000,
        max_output_tokens: 2_048,
        output_headroom_tokens: 1_024,
        no_proxy: true,
      },
    },
  });
  const credentialsFile = await context.writeStateJson(`${id}-user-config/credentials.json`, {
    [providerId]: { type: "api", key: secret },
  });
  const overlayFile = await context.writeStateJson(`${id}-cli-settings-overlay.json`, {});
  const command = context.pathInState(`kcoder-${id}`);
  await writeFile(command, [
    "#!/bin/sh",
    `export KCODER_CONFIG_DIR=${shellQuote(configDir)}`,
    `exec ${shellQuote(binary)} "$@"`,
    "",
  ].join("\n"));
  await chmod(command, 0o700);
  return {
    id,
    profile: providerId,
    configDir,
    userSettingsFile,
    credentialsFile,
    overlayFile,
    command,
    workspace,
    secret,
    binarySha256: sha256(await readFile(binary)),
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function observeFaultPage(page, label, errors) {
  page.on("pageerror", error => errors.push({
    kind: "pageerror",
    label,
    message: sanitizeFaultErrorText(error.message),
  }));
  page.on("console", message => {
    if (message.type() !== "error") return;
    errors.push({
      kind: "console",
      label,
      message: sanitizeFaultErrorText(message.text()),
    });
  });
}

function observeFaultPageRpc(page, expectedInstructionsByTarget = {}) {
  const receipts = [];
  page.on("websocket", socket => {
    const pending = new Map();
    const url = new URL(socket.url());
    const targetId = url.searchParams.get("server") ?? undefined;
    const channel = url.searchParams.get("channel") === "browser" ? "browser" : "runtime";
    socket.on("framesent", event => {
      const frame = parseObservedRpcFrame(event.payload);
      if (!frame || typeof frame !== "object"
        || typeof frame.method !== "string" || frame.id === undefined || frame.id === null) return;
      pending.set(frame.id, { method: frame.method, targetId, channel });
    });
    socket.on("framereceived", event => {
      const frame = parseObservedRpcFrame(event.payload);
      if (!frame || typeof frame !== "object"
        || frame.id === undefined || frame.id === null || !pending.has(frame.id)) return;
      const request = pending.get(frame.id);
      pending.delete(frame.id);
      const receipt = {
        method: request.method,
        targetId: request.targetId,
        channel: request.channel,
        hasResult: Object.hasOwn(frame, "result"),
        hasError: Object.hasOwn(frame, "error"),
      };
      if (request.method === "runtime.context.get" && Object.hasOwn(expectedInstructionsByTarget, request.targetId)) {
        receipt.instructionsMatchExpected = frame.result?.instructions === expectedInstructionsByTarget[request.targetId];
      }
      receipts.push(receipt);
    });
  });
  return receipts;
}

function successfulContextReadCount(receipts, targetId) {
  return receipts.filter(receipt => receipt.method === "runtime.context.get"
    && receipt.targetId === targetId && receipt.hasResult && !receipt.hasError).length;
}

function successfulContextReadMatchingExpectedValueCount(receipts, targetId) {
  return receipts.filter(receipt => receipt.method === "runtime.context.get"
    && receipt.targetId === targetId && receipt.hasResult && !receipt.hasError
    && receipt.instructionsMatchExpected === true).length;
}

function sanitizeFaultErrorText(value) {
  return String(value).replace(/\bwss?:\/\/[^\s"'`]+/gi, socketUrl => {
    const withoutQuery = socketUrl.split("?")[0];
    return withoutQuery.replace(/[),.;]+$/, "");
  });
}

function assertNoUnexpectedFaultPageErrors(errors) {
  const unexpected = [];
  let allowedConnectionErrors = 0;
  for (const error of errors) {
    if (error.kind === "console" && isExpectedFaultWebSocketClose(error.message)) {
      allowedConnectionErrors += 1;
      continue;
    }
    unexpected.push({ kind: error.kind, label: error.label, message: error.message });
  }
  assert.deepEqual(unexpected, [], "ACK-loss recovery pages must have no page errors or unexpected console errors");
  return allowedConnectionErrors;
}

function isExpectedFaultWebSocketClose(message) {
  return /^WebSocket connection to 'wss?:\/\/[^']+\/rpc' failed: WebSocket is closed before the connection was established\.?$/i.test(message);
}

async function installCommittedContextWriteAckDrop(
  page,
  targetId,
  expectedInstructions,
  { holdRecoveryReadResultsAfterAck = false } = {},
) {
  const state = {
    targetAConnections: 0,
    writeRequests: 0,
    matchingInstructionsWriteRequests: 0,
    serverSuccessResponseObserved: false,
    ackDropped: false,
    serverSuccessfulReadsAfterDrop: 0,
    successfulReadsAfterDrop: 0,
    recoveryReadResultsDropped: 0,
    droppedReadResultMatchedExpectedInstructions: false,
    forwardedReadResultMatchedExpectedInstructions: false,
    holdRecoveryReadResults: false,
    recoveryReadsReleased: false,
  };
  await page.routeWebSocket(
    url => url.pathname.endsWith("/rpc") && url.searchParams.get("server") === targetId,
    route => {
      state.targetAConnections += 1;
      const upstream = route.connectToServer();
      const readsAfterDrop = new Set();
      let writeRequestId;

      route.onMessage(message => {
        let frame;
        try { frame = JSON.parse(String(message)); } catch { frame = null; }
        if (frame?.method === "runtime.context.update") {
          state.writeRequests += 1;
          if (frame.params?.instructions === expectedInstructions) {
            state.matchingInstructionsWriteRequests += 1;
            if (!state.ackDropped && writeRequestId === undefined) writeRequestId = frame.id;
          }
        }
        if (
          state.ackDropped
          && frame?.method === "runtime.context.get"
          && frame.id !== undefined
          && frame.id !== null
        ) {
          readsAfterDrop.add(frame.id);
        }
        upstream.send(message);
      });

      upstream.onMessage(message => {
        let frame;
        try { frame = JSON.parse(String(message)); } catch { frame = null; }
        if (
          !state.ackDropped
          && writeRequestId !== undefined
          && frame?.id === writeRequestId
          && Object.hasOwn(frame, "result")
          && !Object.hasOwn(frame, "error")
        ) {
          state.serverSuccessResponseObserved = true;
          state.ackDropped = true;
          state.holdRecoveryReadResults = holdRecoveryReadResultsAfterAck;
          route.close({ code: 1011, reason: "fixture settings ACK lost" });
          upstream.close();
          return;
        }
        if (
          state.ackDropped
          && frame?.id !== undefined
          && readsAfterDrop.delete(frame.id)
          && Object.hasOwn(frame, "result")
          && !Object.hasOwn(frame, "error")
        ) {
          state.serverSuccessfulReadsAfterDrop += 1;
          const expectedValue = frame.result?.instructions === expectedInstructions;
          if (state.holdRecoveryReadResults) {
            state.recoveryReadResultsDropped += 1;
            state.droppedReadResultMatchedExpectedInstructions ||= expectedValue;
            route.close({ code: 1011, reason: "fixture settings read result lost" });
            upstream.close();
            return;
          }
          state.successfulReadsAfterDrop += 1;
          state.forwardedReadResultMatchedExpectedInstructions ||= expectedValue;
        }
        route.send(message);
      });
    },
  );
  state.releaseRecoveryReads = () => {
    state.holdRecoveryReadResults = false;
    state.recoveryReadsReleased = true;
  };
  return state;
}

async function settingsFileHasInstructions(filePath, expected) {
  const settings = JSON.parse(await readFile(filePath, "utf8"));
  return settings.studio_context?.instructions === expected;
}

async function settingsFileHasPermissionMode(filePath, expected) {
  const settings = JSON.parse(await readFile(filePath, "utf8"));
  return settings.permission_mode === expected;
}

function settingsInstructionsFromText(serializedSettings) {
  const settings = JSON.parse(serializedSettings);
  return typeof settings.studio_context?.instructions === "string"
    ? settings.studio_context.instructions
    : "";
}

async function captureFaultPageFailure(context, page, label, stage, error) {
  let visibleTestIds = [];
  try {
    visibleTestIds = await page.locator("[data-testid]:visible").evaluateAll(nodes => nodes
      .map(node => node.getAttribute("data-testid"))
      .filter(value => typeof value === "string"));
  } catch {}
  await context.writeArtifactJson(`${label}-failure-diagnostic.json`, {
    stage,
    errorType: typeof error?.name === "string" ? error.name : "Error",
    pathname: (() => {
      try { return new URL(page.url()).pathname; } catch { return ""; }
    })(),
    visibleTestIds,
    inputValuesCaptured: false,
  }).catch(() => {});
  await page.screenshot({
    path: context.pathInArtifacts(`${label}-failure.png`),
    mask: [page.locator("input, textarea, [contenteditable='true']")],
    maskColor: "#111827",
  }).catch(() => {});
}

async function waitForReadOrVisibleControl(readCount, baseline, control, timeoutMs, label) {
  await waitFor(async () => readCount() > baseline || await control.isVisible(), timeoutMs, label);
  return readCount() > baseline;
}

async function selectOptionIfNeeded(select, value, label) {
  await select.waitFor({ state: "visible", timeout: 20_000 });
  await waitFor(async () => await select.isEnabled(), 20_000, `${label} selector to be enabled`);
  await waitFor(
    async () => await select.locator("option").evaluateAll((options, expected) =>
      options.some(option => option.value === expected), value),
    20_000,
    `${label} option ${value} to be available`,
  );
  const before = await select.inputValue();
  if (before !== value) await select.selectOption(value);
  await waitFor(async () => await select.inputValue() === value, 20_000, `${label} to select ${value}`);
  return { before, after: value, changed: before !== value };
}

function observePage(page, label, errors, rpcMethods, rpcReceipts) {
  page.on("pageerror", error => errors.push(`${label} pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") errors.push(`${label} console: ${message.text()}`);
  });
  page.on("websocket", socket => {
    const pending = new Map();
    const url = new URL(socket.url());
    const targetId = url.searchParams.get("server") ?? undefined;
    const channel = url.searchParams.get("channel") === "browser" ? "browser" : "runtime";
    socket.on("framesent", event => {
      const frame = parseObservedRpcFrame(event.payload);
      if (!frame || typeof frame !== "object" || typeof frame.method !== "string") return;
      rpcMethods.push(frame.method);
      if (frame.id !== undefined && frame.id !== null) pending.set(frame.id, { method: frame.method, targetId, channel });
    });
    socket.on("framereceived", event => {
      const frame = parseObservedRpcFrame(event.payload);
      if (!frame || typeof frame !== "object"
        || frame.id === undefined || frame.id === null || !pending.has(frame.id)) return;
      const request = pending.get(frame.id);
      pending.delete(frame.id);
      rpcReceipts.push({
        method: request.method,
        targetId: request.targetId,
        channel: request.channel,
        hasResult: Object.hasOwn(frame, "result"),
        hasError: Object.hasOwn(frame, "error"),
      });
    });
  });
}

function parseObservedRpcFrame(payload) {
  try {
    return JSON.parse(String(payload));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function pairMobile(page, gateway) {
  const response = await page.goto(`${gateway.baseUrl}/login?returnTo=%2Fmobile%2F`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "Mobile Web login route must be served by the owned Gateway");
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

async function loginDesktop(page, gateway) {
  const response = await page.goto(`${gateway.baseUrl}/login?returnTo=%2F`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "desktop Web login route must be served by the owned Gateway");
  const tokenInput = page.locator('input[name="token"]');
  if (await tokenInput.count()) {
    await tokenInput.fill(gateway.authToken);
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
}

function visibleTestId(page, testId) {
  return page.locator(`[data-testid=${JSON.stringify(testId)}]:visible`);
}

function mobileProfileId(url) {
  const pathname = new URL(url).pathname;
  const parts = pathname.split("/").filter(Boolean);
  const index = parts.indexOf("h");
  return index >= 0 && parts[index + 1] ? decodeURIComponent(parts[index + 1]) : null;
}

async function openMobileSection(page, section) {
  const sectionRow = visibleTestId(page, `settings-section-${section}`);
  if (await sectionRow.count()) {
    await sectionRow.click();
  } else {
    await page.goto(`${new URL(page.url()).origin}/mobile/settings-section?section=${encodeURIComponent(section)}`, { waitUntil: "domcontentloaded" });
  }
  await visibleTestId(page, "settings-section-screen").waitFor({ state: "visible", timeout: 30_000 });
  await visibleTestId(page, "settings-section-title").waitFor({ state: "visible", timeout: 10_000 });
}

async function toggleConversationPreference(page, testId, field) {
  const control = visibleTestId(page, testId);
  await control.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(({ key, field: preferenceField }) => {
    try {
      return typeof JSON.parse(localStorage.getItem(key) ?? "null")?.[preferenceField] === "boolean";
    } catch {
      return false;
    }
  }, { key: MOBILE_PREFERENCES_KEY, field }, { timeout: 10_000 });

  const initialChecked = await control.getAttribute("aria-checked");
  assert.ok(initialChecked === "true" || initialChecked === "false",
    `${testId} must expose its real initial switch state`);
  const before = initialChecked === "true";
  const switchInput = control.locator('input[role="switch"]');
  await switchInput.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await switchInput.isChecked(), before,
    `${field} nested native switch must match the persisted outer switch state`);
  const storedBefore = await page.evaluate(({ key, field: preferenceField }) =>
    JSON.parse(localStorage.getItem(key) ?? "null")?.[preferenceField],
  { key: MOBILE_PREFERENCES_KEY, field });
  assert.equal(storedBefore, before, `${field} must begin from the persisted Mobile preference`);

  const afterOuterPress = !before;
  await control.click();
  await waitForConversationPreferenceState(page, testId, field, afterOuterPress,
    `${field} outer switch press to persist and synchronize its visible state`);
  await visibleTestId(page, "conversation-preferences-saving").waitFor({ state: "hidden", timeout: 10_000 });

  await page.evaluate(storageKey => {
    const storage = window.localStorage;
    const prototype = Object.getPrototypeOf(storage);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "setItem");
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new Error("localStorage setItem cannot be observed for the switch interaction");
    }
    const probe = { storage, prototype, descriptor, writes: 0 };
    Object.defineProperty(window, "__kcoderSettingsPreferenceWriteProbe", {
      configurable: true,
      value: probe,
    });
    Object.defineProperty(prototype, "setItem", {
      ...descriptor,
      value(name, value) {
        if (this === storage && name === storageKey) probe.writes += 1;
        return descriptor.value.call(this, name, value);
      },
    });
  }, MOBILE_PREFERENCES_KEY);

  const afterNestedInput = !afterOuterPress;
  let nestedInputStorageWrites;
  try {
    await switchInput.click();
    await waitForConversationPreferenceState(page, testId, field, afterNestedInput,
      `${field} nested input switch click to persist exactly one state change`);
    await visibleTestId(page, "conversation-preferences-saving").waitFor({ state: "hidden", timeout: 10_000 });
    nestedInputStorageWrites = await page.evaluate(() =>
      window.__kcoderSettingsPreferenceWriteProbe?.writes ?? 0);
  } finally {
    await page.evaluate(() => {
      const probe = window.__kcoderSettingsPreferenceWriteProbe;
      if (!probe) return;
      Object.defineProperty(probe.prototype, "setItem", probe.descriptor);
      delete window.__kcoderSettingsPreferenceWriteProbe;
    });
  }
  assert.equal(nestedInputStorageWrites, 1,
    `${field} nested input click must issue one local preference write, not a duplicate bubbled Pressable save`);
  const afterFinalOuterPress = !afterNestedInput;
  await control.click();
  await waitForConversationPreferenceState(page, testId, field, afterFinalOuterPress,
    `${field} final outer switch press to persist and synchronize its visible state`);
  await visibleTestId(page, "conversation-preferences-saving").waitFor({ state: "hidden", timeout: 10_000 });
  return {
    before,
    after: afterFinalOuterPress,
    outerPressAfter: afterOuterPress,
    nestedInputAfter: afterNestedInput,
    nestedInputStorageWrites,
  };
}

async function waitForConversationPreferenceState(page, testId, field, expected, label) {
  await waitFor(
    async () => await page.evaluate(({ key, testId: expectedTestId, field: preferenceField, expectedValue }) => {
      try {
        const stored = JSON.parse(localStorage.getItem(key) ?? "null")?.[preferenceField];
        const row = Array.from(document.querySelectorAll("[data-testid]")).find(node =>
          node.getAttribute("data-testid") === expectedTestId
            && node.getClientRects().length > 0
            && getComputedStyle(node).visibility !== "hidden");
        const input = row?.querySelector('input[role="switch"]');
        return stored === expectedValue
          && row?.getAttribute("aria-checked") === String(expectedValue)
          && input instanceof HTMLInputElement
          && input.checked === expectedValue;
      } catch {
        return false;
      }
    }, {
      key: MOBILE_PREFERENCES_KEY,
      testId,
      field,
      expectedValue: expected,
    }),
    10_000,
    label,
  );
}

async function captureMobileSettingsHomeMatrix(page, context, gateway) {
  const response = await page.goto(`${gateway.baseUrl}/mobile/settings`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "the owned Gateway must serve the paired Mobile Settings route");
  await visibleTestId(page, "settings-home").waitFor({ state: "visible", timeout: 30_000 });
  await page.setViewportSize({ width: 390, height: 1180 });

  const observations = [];
  for (const language of ["zh-CN", "en"]) {
    for (const theme of ["light", "dark"]) {
      await setMobileSettingsAppearance(page, language, theme);
      await assertMobileSettingsPresentation(page, language, theme);
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 1180 });
        const dimensions = await page.evaluate(() => ({
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        }));
        assert.equal(dimensions.viewport, width);
        assert.ok(Math.max(dimensions.document, dimensions.body) <= width,
          `Settings home must not overflow horizontally at ${width}px`);
        const rows = await visibleTestId(page, "settings-home").locator('[data-testid][role="button"]:visible').evaluateAll(nodes =>
          nodes.filter(node => node.dataset.testid !== "settings-detail-back").map(node => ({
            id: node.dataset.testid,
            height: node.getBoundingClientRect().height,
            right: node.getBoundingClientRect().right,
            text: node.innerText,
            clippedText: Array.from(node.querySelectorAll("div, span")).filter(element =>
              Array.from(element.childNodes).some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())
              && getComputedStyle(element).overflow === "hidden"
              && element.scrollWidth > element.clientWidth + 1,
            ).map(element => element.textContent),
          })));
        assert.deepEqual(rows.map(row => row.id), SETTINGS_HOME_ROW_IDS,
          `${language}/${theme}/${width}px must show all fourteen Settings rows in order`);
        for (const row of rows) {
          assert.ok(row.height >= 44 && row.height <= 64, `${row.id} must remain compact and touch accessible`);
          assert.ok(row.right <= width, `${row.id} must fit within ${width}px`);
          assert.ok(!row.text.includes("settings_hub."), "translation key leaked into Settings home");
          assert.deepEqual(row.clippedText, [], `${row.id} labels and summaries must fit without truncation`);
        }
        const screenshot = `settings-home-${width}-${language}-${theme}.png`;
        await page.screenshot({ path: context.pathInArtifacts(screenshot), animations: "disabled" });
        observations.push({
          language,
          theme,
          viewport: `${width}x1180`,
          screenshot,
          rowCount: rows.length,
          rows,
          documentScrollWidth: dimensions.document,
          bodyScrollWidth: dimensions.body,
          horizontalOverflow: false,
        });
      }
    }
  }

  // Return to the locale, theme, and compact viewport used by the functional flow.
  await setMobileSettingsAppearance(page, "zh-CN", "light");
  await page.setViewportSize({ width: 390, height: 844 });
  const result = {
    locales: ["zh-CN", "en"],
    themes: ["light", "dark"],
    widths: [320, 390],
    screenshotHeight: 1180,
    acceptanceFlowViewport: "390x844",
    rowCount: SETTINGS_HOME_ROW_IDS.length,
    observations,
  };
  await context.writeArtifactJson("mobile-settings-home-layout-matrix.json", result);
  return result;
}

async function setMobileSettingsAppearance(page, language, theme) {
  await visibleTestId(page, "settings-home").waitFor({ state: "visible", timeout: 10_000 });
  await visibleTestId(page, "settings-appearance").click();
  await visibleTestId(page, "settings-appearance-screen").waitFor({ state: "visible", timeout: 10_000 });
  await visibleTestId(page, "settings-language-row").click();
  const languageSheet = visibleTestId(page, "settings-choice-sheet-language");
  await languageSheet.waitFor({ state: "visible", timeout: 10_000 });
  const languageChoice = language === "zh-CN" ? "zh-cn" : language;
  await visibleTestId(page, `settings-language-choice-${languageChoice}`).click();
  await languageSheet.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForFunction(expected => document.documentElement.lang === expected, language, { timeout: 10_000 });
  await visibleTestId(page, "settings-theme-row").click();
  const sheet = visibleTestId(page, "settings-choice-sheet-theme");
  await sheet.waitFor({ state: "visible", timeout: 10_000 });
  await visibleTestId(page, `settings-theme-choice-${theme}`).click();
  await sheet.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, theme, { timeout: 10_000 });
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--mobile-color-scheme").trim());
  assert.equal(scheme, theme, `Mobile Settings UI must apply the selected ${theme} presentation`);
  await visibleTestId(page, "settings-detail-back").click();
  await visibleTestId(page, "settings-home").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(new URL(page.url()).pathname, "/mobile/settings", "Appearance Back must return to the mounted Mobile Settings home");
}

async function assertMobileSettingsPresentation(page, language, theme) {
  await page.waitForFunction(expected => document.documentElement.lang === expected, language, { timeout: 10_000 });
  await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, theme, { timeout: 10_000 });
  assert.equal(await visibleTestId(page, "settings-home-title").innerText(), language === "en" ? "Settings" : "设置");
  assert.equal(await page.locator("html").getAttribute("lang"), language);
  assert.equal(await visibleTestId(page, "settings-home").evaluate(node => getComputedStyle(node).backgroundColor),
    theme === "light" ? "rgb(244, 244, 245)" : "rgb(24, 24, 27)");
  await page.waitForFunction(({ key, language: expectedLanguage, theme: expectedTheme }) => {
    try {
      const preference = JSON.parse(localStorage.getItem(key) ?? "null");
      return preference?.language === expectedLanguage && preference?.theme === expectedTheme;
    } catch {
      return false;
    }
  }, { key: MOBILE_PREFERENCES_KEY, language, theme }, { timeout: 10_000 });
}

async function selectMobileTarget(page, serverId) {
  const selector = visibleTestId(page, "settings-runtime-target-selector");
  await selector.waitFor({ state: "visible", timeout: 20_000 });
  const option = visibleTestId(page, `settings-runtime-target-option-${serverId}`);
  const selectedText = await selector.innerText().catch(() => "");
  const label = serverId === TARGET_A ? "Settings Target A" : "Settings Target B";
  if (!selectedText.includes(label)) {
    await selector.click();
    await option.waitFor({ state: "visible", timeout: 15_000 });
    await option.click();
  }
  await waitFor(async () => (await selector.innerText().catch(() => "")).includes(label), 20_000, `Mobile selected runtime target ${serverId}`, 100, undefined);
}

async function withTargetRpc(context, gateway, cookie, token, serverId, body, { channel = "runtime" } = {}) {
  const rpc = await openRpc(gatewayRpcUrl(gateway, serverId, token, channel), {
    headers: { Cookie: cookie, Origin: gateway.baseUrl },
  });
  const cleanupLabel = `close ${SETTINGS_SOURCE} ${serverId} ${channel} RPC`;
  const cleanup = context.addCleanup(cleanupLabel, () => closeRpcAndWait(rpc, cleanupLabel));
  try {
    const initialized = await initializeRpc(rpc, `${SETTINGS_SOURCE}-${serverId}-${++targetRpcSequence}`);
    return await body(rpc, initialized);
  } finally {
    await closeRpcAndWait(rpc, cleanupLabel);
    cleanup?.();
  }
}

async function restartTargetAndRead(context, gateway, cookie, token, serverId, brokerOwnershipDiagnostic) {
  const connect = async name => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, serverId, token), {
      headers: { Cookie: cookie, Origin: gateway.baseUrl },
    });
    context.addCleanup(`close ${SETTINGS_SOURCE} ${name} RPC`, () => rpc.close());
    await initializeRpc(rpc, `settings-acceptance-${name}`);
    return rpc;
  };
  let rpc = await connect("restart-before");
  if (brokerOwnershipDiagnostic) brokerOwnershipDiagnostic.stage = "target-a-restart-rpc-initialized";
  const before = await rpc.request("server/resources/read", {});
  if (brokerOwnershipDiagnostic) {
    brokerOwnershipDiagnostic.stage = "target-a-resource-read-complete";
    brokerOwnershipDiagnostic.beforeResources = before;
    brokerOwnershipDiagnostic.targetGeneration.processIdBeforeRestart = before?.processId ?? null;
    brokerOwnershipDiagnostic.restartOutcome = { state: "requesting", force: false };
  }
  let stopped;
  try {
    stopped = await rpc.request("gateway/app-server/restart", { confirm: true, force: false }, 30_000);
  } catch (error) {
    if (brokerOwnershipDiagnostic) {
      brokerOwnershipDiagnostic.stage = "target-a-restart-rpc-error";
      brokerOwnershipDiagnostic.restartOutcome = {
        state: "rpc-error",
        errorType: error instanceof Error ? error.name : "Error",
      };
    }
    throw error;
  }
  if (brokerOwnershipDiagnostic) {
    brokerOwnershipDiagnostic.stage = "target-a-restart-accepted";
    brokerOwnershipDiagnostic.restartOutcome = { state: "accepted", stopped: stopped?.stopped === true };
  }
  assert.equal(stopped.stopped, true);
  await waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED, 5_000, "target A restart closes its old owned RPC");
  rpc = await connect("restart-after");
  const after = await rpc.request("server/resources/read", {});
  if (brokerOwnershipDiagnostic) {
    brokerOwnershipDiagnostic.afterResources = after;
    brokerOwnershipDiagnostic.targetGeneration.processIdAfterRestart = after?.processId ?? null;
    brokerOwnershipDiagnostic.stage = "target-a-restarted-resource-read-complete";
  }
  const execution = await rpc.request("settings/execution-defaults/read", {});
  return { stopped, before, after, execution };
}

async function setExecutionDefault(page, mode) {
  const selector = visibleTestId(page, "execution-defaults-permission-mode");
  await selector.waitFor({ state: "visible", timeout: 15_000 });
  await selector.click();
  await visibleTestId(page, "execution-defaults-choice-sheet").waitFor({ state: "visible", timeout: 10_000 });
  await visibleTestId(page, `execution-defaults-option-${mode}`).click();
  await visibleTestId(page, "execution-defaults-save").click();
  await visibleTestId(page, "execution-defaults-saved").waitFor({ state: "visible", timeout: 20_000 });
}

async function saveMobileInstructions(page, contents) {
  const editor = visibleTestId(page, "custom-instructions-input");
  await editor.waitFor({ state: "visible", timeout: 15_000 });
  await editor.fill(contents);
  await visibleTestId(page, "custom-instructions-save").click();
  await visibleTestId(page, "custom-instructions-saved").waitFor({ state: "visible", timeout: 20_000 });
}

function isTargetSettingsWrite(method) {
  return method === "settings/tools/save"
    || method === "settings/execution-defaults/save"
    || method === "runtime.context.update"
    || method === "runtime.providers.upsert"
    || method === "runtime.providers.delete"
    || method === "skills/setEnabled"
    || method === "plugin/enable"
    || method === "plugin/disable";
}

function successfulExecutionDefaultsReceiptCount(receipts, method) {
  return receipts.filter(receipt => receipt.method === method
    && receipt.targetId === TARGET_A
    && receipt.channel === "runtime"
    && receipt.hasResult
    && !receipt.hasError).length;
}

function safeUrl(value) {
  const url = new URL(value);
  url.searchParams.delete("token");
  return url.toString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
