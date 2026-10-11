import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const baselineMobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(baselineMobileDist, "index.html"));

const STALLED_REQUEST_OBSERVATION_MS = 12_000;
const SESSION_PATH = "/api/mobile/session";

await runE2E(import.meta.url, {
  testId: "mobile-web-boundary-login-session-timeout-focus-responsive",
  tier: "model-independent",
  modelPolicy: "model-independent real Gateway and Chromium UI; session/DELETE responses and one browser profile-index write are fault-injected",
  retainSuccessLogs: true,
}, async context => {
  let mobileDist = baselineMobileDist;
  if (process.env.KCODER_E2E_BUILD_MOBILE_WEB === "1") {
    const mobileRoot = resolve(appRoot, "mobile");
    mobileDist = context.pathInState("mobile-dist");
    const exporter = context.spawnOwned("mobile-web-boundary-export", process.execPath, [
      resolve(mobileRoot, "node_modules/expo/bin/cli"), "export", "--platform", "web", "--output-dir", mobileDist,
    ], {
      cwd: mobileRoot,
      env: context.isolatedEnvironment({ CI: "1", EXPO_NO_TELEMETRY: "1", EXPO_NO_DOTENV: "1" }),
    });
    await waitFor(() => exporter.exitCode !== null || exporter.signalCode !== null, 180_000, "isolated current-source Mobile Web export", 100, context.abortSignal);
    assert.equal(exporter.exitCode, 0, "isolated Mobile Web export must complete before the browser check");
    await access(resolve(mobileDist, "index.html"));
    await context.stopOwned("mobile-web-boundary-export");
  }
  const mobileDistProvenance = await inspectBundle(mobileDist);
  const sourceFileHashes = {};
  for (const relativePath of [
    "src/app/welcome.tsx",
    "src/app/settings.tsx",
    "src/gateway/http.ts",
    "src/state/AppContext.tsx",
    "src/state/profile-coordinator.ts",
    "src/state/profile-connection-effects.ts",
    "src/storage/profile-store.ts",
  ]) {
    const source = await readFile(resolve(appRoot, "mobile", relativePath));
    sourceFileHashes[relativePath] = createHash("sha256").update(source).digest("hex");
  }
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-web-boundary-gateway",
    workspace,
    env: { KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const secondWorkspace = context.pathInState("workspace-second-profile");
  await mkdir(secondWorkspace, { recursive: true });
  const secondGateway = await startGateway(context, {
    auth: true,
    label: "mobile-web-boundary-second-profile-gateway",
    workspace: secondWorkspace,
    env: {
      KCODER_STUDIO_WEB_ROOT: mobileDist,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: gateway.baseUrl,
    },
  });
  const chromium = await startChromium(context, { label: "mobile-web-boundary-chromium" });
  let page = await chromium.browser.contexts()[0].newPage();
  const pageErrors = [];
  const consoleMessages = [];
  const httpIssueEvents = [];
  const requestLifecycleEvents = [];
  const requestMetadata = new WeakMap();
  const requestIds = new WeakMap();
  let requestSequence = 0;
  let heldDeleteRequestId = null;
  let heldDeleteRouteFulfillResolved = false;
  let diagnosticPhase = "gateway-login-page-load";
  const safeDiagnosticText = value => context.redactText(String(value ?? ""));
  const requestLocation = request => {
    try {
      const parsed = new URL(request.url());
      const gatewayName = parsed.origin === gateway.baseUrl ? "gateway-a"
        : parsed.origin === secondGateway.baseUrl ? "gateway-b" : "other-origin";
      return { gateway: gatewayName, path: parsed.pathname };
    } catch {
      return { gateway: "non-http", path: null };
    }
  };
  const attachBrowserDiagnostics = targetPage => {
    targetPage.on("pageerror", error => pageErrors.push({
      phase: diagnosticPhase,
      name: error.name || "Error",
      message: safeDiagnosticText(error.message),
      stack: safeDiagnosticText(error.stack ?? ""),
    }));
    targetPage.on("console", message => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      let locationPath = null;
      try { locationPath = new URL(message.location().url).pathname; } catch { /* non-HTTP console locations have no request path */ }
      consoleMessages.push({
        phase: diagnosticPhase,
        type: message.type(),
        text: safeDiagnosticText(message.text()),
        locationPath,
        line: message.location().lineNumber,
        column: message.location().columnNumber,
      });
    });
    targetPage.on("request", request => {
      const info = {
        requestId: `browser-request-${++requestSequence}`,
        ...requestLocation(request),
        phase: diagnosticPhase,
        method: request.method(),
      };
      requestIds.set(request, info.requestId);
      requestMetadata.set(request, info);
      if (info.path === SESSION_PATH && (info.method === "POST" || info.method === "DELETE")) {
        requestLifecycleEvents.push({ ...info, kind: "request", atUnixMs: Date.now(), status: null, failure: null });
      }
    });
    targetPage.on("response", response => {
      const request = response.request();
      const info = requestMetadata.get(request) ?? {
        requestId: requestIds.get(request) ?? `browser-request-untracked-${++requestSequence}`,
        ...requestLocation(request),
        phase: diagnosticPhase,
        method: request.method(),
      };
      if (info.path === SESSION_PATH && (info.method === "POST" || info.method === "DELETE")) {
        requestLifecycleEvents.push({ ...info, kind: "response", atUnixMs: Date.now(), status: response.status(), failure: null });
      }
      if (response.status() >= 400) {
        httpIssueEvents.push({ ...info, kind: "response", status: response.status(), failure: null });
      }
    });
    targetPage.on("requestfinished", request => {
      const info = requestMetadata.get(request) ?? {
        requestId: requestIds.get(request) ?? `browser-request-untracked-${++requestSequence}`,
        ...requestLocation(request),
        phase: diagnosticPhase,
        method: request.method(),
      };
      if (info.path === SESSION_PATH && (info.method === "POST" || info.method === "DELETE")) {
        requestLifecycleEvents.push({ ...info, kind: "requestfinished", atUnixMs: Date.now(), status: null, failure: null });
      }
    });
    targetPage.on("requestfailed", request => {
      const info = requestMetadata.get(request) ?? {
        requestId: requestIds.get(request) ?? `browser-request-untracked-${++requestSequence}`,
        ...requestLocation(request),
        phase: diagnosticPhase,
        method: request.method(),
      };
      const failure = safeDiagnosticText(request.failure()?.errorText ?? "unknown request failure");
      if (info.path === SESSION_PATH && (info.method === "POST" || info.method === "DELETE")) {
        requestLifecycleEvents.push({ ...info, kind: "requestfailed", atUnixMs: Date.now(), status: null, failure });
      }
      httpIssueEvents.push({ ...info, kind: "requestfailed", status: null, failure });
    });
  };
  const classifyHttpIssue = issue => {
    if (issue.gateway !== "gateway-a") return "unexpected";
    if (issue.kind === "response" && issue.phase === "invalid-token-login" && issue.method === "POST" && issue.path === "/login" && issue.status === 401)
      return "expected-invalid-token-login";
    if (issue.kind === "requestfailed" && issue.method === "POST" && issue.path === SESSION_PATH) {
      if (issue.phase === "session-timeout-fault") return "expected-stalled-session-timeout";
      if (issue.phase === "session-timeout-retry") return "expected-stalled-session-retry-abort";
      if (issue.phase === "modal-close-no-new-connection") return "expected-modal-close-session-cancellation";
      if (issue.phase === "interleaved-old-endpoint") return "expected-interleaved-session-cancellation";
    }
    if (issue.kind === "requestfailed" && issue.method === "DELETE" && issue.path === SESSION_PATH &&
      issue.phase === "settings-delete-held-delete" && issue.requestId === heldDeleteRequestId &&
      heldDeleteRouteFulfillResolved && issue.failure === "net::ERR_ABORTED") {
      return "expected-held-delete-browser-cancellation-after-route-fulfill";
    }
    return "unexpected";
  };
  const classifyConsoleMessage = event => {
    if (/^props\.pointerEvents is deprecated\. Use style\.pointerEvents\.?$/i.test(event.text.trim())) return "known-pointer-events-deprecation";
    if (/failed to load resource|failed to fetch/i.test(event.text)) {
      const expectedIssue = httpIssueEvents
        .map(issue => ({ issue, classification: classifyHttpIssue(issue) }))
        .find(candidate => candidate.classification !== "unexpected" && candidate.issue.phase === event.phase &&
          (!event.locationPath || candidate.issue.path === event.locationPath));
      if (expectedIssue) return `expected-console-for-${expectedIssue.classification}`;
    }
    return "unexpected";
  };
  attachBrowserDiagnostics(page);
  await page.setViewportSize({ width: 390, height: 844 });

  diagnosticPhase = "gateway-login-page-load";
  const loginResponse = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(loginResponse?.status(), 200, "unauthenticated page load should show the Gateway login form");
  const rejectedToken = `invalid-login-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  context.registerSecret(rejectedToken);
  diagnosticPhase = "invalid-token-login";
  await page.locator('input[name="token"]').fill(rejectedToken);
  const rejectedLoginResponse = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/login") && response.request().method() === "POST"),
    page.locator('button[type="submit"]').click(),
  ]).then(([response]) => response);
  const rejectedLoginMessage = await page.getByText("访问令牌不正确。", { exact: true }).isVisible();
  assert.equal(rejectedLoginResponse.status(), 401, "Gateway must reject an invalid access token");
  assert.equal(rejectedLoginMessage, true, "login failure must be visible and recoverable");

  diagnosticPhase = "valid-token-login";
  await page.locator('input[name="token"]').fill(gateway.authToken);
  const acceptedLoginResponse = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/login") && response.request().method() === "POST"),
    page.locator('button[type="submit"]').click(),
  ]).then(([response]) => response);
  assert.equal(acceptedLoginResponse.status(), 303, "valid access token should establish the isolated browser session");
  diagnosticPhase = "welcome-and-responsive-layout";
  await page.locator('[data-testid="welcome-direct-connection"]:visible').waitFor({ state: "visible", timeout: 30_000 });

  const responsiveWidths = [];
  for (const width of [360, 390, 768]) {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 844 });
    const dimensions = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    responsiveWidths.push({ width, ...dimensions, noHorizontalOverflow: dimensions.documentWidth <= width && dimensions.bodyWidth <= width });
  }
  await page.setViewportSize({ width: 390, height: 844 });

  const openerObservations = [];
  const addGatewayAccessibilityFindings = [];
  const addGatewayKeyboardObservations = [];
  const allOpeners = () => page.locator('[data-testid="welcome-direct-connection"]');
  const oneVisibleTestId = async testId => {
    const candidates = page.locator(`[data-testid="${testId}"]:visible`);
    await candidates.waitFor({ state: "visible", timeout: 10_000 });
    const count = await candidates.count();
    assert.equal(count, 1, `active route ${new URL(page.url()).pathname} must expose exactly one visible ${testId}: ${count}`);
    return candidates;
  };
  const openDirectConnection = async stage => {
    await page.waitForTimeout(350);
    const candidates = await inspectWelcomeOpeners(page);
    const exposedIndexes = candidates.filter(candidate => candidate.visibleByGeometry &&
      candidate.hidden !== "true" && !candidate.hiddenByAncestor && !candidate.inertByAncestor).map(candidate => candidate.index);
    const observation = {
      path: new URL(page.url()).pathname,
      cssVisibleCount: candidates.filter(candidate => candidate.visibleByGeometry).length,
      exposedVisibleCount: exposedIndexes.length,
      candidates,
    };
    openerObservations.push(observation);
    await context.writeArtifactJson(`opener-${stage}.json`, observation);
    assert.equal(exposedIndexes.length, 1, `the active route must expose exactly one visible non-hidden connection opener: ${JSON.stringify(observation)}`);
    await allOpeners().nth(exposedIndexes[0]).click();
  };
  await page.setViewportSize({ width: 390, height: 320 });
  diagnosticPhase = "short-viewport-connect-modal";
  await openDirectConnection("short-viewport");
  await (await oneVisibleTestId("gateway-endpoint")).waitFor({ state: "visible", timeout: 10_000 });
  const shortViewportConnect = await oneVisibleTestId("gateway-connect");
  const shortViewportButtonBoxBeforeScroll = await shortViewportConnect.boundingBox();
  await shortViewportConnect.scrollIntoViewIfNeeded().catch(() => {});
  const shortViewportButtonBoxAfterScroll = await shortViewportConnect.boundingBox();
  const shortViewportDialog = page.locator('[role="dialog"]:visible');
  await shortViewportDialog.waitFor({ state: "visible", timeout: 10_000 });
  const shortViewportDialogCount = await shortViewportDialog.count();
  assert.equal(shortViewportDialogCount, 1, "390x320 active route must expose exactly one visible connection dialog");
  const shortViewportModal = await shortViewportDialog.boundingBox().catch(() => null);
  const shortViewportDialogAttributes = await shortViewportDialog.evaluate(element => ({
    role: element.getAttribute("role"),
    label: element.getAttribute("aria-label"),
    hidden: element.getAttribute("aria-hidden"),
    modal: element.getAttribute("aria-modal"),
  })).catch(() => null);
  const shortViewportModalFits = Boolean(shortViewportButtonBoxAfterScroll &&
    shortViewportButtonBoxAfterScroll.y >= 0 && shortViewportButtonBoxAfterScroll.y + shortViewportButtonBoxAfterScroll.height <= 320);
  await page.screenshot({ path: context.pathInArtifacts("connection-modal-390x320.png"), fullPage: true });
  await context.writeArtifactJson("connection-modal-390x320-evidence.json", {
    currentPath: new URL(page.url()).pathname,
    viewport: { width: 390, height: 320 },
    visibleDialogCount: shortViewportDialogCount,
    buttonBeforeScroll: shortViewportButtonBoxBeforeScroll,
    buttonAfterScroll: shortViewportButtonBoxAfterScroll,
    dialog: shortViewportModal,
    dialogAttributes: shortViewportDialogAttributes,
    screenshot: "connection-modal-390x320.png",
    nativeSoftKeyboard: "UNVERIFIED; browser viewport reduction is not native keyboard simulation",
  });
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="gateway-endpoint"]:visible').waitFor({ state: "hidden", timeout: 10_000 });
  await page.setViewportSize({ width: 390, height: 844 });

  diagnosticPhase = "keyboard-focus-modal";
  await openDirectConnection("focus-modal");
  await (await oneVisibleTestId("gateway-endpoint")).waitFor({ state: "visible", timeout: 10_000 });
  const dialogCountAtOpen = await page.getByRole("dialog").count();
  await page.waitForTimeout(350);
  const connectDialog = page.getByRole("dialog", { name: "Direct connection", exact: true });
  const connectDialogCount = await page.getByRole("dialog").count();
  const namedConnectDialogCount = await connectDialog.count();
  const normalViewportDialog = page.locator('[role="dialog"]:visible');
  const normalViewportDialogCount = await normalViewportDialog.count();
  assert.equal(normalViewportDialogCount, 1, "active route must expose exactly one visible connection dialog after opening settles");
  const normalViewportDialogAttributes = await normalViewportDialog.evaluate(element => ({
    documentLanguage: document.documentElement.lang,
    visibleHeading: document.querySelector("h1")?.textContent?.trim() ?? null,
    role: element.getAttribute("role"),
    label: element.getAttribute("aria-label"),
    labelledBy: element.getAttribute("aria-labelledby"),
    hidden: element.getAttribute("aria-hidden"),
    modal: element.getAttribute("aria-modal"),
    tabIndex: element.getAttribute("tabindex"),
    ancestors: (() => {
      const values = [];
      for (let parent = element.parentElement; parent && values.length < 5; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        values.push({
          tag: parent.tagName,
          role: parent.getAttribute("role"),
          label: parent.getAttribute("aria-label"),
          hidden: parent.getAttribute("aria-hidden"),
          inert: parent.hasAttribute("inert"),
          display: style.display,
          visibility: style.visibility,
        });
      }
      return values;
    })(),
  })).catch(() => null);
  const normalViewportDialogAriaSnapshot = await normalViewportDialog.ariaSnapshot().catch(() => null);
  const connectDialogName = normalViewportDialogAttributes?.label ?? null;
  await context.writeArtifactJson("mobile-web-boundary-dialog-evidence.json", {
    genericDialogCountAtOpen: dialogCountAtOpen,
    computedDialogRoleCount: connectDialogCount,
    visibleDialogCountAfterSettle: normalViewportDialogCount,
    namedEnglishDialogCount: namedConnectDialogCount,
    dialogLabelAttribute: connectDialogName,
    dialogAriaSnapshot: normalViewportDialogAriaSnapshot,
    dialogAttributes: normalViewportDialogAttributes,
    activeDocumentLanguage: normalViewportDialogAttributes?.documentLanguage ?? null,
    visibleHeading: normalViewportDialogAttributes?.visibleHeading ?? null,
  });
  const focusTarget = () => page.evaluate(() => ({
    testId: document.activeElement?.getAttribute("data-testid") ?? null,
    label: document.activeElement?.getAttribute("aria-label") ?? null,
  }));
  const initialFocus = await focusTarget();
  await (await oneVisibleTestId("gateway-endpoint")).press("Shift+Tab");
  const reverseTabFocus = await focusTarget();
  await (await oneVisibleTestId("gateway-endpoint")).focus();
  await page.keyboard.press("Tab");
  const forwardTabFocus = await focusTarget();
  await page.keyboard.press("Escape");
  await connectDialog.waitFor({ state: "hidden", timeout: 10_000 });
  const focusReturnedToOpener = await page.evaluate(() =>
    document.activeElement?.getAttribute("data-testid") === "welcome-direct-connection",
  );

  await page.setViewportSize({ width: 390, height: 320 });
  diagnosticPhase = "session-timeout-fault";
  await openDirectConnection("stalled-session");
  await (await oneVisibleTestId("gateway-endpoint")).fill(gateway.baseUrl);
  await (await oneVisibleTestId("gateway-token")).fill(gateway.authToken);
  const submitConnect = await oneVisibleTestId("gateway-connect");
  await submitConnect.scrollIntoViewIfNeeded().catch(() => {});
  const shortViewportButtonBoxAtSubmit = await submitConnect.boundingBox();
  const shortViewportSubmitFullyVisible = Boolean(shortViewportButtonBoxAtSubmit &&
    shortViewportButtonBoxAtSubmit.y >= 0 && shortViewportButtonBoxAtSubmit.y + shortViewportButtonBoxAtSubmit.height <= 320);

  const profileIndexKey = "kcoder-studio-mobile.gateway-profiles.v2";
  const profileStateBeforeStall = await readProfileState(page, profileIndexKey);
  let stallStartedAt = null;
  let requestFailedElapsedMs = null;
  let sessionRequestPhase = "session-timeout-fault";
  let stalledPostCount = 0;
  const releaseStalledRoutes = [];
  const sessionRequestFailures = [];
  const matchesSessionPath = url => {
    try { return new URL(url).origin === gateway.baseUrl && new URL(url).pathname === SESSION_PATH; }
    catch { return false; }
  };
  const onSessionRequest = request => {
    if (request.method() === "POST" && matchesSessionPath(request.url())) stallStartedAt = Date.now();
  };
  const onSessionRequestFailed = request => {
    if (request.method() === "POST" && matchesSessionPath(request.url()) && stallStartedAt !== null) {
      requestFailedElapsedMs ??= Date.now() - stallStartedAt;
    }
    if (request.method() === "POST" && matchesSessionPath(request.url())) {
      sessionRequestFailures.push({
        requestId: requestIds.get(request) ?? null,
        phase: sessionRequestPhase,
        path: new URL(request.url()).pathname,
        failure: request.failure()?.errorText ?? null,
      });
    }
  };
  page.on("request", onSessionRequest);
  page.on("requestfailed", onSessionRequestFailed);

  const stallHandler = route => new Promise(resolveRoute => {
    stallStartedAt ??= Date.now();
    stalledPostCount += 1;
    releaseStalledRoutes.push(async () => {
      try { await route.abort("failed"); } catch { /* The client timeout may already have cancelled this request. */ }
      resolveRoute();
    });
  });
  const sessionRoute = url => matchesSessionPath(url);
  await page.route(sessionRoute, stallHandler);
  context.addCleanup("release pending Mobile Web session fault routes", async () => {
    await Promise.all(releaseStalledRoutes.map(release => release()));
  });
  const requestStarted = page.waitForRequest(request =>
    request.method() === "POST" && matchesSessionPath(request.url()),
  { timeout: 10_000 });
  await (await oneVisibleTestId("gateway-connect")).click();
  await requestStarted;
  const shortViewportConnectRequestStarted = true;
  await page.waitForTimeout(STALLED_REQUEST_OBSERVATION_MS);

  const alert = page.getByRole("alert");
  const alertVisibleBeforeRelease = await alert.isVisible().catch(() => false);
  const alertTextBeforeRelease = alertVisibleBeforeRelease ? await alert.textContent() : null;
  const connectEnabledBeforeRelease = await (await oneVisibleTestId("gateway-connect")).isEnabled();
  const profileStateBeforeRelease = await readProfileState(page, profileIndexKey);
  const stalledWaitMs = Date.now() - stallStartedAt;
  const screenshotPath = context.pathInArtifacts("session-post-stalled-before-release.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const requestFailedBeforeManualRelease = requestFailedElapsedMs !== null;
  const requestFailedElapsedBeforeManualReleaseMs = requestFailedElapsedMs;

  await releaseStalledRoutes[0]?.();
  await alert.waitFor({ state: "visible", timeout: 30_000 });
  const connectEnabledAfterRelease = await (await oneVisibleTestId("gateway-connect")).isEnabled();
  diagnosticPhase = "session-timeout-retry";
  sessionRequestPhase = "session-timeout-retry";
  const retryRequestStarted = page.waitForRequest(request =>
    request.method() === "POST" && matchesSessionPath(request.url()),
  { timeout: 10_000 });
  await (await oneVisibleTestId("gateway-connect")).click();
  await retryRequestStarted;
  const retryPostIssued = stalledPostCount === 2;
  await releaseStalledRoutes[1]?.();
  await alert.waitFor({ state: "visible", timeout: 30_000 });
  const connectEnabledAfterRetry = await (await oneVisibleTestId("gateway-connect")).isEnabled();
  const timeoutRequestFailedElapsedMs = requestFailedElapsedMs;
  page.off("request", onSessionRequest);
  page.off("requestfailed", onSessionRequestFailed);
  await page.unroute(sessionRoute, stallHandler);
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="gateway-endpoint"]:visible').waitFor({ state: "hidden", timeout: 10_000 });

  const createHeldSessionResponse = () => {
    const probe = {
      gatewayStatus: null,
      containsExpectedSessionMaterial: false,
      responseBodyBytes: 0,
      releaseAttempted: false,
      routeFulfillResolved: false,
      requestId: null,
      failedRequestCountBeforeRelease: 0,
      release: null,
      ready: null,
    };
    let resolveReady;
    probe.ready = new Promise(resolveResponse => { resolveReady = resolveResponse; });
    const responseHandler = async route => {
      const browserRequest = route.request();
      probe.requestId = requestIds.get(browserRequest) ?? null;
      const response = await route.fetch();
      probe.gatewayStatus = response.status();
      const body = await response.body();
      probe.responseBodyBytes = body.byteLength;
      try {
        const payload = JSON.parse(body.toString("utf8"));
        for (const secret of [payload.accessToken, payload.rpcToken]) {
          if (typeof secret === "string" && secret.length >= 8) context.registerSecret(secret);
        }
        probe.containsExpectedSessionMaterial = typeof payload.accessToken === "string" && payload.accessToken.length >= 8;
      } catch {
        probe.containsExpectedSessionMaterial = false;
      }
      resolveReady();
      await new Promise(resolveFulfill => {
        probe.release = async () => {
          probe.releaseAttempted = true;
          try {
            await route.fulfill({ response });
            probe.routeFulfillResolved = true;
          } catch {
            // Modal-close cancellation can close the browser request before a late response is released.
            probe.routeFulfillResolved = false;
          } finally {
            resolveFulfill();
          }
        };
      });
    };
    context.addCleanup("release held successful Mobile Web session response", async () => {
      await probe.release?.();
    });
    return { probe, responseHandler };
  };
  const browserLifecycleFor = probe => requestLifecycleEvents.filter(event => event.requestId === probe.requestId);
  const browserOutcomeFor = probe => {
    const events = browserLifecycleFor(probe);
    const responseEvents = events.filter(event => event.kind === "response");
    const finished = events.some(event => event.kind === "requestfinished");
    const failed = events.find(event => event.kind === "requestfailed");
    const successfulResponseCompleted = responseEvents.some(event => event.status === 200) && finished;
    return {
      requestId: probe.requestId,
      events,
      responseObserved: responseEvents.length > 0,
      responseStatuses: responseEvents.map(event => event.status),
      requestFinishedObserved: finished,
      requestFailure: failed?.failure ?? null,
      completedSuccessfulResponse: successfulResponseCompleted,
      outcome: successfulResponseCompleted ? "browser-response-200-and-requestfinished"
        : failed && responseEvents.length ? "browser-response-observed-then-requestfailed-before-finish"
          : failed ? "browser-requestfailed-without-response"
          : responseEvents.length ? "browser-response-observed-but-not-completed" : "UNVERIFIED",
    };
  };
  const settingsButton = async () => {
    await page.waitForTimeout(350);
    const visibleCandidates = page.locator('[role="button"]:visible').filter({ hasText: /settings|设置/i });
    const count = await visibleCandidates.count();
    assert.equal(count, 1, `current route must expose exactly one visible Settings control: ${count}`);
    return visibleCandidates;
  };
  const addGatewayButton = async () => {
    await page.waitForTimeout(350);
    const visibleCandidates = page.locator('[role="button"]:visible').filter({ hasText: /^(Add Gateway|添加 Gateway|添加网关)$/i });
    const count = await visibleCandidates.count();
    if (count !== 1) {
      const evidence = await page.locator("body").evaluate(body => {
        const labels = new Set(["add gateway", "添加 gateway", "添加网关"]);
        const nodes = [...body.querySelectorAll("*")].filter(element => labels.has(element.textContent?.trim().toLocaleLowerCase() ?? ""));
        const describe = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const ancestors = [];
          for (let current = element, depth = 0; current && depth < 5; current = current.parentElement, depth += 1) {
            const currentStyle = getComputedStyle(current);
            ancestors.push({
              tagName: current.tagName.toLowerCase(),
              role: current.getAttribute("role"),
              ariaLabel: current.getAttribute("aria-label"),
              tabIndex: current.tabIndex,
              hidden: current.hasAttribute("hidden"),
              inert: current.hasAttribute("inert"),
              display: currentStyle.display,
              visibility: currentStyle.visibility,
              opacity: currentStyle.opacity,
            });
          }
          return {
            label: element.textContent?.trim() ?? "",
            tagName: element.tagName.toLowerCase(),
            role: element.getAttribute("role"),
            ariaLabel: element.getAttribute("aria-label"),
            tabIndex: element.tabIndex,
            hidden: element.hasAttribute("hidden"),
            inert: element.hasAttribute("inert"),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            ancestors,
          };
        };
        return {
          language: document.documentElement.lang,
          path: location.pathname,
          exactTextCandidates: nodes.map(describe),
        };
      });
      const finding = { expectedSemanticButtonCount: 1, actualSemanticButtonCount: count, ...evidence };
      addGatewayAccessibilityFindings.push(finding);
      await context.writeArtifactJson(`add-gateway-control-accessibility-${addGatewayAccessibilityFindings.length}.json`, finding);
      const uniqueVisibleFocusableControl = page.locator('div[tabindex="0"]:visible').filter({ hasText: /^(Add Gateway|添加 Gateway|添加网关)$/i });
      const focusableCount = await uniqueVisibleFocusableControl.count();
      assert.equal(focusableCount, 1,
        `when the named-button assertion fails, the real Settings action must still be uniquely identifiable for the remaining boundary probes: ${JSON.stringify({ path: evidence.path, language: evidence.language, focusableCount, exactTextCandidates: evidence.exactTextCandidates })}`);
      return uniqueVisibleFocusableControl;
    }
    return visibleCandidates;
  };
  const routeToSettingsFromWelcome = async () => {
    await (await settingsButton()).click();
    await page.waitForURL(url => url.pathname.endsWith("/settings"), { timeout: 10_000 });
  };
  const describeKeyboardTarget = locator => locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      tagName: element.tagName.toLowerCase(),
      text: element.textContent?.trim() ?? "",
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      ariaLabelledBy: element.getAttribute("aria-labelledby"),
      tabIndex: element.tabIndex,
      activeElement: document.activeElement === element,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
  const runSettingsAddGatewayKeyboardProbe = async key => {
    const stage = `settings-add-gateway-${key.toLowerCase()}`;
    diagnosticPhase = stage;
    if (!new URL(page.url()).pathname.endsWith("/settings")) await routeToSettingsFromWelcome();
    const addGateway = await addGatewayButton();
    const addGatewayDom = await describeKeyboardTarget(addGateway);
    await addGateway.focus();
    const addGatewayFocused = await addGateway.evaluate(element => document.activeElement === element);
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    let addGatewayKeyActivated = new URL(page.url()).pathname.endsWith("/welcome");
    if (!addGatewayKeyActivated) {
      await addGateway.click();
      await page.waitForURL(url => url.pathname.endsWith("/welcome"), { timeout: 10_000 });
    }
    const opener = await oneVisibleTestId("welcome-direct-connection");
    const openerDom = await describeKeyboardTarget(opener);
    await opener.focus();
    const openerFocused = await opener.evaluate(element => document.activeElement === element);
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    let dialogCountAfterKey = await page.locator('[role="dialog"]:visible').count();
    const dialogCountImmediatelyAfterOpenerKey = dialogCountAfterKey;
    let openerKeyActivated = dialogCountAfterKey === 1;
    if (!openerKeyActivated) {
      await opener.click();
      await page.locator('[role="dialog"]:visible').waitFor({ state: "visible", timeout: 10_000 });
      dialogCountAfterKey = await page.locator('[role="dialog"]:visible').count();
    }
    const dialog = page.locator('[role="dialog"]:visible');
    const dialogDom = dialogCountAfterKey === 1 ? await dialog.evaluate(element => ({
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      ariaLabelledBy: element.getAttribute("aria-labelledby"),
      ariaModal: element.getAttribute("aria-modal"),
    })) : null;
    const namedDialogCount = await page.getByRole("dialog", { name: "Direct connection", exact: true }).count();
    const observation = {
      key,
      settingsPathBefore: "/settings",
      addGatewayDom,
      addGatewayFocused,
      addGatewayKeyActivated,
      pathAfterAddGatewayKey: new URL(page.url()).pathname,
      openerDom,
      openerFocused,
      openerKeyActivated,
      visibleDialogCountImmediatelyAfterOpenerKey: dialogCountImmediatelyAfterOpenerKey,
      visibleDialogCountAfterKeyOrPointerFallback: dialogCountAfterKey,
      namedEnglishDialogCount: namedDialogCount,
      dialogDom,
      pointerFallbackUsedForAddGateway: !addGatewayKeyActivated,
      pointerFallbackUsedForOpener: !openerKeyActivated,
    };
    addGatewayKeyboardObservations.push(observation);
    await context.writeArtifactJson(`${stage}.json`, observation);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    if (!new URL(page.url()).pathname.endsWith("/settings")) await routeToSettingsFromWelcome();
    return observation;
  };

  const addGatewayEnterObservation = await runSettingsAddGatewayKeyboardProbe("Enter");
  const addGatewaySpaceObservation = await runSettingsAddGatewayKeyboardProbe("Space");
  // Restore the ordinary Welcome entry point used by the session fault probes.
  await (await addGatewayButton()).click();
  await page.waitForURL(url => url.pathname.endsWith("/welcome"), { timeout: 10_000 });

  // Probe 1: closing a pending connection and releasing its genuine successful
  // Gateway response on Settings must not commit that profile by itself.
  stallStartedAt = null;
  requestFailedElapsedMs = null;
  sessionRequestPhase = "modal-close-no-new-connection";
  diagnosticPhase = "modal-close-no-new-connection";
  page.on("request", onSessionRequest);
  page.on("requestfailed", onSessionRequestFailed);
  const noNewConnectionProbe = createHeldSessionResponse();
  await page.route(sessionRoute, noNewConnectionProbe.responseHandler);
  await page.setViewportSize({ width: 390, height: 844 });
  await openDirectConnection("late-session");
  await (await oneVisibleTestId("gateway-endpoint")).fill(gateway.baseUrl);
  await (await oneVisibleTestId("gateway-token")).fill(gateway.authToken);
  const noNewConnectionRequest = page.waitForRequest(request =>
    request.method() === "POST" && matchesSessionPath(request.url()),
  { timeout: 10_000 });
  await (await oneVisibleTestId("gateway-connect")).click();
  await noNewConnectionRequest;
  await waitFor(() => noNewConnectionProbe.probe.gatewayStatus !== null, 10_000, "real Gateway session response held for modal-close probe", 25, context.abortSignal);
  await noNewConnectionProbe.probe.ready;
  const noNewConnectionProfileStateBeforeClose = await readProfileState(page, profileIndexKey);
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="gateway-endpoint"]:visible').waitFor({ state: "hidden", timeout: 10_000 });
  const firstProbeModalClosedAt = Date.now();
  const firstProbeFailureCountAtClose = sessionRequestFailures.filter(event => event.phase === "modal-close-no-new-connection").length;
  await routeToSettingsFromWelcome();
  const noNewConnectionSettingsEnteredAt = Date.now();
  const noNewConnectionSettingsPath = new URL(page.url()).pathname;
  const noNewConnectionStateBeforeRelease = await readProfileState(page, profileIndexKey);
  await waitFor(() => Date.now() - noNewConnectionSettingsEnteredAt >= 1_250, 3_000,
    "wait 1-4 seconds after Settings navigation before releasing the first held response", 25, context.abortSignal);
  const noNewConnectionModalCloseDelayMs = Date.now() - firstProbeModalClosedAt;
  const noNewConnectionSettingsDelayMs = Date.now() - noNewConnectionSettingsEnteredAt;
  const noNewConnectionFailureCountBeforeRelease = sessionRequestFailures.filter(event => event.phase === "modal-close-no-new-connection").length;
  noNewConnectionProbe.probe.failedRequestCountBeforeRelease = noNewConnectionFailureCountBeforeRelease;
  await noNewConnectionProbe.probe.release?.();
  await page.waitForTimeout(1_000);
  const noNewConnectionBrowserLifecycle = browserOutcomeFor(noNewConnectionProbe.probe);
  const noNewConnectionFinalPath = new URL(page.url()).pathname;
  const noNewConnectionProfileStateAfterRelease = await readProfileState(page, profileIndexKey);
  const noNewConnectionRequestFailureEvents = sessionRequestFailures.filter(event => event.phase === "modal-close-no-new-connection");
  const noNewConnectionResponseOutcome = noNewConnectionBrowserLifecycle.outcome;
  const noNewConnectionIntentGuardEvidence = noNewConnectionBrowserLifecycle.completedSuccessfulResponse
    ? (noNewConnectionProfileStateAfterRelease.profileCount === 0 && noNewConnectionFinalPath.endsWith("/settings") ? "PASS" : "FAIL")
    : noNewConnectionBrowserLifecycle.requestFailure && !noNewConnectionBrowserLifecycle.responseObserved
      ? "UNVERIFIED: exact browser request cancellation was observed; delivered-success intent guard remains unit-only"
      : "UNVERIFIED: route.fulfill completion is not evidence of browser response delivery";
  await page.unroute(sessionRoute, noNewConnectionProbe.responseHandler);
  await context.writeArtifactJson("late-response-after-modal-close-no-new-connection.json", {
    gatewayStatus: noNewConnectionProbe.probe.gatewayStatus,
    expectedSessionFieldsPresent: noNewConnectionProbe.probe.containsExpectedSessionMaterial,
    responseBodyBytes: noNewConnectionProbe.probe.responseBodyBytes,
    releaseAttempted: noNewConnectionProbe.probe.releaseAttempted,
    routeFulfillResolved: noNewConnectionProbe.probe.routeFulfillResolved,
    browserRequestId: noNewConnectionProbe.probe.requestId,
    browserLifecycle: noNewConnectionBrowserLifecycle,
    responseOutcome: noNewConnectionResponseOutcome,
    deliveredSuccessIntentGuard: noNewConnectionIntentGuardEvidence,
    modalCloseToReleaseDelayMs: noNewConnectionModalCloseDelayMs,
    settingsToReleaseDelayMs: noNewConnectionSettingsDelayMs,
    settingsPathBeforeRelease: noNewConnectionSettingsPath,
    settingsPathAfterRelease: noNewConnectionFinalPath,
    requestFailuresAtModalClose: firstProbeFailureCountAtClose,
    requestFailuresBeforeRelease: noNewConnectionFailureCountBeforeRelease,
    requestFailureEvents: noNewConnectionRequestFailureEvents,
    profileStateBeforeClose: noNewConnectionProfileStateBeforeClose,
    profileStateBeforeRelease: noNewConnectionStateBeforeRelease,
    profileStateAfterRelease: noNewConnectionProfileStateAfterRelease,
  });

  // Probe 2: independently race another old endpoint against a newly completed
  // Gateway C connection; neither the active route nor the profile list may
  // acquire the stale endpoint.
  page.off("request", onSessionRequest);
  page.off("requestfailed", onSessionRequestFailed);
  await page.close();
  const interleavedBrowserContext = await chromium.browser.newContext();
  context.addCleanup("close isolated interleaved stale-response browser context", async () => {
    await interleavedBrowserContext.close().catch(() => undefined);
  });
  page = await interleavedBrowserContext.newPage();
  attachBrowserDiagnostics(page);
  await page.setViewportSize({ width: 390, height: 844 });
  diagnosticPhase = "interleaved-browser-login";
  const isolatedProbeLoginPage = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(isolatedProbeLoginPage?.status(), 200, "interleaving probe starts with a clean browser storage partition and Gateway login");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  const isolatedProbeLoginResponse = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/login") && response.request().method() === "POST"),
    page.locator('button[type="submit"]').click(),
  ]).then(([response]) => response);
  assert.equal(isolatedProbeLoginResponse.status(), 303, "clean interleaving partition must authenticate to the isolated Gateway");
  await page.locator('[data-testid="welcome-direct-connection"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  stallStartedAt = null;
  requestFailedElapsedMs = null;
  sessionRequestPhase = "interleaved-old-endpoint";
  diagnosticPhase = "interleaved-old-endpoint";
  page.on("request", onSessionRequest);
  page.on("requestfailed", onSessionRequestFailed);
  const interleavedProbe = createHeldSessionResponse();
  await page.route(sessionRoute, interleavedProbe.responseHandler);
  await openDirectConnection("stale-interleaved-old-profile");
  await (await oneVisibleTestId("gateway-endpoint")).fill(gateway.baseUrl);
  await (await oneVisibleTestId("gateway-token")).fill(gateway.authToken);
  const interleavedOldRequest = page.waitForRequest(request =>
    request.method() === "POST" && matchesSessionPath(request.url()),
  { timeout: 10_000 });
  await (await oneVisibleTestId("gateway-connect")).click();
  await interleavedOldRequest;
  await waitFor(() => interleavedProbe.probe.gatewayStatus !== null, 10_000, "real old Gateway response held for interleaved connection probe", 25, context.abortSignal);
  await interleavedProbe.probe.ready;
  const interleavedOldStateBeforeClose = await readProfileState(page, profileIndexKey);
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="gateway-endpoint"]:visible').waitFor({ state: "hidden", timeout: 10_000 });
  const interleavedModalClosedAt = Date.now();
  await routeToSettingsFromWelcome();
  const interleavedSettingsEnteredAt = Date.now();
  const interleavedSettingsPath = new URL(page.url()).pathname;
  const interleavedStateBeforeNewConnection = await readProfileState(page, profileIndexKey);
  await (await addGatewayButton()).click();
  await page.waitForURL(url => url.pathname.endsWith("/welcome"), { timeout: 10_000 });
  diagnosticPhase = "interleaved-new-gateway-connect";
  await openDirectConnection("new-profile-after-stale-request");
  await (await oneVisibleTestId("gateway-endpoint")).fill(secondGateway.baseUrl);
  await (await oneVisibleTestId("gateway-token")).fill(secondGateway.authToken);
  const secondProfileConnectRequest = page.waitForRequest(request =>
    request.method() === "POST" && request.url().startsWith(secondGateway.baseUrl) && new URL(request.url()).pathname === SESSION_PATH,
  { timeout: 10_000 });
  await (await oneVisibleTestId("gateway-connect")).click();
  await secondProfileConnectRequest;
  await page.waitForURL(url => /\/h\/[^/?]+$/.test(url.pathname), { timeout: 30_000 });
  const secondProfileId = new URL(page.url()).pathname.match(/\/h\/([^/?]+)$/)?.[1] ?? null;
  const interleavedStateAfterNewConnection = await readProfileState(page, profileIndexKey);
  await waitFor(() => Date.now() - interleavedSettingsEnteredAt >= 1_250, 3_000,
    "wait 1-4 seconds after Settings navigation before releasing the interleaved response", 25, context.abortSignal);
  const interleavedModalCloseDelayMs = Date.now() - interleavedModalClosedAt;
  const interleavedSettingsDelayMs = Date.now() - interleavedSettingsEnteredAt;
  const interleavedFailureCountBeforeRelease = sessionRequestFailures.filter(event => event.phase === "interleaved-old-endpoint").length;
  interleavedProbe.probe.failedRequestCountBeforeRelease = interleavedFailureCountBeforeRelease;
  await interleavedProbe.probe.release?.();
  await page.waitForTimeout(1_500);
  const interleavedBrowserLifecycle = browserOutcomeFor(interleavedProbe.probe);
  const interleavedFinalPathAfterRelease = new URL(page.url()).pathname;
  const interleavedStateAfterRelease = await readProfileState(page, profileIndexKey);
  const interleavedOldEndpointPresentAfterRelease = interleavedStateAfterRelease.profiles.some(profile => profile.baseUrl === gateway.baseUrl);
  const interleavedRequestFailureEvents = sessionRequestFailures.filter(event => event.phase === "interleaved-old-endpoint");
  const interleavedResponseOutcome = interleavedBrowserLifecycle.outcome;
  const interleavedIntentGuardEvidence = interleavedBrowserLifecycle.completedSuccessfulResponse
    ? (interleavedStateAfterRelease.activeId === secondProfileId && !interleavedOldEndpointPresentAfterRelease ? "PASS" : "FAIL")
    : interleavedBrowserLifecycle.requestFailure && !interleavedBrowserLifecycle.responseObserved
      ? "UNVERIFIED: exact browser request cancellation was observed; delivered-success intent guard remains unit-only"
      : "UNVERIFIED: route.fulfill completion is not evidence of browser response delivery";
  page.off("request", onSessionRequest);
  page.off("requestfailed", onSessionRequestFailed);
  await page.unroute(sessionRoute, interleavedProbe.responseHandler);
  await context.writeArtifactJson("late-response-interleaved-with-new-gateway.json", {
    freshBrowserStoragePartition: true,
    loginStatus: isolatedProbeLoginResponse.status(),
    oldGatewayStatus: interleavedProbe.probe.gatewayStatus,
    oldResponseContainsExpectedSessionFields: interleavedProbe.probe.containsExpectedSessionMaterial,
    oldResponseBodyBytes: interleavedProbe.probe.responseBodyBytes,
    oldResponseReleaseAttempted: interleavedProbe.probe.releaseAttempted,
    routeFulfillResolved: interleavedProbe.probe.routeFulfillResolved,
    browserRequestId: interleavedProbe.probe.requestId,
    browserLifecycle: interleavedBrowserLifecycle,
    oldResponseOutcome: interleavedResponseOutcome,
    deliveredSuccessIntentGuard: interleavedIntentGuardEvidence,
    modalCloseToReleaseDelayMs: interleavedModalCloseDelayMs,
    settingsToReleaseDelayMs: interleavedSettingsDelayMs,
    settingsPathBeforeNewConnection: interleavedSettingsPath,
    profileStateBeforeClose: interleavedOldStateBeforeClose,
    profileStateBeforeNewConnection: interleavedStateBeforeNewConnection,
    profileStateAfterNewConnection: interleavedStateAfterNewConnection,
    profileStateAfterOldResponseRelease: interleavedStateAfterRelease,
    oldEndpointPresentAfterRelease: interleavedOldEndpointPresentAfterRelease,
    newEndpoint: secondGateway.baseUrl,
    finalPathAfterRelease: interleavedFinalPathAfterRelease,
    requestFailuresBeforeRelease: interleavedFailureCountBeforeRelease,
    requestFailureEvents: interleavedRequestFailureEvents,
  });

  // Establish two committed profiles even when the late request was correctly
  // invalidated at modal close and therefore was not saved.
  await page.goto(`${gateway.baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(url => url.pathname.endsWith("/settings"), { timeout: 10_000 });
  await (await addGatewayButton()).click();
  await page.waitForURL(url => url.pathname.endsWith("/welcome"), { timeout: 10_000 });
  diagnosticPhase = "settings-write-fixture-connect-a";
  await openDirectConnection("active-profile");
  await (await oneVisibleTestId("gateway-endpoint")).fill(gateway.baseUrl);
  await (await oneVisibleTestId("gateway-token")).fill(gateway.authToken);
  await (await oneVisibleTestId("gateway-connect")).click();
  await page.waitForURL(url => /\/h\/[^/?]+$/.test(url.pathname), { timeout: 30_000 });
  const firstProfileId = new URL(page.url()).pathname.match(/\/h\/([^/?]+)$/)?.[1] ?? null;
  await page.goto(`${gateway.baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(url => url.pathname.endsWith("/settings"), { timeout: 10_000 });
  const settingsStateBeforeWriteFailure = await readProfileState(page, profileIndexKey);
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    window.__qaRejectProfileIndexWrite = true;
    window.__qaRejectedProfileIndexWrites = 0;
    Storage.prototype.setItem = function(storageKey, value) {
      if (this === window.localStorage && storageKey === key && window.__qaRejectProfileIndexWrite) {
        window.__qaRejectProfileIndexWrite = false;
        window.__qaRejectedProfileIndexWrites += 1;
        throw new DOMException("Storage quota injected by the isolated browser test", "QuotaExceededError");
      }
      return original.call(this, storageKey, value);
    };
  }, profileIndexKey);
  const previousErrors = pageErrors.length;
  const inactiveProfileButton = page.locator('[role="button"]:visible').filter({ hasText: secondGateway.baseUrl });
  const inactiveProfileButtonCount = await inactiveProfileButton.count();
  assert.equal(inactiveProfileButtonCount, 1, "active Settings route must expose exactly one visible button for the inactive Gateway");
  diagnosticPhase = "settings-storage-write-failure";
  await inactiveProfileButton.click();
  await waitFor(() => page.evaluate(() => window.__qaRejectedProfileIndexWrites || 0), 10_000,
    "injected Gateway profile index write rejection", 25, context.abortSignal);
  await page.waitForTimeout(500);
  const profileStateAfterRejectedWrite = await readProfileState(page, profileIndexKey);
  const settingsPathAfterRejectedWrite = new URL(page.url()).pathname;
  const switchErrorAlert = page.getByRole("alert");
  const switchErrorVisibleAfterRejectedWrite = await switchErrorAlert.isVisible().catch(() => false);
  const switchErrorTextAfterRejectedWrite = switchErrorVisibleAfterRejectedWrite ? await switchErrorAlert.textContent() : null;
  const switchErrorPageErrors = pageErrors.slice(previousErrors);
  await page.screenshot({ path: context.pathInArtifacts("settings-profile-write-rejected.png"), fullPage: true });
  diagnosticPhase = "settings-storage-write-retry";
  await inactiveProfileButton.click();
  await page.waitForURL(url => url.pathname.endsWith(`/h/${secondProfileId}`), { timeout: 30_000 });
  const profileStateAfterRetry = await readProfileState(page, profileIndexKey);
  const settingsPathAfterRetry = new URL(page.url()).pathname;
  const rejectedStorageWriteCount = await page.evaluate(() => window.__qaRejectedProfileIndexWrites || 0).catch(() => 0);

  // Probe 3: removing the last profile persists the local deletion before its
  // remote DELETE completes. Leave Settings, connect B, then release A's real
  // Gateway response while B is active; the stale Settings completion must not
  // replace the route with Welcome.
  await page.close();
  const deleteRaceBrowserContext = await chromium.browser.newContext();
  context.addCleanup("close isolated Settings-delete race browser context", async () => {
    await deleteRaceBrowserContext.close().catch(() => undefined);
  });
  page = await deleteRaceBrowserContext.newPage();
  attachBrowserDiagnostics(page);
  await page.setViewportSize({ width: 390, height: 844 });
  diagnosticPhase = "settings-delete-browser-login";
  const deleteRaceLoginPage = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(deleteRaceLoginPage?.status(), 200, "Settings-delete probe starts in a clean browser partition");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  const deleteRaceLoginResponse = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/login") && response.request().method() === "POST"),
    page.locator('button[type="submit"]').click(),
  ]).then(([response]) => response);
  assert.equal(deleteRaceLoginResponse.status(), 303, "delete-race browser partition must authenticate to Gateway A");
  await page.locator('[data-testid="welcome-direct-connection"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  await openDirectConnection("delete-race-profile-a");
  await (await oneVisibleTestId("gateway-endpoint")).fill(gateway.baseUrl);
  await (await oneVisibleTestId("gateway-token")).fill(gateway.authToken);
  const deleteRaceAConnectResponse = page.waitForResponse(response =>
    response.url().startsWith(gateway.baseUrl) && new URL(response.url()).pathname === SESSION_PATH &&
    response.request().method() === "POST" && response.status() === 200,
  { timeout: 10_000 });
  await (await oneVisibleTestId("gateway-connect")).click();
  await deleteRaceAConnectResponse;
  await page.waitForURL(url => /\/h\/[^/?]+$/.test(url.pathname), { timeout: 30_000 });
  const deleteRaceProfileAId = new URL(page.url()).pathname.match(/\/h\/([^/?]+)$/)?.[1] ?? null;
  await page.goto(`${gateway.baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(url => url.pathname.endsWith("/settings"), { timeout: 10_000 });
  const deleteRaceStateBeforeRemoval = await readProfileState(page, profileIndexKey);
  assert.equal(deleteRaceStateBeforeRemoval.profileCount, 1, "the race starts with exactly one locally owned Gateway A profile");
  assert.equal(deleteRaceStateBeforeRemoval.profiles[0]?.baseUrl, gateway.baseUrl, "the only local profile before deletion must be Gateway A");

  let heldDeleteStartedAt = null;
  let heldDeleteStatus = null;
  let heldDeleteBodyBytes = 0;
  let heldDeleteReleaseAttempted = false;
  let releaseHeldDelete = null;
  // Fetch the genuine DELETE response from Gateway A, then hold only its
  // delivery to the Mobile Web client while a new profile is connected.
  const heldDeleteHandler = async route => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    heldDeleteRequestId = requestIds.get(route.request()) ?? null;
    heldDeleteStartedAt ??= Date.now();
    const response = await route.fetch();
    heldDeleteStatus = response.status();
    heldDeleteBodyBytes = (await response.body()).byteLength;
    await new Promise(resolveReleased => {
      releaseHeldDelete = async () => {
        if (heldDeleteReleaseAttempted) return;
        heldDeleteReleaseAttempted = true;
        try {
          await route.fulfill({ response });
          heldDeleteRouteFulfillResolved = true;
        } catch {
          // A 5s client timeout can abort the browser request before explicit release.
          heldDeleteRouteFulfillResolved = false;
        } finally {
          resolveReleased();
          releaseHeldDelete = null;
        }
      };
      });
  };
  const deleteRouteMatcher = url => {
    try {
      const parsed = new URL(url);
      return parsed.origin === gateway.baseUrl && parsed.pathname === SESSION_PATH;
    } catch {
      return false;
    }
  };
  await page.route(deleteRouteMatcher, heldDeleteHandler);
  context.addCleanup("release held Gateway A Mobile Web session DELETE", async () => {
    await releaseHeldDelete?.();
  });
  const removeLabel = await page.locator("html").getAttribute("lang") === "en" ? "Remove" : "移除";
  const removeButtons = page.getByRole("button", { name: removeLabel, exact: true });
  const removeButtonCount = await removeButtons.count();
  assert.equal(removeButtonCount, 1, `Settings must expose one remove control for the only profile: ${removeButtonCount}`);
  const deleteRaceConfirmation = page.waitForEvent("dialog", { timeout: 10_000 });
  diagnosticPhase = "settings-delete-held-delete";
  const removeClickedAt = Date.now();
  const removeClick = removeButtons.click();
  const removeDialog = await deleteRaceConfirmation;
  const removeDialogType = removeDialog.type();
  await removeDialog.accept();
  await removeClick;
  await waitFor(() => heldDeleteStatus !== null, 4_000, "real Gateway A profile-removal DELETE response held", 20, context.abortSignal);
  const deleteResponseObservedAt = Date.now();
  const deleteRaceStateAfterLocalRemoval = await waitFor(async () => {
    const state = await readProfileState(page, profileIndexKey);
    return state.profileCount === 0 ? state : false;
  }, 2_000, "Gateway A profile removed from local profile index before DELETE response delivery", 20, context.abortSignal);
  const deleteRacePathAfterLocalRemoval = new URL(page.url()).pathname;
  await (await addGatewayButton()).click();
  await page.waitForURL(url => url.pathname.endsWith("/welcome"), { timeout: 10_000 });
  diagnosticPhase = "settings-delete-connect-profile-b";
  await openDirectConnection("delete-race-profile-b");
  await (await oneVisibleTestId("gateway-endpoint")).fill(secondGateway.baseUrl);
  await (await oneVisibleTestId("gateway-token")).fill(secondGateway.authToken);
  const deleteRaceBConnectResponse = page.waitForResponse(response =>
    response.url().startsWith(secondGateway.baseUrl) && new URL(response.url()).pathname === SESSION_PATH &&
    response.request().method() === "POST" && response.status() === 200,
  { timeout: 10_000 });
  await (await oneVisibleTestId("gateway-connect")).click();
  await deleteRaceBConnectResponse;
  await page.waitForURL(url => /\/h\/[^/?]+$/.test(url.pathname), { timeout: 30_000 });
  const deleteRaceProfileBId = new URL(page.url()).pathname.match(/\/h\/([^/?]+)$/)?.[1] ?? null;
  const deleteRaceStateBeforeRelease = await readProfileState(page, profileIndexKey);
  const deleteRacePathBeforeRelease = new URL(page.url()).pathname;
  const deleteRaceHoldUntilBMs = heldDeleteStartedAt === null ? null : Date.now() - heldDeleteStartedAt;
  const deleteRaceReleaseAttemptedBeforeRelease = heldDeleteReleaseAttempted;
  const deleteRaceActiveBConfirmedBeforeRelease = Boolean(deleteRaceProfileBId) &&
    deleteRaceStateBeforeRelease.profileCount === 1 &&
    deleteRaceStateBeforeRelease.activeId === deleteRaceProfileBId &&
    deleteRaceStateBeforeRelease.profiles.some(profile => profile.baseUrl === secondGateway.baseUrl) &&
    deleteRacePathBeforeRelease.endsWith(`/h/${deleteRaceProfileBId}`);
  await context.writeArtifactJson("settings-delete-late-response-before-release.json", {
    loginStatus: deleteRaceLoginResponse.status(),
    profileAConnectSucceeded: Boolean(deleteRaceProfileAId),
    profileStateBeforeRemoval: deleteRaceStateBeforeRemoval,
    deleteRequestPath: SESSION_PATH,
    deleteMethod: "DELETE",
    actualGatewayDeleteStatus: heldDeleteStatus,
    actualGatewayDeleteResponseBodyBytes: heldDeleteBodyBytes,
    nativeConfirmationType: removeDialogType,
    localStateAfterDeleteStarted: deleteRaceStateAfterLocalRemoval,
    pathAfterLocalRemoval: deleteRacePathAfterLocalRemoval,
    profileBConnectSucceeded: Boolean(deleteRaceProfileBId),
    profileStateBeforeRelease: deleteRaceStateBeforeRelease,
    pathBeforeRelease: deleteRacePathBeforeRelease,
    deleteHeldUntilBActiveMs: deleteRaceHoldUntilBMs,
    deleteRequestId: heldDeleteRequestId,
    routeFulfillHadNotBeenAttemptedAtSnapshot: !deleteRaceReleaseAttemptedBeforeRelease,
    gatewayBActiveAndRouteCorrectAtSnapshot: deleteRaceActiveBConfirmedBeforeRelease,
    browserLifecycleAtSnapshot: browserLifecycleFor({ requestId: heldDeleteRequestId }),
  });
  diagnosticPhase = "settings-delete-release-old-delete";
  await releaseHeldDelete?.();
  await page.unroute(deleteRouteMatcher, heldDeleteHandler);
  await page.waitForTimeout(1_250);
  const deleteBrowserLifecycle = browserOutcomeFor({ requestId: heldDeleteRequestId });
  const deleteRaceFinalPath = new URL(page.url()).pathname;
  const deleteRaceStateAfterRelease = await readProfileState(page, profileIndexKey);
  await context.writeArtifactJson("settings-delete-late-route-preservation.json", {
    loginStatus: deleteRaceLoginResponse.status(),
    profileAIdPresent: Boolean(deleteRaceProfileAId),
    profileBIdPresent: Boolean(deleteRaceProfileBId),
    deleteRequestPath: SESSION_PATH,
    deleteMethod: "DELETE",
    actualGatewayDeleteStatus: heldDeleteStatus,
    actualGatewayDeleteResponseBodyBytes: heldDeleteBodyBytes,
    nativeConfirmationType: removeDialogType,
    deleteRequestId: heldDeleteRequestId,
    deleteResponseReleaseAttempted: heldDeleteReleaseAttempted,
    routeFulfillResolved: heldDeleteRouteFulfillResolved,
    browserLifecycle: deleteBrowserLifecycle,
    deleteBrowserOutcome: deleteBrowserLifecycle.outcome,
    deleteHeldUntilBActiveMs: deleteRaceHoldUntilBMs,
    removeClickToDeleteResponseMs: deleteResponseObservedAt - removeClickedAt,
    localStateBeforeRemoval: deleteRaceStateBeforeRemoval,
    localStateAfterRemovalBeforeB: deleteRaceStateAfterLocalRemoval,
    pathAfterLocalRemoval: deleteRacePathAfterLocalRemoval,
    localStateBeforeRelease: deleteRaceStateBeforeRelease,
    pathBeforeRelease: deleteRacePathBeforeRelease,
    localStateAfterRelease: deleteRaceStateAfterRelease,
    pathAfterRelease: deleteRaceFinalPath,
    gatewayAEndpoint: gateway.baseUrl,
    gatewayBEndpoint: secondGateway.baseUrl,
  });

  const classifiedHttpIssueEvents = httpIssueEvents.map(issue => ({ ...issue, classification: classifyHttpIssue(issue) }));
  const classifiedConsoleMessages = consoleMessages.map(message => ({ ...message, classification: classifyConsoleMessage(message) }));
  const unexpectedHttpIssueEvents = classifiedHttpIssueEvents.filter(issue => issue.classification === "unexpected");
  const unexpectedConsoleMessages = classifiedConsoleMessages.filter(message => message.classification === "unexpected");

  const checks = {
    browserDiagnosticsClean: pageErrors.length === 0 && unexpectedHttpIssueEvents.length === 0 && unexpectedConsoleMessages.length === 0,
    addGatewayAccessibleSemanticButton: addGatewayAccessibilityFindings.length === 0,
    addGatewayEnterKeyboardActivation: addGatewayEnterObservation.addGatewayKeyActivated && addGatewayEnterObservation.openerKeyActivated,
    addGatewaySpaceKeyboardActivation: addGatewaySpaceObservation.addGatewayKeyActivated && addGatewaySpaceObservation.openerKeyActivated,
    loginFailureAndRecovery: rejectedLoginMessage && acceptedLoginResponse.status() === 303,
    noHorizontalOverflow: responsiveWidths.every(sample => sample.noHorizontalOverflow),
    modalInitialFocus: initialFocus.testId === "gateway-endpoint",
    modalDialogSemantics: connectDialogCount === 1 && namedConnectDialogCount === 1 && normalViewportDialogAttributes?.documentLanguage === "en",
    modalTabTrap: reverseTabFocus.testId === null && Boolean(reverseTabFocus.label) && forwardTabFocus.testId === "gateway-token",
    modalEscapeAndFocusReturn: focusReturnedToOpener,
    shortViewportModalConnectVisible: shortViewportModalFits && shortViewportSubmitFullyVisible && shortViewportConnectRequestStarted,
    sessionTimeoutSettlesBeforeManualRelease:
      alertVisibleBeforeRelease && connectEnabledBeforeRelease &&
      requestFailedBeforeManualRelease && requestFailedElapsedBeforeManualReleaseMs !== null && requestFailedElapsedBeforeManualReleaseMs <= 10_000,
    noProfileCommittedWhileSessionRequestPending: profileStateBeforeStall.profileCount === 0 && profileStateBeforeRelease.profileCount === 0,
    retryAfterNetworkFailure: connectEnabledAfterRelease && retryPostIssued && connectEnabledAfterRetry,
    noNewConnectionUpstreamResponseWasValid:
      noNewConnectionProbe.probe.gatewayStatus === 200 && noNewConnectionProbe.probe.containsExpectedSessionMaterial,
    noNewConnectionLateResponseReleaseWasAttempted:
      noNewConnectionProbe.probe.releaseAttempted && noNewConnectionProbe.probe.responseBodyBytes > 0,
    noNewConnectionLateResponseOutcomeVerified:
      Boolean(noNewConnectionProbe.probe.requestId) &&
      (noNewConnectionBrowserLifecycle.completedSuccessfulResponse ||
        (noNewConnectionBrowserLifecycle.requestFailure === "net::ERR_ABORTED" &&
          !noNewConnectionBrowserLifecycle.responseObserved && !noNewConnectionBrowserLifecycle.requestFinishedObserved)),
    noNewConnectionCancellationInvariantPassed:
      noNewConnectionBrowserLifecycle.requestFailure === "net::ERR_ABORTED" &&
      !noNewConnectionBrowserLifecycle.responseObserved && !noNewConnectionBrowserLifecycle.requestFinishedObserved &&
      noNewConnectionProfileStateAfterRelease.profileCount === 0 &&
      noNewConnectionProfileStateAfterRelease.activeId === null &&
      noNewConnectionFinalPath.endsWith("/settings"),
    noNewConnectionLateResponseArrivedAfterSettings:
      noNewConnectionSettingsDelayMs >= 1_000 && noNewConnectionSettingsDelayMs <= 4_000 &&
      noNewConnectionModalCloseDelayMs >= 1_000 && noNewConnectionModalCloseDelayMs <= 4_000,
    noNewConnectionLateResponseDidNotCommitProfile:
      noNewConnectionProfileStateBeforeClose.profileCount === 0 &&
      noNewConnectionStateBeforeRelease.profileCount === 0 &&
      noNewConnectionProfileStateAfterRelease.profileCount === 0 &&
      noNewConnectionProfileStateAfterRelease.activeId === null &&
      noNewConnectionSettingsPath.endsWith("/settings") && noNewConnectionFinalPath.endsWith("/settings"),
    interleavedUpstreamResponseWasValid:
      interleavedProbe.probe.gatewayStatus === 200 && interleavedProbe.probe.containsExpectedSessionMaterial,
    interleavedLateResponseReleaseWasAttempted:
      interleavedProbe.probe.releaseAttempted && interleavedProbe.probe.responseBodyBytes > 0,
    interleavedLateResponseOutcomeVerified:
      Boolean(interleavedProbe.probe.requestId) &&
      (interleavedBrowserLifecycle.completedSuccessfulResponse ||
        (interleavedBrowserLifecycle.requestFailure === "net::ERR_ABORTED" &&
          !interleavedBrowserLifecycle.responseObserved && !interleavedBrowserLifecycle.requestFinishedObserved)),
    interleavedCancellationInvariantPassed:
      interleavedBrowserLifecycle.requestFailure === "net::ERR_ABORTED" &&
      !interleavedBrowserLifecycle.responseObserved && !interleavedBrowserLifecycle.requestFinishedObserved &&
      Boolean(secondProfileId) && interleavedStateAfterRelease.activeId === secondProfileId &&
      interleavedStateAfterRelease.profileCount === 1 && !interleavedOldEndpointPresentAfterRelease &&
      interleavedFinalPathAfterRelease.endsWith(`/h/${secondProfileId}`),
    interleavedLateResponseArrivedAfterSettings:
      interleavedSettingsDelayMs >= 1_000 && interleavedSettingsDelayMs <= 4_000 &&
      interleavedModalCloseDelayMs >= 1_000 && interleavedModalCloseDelayMs <= 4_000,
    interleavedLateResponseDidNotCommitOldEndpoint:
      Boolean(secondProfileId) &&
      interleavedStateBeforeNewConnection.profileCount === 0 &&
      interleavedStateAfterNewConnection.activeId === secondProfileId &&
      interleavedStateAfterRelease.activeId === secondProfileId &&
      interleavedStateAfterRelease.profileCount === 1 &&
      !interleavedOldEndpointPresentAfterRelease &&
      interleavedStateAfterRelease.profiles.some(profile => profile.baseUrl === secondGateway.baseUrl),
    interleavedLateResponsePreservedNewRoute:
      Boolean(secondProfileId) && interleavedFinalPathAfterRelease.endsWith(`/h/${secondProfileId}`),
    settingsProfileWriteWasRejected: rejectedStorageWriteCount === 1,
    settingsWriteFailurePreservedActiveProfile:
      settingsStateBeforeWriteFailure.activeId === firstProfileId &&
      profileStateAfterRejectedWrite.activeId === firstProfileId &&
      profileStateAfterRejectedWrite.profileCount === 2 && settingsPathAfterRejectedWrite.endsWith("/settings"),
    settingsWriteFailureVisibleAndRetryable:
      switchErrorVisibleAfterRejectedWrite && rejectedStorageWriteCount === 1 &&
      profileStateAfterRetry.activeId === secondProfileId && settingsPathAfterRetry.endsWith(`/h/${secondProfileId}`),
    settingsDeleteRemovedOnlyProfileBeforeResponseDelivery:
      heldDeleteStatus === 204 && deleteRaceStateBeforeRemoval.profileCount === 1 &&
      deleteRaceStateAfterLocalRemoval.profileCount === 0 &&
      !deleteRaceStateAfterLocalRemoval.profiles.some(profile => profile.baseUrl === gateway.baseUrl),
    settingsDeleteConnectedGatewayBWhileResponseHeld:
      deleteRaceActiveBConfirmedBeforeRelease && !deleteRaceReleaseAttemptedBeforeRelease &&
      deleteRaceStateBeforeRelease.profileCount === 1 &&
      deleteRaceStateBeforeRelease.activeId === deleteRaceProfileBId &&
      deleteRaceStateBeforeRelease.profiles.some(profile => profile.baseUrl === secondGateway.baseUrl) &&
      deleteRacePathBeforeRelease.endsWith(`/h/${deleteRaceProfileBId}`) &&
      deleteRaceHoldUntilBMs !== null && deleteRaceHoldUntilBMs < 5_000,
    settingsDeleteReleaseOutcomeVerified:
      heldDeleteReleaseAttempted && Boolean(heldDeleteRequestId) &&
      (deleteBrowserLifecycle.completedSuccessfulResponse ||
        (heldDeleteRouteFulfillResolved && deleteBrowserLifecycle.responseStatuses.includes(204) &&
          deleteBrowserLifecycle.requestFailure === "net::ERR_ABORTED" && !deleteBrowserLifecycle.requestFinishedObserved)),
    settingsDeleteCompletionOrCancellationPreservedGatewayB:
      heldDeleteReleaseAttempted && (deleteBrowserLifecycle.completedSuccessfulResponse || Boolean(deleteBrowserLifecycle.requestFailure)) &&
      Boolean(deleteRaceProfileBId) &&
      deleteRaceStateAfterRelease.profileCount === 1 &&
      deleteRaceStateAfterRelease.activeId === deleteRaceProfileBId &&
      deleteRaceStateAfterRelease.profiles.some(profile => profile.baseUrl === secondGateway.baseUrl) &&
      !deleteRaceStateAfterRelease.profiles.some(profile => profile.baseUrl === gateway.baseUrl) &&
      deleteRaceFinalPath.endsWith(`/h/${deleteRaceProfileBId}`),
  };

  const artifact = {
    evidence: {
      browser: "system Chromium started by startChromium in this RunContext",
      gateway: "two isolated real Studio Gateways started by startGateway; the second is CORS-trusted by the first",
      mobileWeb: process.env.KCODER_E2E_BUILD_MOBILE_WEB === "1"
        ? "current source exported to this RunContext state and served by the Gateway"
        : "preserved mobile/dist baseline served by the Gateway",
      mobileDistProvenance,
      sourceFileHashes,
      model: "not used",
      faultInjection: "browser held genuine POST /api/mobile/session and genuine Gateway A DELETE /api/mobile/session responses; Settings also rejected one profile-index Storage.setItem; no successful session payload was fabricated",
    },
    browserDiagnostics: {
      pageErrors,
      consoleErrorAndWarnings: classifiedConsoleMessages,
      httpIssues: classifiedHttpIssueEvents,
      sessionRequestLifecycle: requestLifecycleEvents,
      unexpectedHttpIssueCount: unexpectedHttpIssueEvents.length,
      unexpectedConsoleMessageCount: unexpectedConsoleMessages.length,
    },
    addGatewayAccessibilityFindings,
    login: {
      unauthenticatedPageStatus: loginResponse.status(),
      invalidLoginStatus: rejectedLoginResponse.status(),
      invalidLoginMessageVisible: rejectedLoginMessage,
      validLoginStatus: acceptedLoginResponse.status(),
    },
    responsiveWidths,
    openerObservations,
    shortViewportModal: {
      viewport: { width: 390, height: 320 },
      buttonBeforeScroll: shortViewportButtonBoxBeforeScroll,
      buttonAfterScroll: shortViewportButtonBoxAfterScroll,
      buttonAtSubmit: shortViewportButtonBoxAtSubmit,
      dialog: shortViewportModal,
      dialogAttributes: shortViewportDialogAttributes,
      connectButtonFullyVisibleAfterScroll: shortViewportModalFits,
      connectButtonFullyVisibleAtSubmit: shortViewportSubmitFullyVisible,
      actualConnectRequestStarted: shortViewportConnectRequestStarted,
      note: "reduced viewport height and browser scrolling probe layout/tap reachability; native soft-keyboard occlusion remains UNVERIFIED",
    },
    modalKeyboard: {
      accessibleDialogCount: connectDialogCount,
      dialogLabelAttribute: connectDialogName,
      dialogAriaSnapshot: normalViewportDialogAriaSnapshot,
      dialogAttributes: normalViewportDialogAttributes,
      initialFocus,
      reverseTabFocus,
      forwardTabFocus,
      focusReturnedToOpener,
    },
    settingsAddGatewayKeyboard: {
      Enter: addGatewayEnterObservation,
      Space: addGatewaySpaceObservation,
      accessibilityRoleFindings: addGatewayAccessibilityFindings,
      conclusion: "Key results record focus and key activation separately from pointer fallback. A visible dialog after pointer fallback does not count as keyboard activation.",
    },
    stalledSessionRequest: {
      path: SESSION_PATH,
      observedForMs: stalledWaitMs,
      requestFailedBeforeManualRelease,
      requestFailedElapsedBeforeManualReleaseMs,
      requestFailedElapsedMs: timeoutRequestFailedElapsedMs,
      alertVisibleBeforeManualRelease: alertVisibleBeforeRelease,
      alertTextBeforeManualRelease: alertTextBeforeRelease,
      connectEnabledBeforeManualRelease: connectEnabledBeforeRelease,
      profileCountBeforeStall: profileStateBeforeStall.profileCount,
      profileCountBeforeManualRelease: profileStateBeforeRelease.profileCount,
      connectEnabledAfterManualRelease: connectEnabledAfterRelease,
      retryPostIssued,
      connectEnabledAfterRetry: connectEnabledAfterRetry,
      screenshot: "session-post-stalled-before-release.png",
      requestFailures: sessionRequestFailures,
    },
    lateResponseAfterModalCloseWithoutNewConnection: {
      gatewayStatus: noNewConnectionProbe.probe.gatewayStatus,
      expectedSessionFieldsPresent: noNewConnectionProbe.probe.containsExpectedSessionMaterial,
      responseBodyBytes: noNewConnectionProbe.probe.responseBodyBytes,
      responseReleaseAttempted: noNewConnectionProbe.probe.releaseAttempted,
      routeFulfillResolved: noNewConnectionProbe.probe.routeFulfillResolved,
      browserRequestId: noNewConnectionProbe.probe.requestId,
      browserLifecycle: noNewConnectionBrowserLifecycle,
      responseOutcome: noNewConnectionResponseOutcome,
      deliveredSuccessIntentGuard: noNewConnectionIntentGuardEvidence,
      modalCloseToReleaseDelayMs: noNewConnectionModalCloseDelayMs,
      settingsToReleaseDelayMs: noNewConnectionSettingsDelayMs,
      settingsPathBeforeRelease: noNewConnectionSettingsPath,
      settingsPathAfterRelease: noNewConnectionFinalPath,
      requestFailuresAtModalClose: firstProbeFailureCountAtClose,
      requestFailuresBeforeRelease: noNewConnectionFailureCountBeforeRelease,
      requestFailureEvents: noNewConnectionRequestFailureEvents,
      intentAfterDeliveredSuccess: "UNVERIFIED unless browserLifecycle.completedSuccessfulResponse is true; unit coverage is separate",
      profileStateBeforeClose: noNewConnectionProfileStateBeforeClose,
      profileStateBeforeRelease: noNewConnectionStateBeforeRelease,
      profileStateAfterRelease: noNewConnectionProfileStateAfterRelease,
    },
    lateResponseInterleavedWithNewGateway: {
      oldGatewayStatus: interleavedProbe.probe.gatewayStatus,
      oldResponseContainsExpectedSessionFields: interleavedProbe.probe.containsExpectedSessionMaterial,
      oldResponseBodyBytes: interleavedProbe.probe.responseBodyBytes,
      oldResponseReleaseAttempted: interleavedProbe.probe.releaseAttempted,
      routeFulfillResolved: interleavedProbe.probe.routeFulfillResolved,
      browserRequestId: interleavedProbe.probe.requestId,
      browserLifecycle: interleavedBrowserLifecycle,
      oldResponseOutcome: interleavedResponseOutcome,
      deliveredSuccessIntentGuard: interleavedIntentGuardEvidence,
      modalCloseToReleaseDelayMs: interleavedModalCloseDelayMs,
      settingsToReleaseDelayMs: interleavedSettingsDelayMs,
      settingsPathBeforeNewConnection: interleavedSettingsPath,
      profileStateBeforeClose: interleavedOldStateBeforeClose,
      profileStateBeforeNewConnection: interleavedStateBeforeNewConnection,
      profileStateAfterNewConnection: interleavedStateAfterNewConnection,
      profileStateAfterOldResponseRelease: interleavedStateAfterRelease,
      oldEndpointPresentAfterRelease: interleavedOldEndpointPresentAfterRelease,
      newEndpoint: secondGateway.baseUrl,
      finalPathAfterRelease: interleavedFinalPathAfterRelease,
      requestFailuresBeforeRelease: interleavedFailureCountBeforeRelease,
      requestFailureEvents: interleavedRequestFailureEvents,
      intentAfterDeliveredSuccess: "UNVERIFIED unless browserLifecycle.completedSuccessfulResponse is true; unit coverage is separate",
    },
    settingsProfileWriteFailure: {
      profileCountBeforeFailure: settingsStateBeforeWriteFailure.profileCount,
      activeProfileBeforeFailure: settingsStateBeforeWriteFailure.activeId,
      injectedWriteRejectionCount: rejectedStorageWriteCount,
      activeProfileAfterFailure: profileStateAfterRejectedWrite.activeId,
      profileCountAfterFailure: profileStateAfterRejectedWrite.profileCount,
      pathAfterFailure: settingsPathAfterRejectedWrite,
      visibleError: switchErrorVisibleAfterRejectedWrite,
      visibleErrorText: switchErrorTextAfterRejectedWrite,
      pageErrorNames: switchErrorPageErrors,
      profileCountAfterRetry: profileStateAfterRetry.profileCount,
      activeProfileAfterRetry: profileStateAfterRetry.activeId,
      pathAfterRetry: settingsPathAfterRetry,
      retryTargetWasFound: inactiveProfileButtonCount === 1,
      screenshot: "settings-profile-write-rejected.png",
    },
    settingsDeleteLateCompletion: {
      gatewayADeleteStatus: heldDeleteStatus,
      gatewayADeleteResponseBodyBytes: heldDeleteBodyBytes,
      deleteRequestId: heldDeleteRequestId,
      deleteResponseReleaseAttempted: heldDeleteReleaseAttempted,
      routeFulfillResolved: heldDeleteRouteFulfillResolved,
      browserLifecycle: deleteBrowserLifecycle,
      browserOutcome: deleteBrowserLifecycle.outcome,
      gatewayBActiveAndRouteCorrectBeforeRelease: deleteRaceActiveBConfirmedBeforeRelease,
      releaseWasNotAttemptedAtBeforeReleaseSnapshot: !deleteRaceReleaseAttemptedBeforeRelease,
      deleteHeldUntilBActiveMs: deleteRaceHoldUntilBMs,
      deleteAIdPresent: Boolean(deleteRaceProfileAId),
      deleteBIdPresent: Boolean(deleteRaceProfileBId),
      profileStateBeforeRemoval: deleteRaceStateBeforeRemoval,
      profileStateAfterLocalRemovalBeforeB: deleteRaceStateAfterLocalRemoval,
      pathAfterLocalRemoval: deleteRacePathAfterLocalRemoval,
      profileStateBeforeRelease: deleteRaceStateBeforeRelease,
      pathBeforeRelease: deleteRacePathBeforeRelease,
      profileStateAfterRelease: deleteRaceStateAfterRelease,
      pathAfterRelease: deleteRaceFinalPath,
    },
    checks,
  };
  await context.writeArtifactJson("mobile-web-boundary-session-timeout.json", artifact);
  await context.writeArtifactJson("mobile-web-boundary-session-timeout-checks.json", checks);

  assert.equal(checks.loginFailureAndRecovery, true, "real Gateway login must reject an invalid token and then accept the valid token");
  assert.equal(checks.browserDiagnosticsClean, true,
    `the complete browser run must have no pageerrors or unclassified console/HTTP diagnostics: ${JSON.stringify({ pageErrors, unexpectedHttpIssueEvents, unexpectedConsoleMessages })}`);
  assert.equal(checks.noHorizontalOverflow, true, `Mobile Web must fit 360/390/768 widths: ${JSON.stringify(responsiveWidths)}`);
  assert.equal(checks.modalInitialFocus, true, `opening the connection modal must focus its endpoint field: ${JSON.stringify(initialFocus)}`);
  assert.equal(checks.modalDialogSemantics, true, `connection modal must expose one named dialog: ${JSON.stringify({ connectDialogCount, connectDialogName })}`);
  assert.equal(checks.modalTabTrap, true, `Tab and Shift+Tab must stay within the modal: ${JSON.stringify({ reverseTabFocus, forwardTabFocus })}`);
  assert.equal(checks.modalEscapeAndFocusReturn, true, "Escape must close the modal and return focus to its opener");
  assert.equal(checks.shortViewportModalConnectVisible, true,
    `connection modal Connect button must be reachable and submit at 390x320: ${JSON.stringify({ shortViewportButtonBoxBeforeScroll, shortViewportButtonBoxAfterScroll, shortViewportButtonBoxAtSubmit, shortViewportModal })}`);
  assert.equal(checks.sessionTimeoutSettlesBeforeManualRelease, true,
    `a stalled session exchange must show a recoverable error and re-enable Connect within 10s: ${JSON.stringify({ alertVisibleBeforeRelease, connectEnabledBeforeRelease, requestFailedElapsedMs, alertTextBeforeRelease, stalledWaitMs })}`);
  assert.equal(checks.noProfileCommittedWhileSessionRequestPending, true, "an unfinished session exchange must not persist a Gateway profile");
  assert.equal(checks.retryAfterNetworkFailure, true, "a failed exchange must re-enable Connect and allow another session POST");
  assert.equal(checks.noNewConnectionUpstreamResponseWasValid, true, "the no-new-connection probe must fetch a valid session response from the real Gateway");
  assert.equal(checks.noNewConnectionLateResponseReleaseWasAttempted, true, "the no-new-connection probe must attempt to deliver that real response");
  assert.equal(checks.noNewConnectionLateResponseOutcomeVerified, true,
    `the no-new-connection POST must have a correlated browser completion or requestfailed event: ${JSON.stringify({ outcome: noNewConnectionResponseOutcome, routeFulfillResolved: noNewConnectionProbe.probe.routeFulfillResolved, browserLifecycle: noNewConnectionBrowserLifecycle, requestFailureEvents: noNewConnectionRequestFailureEvents })}`);
  assert.equal(checks.noNewConnectionLateResponseArrivedAfterSettings, true,
    `first real Gateway response release must occur 1-4s after modal close and Settings navigation: ${JSON.stringify({ noNewConnectionModalCloseDelayMs, noNewConnectionSettingsDelayMs })}`);
  assert.equal(checks.noNewConnectionLateResponseDidNotCommitProfile, true,
    `with no replacement connect, response delivery or cancellation must leave Settings and profile storage unchanged: ${JSON.stringify({ noNewConnectionProfileStateBeforeClose, noNewConnectionStateBeforeRelease, noNewConnectionProfileStateAfterRelease, noNewConnectionSettingsPath, noNewConnectionFinalPath, noNewConnectionResponseOutcome })}`);
  assert.equal(checks.interleavedUpstreamResponseWasValid, true, "the interleaving probe must fetch a valid response from the real old Gateway");
  assert.equal(checks.interleavedLateResponseReleaseWasAttempted, true, "the interleaving probe must attempt to deliver the real old response");
  assert.equal(checks.interleavedLateResponseOutcomeVerified, true,
    `the old POST must have a correlated browser completion or requestfailed event: ${JSON.stringify({ outcome: interleavedResponseOutcome, routeFulfillResolved: interleavedProbe.probe.routeFulfillResolved, browserLifecycle: interleavedBrowserLifecycle, requestFailureEvents: interleavedRequestFailureEvents })}`);
  assert.equal(checks.interleavedLateResponseArrivedAfterSettings, true,
    `interleaved old response release must occur 1-4s after modal close and Settings navigation: ${JSON.stringify({ interleavedModalCloseDelayMs, interleavedSettingsDelayMs })}`);
  assert.equal(checks.interleavedLateResponseDidNotCommitOldEndpoint, true,
    `after Gateway C connects, delivery or cancellation of old Gateway A POST must not add A or replace active C: ${JSON.stringify({ responseOutcome: interleavedResponseOutcome, stateBeforeNewConnection: interleavedStateBeforeNewConnection, stateAfterNewConnection: interleavedStateAfterNewConnection, stateAfterRelease: interleavedStateAfterRelease, secondProfileId, oldEndpointPresent: interleavedOldEndpointPresentAfterRelease })}`);
  assert.equal(checks.interleavedLateResponsePreservedNewRoute, true,
    `late Gateway A completion must preserve Gateway C route: ${JSON.stringify({ finalPath: interleavedFinalPathAfterRelease, secondProfileId })}`);
  assert.equal(checks.settingsProfileWriteWasRejected, true,
    `the isolated browser must reject exactly one profile-index write: ${rejectedStorageWriteCount}`);
  assert.equal(checks.settingsWriteFailurePreservedActiveProfile, true,
    `failed Settings activation must preserve the old active profile and route: ${JSON.stringify({ settingsStateBeforeWriteFailure, profileStateAfterRejectedWrite, settingsPathAfterRejectedWrite, inactiveProfileButtonCount })}`);
  assert.equal(checks.settingsWriteFailureVisibleAndRetryable, true,
    `failed Settings activation must show a visible localized error and retry successfully: ${JSON.stringify({ switchErrorVisibleAfterRejectedWrite, switchErrorTextAfterRejectedWrite, profileStateAfterRetry, path: new URL(page.url()).pathname })}`);
  assert.equal(checks.settingsDeleteRemovedOnlyProfileBeforeResponseDelivery, true,
    `Gateway A local profile removal must commit while its real DELETE response is held: ${JSON.stringify({ heldDeleteStatus, deleteRaceStateBeforeRemoval, deleteRaceStateAfterLocalRemoval })}`);
  assert.equal(checks.settingsDeleteConnectedGatewayBWhileResponseHeld, true,
    `a new Gateway B profile must become active before releasing A's DELETE response and before its 5s client timeout: ${JSON.stringify({ deleteRaceStateBeforeRelease, deleteRacePathBeforeRelease, deleteRaceHoldUntilBMs, heldDeleteReleaseAttempted })}`);
  assert.equal(checks.settingsDeleteReleaseOutcomeVerified, true,
    `the exact held Gateway A DELETE must have a correlated browser completion or failure after route release: ${JSON.stringify({ heldDeleteRequestId, heldDeleteReleaseAttempted, heldDeleteRouteFulfillResolved, deleteBrowserLifecycle })}`);
  assert.equal(checks.settingsDeleteCompletionOrCancellationPreservedGatewayB, true,
    `the exact held Gateway A DELETE completion or cancellation must preserve Gateway B and its route: ${JSON.stringify({ deleteBrowserLifecycle, deleteRaceStateAfterRelease, deleteRaceFinalPath, deleteRaceProfileBId })}`);
  assert.equal(checks.addGatewayEnterKeyboardActivation, true,
    `Settings Add Gateway and the Welcome direct-connection opener must activate with Enter after focus: ${JSON.stringify(addGatewayEnterObservation)}`);
  assert.equal(checks.addGatewaySpaceKeyboardActivation, true,
    `Settings Add Gateway and the Welcome direct-connection opener must activate with Space after focus: ${JSON.stringify(addGatewaySpaceObservation)}`);
  assert.equal(checks.addGatewayAccessibleSemanticButton, true,
    `Add Gateway must be exposed as one visible named button on Settings; evidence records the active route DOM: ${JSON.stringify(addGatewayAccessibilityFindings)}`);

  return { ...checks, gatewayRetryRequestIssued: retryPostIssued, mobileWeb: artifact.evidence.mobileWeb };
});

async function readProfileState(page, key) {
  return page.evaluate(storageKey => {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
      const profiles = Array.isArray(parsed.profiles) ? parsed.profiles.map(profile => ({
        id: typeof profile?.id === "string" ? profile.id : null,
        label: typeof profile?.label === "string" ? profile.label : null,
        baseUrl: typeof profile?.baseUrl === "string" ? profile.baseUrl : null,
      })) : [];
      return {
        profileCount: profiles.length,
        activeProfilePresent: typeof parsed.activeId === "string" && parsed.activeId.length > 0,
        activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
        profiles,
      };
    } catch {
      return { profileCount: 0, activeProfilePresent: false, activeId: null, profiles: [] };
    }
  }, key);
}

async function inspectBundle(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath, relativePath);
      else if (entry.isFile()) files.push({ relativePath, fullPath, size: (await stat(fullPath)).size });
    }
  }
  await visit(root);
  files.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
  const index = await readFile(resolve(root, "index.html"));
  const tree = createHash("sha256");
  for (const file of files) {
    tree.update(file.relativePath).update("\0").update(await readFile(file.fullPath));
  }
  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    indexSha256: createHash("sha256").update(index).digest("hex"),
    treeSha256: tree.digest("hex"),
  };
}

async function inspectWelcomeOpeners(page) {
  return page.locator('[data-testid="welcome-direct-connection"]').evaluateAll(elements => elements.map((element, index) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const ancestors = [];
    let hiddenByAncestor = false;
    let inertByAncestor = false;
    for (let parent = element.parentElement; parent && ancestors.length < 5; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      const hidden = parent.getAttribute("aria-hidden");
      const inert = parent.hasAttribute("inert");
      hiddenByAncestor ||= hidden === "true" || parentStyle.display === "none" || parentStyle.visibility === "hidden";
      inertByAncestor ||= inert;
      ancestors.push({
        tag: parent.tagName,
        role: parent.getAttribute("role"),
        hidden,
        inert,
        display: parentStyle.display,
        visibility: parentStyle.visibility,
        pointerEvents: parentStyle.pointerEvents,
      });
    }
    return {
      index,
      currentPath: location.pathname,
      role: element.getAttribute("role"),
      label: element.getAttribute("aria-label"),
      hidden: element.getAttribute("aria-hidden"),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visibleByGeometry: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      hiddenByAncestor,
      inertByAncestor,
      ancestors,
    };
  }));
}
