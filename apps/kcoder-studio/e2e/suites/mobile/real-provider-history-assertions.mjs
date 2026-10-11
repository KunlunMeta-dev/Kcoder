import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function expandReadResult(page, readToolTestId) {
  const tool = page.getByTestId(readToolTestId);
  const cardToggleTestId = readToolTestId.replace(
    /^tool-call-/,
    "tool-call-toggle-",
  );
  const cardToggle = page.getByTestId(cardToggleTestId);
  if (await cardToggle.count()) {
    await cardToggle.waitFor({ state: "visible", timeout: 20_000 });
    if ((await cardToggle.getAttribute("aria-expanded")) !== "true")
      await cardToggle.click();
    await tool.waitFor({ state: "visible", timeout: 20_000 });
    return;
  }
  const processing = page.getByTestId("message-processing-toggle").first();
  if (await processing.count()) {
    await processing.waitFor({ state: "visible", timeout: 20_000 });
    if ((await processing.getAttribute("aria-expanded")) !== "true")
      await processing.click();
  }
  await tool.waitFor({ state: "visible", timeout: 20_000 });
  const revealedCardToggle = page.getByTestId(cardToggleTestId);
  if (await revealedCardToggle.count()) {
    await revealedCardToggle.waitFor({ state: "visible", timeout: 20_000 });
    if ((await revealedCardToggle.getAttribute("aria-expanded")) !== "true")
      await revealedCardToggle.click();
    return;
  }
  const button = tool.getByRole("button");
  if (
    (await button.count()) &&
    (await button.getAttribute("aria-expanded")) !== "true"
  )
    await button.click();
}

/** Complete the real Gateway login and Mobile direct-connect flow. */
export async function connectMobileWithGatewayAuth(page, gateway, { onStage } = {}) {
  const reportStage = (stage) => onStage?.(stage);
  reportStage("open-gateway-login");
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  reportStage("submit-gateway-login");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
  reportStage("open-direct-connection");
  await page.getByTestId("welcome-direct-connection").click();
  reportStage("fill-direct-connection");
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  reportStage("connect-mobile-to-gateway");
  await page.getByTestId("gateway-connect").click();
  await page
    .getByTestId("new-workspace")
    .waitFor({ state: "visible", timeout: 30_000 });
}

export function isMobileNewWorkspaceRoute(pathname) {
  const parts = strictPathSegments(pathname);
  if (parts.length === 1 && parts[0] === "new") return true;
  return (
    parts.length === 3 &&
    parts[0] === "h" &&
    decodePathSegment(parts[1]) !== null &&
    parts[2] === "new"
  );
}

export function parseMobileProfileHomeRoute(pathname) {
  const parts = strictPathSegments(pathname);
  if (parts.length !== 2 || parts[0] !== "h") return null;
  const profileId = decodePathSegment(parts[1]);
  return profileId === null ? null : { profileId };
}

export function isMobileProfileHomeRoute(pathname) {
  return parseMobileProfileHomeRoute(pathname) !== null;
}

export function isMobileSessionsRoute(pathname) {
  const parts = strictPathSegments(pathname);
  return parts.length === 1 && parts[0] === "sessions";
}

export function parseMobileTaskRoute(pathname) {
  const parts = strictPathSegments(pathname);
  let serverPart;
  let threadPart;
  let routeKind;
  let profileId = null;
  if (parts.length === 3 && parts[0] === "task") {
    [, serverPart, threadPart] = parts;
    routeKind = "direct";
  } else if (
    parts.length === 5 &&
    parts[0] === "h" &&
    decodePathSegment(parts[1]) !== null &&
    parts[2] === "task"
  ) {
    [, profileId, , serverPart, threadPart] = parts;
    profileId = decodePathSegment(profileId);
    if (profileId === null) return null;
    routeKind = "profile-hosted";
  } else {
    return null;
  }
  const serverId = decodePathSegment(serverPart);
  const threadId = decodePathSegment(threadPart);
  if (serverId === null || threadId === null) return null;
  return { routeKind, profileId, serverId, threadId };
}

export function safeMobileProfileHomeRoute(pathname) {
  return parseMobileProfileHomeRoute(pathname) ? "/h/:profile" : "/unrecognized-route";
}

export function safeTaskRoute(pathname) {
  const route = parseMobileTaskRoute(pathname);
  if (!route) return "/unrecognized-route";
  return route.serverId === "local"
    ? "/task/local/:thread"
    : "/task/:server/:thread";
}

