import assert from "node:assert/strict";

const variants = [
  { width: 320, language: "en", theme: "light" },
  { width: 320, language: "en", theme: "dark" },
  { width: 320, language: "zh-CN", theme: "light" },
  { width: 320, language: "zh-CN", theme: "dark" },
  { width: 390, language: "en", theme: "light" },
  { width: 390, language: "en", theme: "dark" },
  { width: 390, language: "zh-CN", theme: "light" },
  { width: 390, language: "zh-CN", theme: "dark" },
];

export async function runCachedSessionUiVisualMatrix({
  context,
  page,
  protocol,
  browserErrors,
  gatewayOrigin,
  mobileEntryUrl,
  taskPath,
  threadId,
  promptMarker,
  draft,
  anchorMessageId,
  anchorOffset,
  armServerHold,
  releaseServerHold,
  releaseHeldAuthority,
  waitFor,
  waitForReadOnlyTranscriptCache,
  assertCachedSessionComposerReadOnly,
  readTranscriptViewport,
  savePrivateScreenshot,
  verifyRustAppServer,
  archiveEvidence,
}) {
  const screenshots = [];
  const cacheSnapshots = [];
  const anchorDomId = `message-${encodeURIComponent(anchorMessageId)}`;

  for (const variant of variants) {
    await page.evaluate(({ language, theme }) => {
      const key = "kcoder-studio:mobile-app-preferences:v1";
      let preferences = {};
      try { preferences = JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { /* Use defaults for malformed local preferences. */ }
      localStorage.setItem(key, JSON.stringify({ ...preferences, language, theme }));
    }, variant);
    await page.setViewportSize({ width: variant.width, height: 844 });

    const serverHold = armServerHold();
    protocol.rootRestore = {
      minSocketOrdinal: protocol.nextSocketOrdinal + 1,
      threadId,
      holdMode: "full",
    };
    await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded" });
    await waitFor(() => serverHold.pending > 0, 30_000, "owned /api/servers request during visual cache revisit");
    await page.waitForURL(url => new URL(url).pathname === taskPath, { timeout: 30_000 });
    const cacheView = page.getByTestId("session-cache-view");
    await cacheView.waitFor({ state: "visible", timeout: 30_000 });
    await assertCachedSessionComposerReadOnly(page, `cached ${variant.width}px ${variant.language}/${variant.theme}`);
    const initialDraft = cacheView.getByTestId("message-input");
    assert.equal(await initialDraft.inputValue(), "",
      "owner-scoped composer draft must remain withheld until the catalog confirms this task's target");

    releaseServerHold();
    const heldAuthority = await waitFor(() => protocol.rootRestore?.heldResponse ?? protocol.errors[0] ?? null,
      30_000, "unchanged Rust resume response held for the visual cache/live pair");
    assert.equal(protocol.errors.length, 0, `WebSocket bridge errors: ${protocol.errors.join(" | ")}`);
    assert.equal(heldAuthority.fixtureTransformed, false, "visual matrix must use the unchanged Rust authority page");
    assert.ok(heldAuthority.messageIds.includes(anchorMessageId), "the authority page must still contain the selected anchor row");
    await assertCachedSessionComposerReadOnly(page, `hydrated cached ${variant.width}px ${variant.language}/${variant.theme}`);
    const cachedInput = cacheView.getByTestId("message-input");
    await waitFor(async () => await cachedInput.inputValue() === draft ? true : null,
      30_000, "owner-scoped multiline draft to hydrate for the cached screenshot");

    const cacheReadiness = await waitForReadOnlyTranscriptCache(page, {
      threadId,
      gatewayOrigin,
      marker: promptMarker,
      expectedAnchorMessageId: anchorMessageId,
      expectedAnchorOffset: anchorOffset,
      requireReadingAnchor: true,
      minimumMessageCount: heldAuthority.messageIds.length,
    }, 30_000);
    assert.ok(cacheReadiness.ready, "the exact held authority page must remain in the read-only cache");
    assert.deepEqual(cacheReadiness.messageIdentities.map(message => message.id).sort(), [...heldAuthority.messageIds].sort(),
      "the cached screenshot must contain the exact held authority page");
    assert.equal(cacheReadiness.anchor?.messageId, anchorMessageId, "the cached screenshot must retain the exact selected read anchor");
    cacheSnapshots.push({ variant, cacheReadiness });

    const cacheGeometry = await readTranscriptViewport(page, { rowDomId: anchorDomId, rowTestId: "message-user" });
    assert.equal(cacheGeometry.rowMatchCount, 1, "the exact cached anchor row must render once");
    assertNear(cacheGeometry.row.offsetFromHost, anchorOffset, "cached row offset against persisted anchor");
    const cacheLayout = await captureLayoutState(page, variant.width, variant.theme, "cached", cachedInput);
    assert.equal(cacheLayout.inputEditable, false, "cached composer must remain read-only in the screenshot");
    assert.equal(cacheLayout.inputFocused, false, "cached composer screenshot must use the shared blurred input state");
    const cacheStatus = cacheView.getByTestId("session-cache-status");
    assert.equal(await cacheStatus.isVisible(), true, "cache status must remain visible in the cached screenshot");
    const cachePhase = cacheView.getByTestId("session-cache-phase");
    const expectedCachePhase = variant.language === "en" ? "Partial cache · read only" : "缓存可能不完整 · 只读";
    assert.ok((await cachePhase.innerText()).includes(expectedCachePhase),
      `cached status must render ${variant.language} copy for this matrix row`);
    const expectedModelLabel = variant.language === "en" ? "Model after reconnect" : "重连后加载模型";
    const expectedPermissionLabel = variant.language === "en" ? "Permissions after reconnect" : "重连后加载权限";
    const cachedModelControl = cacheView.getByTestId("cached-session-model-selector");
    const cachedPermissionControl = cacheView.getByTestId("cached-session-permission-selector");
    const cachedModelLabel = await cacheView.getByTestId("cached-session-model-label").innerText();
    const cachedPermissionLabel = await cacheView.getByTestId("cached-session-permission-label").innerText();
    assert.equal(await cachedModelControl.getAttribute("aria-label"), expectedModelLabel,
      "cache model control must retain its full not-yet-loaded accessibility label");
    assert.equal(await cachedPermissionControl.getAttribute("aria-label"), expectedPermissionLabel,
      "cache permissions control must retain its full not-yet-loaded accessibility label");
    assert.equal(await cachedModelControl.evaluate(element => getComputedStyle(element).opacity), "1",
      "cache model label must not be dimmed by a translucent disabled overlay");
    assert.equal(await cachedPermissionControl.evaluate(element => getComputedStyle(element).opacity), "1",
      "cache permissions label must not be dimmed by a translucent disabled overlay");
    assert.equal(cachedModelLabel, variant.language === "en" ? "Model" : "模型",
      "cache model display label must fit at phone widths and use the selected locale");
    assert.equal(cachedPermissionLabel, variant.language === "en" ? "Permissions" : "权限",
      "cache permissions display label must fit at phone widths and use the selected locale");
    const cachedConnectingLabel = await cacheView.getByTestId("cached-session-connection-label").innerText();
    assert.equal(cachedConnectingLabel, variant.language === "en" ? "Connecting" : "连接中",
      "cache composer must show a compact reconnect state in the selected locale");
    await assertTextFits(cacheView.getByTestId("session-cache-phase"), "cache phase");
    await assertTextFits(cacheView.getByTestId("cached-session-model-label"), "cache model label");
    await assertTextFits(cacheView.getByTestId("cached-session-permission-label"), "cache permission label");
    await assertTextFits(cacheView.getByTestId("cached-session-connection-label"), "cache connection label");
    const filenameBase = `${variant.width}-${variant.language}-${variant.theme}`;
    screenshots.push({
      phase: "cached-read-only",
      ...variant,
      filename: `cached-session-${filenameBase}-cache.png`,
      capture: await savePrivateScreenshot(page, `cached-session-${filenameBase}-cache.png`),
      layout: cacheLayout,
      anchorOffsetPx: cacheGeometry.row.offsetFromHost,
      phaseText: await cachePhase.innerText(),
      modelControlText: cachedModelLabel,
      permissionControlText: cachedPermissionLabel,
    });

    assert.equal(releaseHeldAuthority(protocol), true, "the test must release only its held authority response");
    await cacheView.waitFor({ state: "detached", timeout: 30_000 });
    await waitFor(() => page.getByTestId("message-input").isEditable(), 30_000,
      "editable composer after the same authority page replaces the cached view");
    const liveInput = page.getByTestId("message-input");
    assert.equal(await liveInput.inputValue(), draft, "the target-scoped unsent draft must survive cache-to-live replacement");
    const liveGeometry = await readTranscriptViewport(page, { rowDomId: anchorDomId, rowTestId: "message-user" });
    assert.equal(liveGeometry.rowMatchCount, 1, "the exact live anchor row must render once");
    assert.equal(liveGeometry.rowIntersectsList, true, "the exact live anchor row must remain in the transcript viewport");
    assertNear(liveGeometry.row.offsetFromHost, anchorOffset, "live row offset against the persisted anchor");
    const liveLayout = await captureLayoutState(page, variant.width, variant.theme, "live", liveInput);
    assert.equal(liveLayout.inputEditable, true, "authority-resumed composer must be editable");
    assert.equal(liveLayout.inputFocused, false, "live composer screenshot must use the same blurred input state");
    assert.equal(liveLayout.inputClientHeight, cacheLayout.inputClientHeight,
      "cached and live screenshots must use the same multiline input viewport height");
    assert.equal(liveLayout.inputScrollTop, cacheLayout.inputScrollTop,
      "cached and live screenshots must use the same multiline input scroll position");
    const liveModel = page.getByTestId("conversation-model-selector");
    const livePermission = page.getByTestId("composer-permission-selector");
    assert.equal(await liveModel.count(), 1, "the live model control must be present");
    assert.equal(await liveModel.isVisible(), true, "the live model control must be visible");
    assert.equal(await livePermission.count(), 1, "the live permission control must be present");
    assert.equal(await livePermission.isVisible(), true, "the live permission control must be visible");
    assert.ok((await liveInput.getAttribute("aria-label"))?.includes(variant.language === "en" ? "Send a message" : "发送消息"),
      "live composer accessibility copy must use the selected locale");
    screenshots.push({
      phase: "authoritative-live",
      ...variant,
      filename: `cached-session-${filenameBase}-live.png`,
      capture: await savePrivateScreenshot(page, `cached-session-${filenameBase}-live.png`),
      layout: liveLayout,
      anchorOffsetPx: liveGeometry.row.offsetFromHost,
      phaseText: null,
      modelControlText: await liveModel.innerText(),
      permissionControlText: await livePermission.innerText(),
    });
  }

  assert.equal(protocol.requests.filter(request => request.method === "turn/start" && request.threadId === threadId).length, 1,
    "the eight visual combinations must share the one deterministic local turn");
  assert.equal(protocol.turnCompletions.filter(event => event.threadId === threadId && event.status === "completed").length, 1,
    "the visual matrix must reuse one completed local turn");
  assert.equal(browserErrors.length, 0, `Browser page errors: ${browserErrors.join(" | ")}`);
  assert.equal(protocol.errors.length, 0, `WebSocket bridge errors: ${protocol.errors.join(" | ")}`);
  const evidence = {
    status: "PASS_CACHED_SESSION_UI_VISUAL_MATRIX",
    boundary: "same real local Mobile Web thread, one deterministic local turn, owner-scoped seven-line unsent draft, persisted user reading anchor, and eight sequential viewport/locale/theme combinations; no external Provider or model call and no native-phone claim",
    threadId,
    taskPath,
    turnStartCount: 1,
    providerCalls: 0,
    browserErrors: browserErrors.length,
    protocolErrors: protocol.errors.length,
    combinations: variants,
    screenshots,
    cacheSnapshots,
  };
  evidence.rustAppServer = await verifyRustAppServer();
  evidence.mobileWebArchive = archiveEvidence;
  await context.writeArtifactJson("mobile-session-cache-ui-visual-matrix.json", evidence);
  return evidence;
}

async function captureLayoutState(page, viewportWidth, theme, phase, input) {
  const state = await input.evaluate((input) => {
    input.blur();
    input.scrollTop = Math.max(0, input.scrollHeight - input.clientHeight);
    const rect = element => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    };
    const byTestId = id => document.querySelector(`[data-testid="${id}"]`);
    const controls = ["task-header", "task-header-title", "task-header-status", "session-cache-status",
      "cached-session-model-selector", "cached-session-permission-selector", "conversation-model-selector",
      "composer-permission-selector", "composer-attachment", "send-message"];
    const visible = {};
    for (const id of controls) {
      const element = byTestId(id);
      if (!element) continue;
      const bounds = rect(element);
      visible[id] = { ...bounds, visible: bounds.width > 0 && bounds.height > 0,
        insideViewport: bounds.x >= -1 && bounds.x + bounds.width <= window.innerWidth + 1 };
    }
    let root = byTestId("session-cache-view") ?? byTestId("task-header")?.parentElement ?? null;
    while (root && getComputedStyle(root).backgroundColor === "rgba(0, 0, 0, 0)") root = root.parentElement;
    return {
      inputEditable: !input.readOnly && !input.disabled,
      inputFocused: document.activeElement === input,
      inputClientHeight: input.clientHeight,
      inputScrollHeight: input.scrollHeight,
      inputScrollTop: input.scrollTop,
      viewportWidth: window.innerWidth,
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
      backgroundColor: root ? getComputedStyle(root).backgroundColor : null,
      visible,
    };
  });
  assert.equal(state.viewportWidth, viewportWidth, "capture must use the selected viewport width");
  assert.equal(state.backgroundColor, theme === "light" ? "rgb(255, 255, 255)" : "rgb(24, 24, 27)",
    `${phase} screen must render the selected ${theme} theme`);
  assert.ok(state.documentWidth <= viewportWidth + 1,
    `the ${viewportWidth}px screen must not overflow horizontally (document width ${state.documentWidth}px)`);
  const requiredIds = phase === "cached"
    ? ["task-header", "task-header-title", "task-header-status", "session-cache-status", "cached-session-model-selector",
      "cached-session-permission-selector", "composer-attachment", "send-message"]
    : ["task-header", "task-header-title", "task-header-status", "conversation-model-selector", "composer-permission-selector",
      "composer-attachment", "send-message"];
  for (const id of requiredIds) assert.ok(state.visible[id], `${phase} ${id} must be rendered and visible`);
  for (const [id, bounds] of Object.entries(state.visible)) {
    assert.equal(bounds.visible, true, `${id} must remain visible in the screenshot`);
    assert.equal(bounds.insideViewport, true, `${id} must remain inside the ${viewportWidth}px viewport`);
  }
  return state;
}

function assertNear(actual, expected, label, tolerance = 4) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label} must be finite`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label} changed from ${expected}px to ${actual}px (tolerance ${tolerance}px)`);
}

async function assertTextFits(locator, label) {
  const dimensions = await locator.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.ok(dimensions.clientWidth > 0 && dimensions.clientHeight > 0,
    `${label} must occupy visible space`);
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `${label} must not be clipped horizontally (${dimensions.scrollWidth}px content in ${dimensions.clientWidth}px)`);
  assert.ok(dimensions.scrollHeight <= dimensions.clientHeight + 1,
    `${label} must not be clipped vertically (${dimensions.scrollHeight}px content in ${dimensions.clientHeight}px)`);
}
