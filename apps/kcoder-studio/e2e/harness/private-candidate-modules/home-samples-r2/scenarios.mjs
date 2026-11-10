// Private historical candidate mechanisms; construction starts no resources.
export function createPrivateHomeSamplesR2Scenarios({
  APPLICATION_DELAY_TIMER_TOLERANCE_MS,
  DEFAULT_DELAYS,
  DEFAULT_SAMPLES,
  REFRESH_BACKGROUND_MOBILE_SESSIONS,
  REFRESH_HOME_MINUTE_BOUNDARY_FIRST_REQUEST_LEAD_MS,
  REFRESH_HOME_MINUTE_BOUNDARY_REQUEST_LEAD_MARGIN_MS,
  SERVER_ID,
  THREAD_ID,
  applyRefreshBackgroundMobileEmulation,
  assert,
  assertApplicationDelay,
  assertHomeThreadPresentationStableExceptRelativeTime,
  assertRunningControlsStayHiddenAfterTwoFrames,
  captureHomeThreadPresentation,
  capturePrivateFailureScreenshot,
  closeOwnedMobilePage,
  closeRefreshDiagnosticMobilePage,
  connectMobile,
  createAcceptedTurnReceiptFixture,
  createRefreshProgressWriter,
  createResponseJitter,
  delayValues,
  describeVisiblePage,
  distribution,
  drainAndArmBackgroundHttpResponseHold,
  ensureFixtureSessionVisible,
  epochNow,
  faultScenarioIds,
  findHttpResponseForRouteRequest,
  formalOwnedAuthLifecycle,
  newMobilePage,
  normalizeHomeThreadRowText,
  observeLoginResponses,
  observeOwnedMobileAuth,
  openFixtureSession,
  ownedMobileDeviceStorePath,
  percentile,
  performance,
  readOwnedMobileDeviceSummary,
  readRefreshBackgroundMobileFacts,
  refreshBackgroundDiagnosticId,
  refreshBackgroundDiagnosticMode,
  refreshBackgroundMobileFactsMatch,
  refreshBackgroundWindowMode,
  refreshCoverageMode,
  refreshDiagnosticMode,
  refreshHomeMinuteBoundaryDiagnosticMode,
  refreshHomeMinuteBoundarySamplesOnlyMode,
  refreshPerSampleAuthCleanupMode,
  refreshScenarioId,
  refreshSendDiagnostic,
  refreshSendDiagnosticMode,
  refreshSharedBackgroundDiagnosticMode,
  refreshSingleSampleMode,
  refreshSmokeMode,
  releaseOwnedMobileAuthSample,
  round,
  safePath,
  sampleCount,
  sanitizeGatewayPath,
  selectedFaultScenario,
  sha256,
  startRefreshBackgroundChromium,
  summarizeHttpDelaySample,
  summarizeNetwork,
  summarizeWebSocketDelaySample,
  waitFor,
  waitForGatewayRpcQuiescence,
}) {
async function runPhoneUxFaultScenarios(chromium, gateway, network, gatewayCalls, browserErrors, context, refreshBackgroundHost, expectedWorkspace) {
  const rows = [];
  const requiredScenarioFailures = [];
  let receiptSummary = null;
  const persistProgress = () => {
    const completedScenarioCount = rows.filter(row => ["PASS", "SMOKE", "DIAGNOSTIC_ONLY", "PARTIAL", "FAIL"].includes(row.status)).length;
    const expectedScenarioCount = selectedFaultScenario ? 1 : faultScenarioIds.length;
    const partialCoverage = rows.some(row => row.checks.coverageStatus && !["PASS", "FAIL", "SMOKE", "DIAGNOSTIC_ONLY"].includes(row.checks.coverageStatus));
    const progressArtifactName = `phone-ux-fault-progress-${String(completedScenarioCount).padStart(2, "0")}.json`;
    return context.writeArtifactJson(progressArtifactName, {
      schemaVersion: 1,
      status: rows.some(row => row.status === "FAIL")
        ? "PARTIAL_FAIL"
        : rows.some(row => row.status === "DIAGNOSTIC_ONLY") ? "DIAGNOSTIC_ONLY"
          : rows.some(row => row.status === "SMOKE") ? "SMOKE_ONLY"
          : partialCoverage ? "PARTIAL_COVERAGE"
          : completedScenarioCount >= expectedScenarioCount ? "PASS_SCOPED" : "RUNNING",
      selectedScenario: selectedFaultScenario ?? "all-required-fault-scenarios",
      completedScenarioCount,
      expectedScenarioCount,
      faults: rows,
      requiredScenarioFailures,
      fixtureReceiptLedger: receiptSummary,
      network: summarizeNetwork(network),
      browserErrors,
      gatewayCalls,
    });
  };
  const runCase = async (scenarioId, delayControl, exercise, { skipPageSetup = false, beforeFixtureSessionVisible } = {}) => {
    if (selectedFaultScenario && selectedFaultScenario !== scenarioId) return null;
    const row = {
      scenario: scenarioId,
      status: "RUNNING",
      evidenceClass: "real Mobile Web page in isolated Chromium context plus KCODER_STUDIO_MOCK Gateway fixture",
      checks: {},
    };
    const scenarioControl = { ...delayControl, delayMs: delayControl.delayMs ?? 0, scenarioId };
    network.currentStage = `fault:${scenarioId}:home`;
    let page;
    const startedAt = performance.now();
    try {
      if (!skipPageSetup) {
        page = await newMobilePage(chromium, network, scenarioControl, gatewayCalls, browserErrors, context);
        await connectMobile(page, gateway, {
          beforeFixtureSessionVisible: beforeFixtureSessionVisible ? () => beforeFixtureSessionVisible(page, row) : undefined,
        });
      }
      await exercise(page, row, scenarioControl);
      row.drain = await waitForGatewayRpcQuiescence(network, 35_000, 200);
      row.status = refreshDiagnosticMode && scenarioId === refreshScenarioId
        ? row.checks.coverageStatus === "DIAGNOSTIC_ONLY" ? "DIAGNOSTIC_ONLY" : "PARTIAL"
        : refreshSmokeMode && scenarioId === refreshScenarioId && row.checks.coverageStatus === "SMOKE"
          ? "SMOKE"
          : refreshSmokeMode && scenarioId === refreshScenarioId ? "PARTIAL" : "PASS";
    } catch (error) {
      row.status = "FAIL";
      row.error = context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 700);
      if (page && !page.isClosed()) row.pageAtFailure = await describeVisiblePage(page);
      requiredScenarioFailures.push({ scenario: scenarioId, reason: row.error });
    } finally {
      row.durationMs = round(performance.now() - startedAt);
      if (page) await closeOwnedMobilePage(page).catch(() => {});
      if (!(["PASS", "SMOKE", "DIAGNOSTIC_ONLY"].includes(row.status))) {
        try { await waitForGatewayRpcQuiescence(network, 2_000, 100); } catch {}
      }
      rows.push(row);
      await persistProgress();
    }
    return row;
  };

  await runCase("slow-status-12s", { statusProbeDelayMs: 12_000 }, async (page, row) => {
    const statusRequest = await waitFor(() => network.httpRouteRequests.find(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status"), 10_000, "slow status probe request");
    await page.getByTestId("server-status-refreshing").waitFor({ state: "visible", timeout: 8_000 });
    row.checks.statusRefreshingVisible = true;
    row.checks.statusRequestStartedAtEpochMs = statusRequest.startedAtEpochMs;
    network.currentStage = `fault:${row.scenario}:history-before-status-response`;
    const historyStartedAt = performance.now();
    await openFixtureSession(page);
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 8_000 });
    const historyVisibleMs = round(performance.now() - historyStartedAt);
    const statusResponseAlreadyReturned = network.httpResponsePathDelays.some(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status");
    assert.equal(statusResponseAlreadyReturned, false, "history should become visible while the 12-second status response is still held");
    row.checks.historyVisibleBeforeSlowStatusResponse = true;
    row.checks.clickToHistoryVisibleMs = historyVisibleMs;
    assert.ok(historyVisibleMs < 10_000, `history appeared after ${historyVisibleMs}ms, while status is configured for 12000ms`);
    await waitForGatewayRpcQuiescence(network, 20_000, 200);
    const delayedStatus = network.httpResponsePathDelays.find(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status");
    assertApplicationDelay(delayedStatus, 12_000, "slow /api/servers/status application response hold");
    row.checks.slowStatusResponseCompleted = true;
    row.checks.statusConfiguredDelayMs = delayedStatus.configuredDelayMs;
    row.checks.statusAppliedDelayMs = delayedStatus.appliedDelayMs;
    row.checks.statusDelayTimerToleranceMs = APPLICATION_DELAY_TIMER_TOLERANCE_MS;
  }, {
    beforeFixtureSessionVisible: async (page, row) => {
      const statusRequest = await waitFor(() => network.httpRouteRequests.find(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status"), 10_000, "slow status probe request before session-list setup");
      await page.getByTestId("server-status-refreshing").waitFor({ state: "visible", timeout: 8_000 });
      const completed = network.httpResponsePathDelays.some(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status");
      assert.equal(completed, false, "slow status response must still be held while the home route is becoming interactive");
      row.checks.statusRequestObservedBeforeSessionListSetup = true;
      row.checks.statusRefreshingVisibleBeforeSessionList = true;
      row.checks.statusResponseStillHeldBeforeSessionListSetup = true;
      row.checks.statusRequestStartedAtEpochMs = statusRequest.startedAtEpochMs;
    },
  });

  await runCase("status-http-401", { httpStatusOverrides: {} }, async (page, row, scenarioControl) => {
    await page.getByTestId(`thread-${THREAD_ID}`).waitFor({ state: "visible", timeout: 10_000 });
    row.checks.sessionRowVisibleBeforeStatus401 = true;
    scenarioControl.httpStatusOverrides["/api/servers/status"] = 401;
    // This is an endpoint-specific forced 401, not a token or session revoke.
    // Let server-list setup settle so the post-challenge UI can attempt the same
    // cold task route through its normal session-row interaction.
    scenarioControl.statusProbeDelayMs = 500;
    network.currentStage = `fault:${row.scenario}:status-401-reload`;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("reauthorize-active-profile").waitFor({ state: "visible", timeout: 15_000 });
    row.checks.reauthorizationChallengeAfterEndpointSpecific401 = true;
    row.checks.serverStatusErrorHiddenWhileReauthorizationRequired = !(await page.getByTestId("server-status-error").isVisible().catch(() => false));
    assert.equal(row.checks.serverStatusErrorHiddenWhileReauthorizationRequired, true, "a 401 must be presented as a reauthorization challenge, not a transient health-probe error");
    const reloadStage = `fault:${row.scenario}:status-401-reload`;
    const statusProbeResponses = network.httpResponsePathDelays.filter(item => item.scenario === row.scenario && item.stage === reloadStage && item.apiPath === "/api/servers/status");
    assert.ok(statusProbeResponses.length > 0 && statusProbeResponses.every(item => item.status === 401), "the isolated status probe must return the injected 401");
    row.checks.statusProbe401ResponseCount = statusProbeResponses.length;
    row.checks.injectedStatus401 = network.injectedHttpStatuses.some(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status" && item.status === 401);
    assert.equal(row.checks.injectedStatus401, true, "the endpoint-specific 401 must be visible in the isolated HTTP route ledger");

    const coldTaskRouteStage = `fault:${row.scenario}:cold-task-route-after-endpoint-401`;
    network.currentStage = coldTaskRouteStage;
    await page.getByTestId(`thread-${THREAD_ID}`).waitFor({ state: "visible", timeout: 8_000 });
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    await page.getByText("无法打开任务", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const coldResumeRequests = network.rpcEvents.filter(item => item.direction === "request" && item.method === "thread/resume" && item.stage === coldTaskRouteStage);
    row.checks.coldTaskRouteBlockedByReauthorization = true;
    row.checks.coldResumeRequestCountAfterChallenge = coldResumeRequests.length;
    assert.equal(coldResumeRequests.length, 0, "a task route opened after the reauthorization challenge must not issue a cold thread/resume request");
    row.evidenceBoundary = "TaskScreen routeError intercepts the cold task route; this scenario makes no claim that a previously hot cached transcript remains readable after auth revocation";
  });

  await runCase("runtime-model-catalog-slow-12s", {
    threadModelFixture: true,
    methodDelayMs: {},
  }, async (page, row, scenarioControl) => {
    network.currentStage = `fault:${row.scenario}:preference-setup`;
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });

    await page.getByTestId("conversation-model-selector").click();
    await page.getByTestId("conversation-model-mock-minimax").waitFor({ state: "visible", timeout: 10_000 });
    const preferenceCatalogRequest = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "runtime.models.list" && item.stage === `fault:${row.scenario}:preference-setup`), 10_000, "real model-picker runtime.models.list request");
    await page.getByTestId("conversation-model-mock-minimax").click();
    const highEffort = page.getByRole("radio", { name: "高", exact: true });
    await highEffort.waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(() => highEffort.isEnabled(), 10_000, "model preference write to settle");
    await highEffort.click();
    await waitFor(async () => (await page.getByTestId("conversation-model-selector").innerText()).includes("高"), 10_000, "persisted high reasoning effort visible in the actual task selector");
    const modelPickerDialogs = page.getByRole("dialog").filter({ hasText: "模型与推理强度" });
    const dialogCount = await modelPickerDialogs.count();
    const modelPickerDialog = modelPickerDialogs.last();
    const closeModelPicker = modelPickerDialog.getByLabel("关闭", { exact: true });
    const closeLocatorProof = {
      dialogCount,
      ariaLabelCloseCount: await closeModelPicker.count(),
    };
    if (closeLocatorProof.ariaLabelCloseCount === 1) {
      Object.assign(closeLocatorProof, await closeModelPicker.evaluate(element => ({
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
        ariaDisabled: element.getAttribute("aria-disabled"),
      })));
    }
    row.checks.modelPickerCloseLocatorProof = closeLocatorProof;
    assert.ok(closeLocatorProof.dialogCount >= 1, "at least one active model-preference dialog must be present");
    assert.equal(closeLocatorProof.ariaLabelCloseCount, 1, "the active model-preference dialog must expose exactly one aria-label=关闭 control");
    await closeModelPicker.waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(() => closeModelPicker.isEnabled(), 10_000, "model preference write to finish before closing the picker");
    await closeModelPicker.click();
    await waitFor(async () => (await modelPickerDialogs.count()) === 0, 10_000, "all model-preference dialog layers to close");
    row.checks.preferenceSetThroughMobileUi = true;
    row.checks.preferenceCatalogRpcObserved = true;
    row.checks.preferencePickerClosedUsingVisibleCloseControl = true;
    row.checks.preferenceSetupRequestIdFingerprint = preferenceCatalogRequest.rpcIdFingerprint;

    await page.getByRole("button", { name: "返回" }).click();
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 10_000 });
    await ensureFixtureSessionVisible(page);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    await ensureFixtureSessionVisible(page);

    scenarioControl.methodDelayMs["runtime.models.list"] = 12_000;
    const routeSocketCountBeforeResume = network.routedWebSocketConnections.length;
    network.currentStage = `fault:${row.scenario}:task-reentry-with-persisted-effort`;
    const clickStartedAt = performance.now();
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    const request = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "runtime.models.list" && item.stage === network.currentStage), 10_000, "runtime.models.list from task resume with persisted effort");
    const responseAlreadyForwarded = network.rpcEvents.some(item => item.direction === "response-forwarded" && item.method === "runtime.models.list" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === request.stage);
    assert.equal(responseAlreadyForwarded, false, "runtime.models.list response must remain held during task re-entry");
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-input").fill(`PHONE_UX_MODEL_GATE_${Date.now()}`);
    assert.equal(await page.getByTestId("message-input").isEnabled(), true, "composer should remain editable during configuration restore");
    assert.equal(await page.getByTestId("send-message").isDisabled(), true, "sending must remain gated while runtime.models.list is pending");
    const clickToHistoryVisibleMs = round(performance.now() - clickStartedAt);
    assert.ok(clickToHistoryVisibleMs < 10_000, `history became visible after ${clickToHistoryVisibleMs}ms with model catalog held for 12000ms`);
    const restoredPreferenceLabel = await page.getByTestId("conversation-model-selector").innerText();
    assert.ok(restoredPreferenceLabel.includes("高"), "the model effort selected before reload must be restored into the active task UI");
    row.checks.resumeModelsListRequestObserved = true;
    row.checks.requestToHistoryVisibleMs = round(performance.now() - request.atMs);
    row.checks.clickToHistoryVisibleMs = clickToHistoryVisibleMs;
    row.checks.historyVisibleBeforeModelCatalogResponse = true;
    row.checks.persistedModelEffortHydratedOnResume = true;
    row.checks.composerEditableWhileModelCatalogPending = true;
    row.checks.sendDisabledWhileModelCatalogPending = true;
    row.checks.persistedModelEffort = "high";
    row.checks.threadResumeModelFixtureApplied = network.faultFixtureEvents.some(item => item.scenario === row.scenario && item.kind === "typed-thread-model-fixture" && item.method === "thread/resume");
    assert.equal(row.checks.threadResumeModelFixtureApplied, true, "thread/resume must provide the typed model identity used with the persisted reasoning preference");
    row.checks.routeSocketCountBeforeResume = routeSocketCountBeforeResume;

    const responseForwarded = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "runtime.models.list" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === request.stage), 20_000, "delayed runtime.models.list response");
    const delayedResponse = network.websocketResponsePathDelays.find(item => item.scenario === row.scenario && item.stage === request.stage && item.method === "runtime.models.list" && item.rpcIdFingerprint === request.rpcIdFingerprint);
    assertApplicationDelay(delayedResponse, 12_000, "task-resume runtime.models.list application response hold");
    const sendButton = page.getByTestId("send-message");
    await sendButton.waitFor({ state: "visible", timeout: 5_000 });
    const sendEnabledObservedAtMs = await waitFor(
      async () => (await sendButton.isEnabled()) ? performance.now() : null,
      5_000,
      "send to become enabled after model catalog restoration",
    );
    row.checks.modelCatalogApplicationDelayTimerToleranceMs = APPLICATION_DELAY_TIMER_TOLERANCE_MS;
    row.checks.modelCatalogResponseForwardedAtMs = responseForwarded.atMs;
    row.checks.sendEnabledObservedAtMs = round(sendEnabledObservedAtMs);
    row.checks.responseForwardedToSendEnabledObservedMs = round(sendEnabledObservedAtMs - responseForwarded.atMs);
    row.checks.sendEnabledAfterCatalogResponse = true;
    row.checks.modelCatalogResponseCompleted = true;
    row.checks.modelCatalogConfiguredDelayMs = delayedResponse.configuredDelayMs;
    row.checks.modelCatalogAppliedDelayMs = delayedResponse.appliedDelayMs;
  });

  await runCase("aux-agent-list-12s", {
    methodDelayMs: { "agent/list": 12_000 },
    testCapabilities: { agentSteering: true },
  }, async (page, row) => {
    network.currentStage = `fault:${row.scenario}:task-entry`;
    const clickStartedAt = performance.now();
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    const request = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "agent/list" && item.stage === `fault:${row.scenario}:task-entry`), 10_000, "capability-gated agent/list request");
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 8_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 8_000 });
    const historyVisibleAt = performance.now();
    const historyVisibleAfterRequestMs = round(historyVisibleAt - request.atMs);
    const clickToHistoryVisibleMs = round(historyVisibleAt - clickStartedAt);
    const responseAlreadyReturned = network.rpcEvents.some(item => item.direction === "response-forwarded" && item.method === "agent/list" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === `fault:${row.scenario}:task-entry`);
    assert.equal(responseAlreadyReturned, false, "history must render before the slow agent/list response");
    assert.ok(historyVisibleAfterRequestMs < 10_000, `history appeared after ${historyVisibleAfterRequestMs}ms with agent/list held for 12000ms`);
    await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 8_000 });
    assert.equal(await page.getByTestId("message-input").isEnabled(), true, "an optional agent/list response must not gate the editable composer");
    const forwarded = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "agent/list" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === request.stage), 20_000, "delayed agent/list response");
    const delayedResponse = network.websocketResponsePathDelays.find(item => item.scenario === row.scenario && item.stage === request.stage && item.method === "agent/list" && item.rpcIdFingerprint === request.rpcIdFingerprint);
    assertApplicationDelay(delayedResponse, 12_000, "agent/list application response hold");
    row.checks.auxiliaryDelayTimerToleranceMs = APPLICATION_DELAY_TIMER_TOLERANCE_MS;
    row.checks.testCapabilityInjected = true;
    row.checks.agentListRequestObserved = true;
    row.checks.historyVisibleBeforeAuxiliaryResponse = true;
    row.checks.composerEditableWhileAuxiliaryResponsePending = true;
    row.checks.agentListResponseCompleted = Boolean(forwarded);
    row.checks.auxiliaryResponseAppliedDelayMs = delayedResponse.appliedDelayMs;
    row.checks.requestToHistoryVisibleMs = historyVisibleAfterRequestMs;
    row.checks.clickToHistoryVisibleMs = clickToHistoryVisibleMs;
    row.checks.auxiliaryResponseConfiguredDelayMs = delayedResponse.configuredDelayMs;
  });

  await runCase("send-pending-2500ms", { methodResponseHoldMs: { "turn/start": 2_500 } }, async (page, row) => {
    network.currentStage = `fault:${row.scenario}:send-pending`;
    await openFixtureSession(page);
    const message = `PHONE_UX_PENDING_FIXTURE_${Date.now()}`;
    await page.getByTestId("message-input").fill(message);
    const priorStarts = network.rpcMethodCounts["turn/start"] ?? 0;
    const clickStartedAt = performance.now();
    await page.getByTestId("send-message").click();
    const pendingCard = page.getByTestId("failed-submission").filter({ hasText: message });
    await pendingCard.getByTestId("failed-submission-content").waitFor({ state: "visible", timeout: 2_000 });
    await pendingCard.getByText("正在发送，恢复记录已保存", { exact: true }).waitFor({ state: "visible", timeout: 2_000 });
    const pendingVisibleMs = round(performance.now() - clickStartedAt);
    const request = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "turn/start" && item.stage === `fault:${row.scenario}:send-pending`), 5_000, "mock turn/start pending request");
    const responseAlreadyForwarded = network.rpcEvents.some(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === `fault:${row.scenario}:send-pending`);
    assert.equal(responseAlreadyForwarded, false, "the local pending UI should appear before the delayed turn/start response");
    assert.ok((network.rpcMethodCounts["turn/start"] ?? 0) - priorStarts === 1, "one send gesture must emit exactly one mock turn/start request");
    assert.ok(network.pendingRpcMethodCounts["turn/start"] > 0, "turn/start must remain in flight while the pending UI is observed");
    row.checks.pendingDraftVisibleBeforeAck = true;
    row.checks.localRecoveryRecordPersistedBeforeAck = true;
    row.checks.pendingCardVisibleMs = pendingVisibleMs;
    row.checks.turnStartRequestCountForGesture = 1;
    await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 15_000 });
    const ack = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === request.stage), 10_000, "delayed mock turn/start response");
    const startObserved = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-start-request" && item.rpcIdFingerprint === request.rpcIdFingerprint), 5_000, "turn/start thread identity at the isolated route");
    assert.equal(startObserved.routeSocketId, request.routeSocketId, "turn/start identity must come from the same routed WebSocket request");
    assert.ok(startObserved.threadIdFingerprint, "the isolated turn/start request must include a thread identity fingerprint");
    const turnStarted = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/started" && item.routeSocketId === startObserved.routeSocketId && item.threadIdFingerprint === startObserved.threadIdFingerprint && item.atMs >= startObserved.atMs), 5_000, "same-route turn/started identity");
    assert.ok(turnStarted.turnIdFingerprint, "the actual turn/started notification must include a turn identity fingerprint");
    const turnCompleted = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/completed" && item.routeSocketId === turnStarted.routeSocketId && item.threadIdFingerprint === turnStarted.threadIdFingerprint && item.turnIdFingerprint === turnStarted.turnIdFingerprint), 10_000, "same-route terminal notification before delayed ACK");
    assert.equal(ack.routeSocketId, startObserved.routeSocketId, "the delayed turn/start ACK must belong to the same route socket");
    assert.ok(turnStarted.atMs >= startObserved.atMs, "turn/started must follow its exact turn/start request");
    assert.ok(turnCompleted.atMs < ack.atMs, "the exact same-route turn must actually complete before its delayed ACK is forwarded");
    const ackHold = await waitFor(() => network.methodResponseHolds.find(item => item.method === "turn/start" && item.configuredHoldMs === 2_500), 5_000, "measured turn/start response hold");
    assertApplicationDelay({ configuredDelayMs: ackHold.configuredHoldMs, appliedDelayMs: ackHold.measuredHoldMs }, 2_500, "mock turn/start response hold");
    row.checks.mockAckForwardedAfterPending = Boolean(ack);
    row.checks.turnLifecycleExactThreadTurnRoute = {
      threadIdFingerprint: startObserved.threadIdFingerprint,
      turnIdFingerprint: turnStarted.turnIdFingerprint,
      routeSocketId: turnStarted.routeSocketId,
    };
    row.checks.turnCompletedBeforeAckMs = round(ack.atMs - turnCompleted.atMs);
    row.checks.responseHoldConfiguredMs = ackHold.configuredHoldMs;
    row.checks.responseHoldAppliedMs = ackHold.measuredHoldMs;
    row.checks.responseHoldTimerToleranceMs = APPLICATION_DELAY_TIMER_TOLERANCE_MS;
    await assertRunningControlsStayHiddenAfterTwoFrames(page, "turn completed before ACK; a late ACK must not revive running UI");
    await waitForGatewayRpcQuiescence(network, 10_000, 200);
    await assertRunningControlsStayHiddenAfterTwoFrames(page, "after network quiescence, a late ACK must not revive running UI");
    row.checks.runningControlsStayedHiddenAfterAckTwoFramesAndNetworkQuiescence = true;
  });

  await runCase("approval-live-turn-interrupt-same-route", {}, async (page, row) => {
    network.currentStage = `fault:${row.scenario}:live-approval-turn`;
    await openFixtureSession(page);
    const message = `MOBILE_APPROVAL_PHONE_UX_${Date.now()}`;
    const priorStarts = network.rpcMethodCounts["turn/start"] ?? 0;
    await page.getByTestId("message-input").fill(message);
    await page.getByTestId("send-message").click();
    await page.getByTestId("approval-card").waitFor({ state: "visible", timeout: 15_000 });
    const stopButton = page.getByTestId("stop-turn");
    await stopButton.waitFor({ state: "visible", timeout: 10_000 });
    const startRequest = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "turn/start" && item.stage === `fault:${row.scenario}:live-approval-turn`), 5_000, "MOBILE_APPROVAL turn/start request");
    assert.equal((network.rpcMethodCounts["turn/start"] ?? 0) - priorStarts, 1, "the approval fixture must start one isolated turn");
    const startObserved = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-start-request" && item.rpcIdFingerprint === startRequest.rpcIdFingerprint), 5_000, "approval turn thread identity");
    const turnStarted = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/started" && item.routeSocketId === startObserved.routeSocketId && item.threadIdFingerprint === startObserved.threadIdFingerprint), 5_000, "approval turn started on its route");
    assert.equal(startObserved.routeSocketId, startRequest.routeSocketId, "the turn identity must match the actual request route");
    assert.ok(turnStarted.turnIdFingerprint, "the approval turn must expose its actual turn identity fingerprint");
    row.checks.approvalUiVisibleForHeldMockTurn = true;
    row.checks.activeTurnRouteSocketId = turnStarted.routeSocketId;

    await stopButton.click();
    const interruptRequest = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-interrupt-request" && item.threadIdFingerprint === turnStarted.threadIdFingerprint && item.turnIdFingerprint === turnStarted.turnIdFingerprint), 10_000, "same-route turn/interrupt request");
    assert.equal(interruptRequest.routeSocketId, turnStarted.routeSocketId, "the stop gesture must interrupt the exact active turn on its owning route");
    const interruptResponse = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-interrupt-upstream-response" && item.rpcIdFingerprint === interruptRequest.rpcIdFingerprint && item.routeSocketId === turnStarted.routeSocketId && item.stage === interruptRequest.stage), 10_000, "upstream turn/interrupt response on the same route and scenario stage");
    assert.equal(interruptResponse.interrupted, true, "the isolated Gateway must acknowledge interruption of the active turn");
    assert.equal(interruptResponse.routeSocketId, turnStarted.routeSocketId, "the interrupt response must use the turn's owning route");
    assert.equal(interruptResponse.threadIdFingerprint, turnStarted.threadIdFingerprint, "the interrupt response must match the active thread");
    assert.equal(interruptResponse.turnIdFingerprint, turnStarted.turnIdFingerprint, "the interrupt response must match the active turn");
    const interruptForwarded = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "turn/interrupt" && item.rpcIdFingerprint === interruptRequest.rpcIdFingerprint && item.routeSocketId === turnStarted.routeSocketId && item.stage === interruptRequest.stage), 10_000, "turn/interrupt response forwarded on the same route and scenario stage");
    assert.equal(interruptForwarded.routeSocketId, turnStarted.routeSocketId, "the interrupt response delivered to the client must stay on the active turn route");
    const terminal = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/completed" && item.turnStatus === "interrupted" && item.routeSocketId === turnStarted.routeSocketId && item.threadIdFingerprint === turnStarted.threadIdFingerprint && item.turnIdFingerprint === turnStarted.turnIdFingerprint), 10_000, "same-route interrupted terminal notification");
    assert.ok(terminal.atMs >= interruptRequest.atMs, "the exact terminal notification must follow the stop request");
    assert.ok(terminal.atMs >= interruptForwarded.atMs, "the exact terminal notification must follow the interrupt response delivered to the client");
    await assertRunningControlsStayHiddenAfterTwoFrames(page, "same-route active-turn interrupt");
    row.checks = {
      ...row.checks,
      sameRouteInterruptRequestAndTerminal: true,
      interruptResponseAccepted: true,
      interruptResponseForwardedToClient: true,
      terminalStatus: terminal.turnStatus,
      terminalAfterInterruptMs: round(terminal.atMs - interruptRequest.atMs),
      exactThreadTurnRoute: {
        threadIdFingerprint: turnStarted.threadIdFingerprint,
        turnIdFingerprint: turnStarted.turnIdFingerprint,
        routeSocketId: turnStarted.routeSocketId,
      },
      runningControlsHiddenAfterTerminalAndTwoFrames: true,
    };
  });

  const receiptFixture = createAcceptedTurnReceiptFixture();
  const receiptScope = Object.freeze({});
  const startCountBeforeReceiptScenario = gatewayCalls.turnStart;
  const ackRow = await runCase("ack-loss-reconnect-exact-receipt", {
    testCapabilities: { turnReceiptsV1: true },
    receiptFixture,
    receiptScope,
    dropFirstResponseForMethod: "turn/start",
    closeAfterDroppedResponse: true,
  }, async (page, row) => {
    network.currentStage = `fault:${row.scenario}:send-and-drop-ack`;
    await openFixtureSession(page);
    const message = `PHONE_UX_ACK_FIXTURE_${Date.now()}`;
    await page.getByTestId("message-input").fill(message);
    await page.getByTestId("send-message").click();
    await waitFor(() => network.injectedWebSocketResponseDrops.find(item => item.scenario === row.scenario && item.method === "turn/start"), 15_000, "dropped isolated turn/start response");
    const dropped = network.injectedWebSocketResponseDrops.find(item => item.scenario === row.scenario && item.method === "turn/start");
    assert.equal(dropped.acceptedObservedFromMockGateway, true, "the dropped response must follow an actual successful isolated mock response");
    const readbackEvent = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-receipt-readback"), 25_000, "exact receipt readback after socket reconnect");
    assert.equal(readbackEvent.exactObservedAcceptanceMatched, true, "receipt readback must match the accepted thread/clientMessageId pair in this page scope");
    assert.notEqual(readbackEvent.routeSocketId, dropped.routeSocketId, "receipt readback must use the replacement WebSocket after the dropped-response close");
    await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 20_000 });
    const summary = receiptFixture.summary();
    assert.equal(summary.turnStartRequestCount, 1, "ACK recovery must not retry turn/start or create a new clientMessageId");
    assert.equal(summary.duplicatePairRequestCount, 0, "ACK recovery must not resubmit the same clientMessageId");
    assert.equal(summary.acceptedResponseCount, 1, "only the one successful mock response may populate the fixture receipt");
    assert.equal(summary.receiptReadCount, 1, "the client should read one receipt for the ambiguous start");
    assert.equal(summary.receiptMismatchCount, 0, "the receipt lookup must remain scoped to the exact accepted pair");
    assert.equal(summary.acceptedIdentityFingerprints.length, 1, "there must be exactly one accepted identity, without a replacement ID");
    assert.equal(summary.acceptedIdentityFingerprints[0].receiptReadOnDifferentRouteSocket, true, "readback should be correlated across the expected reconnect but within one scenario scope");
    row.checks = {
      ...row.checks,
      droppedResponseAfterObservedMockAcceptance: true,
      routeSocketClosedAfterDrop: true,
      reconnectReceiptReadbackExactPair: true,
      turnStartRequestsAcrossRecovery: summary.turnStartRequestCount,
      duplicatePairRequests: summary.duplicatePairRequestCount,
      acceptedResponseCount: summary.acceptedResponseCount,
      receiptReadCount: summary.receiptReadCount,
      receiptMismatchCount: summary.receiptMismatchCount,
      acceptedIdentityFingerprints: summary.acceptedIdentityFingerprints,
      crossRouteStopCoverage: "UNVERIFIED: isolated mock keeps activeTurn on the original socket; this receipt scenario does not claim replacement-route interruption",
      mockActiveTurnOwnerRouteSocketId: dropped.routeSocketId,
      receiptReadbackRouteSocketId: readbackEvent.routeSocketId,
    };
  });
  receiptSummary = receiptFixture.summary();
  if (ackRow) {
    ackRow.checks.turnStartRequestCountForScenario = gatewayCalls.turnStart - startCountBeforeReceiptScenario;
    assert.equal(ackRow.checks.turnStartRequestCountForScenario, 1, "exact receipt recovery must not send a second turn/start");
  }

  await runCase("websocket-disconnect-and-reconnect", {
    disconnectAfterMethodResponse: "thread/read",
  }, async (page, row) => {
    network.currentStage = `fault:${row.scenario}:task-entry`;
    const priorSocketIds = new Set(network.routedWebSocketConnections.map(item => item.id));
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    const readResponse = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "thread/read" && item.stage === `fault:${row.scenario}:task-entry`), 15_000, "thread/read response before forced disconnect");
    const reconnectInitialize = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "initialize" && item.routeSocketId !== readResponse.routeSocketId && !priorSocketIds.has(item.routeSocketId) && item.stage === `fault:${row.scenario}:task-entry`), 25_000, "initialize request on replacement WebSocket");
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
    const disconnectObserved = network.faultFixtureEvents.some(item => item.scenario === row.scenario && item.kind === "socket-closed-after-response" && item.method === "thread/read");
    assert.equal(disconnectObserved, true, "fixture must record the intentional WebSocket close after thread/read");
    row.checks = {
      ...row.checks,
      socketClosedAfterThreadRead: true,
      replacementInitializeObserved: Boolean(reconnectInitialize),
      historyStillVisible: true,
    };
  });

  const jitterSequence = [0, 100, 900, 300, 600];
  const jitter = createResponseJitter({
    http: { "/api/servers/status": jitterSequence },
    rpc: { "thread/read": jitterSequence },
  });
  await runCase("response-jitter-30", { responseJitter: jitter }, async (_unused, row) => {
    const pageSamples = [];
    const pairingSetupStage = `fault:${row.scenario}:pairing-setup`;
    let pairedProfileStorageState;
    let pairingPage;
    const pairingLoginResponses = [];
    let removePairingLoginObserver = () => {};
    network.currentStage = pairingSetupStage;
    try {
      pairingPage = await newMobilePage(chromium, network, { delayMs: 0, scenarioId: row.scenario }, gatewayCalls, browserErrors, context);
      removePairingLoginObserver = observeLoginResponses(pairingPage, pairingLoginResponses, pairingSetupStage, "setup");
      await connectMobile(pairingPage, gateway);
      await waitForGatewayRpcQuiescence(network, 15_000, 100);
      const pairingSessionRows = network.httpResponsePathDelays.filter(item => item.scenario === row.scenario && item.stage === pairingSetupStage && item.apiPath === "/api/mobile/session");
      assert.equal(pairingSessionRows.length, 1, "jitter setup must perform exactly one Mobile Gateway pairing");
      assert.equal(pairingSessionRows[0].status, 200, "jitter setup pairing must be accepted before repeated samples");
      pairedProfileStorageState = await pairingPage.context().storageState();
      await context.writeArtifactJson("phone-ux-jitter-pairing-setup.json", {
        schemaVersion: 1,
        scenario: row.scenario,
        status: "PASS",
        sampleClass: "single pairing setup; excluded from the 30 jitter page samples",
        pairingCount: pairingSessionRows.length,
        pairingResponseStatus: pairingSessionRows[0].status,
        profileStateLocation: "private in-memory Playwright storageState; never serialized to artifacts",
        loginResponses: pairingLoginResponses,
      });
    } catch (error) {
      const pageAtFailure = pairingPage && !pairingPage.isClosed() ? await describeVisiblePage(pairingPage).catch(() => null) : null;
      const screenshot = pairingPage && !pairingPage.isClosed()
        ? await capturePrivateFailureScreenshot(context, pairingPage, "phone-ux-jitter-pairing-setup-failure.png")
        : { artifact: null, status: "page-unavailable" };
      await context.writeArtifactJson("phone-ux-jitter-pairing-setup.json", {
        schemaVersion: 1,
        scenario: row.scenario,
        status: "FAIL",
        sampleClass: "single pairing setup; excluded from the 30 jitter page samples",
        profileStateLocation: "private in-memory Playwright storageState; never serialized to artifacts",
        pageAtFailure,
        loginResponses: pairingLoginResponses,
        apiResponses: network.httpResponsePathDelays
          .filter(item => item.scenario === row.scenario && item.stage === pairingSetupStage)
          .map(summarizeHttpDelaySample),
        screenshot,
        error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 700),
      });
      throw error;
    } finally {
      removePairingLoginObserver();
      if (pairingPage) await closeOwnedMobilePage(pairingPage).catch(() => {});
    }
    row.checks.pairingSetup = {
      pairingCount: 1,
      pairingSetupSampleExcludedFromJitterN30: true,
      profileStateReusedInMemory: true,
      repeatedSamplesUseFreshBrowserContexts: true,
    };

    for (let index = 0; index < 30; index += 1) {
      const sampleId = String(index + 1).padStart(2, "0");
      const stage = `fault:${row.scenario}:sample-${sampleId}`;
      network.currentStage = stage;
      let page;
      const loginResponses = [];
      const failedRequestPaths = [];
      let removeLoginObserver = () => {};
      const failedRequestObserver = request => failedRequestPaths.push(safePath(request.url()));
      const sampleStartedAt = performance.now();
      let sampleResult = {
        schemaVersion: 1,
        scenario: row.scenario,
        sampleId,
        status: "RUNNING",
        sampleClass: "cold runtime in fresh BrowserContext with the single paired profile restored",
        pairingCountForThisSample: 0,
        profileStateLocation: "private in-memory Playwright storageState; never serialized to artifacts",
        stage,
        homeNavigation: null,
        homeReadyMs: null,
        clickToHistoryVisibleMs: null,
      };
      let sampleError = null;
      try {
        page = await newMobilePage(chromium, network, { delayMs: 0, scenarioId: row.scenario, responseJitter: jitter }, gatewayCalls, browserErrors, context, pairedProfileStorageState);
        removeLoginObserver = observeLoginResponses(page, loginResponses, stage, sampleId);
        page.on("requestfailed", failedRequestObserver);
        const homeNavigationStartedAt = performance.now();
        const homeResponse = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
        page.__phoneUxLastNavigationStatus = homeResponse?.status() ?? null;
        const homeNavigation = { path: safePath(homeResponse?.url() ?? page.url()), status: homeResponse?.status() ?? null };
        sampleResult.homeNavigation = homeNavigation;
        assert.equal(homeResponse?.status(), 200, "paired profile should restore the isolated Gateway home");
        await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });
        await ensureFixtureSessionVisible(page);
        const homeReadyMs = round(performance.now() - homeNavigationStartedAt);
        sampleResult.homeReadyMs = homeReadyMs;
        await waitForGatewayRpcQuiescence(network, 15_000, 100);
        const repeatedPairingRows = network.httpResponsePathDelays.filter(item => item.scenario === row.scenario && item.stage === stage && item.apiPath === "/api/mobile/session");
        assert.equal(repeatedPairingRows.length, 0, `jitter sample ${sampleId} must reuse the one paired profile without another pairing request`);
        const clickStartedAt = performance.now();
        await page.getByTestId(`thread-${THREAD_ID}`).click();
        await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
        const clickToHistoryVisibleMs = round(performance.now() - clickStartedAt);
        sampleResult.clickToHistoryVisibleMs = clickToHistoryVisibleMs;
        await waitForGatewayRpcQuiescence(network, 15_000, 100);
        const statusRows = network.httpResponsePathDelays.filter(item => item.scenario === row.scenario && item.stage === stage && item.apiPath === "/api/servers/status");
        const readRows = network.websocketResponsePathDelays.filter(item => item.scenario === row.scenario && item.stage === stage && item.method === "thread/read");
        assert.ok(statusRows.length > 0, `jitter sample ${sampleId} must include a completed HTTP status response`);
        assert.ok(readRows.length > 0, `jitter sample ${sampleId} must include a completed thread/read response`);
        for (const sample of statusRows) {
          assert.ok(Number.isFinite(sample.jitterDelayMs) && jitterSequence.includes(sample.jitterDelayMs), `jitter sample ${sampleId} HTTP delay must be one of the configured fixture values`);
          assert.equal(sample.configuredDelayMs, sample.jitterDelayMs, `jitter sample ${sampleId} HTTP configured delay must preserve its fixture value`);
          assertApplicationDelay(sample, sample.jitterDelayMs, `jitter sample ${sampleId} HTTP application response hold`);
        }
        for (const sample of readRows) {
          assert.ok(Number.isFinite(sample.jitterDelayMs) && jitterSequence.includes(sample.jitterDelayMs), `jitter sample ${sampleId} WSS delay must be one of the configured fixture values`);
          assert.equal(sample.configuredDelayMs, sample.jitterDelayMs, `jitter sample ${sampleId} WSS configured delay must preserve its fixture value`);
          assertApplicationDelay(sample, sample.jitterDelayMs, `jitter sample ${sampleId} WSS application response hold`);
        }
        sampleResult = {
          ...sampleResult,
          status: "PASS",
          homeNavigation,
          homeReadyMs,
          taskShellVisible: true,
          historyFirstMessageVisible: true,
          clickToHistoryVisibleMs,
          httpRequests: network.httpRouteRequests
            .filter(item => item.scenario === row.scenario && item.stage === stage)
            .map(item => ({ path: sanitizeGatewayPath(item.apiPath ?? item.path), method: item.method })),
          httpStatusResponses: statusRows.map(summarizeHttpDelaySample),
          webSocketRequests: network.rpcEvents
            .filter(item => item.scenario === row.scenario && item.stage === stage && item.direction === "request")
            .map(item => ({ path: sanitizeGatewayPath(item.path), method: item.method, routeSocketId: item.routeSocketId })),
          threadReadResponses: readRows.map(summarizeWebSocketDelaySample),
          loginResponses,
          failedRequestPaths,
          elapsedMs: round(performance.now() - sampleStartedAt),
        };
        await context.writeArtifactJson(`phone-ux-jitter-sample-${sampleId}.json`, sampleResult);
        pageSamples.push({ sampleIndex: index, sampleId, stage, homeReadyMs, clickToHistoryVisibleMs, httpStatusResponses: statusRows.length, threadReadResponses: readRows.length });
      } catch (error) {
        sampleError = error;
        const pageAtFailure = page && !page.isClosed() ? await describeVisiblePage(page).catch(() => null) : null;
        const screenshot = page && !page.isClosed()
          ? await capturePrivateFailureScreenshot(context, page, `phone-ux-jitter-sample-${sampleId}-failure.png`)
          : { artifact: null, status: "page-unavailable" };
        sampleResult = {
          ...sampleResult,
          status: "FAIL",
          completedDomSamplesBeforeThisSample: pageSamples.length,
          pageAtFailure,
          loginResponses,
          failedRequestPaths,
          httpRequests: network.httpRouteRequests
            .filter(item => item.scenario === row.scenario && item.stage === stage)
            .map(item => ({ path: sanitizeGatewayPath(item.apiPath ?? item.path), method: item.method })),
          httpResponses: network.httpResponsePathDelays
            .filter(item => item.scenario === row.scenario && item.stage === stage)
            .map(summarizeHttpDelaySample),
          webSocketRequests: network.rpcEvents
            .filter(item => item.scenario === row.scenario && item.stage === stage && item.direction === "request")
            .map(item => ({ path: sanitizeGatewayPath(item.path), method: item.method, routeSocketId: item.routeSocketId })),
          webSocketResponses: network.websocketResponsePathDelays
            .filter(item => item.scenario === row.scenario && item.stage === stage)
            .map(summarizeWebSocketDelaySample),
          screenshot,
          error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 700),
          elapsedMs: round(performance.now() - sampleStartedAt),
        };
        await context.writeArtifactJson(`phone-ux-jitter-sample-${sampleId}.json`, sampleResult);
      } finally {
        removeLoginObserver();
        if (page) {
          page.off("requestfailed", failedRequestObserver);
          await closeOwnedMobilePage(page).catch(() => {});
        }
      }
      if (sampleError) throw sampleError;
    }
    const jitterSampleStage = item => item.scenario === row.scenario && /^fault:response-jitter-30:sample-\d+$/.test(item.stage);
    const httpRows = network.httpResponsePathDelays.filter(item => jitterSampleStage(item) && item.apiPath === "/api/servers/status");
    const rpcRows = network.websocketResponsePathDelays.filter(item => jitterSampleStage(item) && item.method === "thread/read");
    assert.equal(pageSamples.length, 30, "the jitter scenario must retain exactly thirty completed browser samples");
    assert.ok(httpRows.length >= 30, `only ${httpRows.length} completed status responses received jitter`);
    assert.ok(rpcRows.length >= 30, `only ${rpcRows.length} completed thread/read responses received jitter`);
    const applied = rows => rows.map(item => item.appliedDelayMs).filter(Number.isFinite).sort((a, b) => a - b);
    const historySamples = pageSamples.map(item => item.clickToHistoryVisibleMs).sort((a, b) => a - b);
    row.checks = {
      ...row.checks,
      requiredPageSamples: 30,
      completedPageSamples: pageSamples.length,
      pageSampleErrorCount: 0,
      clickToHistoryVisibleP50P95Ms: { p50: percentile(historySamples, 0.5), p95: percentile(historySamples, 0.95) },
      httpStatusResponseSamples: httpRows.length,
      websocketThreadReadResponseSamples: rpcRows.length,
      applicationDelayTimerToleranceMs: APPLICATION_DELAY_TIMER_TOLERANCE_MS,
      httpConfiguredJitterMs: distribution(httpRows.map(item => item.jitterDelayMs)),
      websocketConfiguredJitterMs: distribution(rpcRows.map(item => item.jitterDelayMs)),
      httpAppliedDelayP50P95Ms: { p50: percentile(applied(httpRows), 0.5), p95: percentile(applied(httpRows), 0.95) },
      websocketAppliedDelayP50P95Ms: { p50: percentile(applied(rpcRows), 0.5), p95: percentile(applied(rpcRows), 0.95) },
      pageSamples,
      delayDefinition: "configured HTTP/WSS response-path extra delay, not RTT, packet loss, or native radio network latency",
    };
  }, { skipPageSetup: true });

  await runCase("refresh-send-background-return-n30", {}, async (_unused, row) => {
    assert.equal(sampleCount, refreshHomeMinuteBoundaryDiagnosticMode ? 2 : refreshSingleSampleMode ? 1 : DEFAULT_SAMPLES, refreshHomeMinuteBoundaryDiagnosticMode
      ? "the selected Home minute-boundary diagnostic requires exactly two Home samples"
      : refreshSingleSampleMode
        ? "single-sample refresh diagnostic requires exactly one sample per selected action and delay bin"
        : "refresh/send/background formal coverage requires thirty samples per action and delay bin");
    assert.deepEqual(
      delayValues,
      refreshDiagnosticMode ? [600] : refreshSmokeMode ? [0] : DEFAULT_DELAYS,
      refreshSendDiagnosticMode
        ? "accepted-600 diagnostic requires only the 600ms mock ACK hold"
        : refreshHomeMinuteBoundaryDiagnosticMode
          ? refreshHomeMinuteBoundarySamplesOnlyMode
            ? "the two Home samples-only minute-boundary diagnostic requires only the 600ms /api/servers response hold"
            : "the 35-cycle auth gate plus two Home minute-boundary samples require only the 600ms /api/servers response hold"
          : refreshBackgroundDiagnosticMode
            ? "home-600 diagnostic requires only the 600ms /api/servers response hold"
        : refreshSmokeMode
          ? "refresh smoke requires only the zero-delay functional check"
          : "refresh/send/background formal coverage requires the 0/300/600/1000ms delay bins",
    );

    let pairedProfileStorageState;
    let pairingPage;
    let bootstrapAuth = null;
    let bootstrapAuthCleanup = null;
    const sharedDiagnosticContext = refreshSharedBackgroundDiagnosticMode ? chromium.defaultContext : null;
    const backgroundVisibilityHelper = refreshBackgroundHost?.visibilityHelper ?? null;
    const mobilePageOptions = refreshSharedBackgroundDiagnosticMode
      ? { browserContext: sharedDiagnosticContext, applyMobileEmulation: true, prepareViewportDocument: true }
      : undefined;
    if (refreshHomeMinuteBoundaryDiagnosticMode) {
      row.checks.pairing = {
        status: "PER_SAMPLE_REQUIRED",
        bootstrapPairingCount: 0,
        setupExcludedFromSamples: true,
        profileStorageState: "no bootstrap profile; each Home diagnostic sample pairs in its own fresh owned BrowserContext",
        sampleContexts: "two sequential Home diagnostics each use a fresh owned Chromium/default context and a separately paired, revoked device grant",
        backgroundPairingPolicy: refreshHomeMinuteBoundarySamplesOnlyMode
          ? "the separate 35-cycle auth gate is NOT_RUN in this RunContext; each of the two fresh Home sample pairs exact-revokes and logs out before the next"
          : "the 35-cycle auth gate is followed by two fresh Home sample pairs; each sample exact-revokes and logs out before the next",
        bootstrapAuthCleanup: null,
        formalOwnedAuthLifecycle: null,
      };
    } else {
    const pairingStage = `fault:${row.scenario}:pairing-setup`;
    network.currentStage = pairingStage;
    try {
      pairingPage = await newMobilePage(
        chromium,
        network,
        { delayMs: 0, scenarioId: row.scenario, httpPathDelayMs: {}, methodResponseHoldMs: {} },
        gatewayCalls,
        browserErrors,
        context,
        undefined,
        mobilePageOptions,
      );
      if (formalOwnedAuthLifecycle || refreshHomeMinuteBoundaryDiagnosticMode) {
        const beforePair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
        assert.equal(beforePair.active, 0, "owned-auth pairing must start with no active device grants");
        bootstrapAuth = observeOwnedMobileAuth(pairingPage, context);
      }
      if (refreshSharedBackgroundDiagnosticMode) assert.equal(pairingPage.context(), sharedDiagnosticContext, "pairing page must use the one noDefaults BrowserContext");
      await connectMobile(pairingPage, gateway);
      if (bootstrapAuth) {
        await bootstrapAuth.waitForPair();
        const afterPair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
        assert.equal(afterPair.active, 1, "the formal bootstrap pair must create exactly one owned active device grant");
      }
      await waitForGatewayRpcQuiescence(network, 15_000, 100);
      if (!refreshBackgroundDiagnosticMode && !formalOwnedAuthLifecycle) pairedProfileStorageState = await pairingPage.context().storageState();
    } finally {
      if (bootstrapAuth && pairingPage) {
        try {
          bootstrapAuthCleanup = await releaseOwnedMobileAuthSample(pairingPage, gateway, bootstrapAuth, context);
        } catch (error) {
          bootstrapAuthCleanup = {
            status: "FAIL",
            failures: ["cleanup-helper-error"],
            error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 400),
          };
        }
      }
      if (pairingPage) {
        if (refreshSharedBackgroundDiagnosticMode) await closeRefreshDiagnosticMobilePage(pairingPage);
        else await closeOwnedMobilePage(pairingPage).catch(() => {});
      }
    }
    if (bootstrapAuthCleanup) assert.equal(bootstrapAuthCleanup.status, "PASS", "formal bootstrap auth must be revoked/logged out before its BrowserContext closes");
    row.checks.pairing = {
      status: "PASS",
      bootstrapPairingCount: 1,
      setupExcludedFromSamples: true,
      profileStorageState: refreshSharedBackgroundDiagnosticMode
        ? "same owned noDefaults default BrowserContext localStorage; no storageState export"
        : refreshHomeMinuteBoundaryDiagnosticMode
          ? "each Home diagnostic sample performs a fresh UI pair in its own owned Chromium context; no storageState export"
        : formalOwnedAuthLifecycle
          ? "formal samples use fresh per-sample UI login/pair; no bootstrap profile is reused"
          : "in-memory Playwright state only; not written to artifacts",
      sampleContexts: refreshSharedBackgroundDiagnosticMode
        ? "single diagnostic page and pairing share the one noDefaults default BrowserContext"
        : refreshHomeMinuteBoundaryDiagnosticMode
          ? "two sequential Home diagnostics each use a fresh owned Chromium/default context and a separately paired, revoked device grant"
        : formalOwnedAuthLifecycle
          ? "background: one freshly paired owned Chromium/default context per sample; send: one fresh BrowserContext paired independently per sample"
          : "background: one freshly paired owned Chromium/default context per sample; send: one fresh BrowserContext per sample restored from in-memory paired profile",
      backgroundPairingPolicy: refreshSharedBackgroundDiagnosticMode
        ? "one selected home-600 diagnostic sample reuses its paired default context"
        : refreshHomeMinuteBoundaryDiagnosticMode
          ? refreshHomeMinuteBoundarySamplesOnlyMode
            ? "the separate 35-cycle auth gate is NOT_RUN in this RunContext; each of the two fresh Home sample pairs exact-revokes and logs out before the next"
            : "the 35-cycle auth gate is followed by two fresh Home sample pairs; each sample exact-revokes and logs out before the next"
        : formalOwnedAuthLifecycle
          ? "every formal Home/Task/accepted/rejected sample uses a fresh owned pair and exact grant+web-session cleanup before the next sample"
          : "each Home/Task background sample is paired independently in its fresh noDefaults default context; bootstrap storageState is used only for send samples",
      formalOwnedAuthLifecycle: formalOwnedAuthLifecycle ? {
        status: "PER_SAMPLE_REQUIRED",
        bootstrapAuthCleanup,
        cleanupContract: "exact observed mobile access token DELETE 204; exact BrowserContext web cookie POST /logout 303; stale cookie protected request 401; owned device store active count 0 before context close",
      } : null,
    };
    }


    const allGroups = [
      { id: "home-resume-list-retention", kind: "background", apiPath: "/api/servers", view: "home" },
      { id: "task-resume-history-retention", kind: "background", apiPath: "/api/servers/status", view: "task" },
      { id: "send-pending-accepted", kind: "accepted-send" },
      { id: "send-rejected-draft-retained", kind: "rejected-send" },
    ];
    const groups = refreshSendDiagnosticMode
      ? allGroups.filter(item => item.id === "send-pending-accepted")
      : refreshBackgroundDiagnosticMode
        ? allGroups.filter(item => item.id === "home-resume-list-retention")
      : allGroups;
    if (refreshSmokeMode) {
      assert.deepEqual(groups.map(item => item.id), [
        "home-resume-list-retention",
        "task-resume-history-retention",
        "send-pending-accepted",
        "send-rejected-draft-retained",
      ], "zero-delay smoke must exercise all four actions");
    }
    assert.equal(groups.length, refreshDiagnosticMode ? 1 : allGroups.length, "a single-action diagnostic must run only its selected action group");
    const groupResults = [];
    let totalFailedSamples = 0;
    let backgroundSamplePairingCount = 0;
    let formalAuthSampleCount = 0;
    let formalAuthCleanupCount = 0;
    let formalMaxActiveDeviceGrants = 0;
    let previousMinuteBoundaryHookToRequestMs = null;
    const progressWriter = createRefreshProgressWriter((name, value) => context.writeArtifactJson(name, value));

    await progressWriter.write({
      schemaVersion: 1,
      scenario: row.scenario,
      status: "RUNNING",
      backgroundWindowSetup: refreshBackgroundWindowMode ? {
        hostStartupMs: refreshBackgroundHost?.setupElapsedMs ?? null,
        xvfbPid: refreshBackgroundHost?.display?.child?.pid ?? null,
        openboxPid: refreshBackgroundHost?.openbox?.pid ?? null,
        display: refreshBackgroundHost?.display?.display ?? null,
        policy: "one RunContext-owned Xvfb/Openbox host; a fresh owned noDefaults Chromium/default context per Home/Task sample",
      } : null,
      currentAction: null,
      currentDelayMs: null,
      attemptedSamplesInCurrentBin: 0,
      requiredSamplesPerBin: sampleCount,
      failedSamples: 0,
      completedGroups: [],
      currentBin: [],
      delayBins: delayValues,
      actionIds: groups.map(item => item.id),
      coverageMode: refreshCoverageMode,
      formalN30Coverage: !refreshSingleSampleMode,
      noProviderConfigured: true,
      gatewayEvidenceClass: "KCODER_STUDIO_MOCK; JS runMock except the explicit test-generated error fixture",
    });

    for (const group of groups) {
      const delayResults = [];
      for (const delayMs of delayValues) {
        const sampleResults = [];
        for (let index = 0; index < sampleCount; index += 1) {
          const sampleId = String(index + 1).padStart(2, "0");
          const stage = `fault:${row.scenario}:${group.id}:delay-${delayMs}:sample-${sampleId}`;
          const actionId = `${group.id}:delay-${delayMs}:sample-${sampleId}`;
          network.currentStage = stage;
          network.currentActionId = actionId;
          const sampleControl = {
            delayMs: 0,
            scenarioId: row.scenario,
            httpPathDelayMs: {},
            methodResponseHoldMs: {},
            ...(group.kind === "rejected-send" ? { turnStartErrorFixture: true } : {}),
          };
          const receiptFixture = group.kind === "accepted-send" ? createAcceptedTurnReceiptFixture() : null;
          if (receiptFixture) {
            sampleControl.receiptFixture = receiptFixture;
            sampleControl.receiptScope = {};
          }
          const sampleLifecycleStartedAt = performance.now();
          const sampleResult = {
            schemaVersion: 1,
            scenario: row.scenario,
            action: group.id,
            delayMs,
            sampleId,
            stage,
            actionId,
            status: "RUNNING",
            coverageMode: refreshCoverageMode,
            formalN30Coverage: !refreshSingleSampleMode,
            diagnosticId: refreshSendDiagnosticMode ? refreshSendDiagnostic : refreshBackgroundDiagnosticMode ? refreshBackgroundDiagnosticId : null,
            evidenceClass: group.kind === "background"
              ? "real Mobile Web UI through isolated KCODER_STUDIO_MOCK Gateway; one fresh owned Chromium default context per background sample, actual window minimize/restore with trusted visibility, no Provider/model"
              : group.kind === "rejected-send"
              ? "real Mobile Web TaskRuntime plus test-generated request-id-correlated JSON-RPC error in Playwright WebSocket route; bypasses KCODER_STUDIO_MOCK runMock and is not Rust app-server rejection"
              : "real Mobile Web UI/TaskRuntime plus isolated KCODER_STUDIO_MOCK Gateway; no Provider configured or invoked",
            configuredHold: null,
            visibility: null,
            setupTimingsMs: {
              sharedWindowHostStartup: group.kind === "background" ? refreshBackgroundHost?.setupElapsedMs ?? null : null,
              sharedHostStartedBeforeSample: group.kind === "background" && refreshBackgroundHost !== null,
            },
            timingsMs: {},
          };
          let page;
          let sampleAuth = null;
          let sampleChromium = chromium;
          let ownsSampleChromium = false;
          let measurementStartedAt = null;
          if (group.kind === "background" && refreshSharedBackgroundDiagnosticMode) {
            sampleResult.backgroundBrowser = {
              instanceKey: "home-600-diagnostic",
              pid: chromium.child.pid,
              cdpPort: chromium.cdpPort,
              display: chromium.display,
              noDefaults: true,
              freshDefaultContext: true,
              pairingAndStartupExcludedFromMeasuredIntervals: true,
            };
            sampleResult.setupTimingsMs.ownedChromiumStartup = chromium.startupElapsedMs;
            sampleResult.setupTimingsMs.pairingAndHomeReadyMs = null;
            sampleResult.sharedDiagnosticPairingCompletedBeforeSample = true;
          }
          let sampleError = null;
          try {
            if (group.kind === "background" && !refreshSharedBackgroundDiagnosticMode) {
              const instanceKey = `${group.id}-d${delayMs}-s${sampleId}`;
              sampleChromium = await startRefreshBackgroundChromium(context, { host: refreshBackgroundHost, instanceKey });
              ownsSampleChromium = true;
              sampleResult.setupTimingsMs.ownedChromiumStartup = sampleChromium.startupElapsedMs;
              assert.equal(sampleChromium.browser.contexts().length, 1, "each background sample must use a fresh Chromium with one default BrowserContext");
              assert.equal(sampleChromium.defaultContext, sampleChromium.browser.contexts()[0], "each background sample must use the first and only noDefaults BrowserContext");

              const pairingStage = `${stage}:pairing-setup`;
              network.currentStage = pairingStage;
              network.currentActionId = `${actionId}:pairing-setup`;
              const pageSetupStartedAt = performance.now();
              page = await newMobilePage(
                sampleChromium,
                network,
                sampleControl,
                gatewayCalls,
                browserErrors,
                context,
                null,
                { browserContext: sampleChromium.defaultContext, applyMobileEmulation: true, prepareViewportDocument: true },
              );
              assert.equal(page.context(), sampleChromium.defaultContext, "background sample page must belong to its fresh default BrowserContext");
              sampleResult.setupTimingsMs.mobilePageSetup = round(performance.now() - pageSetupStartedAt);
              const pairingStartedAt = performance.now();
              if (refreshPerSampleAuthCleanupMode) {
                const beforePair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
                assert.equal(beforePair.active, 0, "the previous owned sample must release its device grant before the next pair");
                sampleAuth = observeOwnedMobileAuth(page, context);
                formalAuthSampleCount += 1;
              }
              await connectMobile(page, gateway);
              if (sampleAuth) {
                await sampleAuth.waitForPair();
                const afterPair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
                assert.equal(afterPair.active, 1, "each formal background pair must be the only active device grant");
                formalMaxActiveDeviceGrants = Math.max(formalMaxActiveDeviceGrants, afterPair.active);
              }
              await waitForGatewayRpcQuiescence(network, 15_000, 100);
              backgroundSamplePairingCount += 1;
              sampleResult.setupTimingsMs.pairingAndHomeReady = round(performance.now() - pairingStartedAt);
              sampleResult.backgroundBrowser = {
                instanceKey,
                pid: sampleChromium.child.pid,
                cdpPort: sampleChromium.cdpPort,
                display: sampleChromium.display,
                noDefaults: true,
                freshDefaultContext: true,
                pairingAndStartupExcludedFromMeasuredIntervals: true,
              };
              network.currentStage = stage;
              network.currentActionId = actionId;
            } else {
              page = await newMobilePage(
                chromium,
                network,
                sampleControl,
                gatewayCalls,
                browserErrors,
                context,
                formalOwnedAuthLifecycle ? undefined : pairedProfileStorageState,
                mobilePageOptions,
              );
              if (refreshSharedBackgroundDiagnosticMode && group.kind === "background") assert.equal(page.context(), sharedDiagnosticContext, "diagnostic sample page must use the same noDefaults BrowserContext as pairing");
              if (refreshPerSampleAuthCleanupMode) {
                const beforePair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
                assert.equal(beforePair.active, 0, "the previous owned sample must release its device grant before the next pair");
                sampleAuth = observeOwnedMobileAuth(page, context);
                formalAuthSampleCount += 1;
                const pairingStage = `${stage}:pairing-setup`;
                network.currentStage = pairingStage;
                network.currentActionId = `${actionId}:pairing-setup`;
                const pairingStartedAt = performance.now();
                await connectMobile(page, gateway);
                await sampleAuth.waitForPair();
                const afterPair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
                assert.equal(afterPair.active, 1, "each formal send pair must be the only active device grant");
                formalMaxActiveDeviceGrants = Math.max(formalMaxActiveDeviceGrants, afterPair.active);
                await waitForGatewayRpcQuiescence(network, 15_000, 100);
                sampleResult.setupTimingsMs.pairingAndHomeReady = round(performance.now() - pairingStartedAt);
                network.currentStage = stage;
                network.currentActionId = actionId;
              } else {
                const homeResponse = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
                page.__phoneUxLastNavigationStatus = homeResponse?.status() ?? null;
                assert.equal(homeResponse?.status(), 200, "paired profile must restore the isolated Gateway Home");
                await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
                await ensureFixtureSessionVisible(page);
                await waitForGatewayRpcQuiescence(network, 15_000, 100);
              }
            }

            // Prime after either pairing/setup branch has joined so the fixture response uses the sample stage.
            if (refreshHomeMinuteBoundaryDiagnosticMode && group.kind === "background" && group.view === "home") {
              sampleResult.minuteBoundaryFixturePriming = {
                stage,
                reloadAfterPair: true,
                purpose: "make the exact Home sample stage own the timestamped thread/list baseline",
              };
              await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
              await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });
              await page.getByTestId(`toggle-server-${SERVER_ID}`).waitFor({ state: "visible", timeout: 10_000 });
              await page.getByTestId(`thread-${THREAD_ID}`).waitFor({ state: "visible", timeout: 10_000 });
              await waitForGatewayRpcQuiescence(network, 15_000, 100);
            }

            if (group.kind === "background") {
              let initialMessageText = null;
              if (group.view === "task") {
                await openFixtureSession(page);
                await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
                const firstMessage = page.getByTestId("message-user").first();
                await firstMessage.waitFor({ state: "visible", timeout: 10_000 });
                initialMessageText = await firstMessage.innerText();
                sampleResult.initialHistoryTextFingerprint = sha256(initialMessageText).slice(0, 16);
              } else {
                const homeThreadRow = page.getByTestId(`thread-${THREAD_ID}`);
                await page.getByTestId(`toggle-server-${SERVER_ID}`).waitFor({ state: "visible", timeout: 10_000 });
                await homeThreadRow.waitFor({ state: "visible", timeout: 10_000 });
                const initialHomeThreadPresentation = await captureHomeThreadPresentation(page, network, stage, expectedWorkspace);
                if (refreshHomeMinuteBoundaryDiagnosticMode) {
                  assert.equal(initialHomeThreadPresentation.relativeTimeText, "1 分钟", "each controlled Home sample must start with the fixture row rendered at one minute");
                }
                sampleResult.initialHomeThreadTextFingerprint = sha256(initialHomeThreadPresentation.rowText).slice(0, 16);
                sampleResult.initialHomeThreadContentFingerprint = sha256(normalizeHomeThreadRowText(initialHomeThreadPresentation));
                sampleResult.homeThreadPresentation = { before: initialHomeThreadPresentation, during: null, after: null };
                sampleResult.homeThreadPresentationChecks = { beforeToDuring: null, beforeToAfter: null };
              }
              await waitForGatewayRpcQuiescence(network, 15_000, 100);
              const visibility = await backgroundVisibilityHelper.captureWindowMinimizeVisibilityCycle(page, {
                timeoutMs: 5_000,
                pollIntervalMs: 20,
                beforeMinimize: async () => {
                  const armed = await drainAndArmBackgroundHttpResponseHold({
                    waitForQuiescence: () => waitForGatewayRpcQuiescence(network, 15_000, 100),
                    sampleControl,
                    apiPath: group.apiPath,
                    delayMs,
                  });
                  sampleResult.preMinimizeQuiescence = armed.quiescence;
                  assert.equal(armed.status, "ARMED", "HTTP hold must only arm after Gateway HTTP and RPC activity is drained");
                  sampleResult.configuredHold = {
                    layer: "HTTP response path",
                    path: group.apiPath,
                    delayMs,
                    armedAfterQuiescence: true,
                    definition: "one-way application response hold after Gateway route fetch; not RTT or packet loss",
                  };
                  sampleResult.measurementOrigin = "after pre-minimize quiescence and hold arming; action intervals use actual trusted window/HTTP request timestamps, excluding browser startup and pairing";
                  if (refreshHomeMinuteBoundaryDiagnosticMode && group.view === "home") {
                    const fixture = sampleResult.homeThreadPresentation.before.fixture;
                    const boundary = fixture.minuteBoundary;
                    assert.ok(boundary && Number.isFinite(boundary.transitionEpochMs), "the controlled thread/list fixture must publish its exact minute-transition target");
                    const requestLeadMs = previousMinuteBoundaryHookToRequestMs === null
                      ? REFRESH_HOME_MINUTE_BOUNDARY_FIRST_REQUEST_LEAD_MS
                      : previousMinuteBoundaryHookToRequestMs + REFRESH_HOME_MINUTE_BOUNDARY_REQUEST_LEAD_MARGIN_MS;
                    const waitMs = Math.max(0, boundary.transitionEpochMs - epochNow() - requestLeadMs);
                    if (waitMs > 0) await new Promise(resolveWait => setTimeout(resolveWait, waitMs));
                    sampleResult.homeMinuteBoundary = {
                      fixtureUpdatedAtEpochMs: fixture.updatedAt,
                      relativeTimeLabelBefore: sampleResult.homeThreadPresentation.before.relativeTimeText,
                      expectedLabelBefore: "1 分钟",
                      expectedLabelAfter: sampleResult.sampleId === "02" ? "2 分钟" : null,
                      targetTransitionEpochMs: boundary.transitionEpochMs,
                      updatedAtControl: "test-only WebSocket mock response timestamp; application Date.now is unmodified",
                      plannedRequestLeadMs: requestLeadMs,
                      waitedBeforeVisibilityCycleMs: round(waitMs),
                      beforeMinimizeHookCompletedAtEpochMs: round(epochNow()),
                      requestStartedAtEpochMs: null,
                      responseForwardedAtEpochMs: null,
                      holdStraddledTransition: false,
                      relativeTimeChangedAfterResponse: false,
                    };
                  }
                  sampleResult.measurementStartMonotonicMs = round(performance.now());
                  sampleResult.measurementClock = "Node monotonic; not compared directly with Chromium event epoch timestamps";
                  sampleResult.setupTimingsMs.preMeasurementReady = round(performance.now() - sampleLifecycleStartedAt);
                  measurementStartedAt = performance.now();
                },
                prepareCompanionPage: async companionPage => {
                  const companionEmulation = await applyRefreshBackgroundMobileEmulation(companionPage);
                  sampleResult.companionMobileFacts = { facts: companionEmulation.facts, gate: companionEmulation.gate, detachStatus: "pending" };
                  return async () => {
                    await companionEmulation.session.detach();
                    companionEmulation.detached = true;
                    sampleResult.companionMobileFacts.detachStatus = "acknowledged";
                  };
                },
              });
              sampleResult.visibility = visibility;
              const mainMobileRecord = REFRESH_BACKGROUND_MOBILE_SESSIONS.get(page);
              sampleResult.mainMobileFactsBeforeTransition = mainMobileRecord?.facts ?? null;
              sampleResult.mainMobileFactsAfterTransition = await readRefreshBackgroundMobileFacts(page);
              assert.equal(refreshBackgroundMobileFactsMatch(sampleResult.mainMobileFactsAfterTransition), true, "main Mobile page must retain its real CDP mobile metrics through the visibility cycle");
              const activeSampleChromium = sampleChromium;
              sampleResult.sameDefaultBrowserContext = activeSampleChromium.browser.contexts().length === 1
                && activeSampleChromium.browser.contexts()[0] === activeSampleChromium.defaultContext
                && page.context() === activeSampleChromium.defaultContext;
              sampleResult.visibilityChecks = {
                helperPass: visibility.status === "PASS",
                actualWindowMinimized: visibility.minimizedWindow?.bounds?.windowState === "minimized",
                actualWindowRestored: visibility.restoredWindow?.bounds?.windowState === "normal",
                trustedHiddenAfterMinimize: visibility.hiddenEvent?.isTrusted === true && visibility.hiddenEvent.atEpochMs > visibility.minimizeBoundaryEpochMs && visibility.hiddenState === "hidden",
                trustedVisibleAfterRestore: visibility.activeEvent?.isTrusted === true && visibility.activeEvent.atEpochMs > visibility.restoreBoundaryEpochMs && visibility.activeState === "visible",
                sameBrowserContext: visibility.targetOwnership?.sameBrowserContext === true,
                sameBrowserWindow: visibility.targetOwnership?.sameBrowserWindow === true,
                companionClosed: visibility.companionClosed === true,
                traceDetached: visibility.traceDetached === true,
                oneFreshNoDefaultsDefaultContext: sampleResult.sameDefaultBrowserContext,
                mainMetricsBefore: refreshBackgroundMobileFactsMatch(sampleResult.mainMobileFactsBeforeTransition),
                mainMetricsAfter: refreshBackgroundMobileFactsMatch(sampleResult.mainMobileFactsAfterTransition),
                companionMetrics: sampleResult.companionMobileFacts?.gate === true,
                companionMetricsDetached: sampleResult.companionMobileFacts?.detachStatus === "acknowledged",
                preMinimizeQuiescence: sampleResult.preMinimizeQuiescence?.status === "DRAINED",
                beforeMinimizeHookCompletedBeforeBoundary: visibility.beforeMinimizeHookStatus === "COMPLETED"
                  && visibility.completedStages.indexOf("check-main-page-visible") < visibility.completedStages.indexOf("before-minimize-hook")
                  && visibility.completedStages.indexOf("before-minimize-hook") < visibility.completedStages.indexOf("capture-minimize-boundary"),
                holdArmedBeforeMinimize: sampleResult.configuredHold?.armedAfterQuiescence === true
                  && visibility.beforeMinimizeHookStatus === "COMPLETED"
                  && visibility.completedStages.indexOf("before-minimize-hook") < visibility.completedStages.indexOf("capture-minimize-boundary"),
                noCleanupErrors: !visibility.cleanupError && !visibility.cleanupErrorStage && !visibility.restoreError && !visibility.restoreErrorStage && !visibility.traceError && !visibility.traceErrorStage && !visibility.cdpDetachError && !visibility.cdpDetachErrorStage && !visibility.companionPreparationCleanupError && !visibility.companionPreparationCleanupErrorStage,
              };
              if (visibility.status === "PASS") {
                for (const [name, passed] of Object.entries(sampleResult.visibilityChecks)) {
                  assert.equal(passed, true, `owned-window Mobile visibility gate failed: ${name}`);
                }
              }
              if (visibility.status !== "PASS") {
                sampleResult.status = "NOT_RUN";
                sampleResult.notRunReason = visibility.reason ?? "trusted visible-hidden-visible transition not observed";
              } else {
                const activeAtEpochMs = visibility.activeEvent.atEpochMs;
                const request = await waitFor(
                  () => network.httpRouteRequests.find(item => item.scenario === row.scenario
                    && item.stage === stage
                    && item.apiPath === group.apiPath
                    && item.startedAtEpochMs >= activeAtEpochMs),
                  5_000,
                  `${group.apiPath} request after trusted AppState active transition`,
                );
                sampleResult.activeEventAtEpochMs = activeAtEpochMs;
                sampleResult.refreshRequest = {
                  routeRequestOrdinal: request.routeRequestOrdinal,
                  path: request.apiPath,
                  method: request.method,
                  startedAtEpochMs: request.startedAtEpochMs,
                  activeToRequestMs: round(request.startedAtEpochMs - activeAtEpochMs),
                  afterActiveTransition: request.startedAtEpochMs >= activeAtEpochMs,
                };
                assert.equal(sampleResult.refreshRequest.afterActiveTransition, true, "the refresh request must follow the real active transition");

                const matchingResponse = () => findHttpResponseForRouteRequest(network.httpResponsePathDelays, request);
                const rowVisibleDuringHold = group.view === "home"
                  ? await page.getByTestId(`thread-${THREAD_ID}`).isVisible()
                  : await page.getByTestId("message-user").first().isVisible();
                assert.equal(rowVisibleDuringHold, true, "existing Home thread row or Task history must stay visible while refresh is pending");
                sampleResult.retainedVisibleBeforeResponse = true;
                if (group.view === "home") {
                  const duringHomeThreadPresentation = await captureHomeThreadPresentation(page, network, stage, expectedWorkspace);
                  if (refreshHomeMinuteBoundaryDiagnosticMode) {
                    assert.ok(["1 分钟", "2 分钟"].includes(duringHomeThreadPresentation.relativeTimeText), "Home relative time during the held response must remain one of the two valid boundary labels");
                    sampleResult.homeMinuteBoundary.relativeTimeLabelDuring = duringHomeThreadPresentation.relativeTimeText;
                  }
                  sampleResult.homeThreadPresentation.during = duringHomeThreadPresentation;
                  sampleResult.homeThreadTextFingerprintDuringHold = sha256(duringHomeThreadPresentation.rowText).slice(0, 16);
                  sampleResult.homeThreadContentFingerprintDuringHold = sha256(normalizeHomeThreadRowText(duringHomeThreadPresentation));
                  sampleResult.homeThreadPresentationChecks.beforeToDuring = assertHomeThreadPresentationStableExceptRelativeTime(
                    sampleResult.homeThreadPresentation.before,
                    duringHomeThreadPresentation,
                    "during held refresh",
                  );
                  assert.equal(sampleResult.homeThreadContentFingerprintDuringHold, sampleResult.initialHomeThreadContentFingerprint, "only the computed Home relative-time field may change during the held refresh");
                } else {
                  const currentMessageText = await page.getByTestId("message-user").first().innerText();
                  sampleResult.historyTextFingerprintDuringHold = sha256(currentMessageText).slice(0, 16);
                  assert.equal(sampleResult.historyTextFingerprintDuringHold, sampleResult.initialHistoryTextFingerprint, "existing Task history content must remain unchanged while the foreground refresh is held");
                }
                if (delayMs > 0) {
                  assert.equal(Boolean(matchingResponse()), false, "the configured positive response hold must still be pending when retention is checked");
                }
                const response = await waitFor(matchingResponse, Math.max(5_000, delayMs + 3_000), `${group.apiPath} refresh response`);
                assert.equal(response.routeRequestOrdinal, request.routeRequestOrdinal, "foreground response evidence must correlate to the exact post-active request ordinal");
                assertApplicationDelay(response, delayMs, `${group.id} HTTP refresh hold`);
                if (sampleResult.homeMinuteBoundary) {
                  const boundary = sampleResult.homeMinuteBoundary;
                  boundary.requestStartedAtEpochMs = request.startedAtEpochMs;
                  boundary.responseForwardedAtEpochMs = response.forwardedAtEpochMs;
                  boundary.holdStraddledTransition = request.startedAtEpochMs < boundary.targetTransitionEpochMs
                    && response.forwardedAtEpochMs >= boundary.targetTransitionEpochMs;
                  boundary.requestToResponseMs = round(response.forwardedAtEpochMs - request.startedAtEpochMs);
                  boundary.requiredBoundaryCrossing = sampleResult.sampleId === "02";
                  previousMinuteBoundaryHookToRequestMs = request.startedAtEpochMs - boundary.beforeMinimizeHookCompletedAtEpochMs;
                  boundary.observedHookToRequestMs = round(previousMinuteBoundaryHookToRequestMs);
                  if (boundary.requiredBoundaryCrossing) {
                    assert.equal(boundary.holdStraddledTransition, true, "the second 600ms /api/servers response hold must straddle the controlled minute transition");
                  }
                }
                sampleResult.refreshResponseCorrelation = {
                  routeRequestOrdinal: response.routeRequestOrdinal,
                  matchesSelectedPostActiveRequest: response.routeRequestOrdinal === sampleResult.refreshRequest.routeRequestOrdinal,
                  configuredDelayMs: response.configuredDelayMs,
                  appliedDelayMs: response.appliedDelayMs,
                };
                if (group.view === "home") {
                  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 5_000 });
                  const homeThreadRow = page.getByTestId(`thread-${THREAD_ID}`);
                  await homeThreadRow.waitFor({ state: "visible", timeout: 5_000 });
                  if (group.view === "home") {
                    const requireVisibleMinuteChange = refreshHomeMinuteBoundaryDiagnosticMode && sampleResult.sampleId === "02";
                    const finalHomeThreadPresentation = requireVisibleMinuteChange
                      ? await waitFor(async () => {
                        const presentation = await captureHomeThreadPresentation(page, network, stage, expectedWorkspace);
                        return presentation.relativeTimeText !== sampleResult.homeThreadPresentation.before.relativeTimeText ? presentation : null;
                      }, 3_000, "Home relative-time label after the controlled minute boundary", 50)
                      : await captureHomeThreadPresentation(page, network, stage, expectedWorkspace);
                    if (sampleResult.homeMinuteBoundary) {
                      sampleResult.homeMinuteBoundary.relativeTimeLabelAfter = finalHomeThreadPresentation.relativeTimeText;
                      sampleResult.homeMinuteBoundary.relativeTimeChangedAfterResponse = finalHomeThreadPresentation.relativeTimeText !== sampleResult.homeThreadPresentation.before.relativeTimeText;
                      sampleResult.homeMinuteBoundary.requiredVisibleMinuteChange = requireVisibleMinuteChange;
                      if (requireVisibleMinuteChange) {
                        assert.equal(sampleResult.homeMinuteBoundary.expectedLabelAfter, "2 分钟", "the required second-sample boundary label must be two minutes");
                        assert.equal(finalHomeThreadPresentation.relativeTimeText, sampleResult.homeMinuteBoundary.expectedLabelAfter, "the second sample must render exactly two minutes after the held response crosses the controlled Home minute boundary");
                        assert.equal(sampleResult.homeMinuteBoundary.relativeTimeChangedAfterResponse, true, "the second sample must show the computed Home relative-time change after the held response crosses its fixture minute boundary");
                      }
                    }
                    sampleResult.homeThreadPresentation.after = finalHomeThreadPresentation;
                    sampleResult.homeThreadTextFingerprintAfterResponse = sha256(finalHomeThreadPresentation.rowText).slice(0, 16);
                    sampleResult.homeThreadContentFingerprintAfterResponse = sha256(normalizeHomeThreadRowText(finalHomeThreadPresentation));
                    sampleResult.homeThreadPresentationChecks.beforeToAfter = assertHomeThreadPresentationStableExceptRelativeTime(
                      sampleResult.homeThreadPresentation.before,
                      finalHomeThreadPresentation,
                      "after refresh response",
                    );
                    assert.equal(sampleResult.homeThreadContentFingerprintAfterResponse, sampleResult.initialHomeThreadContentFingerprint, "only the computed Home relative-time field may change after the foreground refresh response");
                    sampleResult.postActiveMatchingRequestCount = network.httpRouteRequests.filter(item => item.scenario === row.scenario && item.stage === stage && item.apiPath === group.apiPath && item.startedAtEpochMs >= activeAtEpochMs).length;
                  }
                } else {
                  await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 5_000 });
                  const afterMessage = page.getByTestId("message-user").first();
                  await afterMessage.waitFor({ state: "visible", timeout: 5_000 });
                  const finalMessageText = await afterMessage.innerText();
                  assert.equal(sha256(finalMessageText), sha256(initialMessageText), "the previously visible history item must be unchanged after the refresh response");
                  sampleResult.finalHistoryTextFingerprint = sha256(finalMessageText).slice(0, 16);
                }
                sampleResult.retainedVisibleAfterResponse = true;
                sampleResult.response = summarizeHttpDelaySample(response);
                sampleResult.status = refreshBackgroundDiagnosticMode ? "DIAGNOSTIC" : refreshSmokeMode ? "SMOKE" : "PASS";
              }
            } else {
              measurementStartedAt = performance.now();
              await openFixtureSession(page);
              await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
              await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 10_000 });
              await waitForGatewayRpcQuiescence(network, 15_000, 100);
              sampleControl.methodResponseHoldMs["turn/start"] = delayMs;
              sampleResult.configuredHold = { layer: "WebSocket JSON-RPC response path", method: "turn/start", delayMs, definition: group.kind === "rejected-send" ? "test-generated request-id-correlated error response hold; bypasses mock Gateway runMock" : "isolated mock Gateway successful ACK hold; not RTT or packet loss" };

              const message = `PHONE_UX_${group.kind === "accepted-send" ? "ACCEPTED" : "REJECTED"}_${delayMs}_${sampleId}`;
              const priorStartCount = network.rpcMethodCounts["turn/start"] ?? 0;
              await page.getByTestId("message-input").fill(message);
              const clickStartedAt = performance.now();
              await page.getByTestId("send-message").click();
              const pendingCard = page.getByTestId("failed-submission").filter({ hasText: message });
              const zeroDelayAccepted = group.kind === "accepted-send" && delayMs === 0;
              const zeroDelayRejected = group.kind === "rejected-send" && delayMs === 0;
              if (zeroDelayAccepted) {
                const acceptedUserMessageForFeedback = page.getByTestId("message-user").filter({ hasText: message }).last();
                const firstFeedback = await Promise.any([
                  pendingCard.getByTestId("failed-submission-content").waitFor({ state: "visible", timeout: 5_000 })
                    .then(() => ({ kind: "pending-content", observedAtMs: performance.now() })),
                  acceptedUserMessageForFeedback.waitFor({ state: "visible", timeout: 5_000 })
                    .then(() => ({ kind: "accepted-user-message", observedAtMs: performance.now() })),
                ]);
                const clickToFirstFeedbackObservedMs = round(firstFeedback.observedAtMs - clickStartedAt);
                assert.ok(clickToFirstFeedbackObservedMs >= 0, "the first visible feedback sample must follow the send gesture");
                sampleResult.timingsMs.clickToFirstFeedbackObserved = clickToFirstFeedbackObservedMs;
                sampleResult.zeroDelayFeedbackEvidence = {
                  status: "FIRST_VISIBLE_FEEDBACK_OBSERVED",
                  kind: firstFeedback.kind,
                  observedAfterClickMs: clickToFirstFeedbackObservedMs,
                  observationSemantics: "Playwright locator visibility resolution is an observation upper bound, not a paint timestamp",
                };
                sampleResult.pendingUiEvidence = {
                  status: "NOT_REQUIRED_ZERO_DELAY_ACK_MAY_PRECEDE_DOM_SAMPLE",
                  reason: "A successful zero-delay ACK can remove the transient retrying-submission card before Playwright samples its pending label; exact request/ACK correlation, accepted transcript visibility, and no-duplicate checks are required below.",
                };
              } else if (zeroDelayRejected) {
                const pendingStatusForFeedback = pendingCard.getByText("正在发送，恢复记录已保存", { exact: true });
                const failedErrorForFeedback = pendingCard.getByTestId("failed-submission-error");
                const firstFeedback = await Promise.any([
                  pendingStatusForFeedback.waitFor({ state: "visible", timeout: 5_000 })
                    .then(() => ({ kind: "pending-status", observedAtMs: performance.now() })),
                  failedErrorForFeedback.waitFor({ state: "visible", timeout: 5_000 })
                    .then(() => ({ kind: "definite-failure-error", observedAtMs: performance.now() })),
                ]);
                const clickToFirstFeedbackObservedMs = round(firstFeedback.observedAtMs - clickStartedAt);
                assert.ok(clickToFirstFeedbackObservedMs >= 0, "the first rejected-send feedback sample must follow the send gesture");
                sampleResult.timingsMs.clickToFirstFeedbackObserved = clickToFirstFeedbackObservedMs;
                sampleResult.zeroDelayFeedbackEvidence = {
                  status: "FIRST_REJECTION_FEEDBACK_OBSERVED",
                  kind: firstFeedback.kind,
                  observedAfterClickMs: clickToFirstFeedbackObservedMs,
                  observationSemantics: "Playwright locator visibility resolution is an observation upper bound, not a paint timestamp",
                };
                sampleResult.pendingUiEvidence = {
                  status: "NOT_REQUIRED_ZERO_DELAY_REJECTION_MAY_PRECEDE_DOM_SAMPLE",
                  reason: "A zero-delay error response may transition the submission from pending to its definite failure card before Playwright samples the transient pending title; the first pending or error feedback is recorded, while exact request/error/route, retained draft, and no-automatic-retry checks remain required below.",
                };
              } else {
                await pendingCard.getByTestId("failed-submission-content").waitFor({ state: "visible", timeout: 5_000 });
                await pendingCard.getByText("正在发送，恢复记录已保存", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
                sampleResult.timingsMs.clickToLocalPending = round(performance.now() - clickStartedAt);
                sampleResult.pendingUiEvidence = { status: "OBSERVED_BEFORE_ACK", delayMs };
              }
              const request = await waitFor(
                () => network.rpcEvents.find(item => item.direction === "request" && item.method === "turn/start" && item.stage === stage),
                5_000,
                "single real client turn/start request",
              );
              assert.equal((network.rpcMethodCounts["turn/start"] ?? 0) - priorStartCount, 1, "one send gesture must create exactly one browser turn/start");
              const startIdentity = await waitFor(
                () => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-start-request" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage),
                5_000,
                "turn/start identity fingerprints at the routed WebSocket boundary",
              );
              assert.equal(startIdentity.routeSocketId, request.routeSocketId, "clientMessageId identity must belong to the same routed socket as this request");
              assert.ok(startIdentity.clientMessageIdFingerprint, "the actual turn/start must include a stable clientMessageId fingerprint");
              sampleResult.messageFingerprint = sha256(message).slice(0, 16);
              sampleResult.request = {
                method: request.method,
                rpcIdFingerprint: request.rpcIdFingerprint,
                clientMessageIdFingerprint: startIdentity.clientMessageIdFingerprint,
                threadIdFingerprint: startIdentity.threadIdFingerprint,
                routeSocketId: request.routeSocketId,
              };

              if (group.kind === "accepted-send") {
                const responseAlreadyForwarded = network.rpcEvents.some(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage);
                if (delayMs > 0) {
                  assert.equal(responseAlreadyForwarded, false, "the delayed success ACK must remain pending when the local pending UI is observed");
                  assert.equal(
                    await pendingCard.getByText("正在发送，恢复记录已保存", { exact: true }).isVisible(),
                    true,
                    "the exact delayed turn/start must retain the pending UI while its ACK is still outstanding",
                  );
                  sampleResult.pendingUiEvidence = {
                    status: "OBSERVED_WITH_EXACT_ACK_OUTSTANDING",
                    delayMs,
                    rpcIdFingerprint: request.rpcIdFingerprint,
                    routeSocketId: request.routeSocketId,
                  };
                }
                const ack = await waitFor(
                  () => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage),
                  Math.max(10_000, delayMs + 5_000),
                  "successful isolated mock turn/start ACK with the exact request id",
                );
                const ackDetails = network.rpc.find(item => item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.routeSocketId === request.routeSocketId);
                assert.equal(ack.rpcIdFingerprint, request.rpcIdFingerprint, "the successful ACK must use the exact turn/start request id");
                assert.equal(ack.routeSocketId, request.routeSocketId, "the successful ACK must match the request route socket");
                assert.equal(ackDetails?.ok, true, "the isolated mock must return a successful turn/start ACK");
                assert.equal(ackDetails?.errorCode, undefined, "the accepted sample must not contain an error response");
                const responseDelay = network.websocketResponsePathDelays.find(item => item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage);
                if (delayMs > 0) {
                  const acceptedHold = network.methodResponseHolds.find(item => item.method === "turn/start" && item.configuredHoldMs === delayMs && item.stage === stage);
                  assertApplicationDelay(
                    { configuredDelayMs: acceptedHold?.configuredHoldMs, appliedDelayMs: acceptedHold?.measuredHoldMs },
                    delayMs,
                    "accepted turn/start response hold",
                  );
                } else {
                  assertApplicationDelay(responseDelay, 0, "zero-delay accepted turn/start response path");
                }
                const started = await waitFor(
                  () => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/started" && item.routeSocketId === request.routeSocketId && item.threadIdFingerprint === startIdentity.threadIdFingerprint && item.stage === stage),
                  10_000,
                  "same-route turn/started notification after successful ACK",
                );
                const completed = await waitFor(
                  () => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/completed" && item.routeSocketId === request.routeSocketId && item.threadIdFingerprint === startIdentity.threadIdFingerprint && item.turnIdFingerprint === started.turnIdFingerprint && item.stage === stage),
                  20_000,
                  "same-route turn/completed notification",
                );
                assert.ok(completed.atMs > started.atMs, "the mock turn must finish after it starts");
                await page.getByTestId("stop-turn").waitFor({ state: "hidden", timeout: 5_000 });
                const acceptedUserMessage = page.getByTestId("message-user").filter({ hasText: message }).last();
                await acceptedUserMessage.waitFor({ state: "visible", timeout: 5_000 });
                assert.ok((await acceptedUserMessage.innerText()).includes(message), "the accepted user message must be visible in the transcript");
                const assistantMessage = page.getByTestId("message-assistant").last();
                await assistantMessage.waitFor({ state: "visible", timeout: 10_000 });
                assert.ok((await assistantMessage.innerText()).includes(message), "the TaskRuntime must render the accepted mock reply in the visible transcript");
                const stageTurnStartRequests = network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/start" && item.stage === stage);
                const stageTurnStartAcks = network.rpcEvents.filter(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage);
                assert.equal(stageTurnStartRequests.length, 1, "the accepted action must not send a duplicate turn/start");
                assert.equal(stageTurnStartAcks.length, 1, "the exact accepted turn/start request must have one forwarded ACK");
                const receiptSummaryForSample = receiptFixture.summary();
                assert.equal(receiptSummaryForSample.turnStartRequestCount, 1, "the receipt fixture must observe exactly one accepted request");
                assert.equal(receiptSummaryForSample.acceptedResponseCount, 1, "the receipt fixture must observe exactly one successful mock ACK");
                assert.equal(receiptSummaryForSample.duplicatePairRequestCount, 0, "the clientMessageId pair must not be resubmitted");
                assert.equal(receiptSummaryForSample.acceptedIdentityFingerprints[0]?.clientMessageIdFingerprint, startIdentity.clientMessageIdFingerprint, "the accepted fixture must correlate the same stable clientMessageId");
                sampleResult.timingsMs.clickToAcceptedAck = round(ack.atMs - clickStartedAt);
                sampleResult.ack = { rpcIdFingerprint: ack.rpcIdFingerprint, routeSocketId: ack.routeSocketId, appliedDelayMs: responseDelay.appliedDelayMs, success: true };
                sampleResult.lifecycle = { turnIdFingerprint: started.turnIdFingerprint, completed: true, terminalVisibleAssistantReply: true };
                sampleResult.receiptFixture = receiptSummaryForSample;
                sampleResult.status = refreshDiagnosticMode ? "DIAGNOSTIC" : refreshSmokeMode ? "SMOKE" : "PASS";
              } else {
                if (delayMs > 0) {
                  const errorAlreadyForwarded = network.rpcEvents.some(item => item.direction === "response-forwarded"
                    && item.method === "turn/start"
                    && item.rpcIdFingerprint === request.rpcIdFingerprint
                    && item.stage === stage
                    && item.ok === false
                    && item.responseSource === "test-generated JSON-RPC error fixture");
                  assert.equal(errorAlreadyForwarded, false, "the delayed rejection response must remain outstanding while the local pending UI is observed");
                  assert.equal(
                    await pendingCard.getByText("正在发送，恢复记录已保存", { exact: true }).isVisible(),
                    true,
                    "the exact delayed turn/start error response must remain outstanding while the pending UI is visible",
                  );
                  sampleResult.pendingUiEvidence = {
                    status: "OBSERVED_WITH_EXACT_ERROR_RESPONSE_OUTSTANDING",
                    delayMs,
                    rpcIdFingerprint: request.rpcIdFingerprint,
                    routeSocketId: request.routeSocketId,
                  };
                }
                const errorResponse = await waitFor(
                  () => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage && item.ok === false && item.responseSource === "test-generated JSON-RPC error fixture"),
                  Math.max(10_000, delayMs + 5_000),
                  "request-id-correlated test error response delivered to the Mobile WebSocketMock",
                );
                sampleResult.timingsMs.clickToErrorResponse = round(errorResponse.atMs - clickStartedAt);
                const errorFixtureEvents = network.faultFixtureEvents.filter(item => item.scenario === row.scenario
                  && item.kind === "turn-start-error-fixture"
                  && item.requestIdFingerprint === request.rpcIdFingerprint
                  && item.stage === stage);
                assert.equal(errorFixtureEvents.length, 1, "exactly one typed rejection fixture must match this request id and stage");
                const [errorFixture] = errorFixtureEvents;
                assert.equal(errorFixture.requestIdPreserved, true, "the fixture error must preserve the exact JSON-RPC request id");
                assert.equal(errorFixture.requestIdFingerprint, request.rpcIdFingerprint, "the error fixture must preserve the exact request fingerprint");
                assert.equal(errorFixture.routeSocketId, request.routeSocketId, "the injected fixture must be bound to the request's originating route socket");
                assert.equal(errorFixture.clientMessageIdFingerprint, startIdentity.clientMessageIdFingerprint, "the injected rejection must correlate to the exact clientMessageId");
                const matchingErrorResponses = network.rpcEvents.filter(item => item.direction === "response-forwarded"
                  && item.method === "turn/start"
                  && item.rpcIdFingerprint === request.rpcIdFingerprint
                  && item.stage === stage
                  && item.ok === false
                  && item.responseSource === "test-generated JSON-RPC error fixture");
                assert.equal(matchingErrorResponses.length, 1, "exactly one request-id-correlated error response must be forwarded");
                const [uniqueErrorResponse] = matchingErrorResponses;
                assert.equal(uniqueErrorResponse.routeSocketId, request.routeSocketId, "the only matching error response must use the originating route socket");
                assert.equal(uniqueErrorResponse.rpcIdFingerprint, errorFixture.requestIdFingerprint, "the fixture and forwarded response must share the exact request fingerprint");
                assert.equal(errorResponse.routeSocketId, request.routeSocketId, "the request-id-correlated fixture response must return on the originating route socket");
                const responseDelay = network.websocketResponsePathDelays.find(item => item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage);
                assertApplicationDelay(responseDelay, delayMs, "rejected turn/start fixture response hold");
                const failedCard = page.getByTestId("failed-submission").filter({ hasText: message });
                await failedCard.getByTestId("failed-submission-error").waitFor({ state: "visible", timeout: 10_000 });
                sampleResult.timingsMs.clickToFailedCardVisible = round(performance.now() - clickStartedAt);
                const failedContent = await failedCard.getByTestId("failed-submission-content").innerText();
                const failedError = await failedCard.getByTestId("failed-submission-error").innerText();
                assert.equal(sha256(failedContent.trim()), sha256(message), "the rejected client message must stay in its own failed-submission card");
                assert.ok(failedError.includes("Isolated Mobile E2E rejected this turn/start"), "the client UI must show the injected definite rejection");
                const startCountForStage = network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/start" && item.stage === stage).length;
                assert.equal(startCountForStage, 1, "the rejected sample must never automatically retry turn/start");

                const draft = `PHONE_UX_DRAFT_RETAINED_${delayMs}_${sampleId}`;
                await page.getByTestId("message-input").fill(draft);
                await waitFor(async () => page.evaluate(expected => Object.keys(localStorage).some(key => {
                  try { return JSON.parse(localStorage.getItem(key) || "null")?.composerDraft === expected; }
                  catch { return false; }
                }), draft), 5_000, "composer draft persistence before reload");
                sampleResult.draftFingerprint = sha256(draft).slice(0, 16);
                await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
                await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
                const reloadedCard = page.getByTestId("failed-submission").filter({ hasText: message });
                await reloadedCard.getByTestId("failed-submission-content").waitFor({ state: "visible", timeout: 15_000 });
                await reloadedCard.getByTestId("failed-submission-error").waitFor({ state: "visible", timeout: 15_000 });
                const restoredDraft = await page.getByTestId("message-input").inputValue();
                const restoredFailedContent = await reloadedCard.getByTestId("failed-submission-content").innerText();
                const restoredFailedError = await reloadedCard.getByTestId("failed-submission-error").innerText();
                assert.equal(sha256(restoredDraft), sha256(draft), "hard reload must restore the unsent composer draft from persisted workspace state");
                assert.equal(sha256(restoredFailedContent.trim()), sha256(message), "hard reload must restore the rejected message in the failed-submission card");
                assert.ok(restoredFailedError.includes("Isolated Mobile E2E rejected this turn/start"), "hard reload must restore the rejection detail in the failed-submission card");
                assert.equal(network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/start" && item.stage === stage).length, 1, "reload must not resend the failed clientMessageId");
                sampleResult.ack = { rpcIdFingerprint: errorResponse.rpcIdFingerprint, routeSocketId: errorResponse.routeSocketId, appliedDelayMs: responseDelay.appliedDelayMs, success: false, errorFixture: true };
                sampleResult.recoveryReadback = { failedSubmissionRestored: true, separateComposerDraftRestored: true, hardReload: true, automaticRetryCount: 0 };
                sampleResult.status = refreshDiagnosticMode ? "DIAGNOSTIC" : refreshSmokeMode ? "SMOKE" : "PASS";
              }
            }
          } catch (error) {
            sampleError = error;
            sampleResult.status = "FAIL";
            sampleResult.error = context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 700);
            if (page && !page.isClosed()) {
              sampleResult.pageAtFailure = await describeVisiblePage(page).catch(() => null);
              sampleResult.screenshot = await capturePrivateFailureScreenshot(context, page, `phone-ux-refresh-${group.id}-d${delayMs}-${sampleId}-failure.png`).catch(() => ({ artifact: null, status: "capture-failed" }));
            }
          } finally {
            const sampleFinishedAt = performance.now();
            sampleResult.setupElapsedMs = round((measurementStartedAt ?? sampleFinishedAt) - sampleLifecycleStartedAt);
            sampleResult.measurementElapsedMs = measurementStartedAt === null ? null : round(sampleFinishedAt - measurementStartedAt);
            sampleResult.elapsedMs = round(sampleFinishedAt - sampleLifecycleStartedAt);
            if (sampleAuth && page) {
              try {
                sampleResult.authLifecycle = await releaseOwnedMobileAuthSample(page, gateway, sampleAuth, context);
                if (sampleResult.authLifecycle.status === "PASS") formalAuthCleanupCount += 1;
                else {
                  sampleResult.status = "FAIL";
                  sampleError ??= new Error("formal per-sample mobile auth cleanup failed");
                }
              } catch (error) {
                sampleResult.authLifecycle = {
                  status: "FAIL",
                  failures: ["cleanup-helper-error"],
                  error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 400),
                };
                sampleResult.status = "FAIL";
                sampleError ??= error instanceof Error ? error : new Error(String(error));
              }
            }
            if (page) {
              try {
                if (group.kind === "background") await closeRefreshDiagnosticMobilePage(page);
                else await closeOwnedMobilePage(page).catch(() => {});
              } catch (error) {
                sampleResult.status = "FAIL";
                sampleResult.pageCleanupError = context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 500);
              }
            }
            if (ownsSampleChromium && sampleChromium) {
              try {
                await sampleChromium.close();
                sampleResult.backgroundBrowserCleanup = { status: "CLOSED", pid: sampleChromium.child.pid, cdpPort: sampleChromium.cdpPort };
              } catch (error) {
                sampleResult.status = "FAIL";
                sampleResult.backgroundBrowserCleanup = {
                  status: "FAILED",
                  pid: sampleChromium.child.pid,
                  cdpPort: sampleChromium.cdpPort,
                  error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 500),
                };
              }
            }
            sampleResults.push(sampleResult);
            if (sampleResult.status === "FAIL") totalFailedSamples += 1;
            await context.writeArtifactJson(`phone-ux-refresh-${group.id}-d${delayMs}-${sampleId}.json`, sampleResult);
            await progressWriter.write({
              schemaVersion: 1,
              scenario: row.scenario,
              status: totalFailedSamples ? "PARTIAL_FAIL" : "RUNNING",
              currentAction: group.id,
              currentDelayMs: delayMs,
              attemptedSamplesInCurrentBin: sampleResults.length,
              requiredSamplesPerBin: sampleCount,
              failedSamples: totalFailedSamples,
              completedGroups: groupResults,
              currentBin: sampleResults,
              delayBins: delayValues,
              actionIds: groups.map(item => item.id),
              noProviderConfigured: true,
              gatewayEvidenceClass: "KCODER_STUDIO_MOCK; JS runMock except the explicit test-generated error fixture",
            });
          }
          if (sampleResult.authLifecycle?.status === "FAIL") {
            throw new Error("formal auth cleanup failed; stop before another sample can inherit capacity state");
          }
          if (sampleError) continue;
        }
        const passed = sampleResults.filter(item => item.status === "PASS");
        const smoked = sampleResults.filter(item => item.status === "SMOKE");
        const diagnosticSamples = sampleResults.filter(item => item.status === "DIAGNOSTIC");
        const successfulSamples = [...passed, ...smoked, ...diagnosticSamples];
        const notRun = sampleResults.filter(item => item.status === "NOT_RUN");
        const failed = sampleResults.filter(item => item.status === "FAIL");
        const groupBin = {
          action: group.id,
          delayMs,
          requiredSamples: sampleCount,
          attemptedSamples: sampleResults.length,
          passedSamples: passed.length,
          smokeSamples: smoked.length,
          diagnosticSamples: diagnosticSamples.length,
          notRunSamples: notRun.length,
          failedSamples: failed.length,
          status: failed.length ? "FAIL"
            : refreshDiagnosticMode && diagnosticSamples.length === sampleCount ? "DIAGNOSTIC_ONLY"
              : refreshSmokeMode && smoked.length === sampleCount ? "SMOKE"
                : passed.length === sampleCount ? "PASS"
                  : passed.length === 0 && smoked.length === 0 && diagnosticSamples.length === 0 && notRun.length === sampleCount ? "NOT_RUN" : "PARTIAL",
          coverageMode: refreshCoverageMode,
          formalN30Coverage: !refreshSingleSampleMode,
          samples: sampleResults,
        };
        const percentileFields = refreshSingleSampleMode
          ? { percentileEligibility: refreshCoverageMode, percentilesReported: false }
          : {};
        if (group.kind === "accepted-send") {
          const pending = successfulSamples.map(item => item.timingsMs.clickToLocalPending).filter(Number.isFinite).sort((a, b) => a - b);
          const accepted = successfulSamples.map(item => item.timingsMs.clickToAcceptedAck).filter(Number.isFinite).sort((a, b) => a - b);
          if (refreshSingleSampleMode) Object.assign(groupBin, percentileFields, { clickToLocalPendingMs: pending[0] ?? null, clickToAcceptedAckMs: accepted[0] ?? null });
          else {
            groupBin.clickToLocalPendingP50P95Ms = { p50: percentile(pending, 0.5), p95: percentile(pending, 0.95) };
            groupBin.clickToAcceptedAckP50P95Ms = { p50: percentile(accepted, 0.5), p95: percentile(accepted, 0.95) };
          }
        }
        if (group.kind === "rejected-send") {
          const rejectionFrames = successfulSamples.map(item => item.timingsMs.clickToErrorResponse).filter(Number.isFinite).sort((a, b) => a - b);
          const failedCards = successfulSamples.map(item => item.timingsMs.clickToFailedCardVisible).filter(Number.isFinite).sort((a, b) => a - b);
          if (refreshSingleSampleMode) Object.assign(groupBin, percentileFields, { clickToErrorResponseMs: rejectionFrames[0] ?? null, clickToFailedCardVisibleMs: failedCards[0] ?? null });
          else {
            groupBin.clickToErrorResponseP50P95Ms = { p50: percentile(rejectionFrames, 0.5), p95: percentile(rejectionFrames, 0.95) };
            groupBin.clickToFailedCardVisibleP50P95Ms = { p50: percentile(failedCards, 0.5), p95: percentile(failedCards, 0.95) };
          }
        }
        if (group.kind === "background") {
          const activeToRequest = successfulSamples.map(item => item.refreshRequest?.activeToRequestMs).filter(Number.isFinite).sort((a, b) => a - b);
          if (refreshSingleSampleMode) Object.assign(groupBin, percentileFields, { activeToRefreshRequestMs: activeToRequest[0] ?? null });
          else groupBin.activeToRefreshRequestP50P95Ms = { p50: percentile(activeToRequest, 0.5), p95: percentile(activeToRequest, 0.95) };
          groupBin.completedResponseAppliedDelayMs = distribution(successfulSamples.map(item => item.response?.appliedDelayMs).filter(Number.isFinite));
        }
        delayResults.push(groupBin);
        await context.writeArtifactJson(`phone-ux-refresh-${group.id}-d${delayMs}-summary.json`, groupBin);
      }
      const groupStatus = refreshDiagnosticMode && delayResults.every(item => item.status === "DIAGNOSTIC_ONLY")
        ? "DIAGNOSTIC_ONLY"
        : refreshSmokeMode && delayResults.every(item => item.status === "SMOKE")
          ? "SMOKE"
        : delayResults.every(item => item.status === "PASS")
        ? "PASS"
        : delayResults.some(item => item.status === "FAIL")
          ? "FAIL"
          : delayResults.every(item => item.status === "NOT_RUN")
            ? "NOT_RUN"
            : "PARTIAL";
      const groupResult = {
        action: group.id,
        kind: group.kind,
        status: groupStatus,
        coverageMode: refreshCoverageMode,
        formalN30Coverage: !refreshSingleSampleMode,
        delayResults,
      };
      groupResults.push(groupResult);
      row.checks.groupResults = groupResults;
      await context.writeArtifactJson(`phone-ux-refresh-${group.id}-summary.json`, groupResult);
    }
    row.checks.pairing.freshBackgroundSamplePairings = backgroundSamplePairingCount;
    if (refreshPerSampleAuthCleanupMode) {
      const finalAuthStore = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
      const expectedFormalSamples = groups.length * delayValues.length * sampleCount;
      const sampleAuthLifecycle = {
        status: formalAuthSampleCount === expectedFormalSamples && formalAuthCleanupCount === expectedFormalSamples && finalAuthStore.active === 0 && formalMaxActiveDeviceGrants === 1 ? "PASS" : "FAIL",
        expectedSamples: expectedFormalSamples,
        observedSamplePairs: formalAuthSampleCount,
        exactGrantRevocationsAndWebLogouts: formalAuthCleanupCount,
        activeDeviceCountAtEnd: finalAuthStore.active,
        revokedDeviceRowsAtEnd: finalAuthStore.revoked,
        maxConcurrentActiveDeviceGrants: formalMaxActiveDeviceGrants,
      };
      const key = refreshHomeMinuteBoundaryDiagnosticMode ? "homeMinuteDiagnosticAuthLifecycle" : "formalOwnedAuthLifecycle";
      row.checks.pairing[key] = sampleAuthLifecycle;
      if (refreshHomeMinuteBoundaryDiagnosticMode) row.checks.pairing.status = sampleAuthLifecycle.status;
      assert.equal(sampleAuthLifecycle.status, "PASS", "every owned Home sample must pair and release its exact auth grant before the next sample");
    }
    row.checks.backgroundWindowLifecycle = refreshBackgroundWindowMode ? {
      hostStartupMs: refreshBackgroundHost?.setupElapsedMs ?? null,
      oneOwnedWindowHostPerRun: true,
      freshOwnedChromiumDefaultContextPerBackgroundSample: true,
      backgroundBrowserStartupRecordedSeparately: true,
      requestAndContentIntervalsExcludeBrowserStartupAndPairing: true,
      allBackgroundDelayBinsArmedAfterDrainedPreMinimizeBoundary: true,
    } : null;
    const allPass = groupResults.every(item => item.status === "PASS");
    const allSmoke = refreshSmokeMode && groupResults.every(item => item.status === "SMOKE");
    const allDiagnostic = refreshDiagnosticMode && groupResults.every(item => item.status === "DIAGNOSTIC_ONLY");
    const anyNotRun = groupResults.some(item => item.status === "NOT_RUN" || item.status === "PARTIAL");
    row.checks.coverageStatus = allPass ? "PASS" : allSmoke ? "SMOKE" : allDiagnostic ? "DIAGNOSTIC_ONLY" : totalFailedSamples ? "FAIL" : anyNotRun ? "PARTIAL" : "NOT_RUN";
    row.checks.coverageMode = refreshCoverageMode;
    row.checks.formalN30Coverage = !refreshSingleSampleMode;
    row.checks.diagnosticId = refreshSendDiagnosticMode ? refreshSendDiagnostic : refreshBackgroundDiagnosticMode ? refreshBackgroundDiagnosticId : null;
    row.checks.requiredActions = groups.map(item => item.id);
    row.checks.requiredDelayBinsMs = delayValues;
    row.checks.samplesPerActionAndBin = sampleCount;
    row.checks.completedSequentially = true;
    row.checks.groupResults = groupResults;
    row.checks.delayBoundary = "one-way HTTP response or WSS JSON-RPC response hold in isolated loopback Gateway route; not RTT, packet loss, or radio latency";
    row.checks.draftDurabilityBoundary = "actual UI draft and failed-submission state are read back after hard reload from browser-persisted Mobile workspace state";
    row.checks.nativePlatform = "UNVERIFIED; Chromium Mobile Web only";
    await context.writeArtifactJson("phone-ux-refresh-send-progress-terminal.json", {
      schemaVersion: 1,
      artifactType: "terminal-aggregate",
      scenario: row.scenario,
      status: row.checks.coverageStatus,
      coverageMode: row.checks.coverageMode,
      formalN30Coverage: row.checks.formalN30Coverage,
      diagnosticId: refreshSendDiagnosticMode ? refreshSendDiagnostic : refreshBackgroundDiagnosticMode ? refreshBackgroundDiagnosticId : null,
      lastProgressSequence: progressWriter.sequence,
      requiredSamplesPerBin: sampleCount,
      delayBins: delayValues,
      actionIds: groups.map(item => item.id),
      failedSamples: totalFailedSamples,
      completedGroups: groupResults,
      noProviderConfigured: true,
      gatewayEvidenceClass: "KCODER_STUDIO_MOCK; JS runMock except the explicit test-generated error fixture",
      nativePlatform: "UNVERIFIED; Chromium Mobile Web only",
    });
    await context.writeArtifactJson("phone-ux-refresh-send-summary.json", {
      schemaVersion: 1,
      scenario: row.scenario,
      status: row.checks.coverageStatus,
      coverageMode: row.checks.coverageMode,
      formalN30Coverage: row.checks.formalN30Coverage,
      evidenceClass: "real Mobile Web UI/TaskRuntime with isolated KCODER_STUDIO_MOCK; rejection is injected at the Playwright WebSocket route",
      noProviderConfigured: true,
      requiredActions: row.checks.requiredActions,
      requiredDelayBinsMs: row.checks.requiredDelayBinsMs,
      samplesPerActionAndBin: row.checks.samplesPerActionAndBin,
      smokeOnly: refreshSmokeMode,
      diagnosticOnly: refreshDiagnosticMode,
      diagnosticId: refreshSendDiagnosticMode ? refreshSendDiagnostic : refreshBackgroundDiagnosticMode ? refreshBackgroundDiagnosticId : null,
      completedSequentially: true,
      groups: groupResults,
      failedSamples: totalFailedSamples,
      profileStorageState: "in-memory only; not serialized",
      nativePlatform: "UNVERIFIED",
    });
    if (totalFailedSamples) throw new Error(`${totalFailedSamples} refresh/send samples failed; inspect per-sample artifacts and preserve the original evidence`);
  }, { skipPageSetup: true });

  return { rows, requiredScenarioFailures, fixtureReceiptLedger: receiptSummary };
}

return { runPhoneUxFaultScenarios };
}