/**
 * Re-enter the current Mobile task through its real back stack, profile Home,
 * and Sessions page. A task opened from Sessions first returns to Sessions;
 * the Sessions header then returns to profile Home, where the Home-only
 * sessions control is available.
 */
export async function returnHomeAndReenterTaskFromSessions(
  page,
  {
    profileId,
    threadId,
    expectedTaskPath,
    timeoutMs = 20_000,
    backActivation = "click",
  },
) {
  assert.ok(
    backActivation === "click" || backActivation === "space",
    'backActivation must be "click" or "space"',
  );
  assert.equal(typeof profileId, "string");
  assert.equal(typeof threadId, "string");
  const expectedTask = parseMobileTaskRoute(expectedTaskPath);
  assert.ok(expectedTask, "the task route must be valid before history re-entry");
  assert.equal(expectedTask.profileId, profileId);
  assert.equal(expectedTask.threadId, threadId);

  const backButton = page.getByRole("button", { name: "返回", exact: true });
  await backButton.waitFor({ state: "visible", timeout: timeoutMs });
  if (backActivation === "space") await backButton.press("Space");
  else await backButton.click();
  await page.waitForURL(
    (url) =>
      isMobileSessionsRoute(url.pathname) ||
      parseMobileProfileHomeRoute(url.pathname)?.profileId === profileId,
    { timeout: timeoutMs },
  );
  const taskBackPath = new URL(page.url()).pathname;
  let sessionsBackToHome = false;
  if (isMobileSessionsRoute(taskBackPath)) {
    const sessionsBackButton = page.getByRole("button", {
      name: "返回",
      exact: true,
    });
    await sessionsBackButton.waitFor({ state: "visible", timeout: timeoutMs });
    await sessionsBackButton.click();
    await page.waitForURL(
      (url) => parseMobileProfileHomeRoute(url.pathname)?.profileId === profileId,
      { timeout: timeoutMs },
    );
    sessionsBackToHome = true;
  } else {
    assert.deepEqual(parseMobileProfileHomeRoute(taskBackPath), { profileId });
  }
  const homePath = new URL(page.url()).pathname;
  assert.deepEqual(parseMobileProfileHomeRoute(homePath), { profileId });

  await page.getByTestId("sessions").click();
  await page.waitForURL((url) => isMobileSessionsRoute(url.pathname), {
    timeout: timeoutMs,
  });
  const sessionsPath = new URL(page.url()).pathname;
  await page.getByTestId("sessions-list").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  const sessionRow = page.getByTestId("session-" + threadId);
  await sessionRow.waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(
    await sessionRow.count(),
    1,
    "history must contain exactly one row for the current task",
  );
  await sessionRow.click();
  await page.waitForURL(
    (url) => {
      const route = parseMobileTaskRoute(url.pathname);
      return (
        route?.profileId === profileId &&
        route.serverId === expectedTask.serverId &&
        route.threadId === threadId
      );
    },
    { timeout: timeoutMs },
  );
  await page
    .locator('[data-testid="message-input-root"]:visible')
    .waitFor({ state: "visible", timeout: timeoutMs });
  const reentryPath = new URL(page.url()).pathname;
  assert.equal(reentryPath, expectedTaskPath);

  return {
    taskBackActivation: backActivation,
    taskBackRoute: isMobileSessionsRoute(taskBackPath)
      ? "/sessions"
      : safeMobileProfileHomeRoute(taskBackPath),
    homeRoute: safeMobileProfileHomeRoute(homePath),
    sessionsBackToHome,
    sessionsRoute: "/sessions",
    rowCount: 1,
    reentryTaskRoute: safeTaskRoute(reentryPath),
    taskRouteRestored: true,
  };
}

const SAFE_STATIC_TEST_IDS = new Set([
  "sessions",
  "sessions-list",
  "session-search",
  "message-input-root",
  "message-input",
  "message-assistant",
  "message-user",
  "message-processing-toggle",
  "send-message",
  "task-header",
  "task-header-title",
  "new-workspace",
  "new-workspace-prompt",
  "create-workspace",
  "workspace-path",
  "server-option-local",
  "welcome-direct-connection",
  "gateway-token",
]);

