import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import {
  repoRoot,
  requireExecutable,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";

await runE2E(
  import.meta.url,
  {
    testId: "task-flow-mobile-question-response-send-failure-and-retry",
    tier: "full-integration",
    modelPolicy:
      "model-independent real Mobile Web, Gateway and app-server question protocol; deterministic local provider fixture; one page-owned runtime WebSocket readyState fault injection; no model-quality claim",
    retainSuccessLogs: true,
  },
  async (context) => {
    const binary = await requireExecutable(
      process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"),
      "isolated KCoder app-server binary",
    );
    const configuredBackendBefore = await hashExecutableFile(binary);
    const mobileWeb = await exportMobileWeb(context, {
      label: "mobile-interaction-web-export",
      outputName: "mobile-web-export",
      dependencyRoot: resolve(
        repoRoot,
        "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules",
      ),
    });
    const mobileDist = mobileWeb.path;
    const bundleMode = "isolated-current-source-export";
    const indexDigest = mobileWeb.indexHtmlSha256;

    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("config");
    await mkdir(workspace, { recursive: true });
    await mkdir(configDir, { recursive: true, mode: 0o700 });

    const answerMarker = "MOBILE_FAULT_RETRY_ANSWER";
    const finalMarker = "MOBILE_FAULT_RETRY_COMPLETED";
    const model = await startApprovalModelFixture(context, {
      question: true,
      questionText: "选择故障恢复选项",
      questionHeader: "恢复验证",
      questionOptions: [
        { label: answerMarker, description: "在恢复连接后提交" },
        { label: "MOBILE_FAULT_OTHER_OPTION", description: "保留其他选择" },
      ],
      questionFinalText: finalMarker,
    });
    const settingsFile = await context.writeStateJson(
      "question-settings.json",
      {
        active_provider: "interaction-fault-fixture",
        permission_mode: "ask",
        providers: {
          "interaction-fault-fixture": {
            api_format: "openai_chat_completions",
            authentication: { mode: "none" },
            endpoint: model.baseUrl,
            default_model: "interaction-fault-model",
            context_window_tokens: 128000,
            output_headroom_tokens: 8192,
            max_output_tokens: 8192,
            request_timeout_secs: 30,
            no_proxy: true,
            extra_body: {},
          },
        },
      },
    );
    await context.writeStateJson("config/settings.json", {});
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Local",
        transport: "local",
        command: binary,
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-interaction-gateway",
      workspace,
      serversFile,
      kcoderBin: binary,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_WEB_ROOT: mobileDist,
      },
    });
    const chromium = await startChromium(context, {
      label: "mobile-interaction-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });

    const pageErrors = [];
    const consoleErrors = [];
    const rpc = {
      sockets: [],
      interactionRequests: [],
      interactionReplies: [],
      clientMethods: [],
    };
    const questionRequestBySocket = new Map();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("websocket", (socket) => {
      const record = {
        index: rpc.sockets.length + 1,
        channel: null,
        server: null,
        workspace: null,
        closeEvents: 0,
      };
      try {
        const url = new URL(socket.url());
        record.channel = url.searchParams.get("channel");
        record.server = url.searchParams.get("server");
        record.workspace = url.searchParams.has("workspace");
      } catch {
        // Keep URLs and their authentication query parameters out of test evidence.
      }
      rpc.sockets.push(record);
      socket.on("close", () => {
        record.closeEvents += 1;
      });
      socket.on("framereceived", ({ payload }) => {
        const message = parseFrame(payload);
        if (!message) return;
        if (
          (message.method === "approval/request" ||
            message.method === "question/request") &&
          Number.isSafeInteger(message.id)
        ) {
          rpc.interactionRequests.push({
            socketIndex: record.index,
            requestId: message.id,
            method: message.method,
          });
          if (message.method === "question/request")
            questionRequestBySocket.set(record.index, message.id);
        }
      });
      socket.on("framesent", ({ payload }) => {
        const message = parseFrame(payload);
        if (!message) return;
        if (typeof message.method === "string") {
          rpc.clientMethods.push(message.method);
          return;
        }
        const questionRequestId = questionRequestBySocket.get(record.index);
        if (
          Number.isSafeInteger(message.id) &&
          message.id === questionRequestId &&
          (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
        ) {
          rpc.interactionReplies.push({
            socketIndex: record.index,
            requestId: message.id,
            responseType: Object.hasOwn(message, "error") ? "error" : "result",
            hasAnswers:
              Boolean(message.result?.answers) &&
              Object.keys(message.result.answers).length > 0,
          });
        }
      });
    });

    const evidence = {
      bundleMode,
      bundlePath: "RunContext state export",
      bundleIndexSha256: indexDigest,
      bundleSourceTreeSha256: mobileWeb.sourceTreeSha256,
      bundleSha256: mobileWeb.bundleSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
      binarySha256: await sha256(binary),
      stages: [],
      rpc,
      faultInjection: null,
      alertText: null,
      alertRole: null,
      alertLiveRegion: null,
      selectedBeforeFailure: false,
      selectedAfterFailure: false,
      questionCardVisibleAfterFailure: false,
      noQuestionReplyBeforeRetry: false,
      questionRequestId: null,
      readyStateRestored: false,
      answerObservedByProvider: false,
      pageErrors,
      consoleErrors,
    };

    let stage = "connect";
    try {
      await installPageOwnedSocketCapture(page);
      await connect(page, gateway);

      stage = "create-question-task";
      await page.getByTestId("new-workspace").click();
      await page.getByTestId("server-option-local").click();
      await page
        .getByTestId("workspace-path")
        .waitFor({ state: "visible", timeout: 30_000 });
      await page
        .getByTestId("new-workspace-prompt")
        .fill("MOBILE_INTERACTION_SEND_FAILURE_RECOVERY");
      await page.getByTestId("create-workspace").click();

      const approvalCard = page.getByTestId("approval-card");
      await approvalCard.waitFor({ state: "visible", timeout: 60_000 });
      assert.match(await approvalCard.innerText(), /AskUserQuestion|question/i);
      assert.equal(await page.getByTestId("approval-accept").isDisabled(), false);
      await page.getByTestId("approval-accept").click();
      await approvalCard.waitFor({ state: "hidden", timeout: 30_000 });

      const questionCard = page.getByTestId("question-card");
      await questionCard.waitFor({ state: "visible", timeout: 60_000 });
      await waitFor(
        () => rpc.interactionRequests.some((item) => item.method === "question/request"),
        10_000,
        "real question/request frame capture",
        50,
        context.abortSignal,
      );
      const questionRequest = rpc.interactionRequests.find(
        (item) => item.method === "question/request",
      );
      assert.ok(questionRequest, "the app-server must deliver the question request");
      evidence.questionRequestId = questionRequest.requestId;
      const answerOption = page.getByRole("radio", {
        name: new RegExp(answerMarker),
      });
      await answerOption.click();
      assert.equal(await answerOption.getAttribute("aria-checked"), "true");
      const repliesBeforeFailure = rpc.interactionReplies.filter(
        (reply) => reply.requestId === questionRequest.requestId,
      ).length;
      assert.equal(repliesBeforeFailure, 0, "the question is still unanswered before fault injection");
      evidence.stages.push("question-visible-and-answer-selected");
      evidence.selectedBeforeFailure = true;

      stage = "closed-before-onclose-fault";
      const targetSocket = await page.evaluate((socketIndex) => {
        const tracked = window.__mobileE2eSockets?.find(
          (entry) => entry.index === socketIndex,
        );
        if (!tracked) throw new Error("the question-owning WebSocket was not page-owned");
        const socket = tracked.socket;
        const descriptor = Object.getOwnPropertyDescriptor(
          WebSocket.prototype,
          "readyState",
        );
        if (!descriptor?.get) throw new Error("WebSocket.readyState getter is unavailable");
        if (Object.hasOwn(socket, "readyState"))
          throw new Error("WebSocket.readyState already has an own-property override");
        const actualState = descriptor.get.call(socket);
        if (actualState !== WebSocket.OPEN)
          throw new Error(`the question-owning WebSocket is not open (${actualState})`);
        Object.defineProperty(socket, "readyState", {
          configurable: true,
          get() {
            return WebSocket.CLOSED;
          },
        });
        return {
          socketIndex,
          actualReadyStateBefore: actualState,
          effectiveReadyStateDuringFault: socket.readyState,
          closeEventsBefore: tracked.closeEvents,
        };
      }, questionRequest.socketIndex);
      assert.equal(targetSocket.effectiveReadyStateDuringFault, 3);
      assert.equal(targetSocket.closeEventsBefore, 0);
      evidence.faultInjection = {
        scope: "this isolated page's real question-owning WebSocket instance",
        socketIndex: targetSocket.socketIndex,
        readyStateBefore: targetSocket.actualReadyStateBefore,
        effectiveReadyStateForOneSubmit: targetSocket.effectiveReadyStateDuringFault,
        closeEventsBeforeSubmit: targetSocket.closeEventsBefore,
      };

      await page.getByTestId("question-submit").click();
      const responseAlert = page.getByTestId("interaction-response-error");
      await responseAlert.waitFor({ state: "visible", timeout: 8_000 });
      evidence.alertText = await responseAlert.innerText();
      evidence.alertRole = await responseAlert.getAttribute("role");
      evidence.alertLiveRegion = await responseAlert.getAttribute("aria-live");
      assert.equal(evidence.alertRole, "alert");
      assert.equal(evidence.alertLiveRegion, "assertive");
      assert.match(evidence.alertText, /Question response failed/);
      assert.match(evidence.alertText, /RPC 连接尚未就绪/);
      assert.match(evidence.alertText, /try again/i);
      evidence.questionCardVisibleAfterFailure = await questionCard.isVisible();
      assert.equal(evidence.questionCardVisibleAfterFailure, true);
      assert.equal(await answerOption.getAttribute("aria-checked"), "true");
      evidence.selectedAfterFailure = true;
      assert.equal(await page.getByTestId("question-submit").isDisabled(), false);
      evidence.noQuestionReplyBeforeRetry =
        rpc.interactionReplies.filter(
          (reply) => reply.requestId === questionRequest.requestId,
        ).length === 0;
      assert.equal(
        evidence.noQuestionReplyBeforeRetry,
        true,
        "the failed attempt must not send an answer over JSON-RPC",
      );
      assert.deepEqual(pageErrors, [], "the card must catch and display the transport error");
      evidence.stages.push("visible-error-preserves-selection-without-rpc-reply");
      await page.screenshot({
        path: context.pathInArtifacts("question-response-error-retryable.png"),
      });

      stage = "restore-socket-and-retry";
      const restoredSocket = await page.evaluate((socketIndex) => {
        const tracked = window.__mobileE2eSockets?.find(
          (entry) => entry.index === socketIndex,
        );
        if (!tracked) throw new Error("question-owning WebSocket tracking entry disappeared");
        const restoredOverride = delete tracked.socket.readyState;
        const descriptor = Object.getOwnPropertyDescriptor(
          WebSocket.prototype,
          "readyState",
        );
        const actualReadyState = descriptor?.get?.call(tracked.socket);
        return {
          restoredOverride,
          actualReadyState,
          closeEvents: tracked.closeEvents,
        };
      }, questionRequest.socketIndex);
      assert.equal(restoredSocket.restoredOverride, true);
      assert.equal(restoredSocket.actualReadyState, 1);
      assert.equal(restoredSocket.closeEvents, 0);
      evidence.readyStateRestored = true;
      evidence.faultInjection = {
        ...evidence.faultInjection,
        readyStateRestoredTo: restoredSocket.actualReadyState,
        closeEventsBeforeRetry: restoredSocket.closeEvents,
      };

      const providerRequestCountBeforeRetry = model.requests.length;
      await page.getByTestId("question-submit").click();
      await questionCard.waitFor({ state: "hidden", timeout: 30_000 });
      await waitFor(
        () => model.requests.length > providerRequestCountBeforeRetry,
        30_000,
        "provider fixture to receive the retried question answer",
        100,
        context.abortSignal,
      );
      await page.getByText(finalMarker, { exact: true }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      const questionRepliesAfterRetry = rpc.interactionReplies.filter(
        (reply) => reply.requestId === questionRequest.requestId,
      );
      assert.equal(questionRepliesAfterRetry.length, 1);
      assert.equal(questionRepliesAfterRetry[0].responseType, "result");
      assert.equal(questionRepliesAfterRetry[0].hasAnswers, true);
      evidence.answerObservedByProvider = model.requests
        .slice(providerRequestCountBeforeRetry)
        .some((request) => JSON.stringify(request.messages ?? []).includes(answerMarker));
      assert.equal(
        evidence.answerObservedByProvider,
        true,
        "the server must receive the retained answer after retry",
      );
      evidence.stages.push("restored-socket-retry-completed-server-roundtrip");
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);

      const backendProcesses = await findOwnedExecutableProcesses({
        pgid: gateway.child.pid,
        executablePath: configuredBackendBefore.path,
      });
      const configuredBackendAfter = await hashExecutableFile(binary);
      const backendBinaryUnchanged = JSON.stringify(configuredBackendAfter) === JSON.stringify(configuredBackendBefore);
      const actualExecutableVerified = backendProcesses.some(item => item.sha256 === configuredBackendBefore.sha256);
      const backendProcessProvenance = {
        configuredBefore: configuredBackendBefore,
        configuredAfter: configuredBackendAfter,
        unchanged: backendBinaryUnchanged,
        gatewayProcessGroupId: gateway.child.pid,
        status: actualExecutableVerified ? "verified" : "unverified",
        ownedProcesses: backendProcesses,
        unverifiedReason: actualExecutableVerified ? null : "no readable matching configured executable found in this run's Gateway process group",
      };
      await context.writeArtifactJson("backend-executable-provenance.json", backendProcessProvenance);
      assert.equal(backendBinaryUnchanged, true, "The configured backend binary must remain unchanged during the run");

      await context.writeArtifactJson("interaction-send-failure-retry.json", {
        ...evidence,
        providerRequestCount: model.requests.length,
        successfulQuestionReplies: questionRepliesAfterRetry.length,
        backendProcessProvenance,
        successScreenshotReason:
          "shows the real question card's accessible send-failure alert while the selected answer remains retryable",
      });
      return {
        visibleAccessibleAlert: true,
        selectedAnswerPreserved: true,
        noReplySentBeforeRetry: true,
        readyStateRestored: true,
        retriedAnswerReachedAppServerAndProvider: true,
        pageErrors: 0,
        consoleErrors: 0,
        providerRequests: model.requests.length,
        bundleMode,
        backendProcessProvenance,
      };
    } catch (error) {
      evidence.questionCardVisibleAfterFailure = await page
        .getByTestId("question-card")
        .isVisible()
        .catch(() => false);
      evidence.selectedAfterFailure = await page
        .getByRole("radio", { name: /MOBILE_FAULT_RETRY_ANSWER/ })
        .getAttribute("aria-checked")
        .then((value) => value === "true")
        .catch(() => false);
      if (Number.isSafeInteger(evidence.questionRequestId)) {
        evidence.noQuestionReplyBeforeRetry = !rpc.interactionReplies.some(
          (reply) => reply.requestId === evidence.questionRequestId,
        );
      }
      await context
        .writeArtifactJson("interaction-send-failure-retry-failure.json", {
          ...evidence,
          stage,
          error: error instanceof Error ? error.message : String(error),
          route: new URL(page.url()).pathname,
          visibleText: await page.locator("body").innerText().catch(() => ""),
          providerRequestCount: model.requests.length,
        })
        .catch(() => undefined);
      await page
        .screenshot({
          path: context.pathInArtifacts("interaction-send-failure-retry-failure.png"),
          fullPage: true,
        })
        .catch(() => undefined);
      throw error;
    } finally {
      await page.close();
    }
  },
);

async function installPageOwnedSocketCapture(page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const trackedSockets = [];
    let nextSocketIndex = 1;
    const InstrumentedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        let channel = null;
        try {
          channel = new URL(socket.url).searchParams.get("channel");
        } catch {
          // Store only the channel, never the full URL with authentication data.
        }
        const tracked = {
          index: nextSocketIndex++,
          channel,
          closeEvents: 0,
          socket,
        };
        socket.addEventListener("close", () => {
          tracked.closeEvents += 1;
        });
        trackedSockets.push(tracked);
        return socket;
      },
    });
    Object.defineProperty(window, "__mobileE2eSockets", {
      configurable: false,
      enumerable: false,
      value: trackedSockets,
    });
    window.WebSocket = InstrumentedWebSocket;
  });
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  const loginInput = page.locator('input[name="token"]');
  if (await loginInput.count()) {
    await loginInput.fill(gateway.authToken);
    await Promise.all([
      page.waitForSelector('[data-testid="welcome-direct-connection"]', {
        timeout: 30_000,
      }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

function parseFrame(payload) {
  try {
    return JSON.parse(String(payload));
  } catch {
    return null;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}
