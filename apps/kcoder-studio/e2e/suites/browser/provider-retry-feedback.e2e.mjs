import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const PROJECT_LABEL = "Provider Retry Feedback E2E";
const SUCCESS_PROMPT = "PROVIDER_RETRY_AUTO_SUCCESS";
const SUCCESS_REPLY = "PROVIDER_RETRY_SUCCESS_RECOVERED";
const EXHAUSTED_PROMPT = "PROVIDER_RETRY_TERMINAL_FAILURE";
const EXHAUSTED_REPLY = "PROVIDER_RETRY_MANUAL_RECOVERY";
const CANCEL_PROMPT = "PROVIDER_RETRY_CANCEL_DURING_BACKOFF";
const CANCEL_RECOVERY_PROMPT = "PROVIDER_RETRY_CANCEL_RECOVERY";
const CANCEL_RECOVERY_REPLY = "PROVIDER_RETRY_CANCELLED_AND_READY";
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 3_500;
const macElectronOptIn = process.env.KCODER_E2E_PROVIDER_RETRY_MAC_ELECTRON === "1";

const explicitOldBundleBaseline =
  process.env.KCODER_E2E_PROVIDER_RETRY_BASELINE === "1";
if (!explicitOldBundleBaseline) await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "provider-retry-feedback-and-turn-cleanup",
    tier: "full-integration",
    modelPolicy: "model-independent local HTTP 503 fault injection through real Gateway, Rust app-server, and browser renderer",
    retainSuccessLogs: true,
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(
      context,
      "minimal",
      { instanceId: "provider-retry-feedback" },
    );
    const configDir = context.pathInState("kcoder-config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await context.writeStateJson("kcoder-config/settings.json", {});
    const credential = "provider-retry-feedback-local-only";
    context.registerSecret(credential);
    await context.writeStateJson("kcoder-config/credentials.json", {
      "provider-retry-feedback": { type: "api", key: credential },
    });

    const fixtureOptions = {
      httpErrorPrompt: SUCCESS_PROMPT,
      httpErrorMatchLimit: 1,
      httpErrorStatus: 503,
      httpErrorMessage: "temporary deterministic provider outage",
      textOnly: true,
      textOnlyResponse: ({ userText }) => {
        if (userText.includes(SUCCESS_PROMPT)) return SUCCESS_REPLY;
        if (userText.includes(EXHAUSTED_PROMPT)) return EXHAUSTED_REPLY;
        if (userText.includes(CANCEL_RECOVERY_PROMPT)) return CANCEL_RECOVERY_REPLY;
        return "PROVIDER_RETRY_UNEXPECTED_REPLY";
      },
    };
    const model = await startApprovalModelFixture(context, fixtureOptions);
    const settingsFile = await context.writeStateJson("kcoder-settings.json", {
      active_provider: "provider-retry-feedback",
      max_retries: MAX_RETRIES,
      retry_base_delay_ms: BASE_DELAY_MS,
      providers: {
        "provider-retry-feedback": {
          api_format: "openai_chat_completions",
          endpoint: model.baseUrl,
          default_model: "provider-retry-feedback-model",
          context_window_tokens: 128_000,
          output_headroom_tokens: 8_192,
          max_output_tokens: 8_192,
          request_timeout_secs: 30,
          no_proxy: true,
          extra_body: {},
        },
      },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: PROJECT_LABEL,
        runtime: "kcoder",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace,
        settingsFile,
      },
    ]);
    let desktop = null;
    let chromium = null;
    let gateway = null;
    let page;
    let gatewayOrigin;
    let platformLabel = "system-chromium";
    if (macElectronOptIn) {
      const { startMacPackagedElectron } = await import(
        "../../harness/provider-retry-electron-verification.mjs"
      );
      desktop = await startMacPackagedElectron(context, {
        fixture: model,
        credential,
        providerId: "provider-retry-feedback",
        projectLabel: PROJECT_LABEL,
        maxRetries: MAX_RETRIES,
        retryBaseDelayMs: BASE_DELAY_MS,
      });
      ({ page } = desktop);
      gatewayOrigin = desktop.gatewayOrigin;
      platformLabel = desktop.platformLabel;
    } else {
      gateway = await startGateway(context, {
        workspace,
        serversFile,
        auth: true,
        env: { KCODER_CONFIG_DIR: configDir },
      });
      gatewayOrigin = gateway.baseUrl;
      chromium = await startChromium(context, {
        label: "provider-retry-feedback-chromium",
      });
      page = await chromium.newPage({
        viewport: { width: 1280, height: 900 },
      });
    }
    const protocol = await observeProtocol(page, { useCdp: macElectronOptIn });
    const browserErrors = [];
    page.on("pageerror", (error) =>
      browserErrors.push(`pageerror: ${error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "unknown";
      if (reason !== "net::ERR_ABORTED") {
        browserErrors.push(`requestfailed: ${new URL(request.url()).pathname} ${reason}`);
      }
    });

    const results = [];
    let stage = "login";
    try {
      if (!macElectronOptIn) {
        await login(page, gateway.baseUrl, gateway.authToken);
      }

      stage = "automatic-retry-recovers";
      const successEventOffset = protocol.providerRetries.length;
      const successTurnOffset = protocol.completedTurns.length;
      fixtureOptions.httpErrorPrompt = SUCCESS_PROMPT;
      fixtureOptions.httpErrorMatchLimit = 1;
      await startConversation(page, SUCCESS_PROMPT);
      const successRetry = await waitForRetryStatus(
        page,
        protocol,
        successEventOffset,
        { attempt: 1, maxRetries: MAX_RETRIES },
        {
          onEvent: explicitOldBundleBaseline
            ? () => capture(
                page,
                context,
                platformLabel,
                "baseline",
                "retry-event-before-legacy-status-timeout.png",
              )
            : undefined,
          onVisible: () => assert.equal(
            matchingRequestCount(model.requests, SUCCESS_PROMPT),
            1,
            "retry feedback must be visible while the first 503 is still the only request",
          ),
        },
      );
      await capture(page, context, platformLabel, "automatic-retry", "retry-visible.png");
      await page
        .getByTestId("message-assistant")
        .filter({ hasText: SUCCESS_REPLY })
        .last()
        .waitFor({ state: "visible", timeout: 30_000 });
      await waitForRetryStatusCleared(page);
      await waitForTurnStatus(
        protocol,
        successTurnOffset,
        "completed",
        "successful automatic retry completion",
      );
      const successRequests = matchingRequestCount(model.requests, SUCCESS_PROMPT);
      assert.equal(successRequests, 2, "one 503 must be followed by one successful HTTP request");
      const successEvents = protocol.providerRetries.slice(successEventOffset);
      assert.deepEqual(successEvents.map((event) => event.attempt), [1]);
      assert.ok(successRetry.retryAfterMs >= BASE_DELAY_MS * 0.75);
      results.push({
        case: "503-then-success",
        providerRequests: successRequests,
        retryEvents: successEvents,
        completion: "completed",
        retryStatusCleared: true,
      });

      stage = "retry-exhaustion-and-manual-recovery";
      const exhaustedEventOffset = protocol.providerRetries.length;
      const exhaustedTurnOffset = protocol.completedTurns.length;
      fixtureOptions.httpErrorPrompt = EXHAUSTED_PROMPT;
      fixtureOptions.httpErrorMatchLimit = 4;
      await startConversation(page, EXHAUSTED_PROMPT);
      const firstExhaustedStatus = await waitForRetryStatus(
        page,
        protocol,
        exhaustedEventOffset,
        { attempt: 1, maxRetries: MAX_RETRIES },
        {
          onVisible: () => assert.equal(
            matchingRequestCount(model.requests, EXHAUSTED_PROMPT),
            1,
            "attempt 1 feedback must appear before the first scheduled retry request",
          ),
        },
      );
      await capture(page, context, platformLabel, "retry-exhaustion", "retry-attempt-1-visible.png");
      await waitForRetryStatusText(page, /2\s*(?:\/|of)\s*2/i, 20_000);
      const secondExhaustedStatus = await waitForRetryStatus(
        page,
        protocol,
        exhaustedEventOffset + 1,
        { attempt: 2, maxRetries: MAX_RETRIES },
        {
          onVisible: () => assert.equal(
            matchingRequestCount(model.requests, EXHAUSTED_PROMPT),
            2,
            "attempt 2 feedback must appear while only two failed HTTP requests have reached the fixture",
          ),
        },
      );
      assert.ok(
        secondExhaustedStatus.retryAfterMs > firstExhaustedStatus.retryAfterMs,
        "the second retry must report a longer backoff than the first",
      );
      await capture(page, context, platformLabel, "retry-exhaustion", "retry-attempt-2-visible.png");
      const errorCard = page.getByTestId("assistant-error-card").last();
      await errorCard.waitFor({ state: "visible", timeout: 30_000 });
      await waitForRetryStatusCleared(page);
      assert.ok((await errorCard.innerText()).trim().length > 0);
      assert.equal(await page.getByTestId("pause-response-button").count(), 0);
      await assertComposerReady(page);
      await capture(page, context, platformLabel, "retry-exhaustion", "terminal-error-visible.png");
      await waitForTurnStatus(
        protocol,
        exhaustedTurnOffset,
        "failed",
        "terminal provider failure completion",
      );
      const exhaustedEvents = protocol.providerRetries.slice(exhaustedEventOffset);
      assert.deepEqual(exhaustedEvents.map((event) => event.attempt), [1, 2]);
      const exhaustedRequests = matchingRequestCount(model.requests, EXHAUSTED_PROMPT);
      assert.equal(exhaustedRequests, 3, "two retries must produce three failed HTTP requests");

      await errorCard.getByTestId("assistant-error-retry").click();
      await page
        .getByTestId("message-assistant")
        .filter({ hasText: EXHAUSTED_REPLY })
        .last()
        .waitFor({ state: "visible", timeout: 30_000 });
      await waitForRetryStatusCleared(page);
      await waitFor(
        async () => (await errorCard.getByTestId("assistant-error-retry").count()) === 0,
        15_000,
        "manual recovery consumes the failed-turn retry action",
      );
      await errorCard.waitFor({ state: "visible", timeout: 15_000 });
      await waitForTurnStatus(
        protocol,
        exhaustedTurnOffset + 1,
        "completed",
        "manual recovery completion",
      );
      assert.equal(
        matchingRequestCount(model.requests, EXHAUSTED_PROMPT),
        4,
        "manual recovery must issue one successful request after the three 503s",
      );
      results.push({
        case: "retry-exhaustion-then-manual-recovery",
        failedProviderRequests: exhaustedRequests,
        manualRecoveryRequests: 1,
        retryEvents: exhaustedEvents,
        terminalErrorRendered: true,
        retryStatusCleared: true,
        recovered: true,
      });

      stage = "cancel-during-backoff";
      const cancelEventOffset = protocol.providerRetries.length;
      const cancelTurnOffset = protocol.completedTurns.length;
      fixtureOptions.httpErrorPrompt = CANCEL_PROMPT;
      fixtureOptions.httpErrorMatchLimit = 5;
      await startConversation(page, CANCEL_PROMPT);
      const cancelRetry = await waitForRetryStatus(
        page,
        protocol,
        cancelEventOffset,
        { attempt: 1, maxRetries: MAX_RETRIES },
        {
          onVisible: () => assert.equal(
            matchingRequestCount(model.requests, CANCEL_PROMPT),
            1,
            "cancel feedback must be visible while only the first 503 request exists",
          ),
        },
      );
      await capture(page, context, platformLabel, "retry-cancel", "cancel-during-backoff.png");
      await page.getByTestId("pause-response-button").click();
      await waitForRetryStatusCleared(page);
      await waitForTurnStatus(
        protocol,
        cancelTurnOffset,
        "interrupted",
        "cancelled provider backoff completion",
      );
      await page.getByTestId("pause-response-button").waitFor({ state: "hidden" });
      await assertComposerReady(page);
      const requestsBeforeBackoffExpiry = matchingRequestCount(model.requests, CANCEL_PROMPT);
      assert.equal(requestsBeforeBackoffExpiry, 1, "the first failed HTTP attempt must reach the fixture");
      await page.waitForTimeout(Math.min(cancelRetry.retryAfterMs + 500, 6_000));
      assert.equal(
        matchingRequestCount(model.requests, CANCEL_PROMPT),
        1,
        "cancelling during backoff must prevent the scheduled retry HTTP request",
      );

      await startConversation(page, CANCEL_RECOVERY_PROMPT);
      await page
        .getByTestId("message-assistant")
        .filter({ hasText: CANCEL_RECOVERY_REPLY })
        .last()
        .waitFor({ state: "visible", timeout: 30_000 });
      await waitForRetryStatusCleared(page);
      await assertComposerReady(page);
      assert.deepEqual(protocol.providerRetries.slice(cancelEventOffset).map((event) => event.attempt), [1]);
      results.push({
        case: "cancel-during-backoff",
        providerRequestsBeforeRecovery: requestsBeforeBackoffExpiry,
        retryEvents: protocol.providerRetries.slice(cancelEventOffset),
        completion: "interrupted",
        scheduledRetryPrevented: true,
        nextTurnRecovered: true,
      });

      assert.deepEqual(browserErrors, []);
      await context.writeArtifactJson("provider-retry-feedback.json", {
        platformLabel,
        runtimeProvenance: desktop?.provenance ?? "Chromium against local Studio Gateway",
        gatewayOrigin,
        rendererFreshness: explicitOldBundleBaseline
          ? "explicit-pre-patch-bundle-baseline"
          : "renderer-build-freshness-verified",
        route: macElectronOptIn
          ? "packaged macOS Electron renderer -> isolated Studio Gateway -> Rust app-server -> local HTTP provider fixture over SSH reverse-forward"
          : "Playwright Chromium -> isolated Studio Gateway -> Rust app-server -> local HTTP provider fixture",
        modelBoundary:
          "synthetic model output and injected HTTP 503 responses; no external provider or model-quality claim",
        protocolCapture: protocol.transport,
        results,
        providerHttpRequestCount: model.requests.length,
        browserErrors,
      });
      return {
        cases: results.map((result) => result.case),
        platformLabel,
        providerHttpRequestCount: model.requests.length,
        providerRetryProtocolEvents: protocol.providerRetries.length,
        browserErrors,
      };
    } catch (error) {
      let baselineAutomaticRetry = null;
      if (
        explicitOldBundleBaseline
        && stage === "automatic-retry-recovers"
        && protocol.providerRetries.length > 0
      ) {
        try {
          await page
            .getByTestId("message-assistant")
            .filter({ hasText: SUCCESS_REPLY })
            .last()
            .waitFor({ state: "visible", timeout: 30_000 });
          await waitFor(
            () => matchingRequestCount(model.requests, SUCCESS_PROMPT) >= 2,
            10_000,
            "legacy-bundle baseline retry HTTP request reaches the fixture",
          );
          baselineAutomaticRetry = {
            fixtureRequestsAfterUiWait: matchingRequestCount(model.requests, SUCCESS_PROMPT),
            assistantReplyVisibleAfterRetry: true,
          };
        } catch (baselineError) {
          baselineAutomaticRetry = {
            fixtureRequestsAfterUiWait: matchingRequestCount(model.requests, SUCCESS_PROMPT),
            assistantReplyVisibleAfterRetry: false,
            waitError: String(baselineError),
          };
        }
      }
      await context.writeArtifactJson("provider-retry-feedback-failure.json", {
        platformLabel,
        runtimeProvenance: desktop?.provenance ?? "Chromium against local Studio Gateway",
        gatewayOrigin,
        rendererFreshness: explicitOldBundleBaseline
          ? "explicit-pre-patch-bundle-baseline"
          : "renderer-build-freshness-verified",
        route: macElectronOptIn
          ? "packaged macOS Electron renderer -> isolated Studio Gateway -> Rust app-server -> local HTTP provider fixture over SSH reverse-forward"
          : "Playwright Chromium -> isolated Studio Gateway -> Rust app-server -> local HTTP provider fixture",
        modelBoundary:
          "synthetic model output and injected HTTP 503 responses; no external provider or model-quality claim",
        protocolCapture: protocol.transport,
        providerHttpRequestCount: model.requests.length,
        promptRequestCounts: {
          success: matchingRequestCount(model.requests, SUCCESS_PROMPT),
          exhausted: matchingRequestCount(model.requests, EXHAUSTED_PROMPT),
          cancel: matchingRequestCount(model.requests, CANCEL_PROMPT),
          recovery: matchingRequestCount(model.requests, CANCEL_RECOVERY_PROMPT),
        },
        providerRetryEvents: protocol.providerRetries,
        completedTurnStatuses: protocol.completedTurns,
        renderedRetryStatus: await readRetryStatusText(page),
        baselineAutomaticRetry,
        browserErrors,
        stage,
        error: String(error),
      });
      await capture(page, context, platformLabel, "failure", "provider-retry-feedback-failure.png").catch(() => {});
      throw error;
    } finally {
      if (desktop) await desktop.stop();
      else await page.close();
    }
  },
);

async function observeProtocol(page, { useCdp = false } = {}) {
  const providerRetries = [];
  const completedTurns = [];
  const recordPayload = (payload) => {
    let message;
    try {
      message = JSON.parse(String(payload));
    } catch {
      return;
    }
    if (message.method === "item/event") {
      const params = message.params;
      const event = params?.event;
      if (event?.type !== "system_notice" || event?.kind !== "provider_retry") return;
      providerRetries.push({
        sequence: params.sequence,
        type: event.type,
        kind: event.kind,
        attempt: event.attempt,
        maxRetries: event.max_retries,
        retryAfterMs: event.retry_after_ms,
        text: event.text,
      });
    } else if (message.method === "turn/completed") {
      completedTurns.push({ status: message.params?.turn?.status ?? null });
    }
  };
  if (useCdp) {
    const session = await page.context().newCDPSession(page);
    session.on("Network.webSocketFrameReceived", ({ response }) => {
      recordPayload(response?.payloadData ?? "");
    });
    await session.send("Network.enable");
    return { providerRetries, completedTurns, transport: "CDP Network.webSocketFrameReceived" };
  }
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => recordPayload(payload));
  });
  return { providerRetries, completedTurns, transport: "Playwright WebSocket framereceived" };
}

async function login(page, baseUrl, token) {
  const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
}

async function startConversation(page, prompt) {
  const project = page
    .getByTestId("project-item")
    .filter({ hasText: PROJECT_LABEL })
    .first();
  await project.waitFor({ state: "visible", timeout: 30_000 });
  await project.hover();
  await project.getByTestId("project-new-conversation-button").click();
  const composer = page.getByTestId("chat-message-input").first();
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await page.keyboard.insertText(prompt);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="send-message-button"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 15_000 });
  await page.getByTestId("send-message-button").first().click();
}

async function waitForRetryStatus(page, protocol, offset, expected, callbacks = {}) {
  await waitFor(
    () => protocol.providerRetries.length > offset,
    120_000,
    `provider_retry protocol event ${expected.attempt}/${expected.maxRetries}`,
  );
  const event = protocol.providerRetries[offset];
  assert.equal(event.attempt, expected.attempt);
  assert.equal(event.maxRetries, expected.maxRetries);
  assert.equal(typeof event.retryAfterMs, "number");
  assert.ok(event.retryAfterMs >= 0);
  assert.match(event.text, new RegExp(`retrying ${expected.attempt}/${expected.maxRetries}`, "i"));
  await callbacks.onEvent?.(event);

  const status = page.getByTestId("provider-retry-status");
  await status.waitFor({
    state: "visible",
    timeout: explicitOldBundleBaseline ? 6_000 : 15_000,
  });
  await callbacks.onVisible?.(event);
  await waitForRetryStatusText(
    page,
    new RegExp(`${expected.attempt}\\s*(?:/|of)\\s*${expected.maxRetries}`, "i"),
    explicitOldBundleBaseline ? 6_000 : 10_000,
  );
  const text = await status.innerText();
  assert.match(text, /重试|retry/i);
  assert.match(text, /(?:秒后重试|\bin\s*\d+\s*s(?:ec(?:ond)?s?)?\b)/i);
  assert.doesNotMatch(text, /temporary deterministic provider outage/i);
  return event;
}

async function waitForRetryStatusText(page, expectedPattern, timeoutMs) {
  await waitFor(
    async () => {
      const status = page.getByTestId("provider-retry-status");
      if (!(await status.isVisible().catch(() => false))) return false;
      return expectedPattern.test(await status.innerText());
    },
    timeoutMs,
    `provider retry status text ${expectedPattern}`,
  );
}

async function waitForRetryStatusCleared(page) {
  await waitFor(
    async () => (await page.getByTestId("provider-retry-status").count()) === 0,
    15_000,
    "provider retry status clears after turn transition",
  );
}

async function assertComposerReady(page) {
  const composer = page.getByTestId("chat-message-input").first();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await composer.isEnabled(), true, "composer must be enabled after the turn ends");
}

async function readRetryStatusText(page) {
  const status = page.getByTestId("provider-retry-status");
  if ((await status.count()) === 0) return null;
  return status.innerText().catch(() => null);
}

async function waitForTurnStatus(protocol, offset, expected, label) {
  await waitFor(
    () => protocol.completedTurns.slice(offset).some((turn) => turn.status === expected),
    20_000,
    label,
  );
}

function matchingRequestCount(requests, prompt) {
  return requests.filter((request) =>
    JSON.stringify(request.messages ?? []).includes(prompt),
  ).length;
}

async function capture(page, context, projectLabel, testSlug, filename) {
  const path = context.pathInCase(projectLabel, `provider-retry-${testSlug}`, filename);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