function safeDomTestId(value) {
  if (typeof value !== "string") return null;
  if (SAFE_STATIC_TEST_IDS.has(value)) return value;
  if (/^session-actions-[A-Za-z0-9._:%-]+$/.test(value)) return "session-actions-:id";
  if (/^session-[A-Za-z0-9._:%-]+$/.test(value)) return "session-:id";
  if (/^tool-call-toggle-[A-Za-z0-9._:%-]+$/.test(value)) return "tool-call-toggle-:id";
  if (/^tool-call-[A-Za-z0-9._:%-]+$/.test(value)) return "tool-call-:id";
  if (/^workspace-option-.+$/.test(value)) return "workspace-option-:path";
  return null;
}

/** Normalize a DOM projection without retaining text, values, URLs, or IDs. */
export function summarizeMobileDomProjection(projection) {
  const elements = Array.isArray(projection?.elements)
    ? projection.elements.slice(0, 2_000)
    : [];
  const normalizedElements = elements.map((element) => ({
    tag: typeof element?.tag === "string" ? element.tag.toLowerCase() : "unknown",
    role: typeof element?.role === "string" ? element.role : null,
    testId: safeDomTestId(element?.testId),
    visible: element?.visible === true,
  }));
  const visibleTestIds = [
    ...new Set(
      normalizedElements
        .filter((element) => element.visible)
        .map((element) => element.testId)
        .filter(Boolean),
    ),
  ].slice(0, 200);
  const canonical = {
    routeClass:
      ["profile-home", "sessions", "task", "new-workspace"].includes(
        projection?.routeClass,
      )
        ? projection.routeClass
        : "other",
    nodeCount: normalizedElements.length,
    visibleNodeCount: normalizedElements.filter((element) => element.visible).length,
    visibleTestIds,
    structure: normalizedElements,
  };
  return {
    ...canonical,
    structureSha256: createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex"),
  };
}

/**
 * Capture failure evidence while masking all rendered text and form values.
 * The JSON stores only a structural DOM digest and safe route/test-id classes.
 */
export async function captureRedactedMobileHistoryFailure(
  page,
  context,
  { stage, error, providerCounters = null },
) {
  let dom = null;
  try {
    const projection = await page.evaluate(() => {
      const visible = (element) => element.getClientRects().length > 0;
      const pathname = window.location.pathname;
      const segments = pathname.split("/").filter(Boolean);
      const routeClass =
        segments.length === 2 && segments[0] === "h"
          ? "profile-home"
          : segments.length === 1 && segments[0] === "sessions"
            ? "sessions"
            : segments[0] === "task" ||
                (segments[0] === "h" && segments[2] === "task")
              ? "task"
              : segments.at(-1) === "new"
                ? "new-workspace"
                : "other";
      return {
        routeClass,
        elements: Array.from(document.body?.querySelectorAll("*") ?? [])
          .slice(0, 2_000)
          .map((element) => ({
            tag: element.tagName,
            role: element.getAttribute("role"),
            testId: element.getAttribute("data-testid"),
            visible: visible(element),
          })),
      };
    });
    dom = summarizeMobileDomProjection(projection);
  } catch {
    dom = null;
  }

  const screenshotName = `mobile-history-failure-${safeEvidenceSlug(stage)}.png`;
  let screenshotSha256 = null;
  let screenshotStatus = "unavailable";
  try {
    const bytes = await page.screenshot({
      path: context.pathInArtifacts(screenshotName),
      fullPage: true,
      animations: "disabled",
      style:
        "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}input,textarea,[contenteditable=true]{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}",
    });
    screenshotSha256 = createHash("sha256").update(bytes).digest("hex");
    screenshotStatus = "saved-text-masked";
  } catch {
    screenshotStatus = "capture-failed";
  }

  const safeCounters = providerCounters
    ? Object.fromEntries(
        [
          "forwardedRequests",
          "forwardedPostRequests",
          "locallyRejectedRequests",
          "blockedRedirectResponses",
          "inFlightRequests",
        ].map((name) => [
          name,
          Number.isSafeInteger(providerCounters[name])
            ? providerCounters[name]
            : null,
        ]),
      )
    : null;
  const evidence = {
    stage: safeEvidenceSlug(stage),
    errorName:
      typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name)
        ? error.name
        : "Error",
    safeRoute:
      dom?.routeClass === "task"
        ? safeTaskRoute(new URL(page.url()).pathname)
        : dom?.routeClass === "profile-home"
          ? "/h/:profile"
          : dom?.routeClass === "sessions"
            ? "/sessions"
            : dom?.routeClass === "new-workspace"
              ? "/new"
              : "/unrecognized-route",
    domStructureSha256: dom?.structureSha256 ?? null,
    domNodeCount: dom?.nodeCount ?? null,
    domVisibleNodeCount: dom?.visibleNodeCount ?? null,
    visibleTestIds: dom?.visibleTestIds ?? [],
    screenshotName: screenshotStatus === "saved-text-masked" ? screenshotName : null,
    screenshotSha256,
    screenshotStatus,
    providerCounters: safeCounters,
  };
  await context.writeArtifactJson("mobile-real-provider-history-failure-evidence.json", evidence);
  return evidence;
}

function safeEvidenceSlug(value) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "unknown"
    : "unknown";
}

/**
 * Persist the final budget ledger from a RunContext cleanup callback.
 * The internal writer is intentional: RunContext is already finishing when
 * cleanups execute, and it still enforces artifact containment and redaction.
 */
export async function writeProviderBudgetFinalLedger(
  context,
  {
    previousRunIds,
    previousRunCumulativeUpperBound,
    previousRunProxyCounterPersisted,
    previousRunObservedTransportAttempts,
    currentRunMaxForwardedRequests,
    cumulativeMaximum,
    counters,
    observedAttempts,
  },
) {
  assert.ok(context && typeof context.writeArtifactJsonInternal === "function");
  assert.ok(Number.isSafeInteger(previousRunCumulativeUpperBound));
  assert.ok(Array.isArray(previousRunIds) && previousRunIds.length > 0);
  assert.ok(Number.isSafeInteger(currentRunMaxForwardedRequests));
  assert.ok(Number.isSafeInteger(cumulativeMaximum));
  assert.ok(counters && typeof counters === "object");
  assert.ok(Array.isArray(observedAttempts));

  const safeAttempts = observedAttempts.map((attempt) => ({
    protocol: typeof attempt.protocol === "string" ? attempt.protocol : null,
    outcome: typeof attempt.outcome === "string" ? attempt.outcome : null,
    status: Number.isSafeInteger(attempt.status) ? attempt.status : null,
    elapsedUs: Number.isSafeInteger(attempt.elapsedUs) ? attempt.elapsedUs : null,
    inputTokens: Number.isSafeInteger(attempt.inputTokens)
      ? attempt.inputTokens
      : null,
    outputTokens: Number.isSafeInteger(attempt.outputTokens)
      ? attempt.outputTokens
      : null,
  }));
  const upstreamRequestUpperBound =
    previousRunCumulativeUpperBound + counters.forwardedRequests;
  const observerMatchesProxyForwardedPosts =
    safeAttempts.length === counters.forwardedPostRequests;

  await context.writeArtifactJsonInternal(
    "provider-budget-proxy-final-stats.json",
    {
      previousRun: {
        runIds: [...previousRunIds],
        cumulativeUpstreamUpperBound: previousRunCumulativeUpperBound,
        exactProxyForwardCounterPersisted: previousRunProxyCounterPersisted,
        observedTransportAttempts: previousRunObservedTransportAttempts,
      },
      currentRun: {
        maxForwardedRequests: currentRunMaxForwardedRequests,
        counters,
        observedProviderTransportAttempts: safeAttempts.length,
        observerMatchesProxyForwardedPosts,
        observedAttempts: safeAttempts,
      },
      cumulativeAccounting: {
        previousRunUpperBound: previousRunCumulativeUpperBound,
        currentRunForwardedRequests: counters.forwardedRequests,
        upstreamRequestUpperBound,
        maximum: cumulativeMaximum,
        withinBudget: upstreamRequestUpperBound <= cumulativeMaximum,
      },
    },
  );

  assert.equal(counters.inFlightRequests, 0);
  assert.ok(counters.forwardedRequests <= currentRunMaxForwardedRequests);
  assert.equal(safeAttempts.length, counters.forwardedPostRequests);
  assert.ok(upstreamRequestUpperBound <= cumulativeMaximum);
  return { upstreamRequestUpperBound, observerMatchesProxyForwardedPosts };
}

function strictPathSegments(pathname) {
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
    pathname === "/" ||
    pathname.endsWith("/") ||
    pathname.includes("//")
  ) {
    return [];
  }
  return pathname.slice(1).split("/");
}

function decodePathSegment(segment) {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded && !/[\\/\0]/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
